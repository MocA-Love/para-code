/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// electron-main側で「browserView viewId → Chromium DevTools targetId」を解決する小さなサービス。
// shared process上のCDPゲートウェイ（paradisCdpGateway.ts）が、バインド済みページの
// targetId を突き止めて `/json/list` のフィルタや WebSocket プロキシの許可判定に使う。
// app.ts の PARA-PATCH 点から ProxyChannel.fromService で共有プロセス向けに公開される。

import * as electron from 'electron';
import type { NativeImage, WebContents } from 'electron';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { BrowserView } from '../../../../platform/browserView/electron-main/browserView.js';
import type { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { browserViewAutomationKeySignatureFromCdp } from '../../../../platform/browserView/common/browserViewAutomationInput.js';
import {
	IParadisCdpExactViewService,
	IParadisCdpFrameEvent,
	IParadisCdpInputDispatchResult,
	IParadisCdpScreenshotOptions,
	IParadisExactBrowserViewDescriptor,
	PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH,
	PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH,
	paradisParseExactBrowserViewDescriptor,
	paradisParseExactBrowserViewId,
	paradisParseExactBrowserViewWindowId,
	paradisParseExactCdpScreenshotOptions,
	paradisParseCdpInputCommand,
} from '../common/paradisAgentBrowser.js';

/** フレームの最小送信間隔（toJPEG は同期でそれなりに重いため、ペイント毎=最大60fpsを間引く）。 */
const FRAME_MIN_INTERVAL_MS = 150;

/** 1ターゲットぶんのフレーム購読状態（複数モバイルの同時ミラーは refCount でファンアウト共有）。 */
interface IFrameSubState {
	refCount: number;
	readonly wc: WebContents;
	lastSentAt: number;
	/** スロットルで抑制された最新フレーム（trailingタイマーで必ず送る）。 */
	pendingImage: NativeImage | undefined;
	trailingTimer: ReturnType<typeof setTimeout> | undefined;
	readonly destroyedListener: () => void;
}

/**
 * shared process から `PARADIS_CDP_TARGET_CHANNEL` 経由で呼ばれるサービス。
 * ProxyChannel.fromService でそのままチャネル化できるよう、公開メソッドはasyncのみ
 * （イベントは `onDid*` 命名で ProxyChannel がそのまま転送する）。
 * app.ts で1度だけ生成されるプロセス寿命のシングルトン前提（dispose経路は無い。
 * フレーム購読は shared process 側の stopFrameSubscription / webContents の destroyed で解放される）。
 */
export class ParadisCdpTargetService implements IParadisCdpExactViewService {

	private readonly frameSubs = new Map<string, IFrameSubState>();
	/** Concrete BrowserView object → opaque lease. Weak keys must never be reversed into strong view references. */
	private readonly viewLeases = new WeakMap<object, string>();
	private readonly _onDidFrame = new Emitter<IParadisCdpFrameEvent>();
	/** beginFrameSubscription 由来のフレーム（base64 JPEG）。全購読ターゲット共通、targetIdで振り分ける。 */
	readonly onDidFrame: Event<IParadisCdpFrameEvent> = this._onDidFrame.event;

	constructor(
		private readonly browserViewMainService: IBrowserViewMainService,
		private readonly createViewLease: () => string = generateUuid,
	) { }

	/**
	 * 対象ページの再描画プッシュ購読を開始する（ブラウザミラー用）。
	 * CDPの Page.startScreencast が Electron の WebContentsView 埋め込みページでは
	 * フレームを発火しないため、Electron 側の webContents.beginFrameSubscription を使う。
	 * 対象が見つからない・破棄済みの場合は false（呼び出し側はポーリングに留まる）。
	 */
	async startFrameSubscription(targetId: string): Promise<boolean> {
		const existing = this.frameSubs.get(targetId);
		if (existing) {
			existing.refCount++;
			return true;
		}
		const wc = electron.webContents.fromDevToolsTargetId(targetId);
		if (!wc || wc.isDestroyed()) {
			return false;
		}
		const state: IFrameSubState = {
			refCount: 1, wc, lastSentAt: 0, pendingImage: undefined, trailingTimer: undefined,
			destroyedListener: () => this.teardownFrameSubscription(targetId),
		};
		try {
			wc.beginFrameSubscription(false, image => this.handleFrame(targetId, image));
		} catch {
			return false;
		}
		this.frameSubs.set(targetId, state);
		wc.once('destroyed', state.destroyedListener);
		return true;
	}

	/**
	 * WebRTCミラー用: 次の1回の getDisplayMedia が指定targetIdのWebContentsView単体を
	 * キャプチャするよう arm する（one-shot、TTL付き）。実体は
	 * paradisBrowserMirrorCapture.ts のモジュール状態（app.ts の
	 * setDisplayMediaRequestHandler が paradisResolveMirrorCaptureFrame() で消費する）。
	 */
	async armMirrorCapture(targetId: string): Promise<void> {
		const { paradisArmMirrorCapture } = await import('../../browserMirror/electron-main/paradisBrowserMirrorCapture.js');
		paradisArmMirrorCapture(targetId);
	}

	/** 購読の参照を1つ返す。最後の参照が消えたら endFrameSubscription する。 */
	async stopFrameSubscription(targetId: string): Promise<void> {
		const state = this.frameSubs.get(targetId);
		if (state && --state.refCount <= 0) {
			this.teardownFrameSubscription(targetId);
		}
	}

	/** WebRTCシグナルを対象BrowserViewのworkbench windowだけへ配送するための所有者解決。 */
	async resolveTargetWindowId(targetId: string): Promise<number | null> {
		for (const info of await this.browserViewMainService.getBrowserViews()) {
			const view = this.browserViewMainService.tryGetBrowserView(info.id);
			try {
				if (view?.debugger.targetId === targetId) {
					return info.owner.mainWindowId;
				}
			} catch { /* 破棄と競合したviewだけを飛ばして残りを調べる */ }
		}
		return null;
	}

	private teardownFrameSubscription(targetId: string): void {
		const state = this.frameSubs.get(targetId);
		if (!state) {
			return;
		}
		this.frameSubs.delete(targetId);
		if (state.trailingTimer !== undefined) {
			clearTimeout(state.trailingTimer);
		}
		if (!state.wc.isDestroyed()) {
			try {
				state.wc.endFrameSubscription();
			} catch { /* 破棄競合は無視 */ }
			state.wc.removeListener('destroyed', state.destroyedListener);
		}
	}

	private handleFrame(targetId: string, image: NativeImage): void {
		const state = this.frameSubs.get(targetId);
		if (!state) {
			return;
		}
		const now = Date.now();
		const elapsed = now - state.lastSentAt;
		if (elapsed >= FRAME_MIN_INTERVAL_MS) {
			state.lastSentAt = now;
			this.emitFrame(targetId, image);
			return;
		}
		// 間引き: 最新フレームだけ保持し、最小間隔の残り時間後に必ず送る（最終フレーム落ち防止）
		state.pendingImage = image;
		if (state.trailingTimer === undefined) {
			state.trailingTimer = setTimeout(() => {
				state.trailingTimer = undefined;
				const pending = state.pendingImage;
				state.pendingImage = undefined;
				if (pending && this.frameSubs.get(targetId) === state) {
					state.lastSentAt = Date.now();
					this.emitFrame(targetId, pending);
				}
			}, FRAME_MIN_INTERVAL_MS - elapsed);
		}
	}

	private emitFrame(targetId: string, image: NativeImage): void {
		try {
			const size = image.getSize();
			if (size.width <= 0 || size.height <= 0) {
				return;
			}
			this._onDidFrame.fire({
				targetId,
				data: image.toJPEG(60).toString('base64'),
				w: Math.round(size.width),
				h: Math.round(size.height),
			});
		} catch { /* 変換失敗は無視（次のペイントで回復する） */ }
	}

	/**
	 * browserView の viewId から Chromium DevTools の targetId を返す。
	 * ビューが存在しない（既に閉じられた）場合は null。
	 * targetId は `webContents.getOrCreateDevToolsTargetId()` 由来
	 * （BrowserViewDebugger.targetId）で、アプリ本体の remote-debugging
	 * エンドポイントの `/json/list` に現れる id と同一。
	 */
	async resolveTargetId(viewId: string): Promise<string | null> {
		const view = this.browserViewMainService.tryGetBrowserView(viewId);
		if (!view) {
			return null;
		}
		try {
			return view.debugger.targetId;
		} catch {
			return null;
		}
	}

	/**
	 * Resolve one concrete BrowserView object into an exact, copy-owned descriptor.
	 * Every object/owner/target check is repeated after target lookup so a reused viewId cannot
	 * turn an in-flight resolution into authority for its replacement.
	 */
	async resolveExactViewDescriptor(windowIdValue: unknown, viewIdValue: unknown): Promise<IParadisExactBrowserViewDescriptor | null> {
		const windowId = paradisParseExactBrowserViewWindowId(windowIdValue);
		const viewId = paradisParseExactBrowserViewId(viewIdValue);
		if (windowId === undefined || viewId === undefined) {
			return null;
		}

		const view = this.browserViewMainService.tryGetBrowserView(viewId);
		if (!view) {
			return null;
		}
		this.ensureViewInitializedForBind(view);
		const firstTargetId = this.readViewIdentity(view, windowId);
		if (firstTargetId === undefined) {
			return null;
		}
		if (this.browserViewMainService.tryGetBrowserView(viewId) !== view) {
			return null;
		}
		const secondTargetId = this.readViewIdentity(view, windowId);
		if (secondTargetId === undefined || secondTargetId !== firstTargetId) {
			return null;
		}

		const viewLease = this.getOrCreateViewLease(view);
		if (viewLease === undefined || this.browserViewMainService.tryGetBrowserView(viewId) !== view) {
			return null;
		}
		const finalTargetId = this.readViewIdentity(view, windowId);
		if (finalTargetId === undefined
			|| finalTargetId !== firstTargetId
			|| this.browserViewMainService.tryGetBrowserView(viewId) !== view) {
			return null;
		}
		return paradisParseExactBrowserViewDescriptor({ windowId, viewId, targetId: firstTargetId, viewLease }) ?? null;
	}

	/** Visibility from the exact descriptor object, checked both before and after reading state. */
	async isExactViewVisible(descriptorValue: unknown): Promise<boolean | null> {
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		if (descriptor === undefined) {
			return null;
		}
		const view = this.resolveExistingExactView(descriptor);
		if (!view) {
			return null;
		}
		try {
			const visible = view.getState().visible;
			if (typeof visible !== 'boolean' || this.resolveExistingExactView(descriptor) !== view) {
				return null;
			}
			return visible;
		} catch {
			return null;
		}
	}

	/** Screenshot from the exact object, with authority revalidated after the await. */
	async captureExactViewScreenshot(descriptorValue: unknown, optionsValue: unknown): Promise<string | null> {
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		const options = paradisParseExactCdpScreenshotOptions(optionsValue);
		if (descriptor === undefined || options === undefined) {
			return null;
		}
		const view = this.resolveExistingExactView(descriptor);
		if (!view) {
			return null;
		}
		try {
			const buffer = await view.captureScreenshot(options);
			return this.resolveExistingExactView(descriptor) === view ? encodeBase64(buffer) : null;
		} catch (error) {
			if (this.resolveExistingExactView(descriptor) !== view) {
				return null;
			}
			throw error;
		}
	}

	/** Apply background throttling only to the concrete object named by the exact descriptor. */
	async setExactViewBackgroundThrottling(descriptorValue: unknown, enabledValue: unknown): Promise<boolean> {
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		if (descriptor === undefined || typeof enabledValue !== 'boolean') {
			return false;
		}
		const view = this.resolveExistingExactView(descriptor);
		if (!view) {
			return false;
		}
		try {
			view.webContents.setBackgroundThrottling(enabledValue);
			return true;
		} catch {
			return false;
		}
	}

	/** Dispatch one validated input command to the exact BrowserView debugger root without focusing it. */
	async dispatchExactViewInput(descriptorValue: unknown, methodValue: unknown, paramsJsonValue: unknown): Promise<IParadisCdpInputDispatchResult> {
		const command = paradisParseCdpInputCommand(methodValue, paramsJsonValue);
		if (!command) {
			const method = typeof methodValue === 'string' && methodValue.length <= 256 ? methodValue : '<invalid method>';
			return { status: 'retryable', message: `PARA_BROWSER_RETRYABLE: ${method} is not an allowed valid focusless BrowserView input command` };
		}
		const descriptor = paradisParseExactBrowserViewDescriptor(descriptorValue);
		if (!descriptor) {
			return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: invalid exact BrowserView descriptor for input dispatch' };
		}
		const view = this.resolveExistingExactView(descriptor);
		if (!view) {
			return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView authority changed before input dispatch' };
		}
		try {
			if (view.webContents.isFocused()) {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user' };
			}
		} catch {
			return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView focus state is unavailable' };
		}

		const keySignature = command.method === 'Input.dispatchKeyEvent'
			? browserViewAutomationKeySignatureFromCdp(command.params)
			: undefined;
		let automationRegistration: Awaited<ReturnType<BrowserView['prepareAutomationKeyInput']>>;
		if (command.method === 'Input.dispatchKeyEvent') {
			if (!keySignature) {
				return { status: 'retryable', message: `PARA_BROWSER_RETRYABLE: ${command.method} does not have a suppressible exact key signature` };
			}
			try {
				automationRegistration = await view.prepareAutomationKeyInput(keySignature);
			} catch {
				automationRegistration = undefined;
			}
			if (!automationRegistration) {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be registered' };
			}
		}

		let committed = false;
		let focusAuthorityBeforeSend: object | undefined;
		try {
			if (this.resolveExistingExactView(descriptor) !== view) {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView authority changed before input dispatch' };
			}
			try {
				if (view.webContents.isFocused()) {
					return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView became focused before input dispatch' };
				}
			} catch {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView focus state became unavailable before input dispatch' };
			}
			if (automationRegistration) {
				let activated = false;
				try {
					activated = await automationRegistration.activate();
				} catch {
					// Activation failures are definite because the debugger command has not been sent.
				}
				if (!activated) {
					return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression could not be activated' };
				}
				if (this.resolveExistingExactView(descriptor) !== view) {
					return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView authority changed before input dispatch' };
				}
				try {
					if (view.webContents.isFocused()) {
						return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView became focused before input dispatch' };
					}
				} catch {
					return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView focus state became unavailable before input dispatch' };
				}
			}
			// Commit point: all allowlist, focus and exact identity checks are complete immediately before send.
			if (automationRegistration && !automationRegistration.commit()) {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: automation key suppression was cancelled before input dispatch' };
			}
			try {
				focusAuthorityBeforeSend = view.captureAutomationInputFocusAuthority();
			} catch {
				focusAuthorityBeforeSend = undefined;
			}
			if (!focusAuthorityBeforeSend) {
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView focus authority became unavailable before input dispatch' };
			}
			committed = true;
			let result: unknown;
			try {
				result = await view.debugger.sendCommandRaw(command.method, command.params, undefined);
			} catch {
				return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView debugger input dispatch did not complete' };
			}
			if (this.resolveExistingExactView(descriptor) !== view) {
				return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: exact BrowserView authority changed after input dispatch' };
			}
			try {
				if (view.captureAutomationInputFocusAuthority() !== focusAuthorityBeforeSend) {
					return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView focus authority changed after input dispatch' };
				}
			} catch {
				return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: BrowserView focus authority became unavailable after input dispatch' };
			}
			try {
				if (view.webContents.isFocused()) {
					return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: the bound BrowserView became focused after input dispatch' };
				}
			} catch {
				return { status: 'outcome-unknown', message: 'PARA_BROWSER_OUTCOME_UNKNOWN: exact BrowserView focus state became unavailable after input dispatch' };
			}
			return { status: 'success', result };
		} finally {
			if (committed) {
				automationRegistration?.complete();
			} else {
				automationRegistration?.cancel();
			}
		}
	}

	private getOrCreateViewLease(view: BrowserView): string | undefined {
		const existing = this.viewLeases.get(view);
		if (existing !== undefined) {
			return existing;
		}
		let created: unknown;
		try {
			created = this.createViewLease();
		} catch {
			return undefined;
		}
		if (typeof created !== 'string' || created.length === 0 || created.length > PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH) {
			return undefined;
		}
		this.viewLeases.set(view, created);
		return created;
	}

	/**
	 * Guarantee a bound view's webContents has navigated at least once.
	 *
	 * A brand-new internal-browser tab whose webContents has never loaded a URL reports an empty
	 * URL. puppeteer (the vendored chrome-devtools-mcp on the pane side) treats such a target as
	 * uninitialized and omits it from `browser.pages()`, so every DOM tool on the pane fails with
	 * "No page selected" — and the agent cannot even `navigate_page` its way out. A single in-place
	 * navigation to about:blank initializes the target. Because about:blank is an in-place navigation
	 * (it does not recreate the webContents), the DevTools targetId is unchanged, so firing this
	 * best-effort and un-awaited cannot race the descriptor's targetId resolution in the caller.
	 */
	private ensureViewInitializedForBind(view: BrowserView): void {
		try {
			const wc = view.webContents;
			if (wc.isDestroyed() || wc.isLoadingMainFrame() || wc.getURL() !== '') {
				return;
			}
			void wc.loadURL('about:blank').catch(() => undefined);
		} catch {
			// Best-effort initialization; never block or fail the bind on this.
		}
	}

	/** Read owner, destroyed state and target from one known BrowserView object. */
	private readViewIdentity(view: BrowserView, expectedWindowId: number): string | undefined {
		try {
			if (view.owner.mainWindowId !== expectedWindowId || view.webContents.isDestroyed()) {
				return undefined;
			}
			const targetId = view.debugger.targetId;
			return typeof targetId === 'string' && targetId.length > 0 && targetId.length <= PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH
				? targetId
				: undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Validate a descriptor against the current registry object. The lease comparison deliberately
	 * precedes every capability access on that object; a replacement with a reused viewId is opaque.
	 */
	private resolveExistingExactView(descriptor: IParadisExactBrowserViewDescriptor): BrowserView | undefined {
		const view = this.browserViewMainService.tryGetBrowserView(descriptor.viewId);
		if (!view || this.viewLeases.get(view) !== descriptor.viewLease) {
			return undefined;
		}
		const firstTargetId = this.readViewIdentity(view, descriptor.windowId);
		if (firstTargetId !== descriptor.targetId || this.browserViewMainService.tryGetBrowserView(descriptor.viewId) !== view) {
			return undefined;
		}
		const finalTargetId = this.readViewIdentity(view, descriptor.windowId);
		return finalTargetId === descriptor.targetId
			&& this.browserViewMainService.tryGetBrowserView(descriptor.viewId) === view
			? view
			: undefined;
	}

	/** Return visibility from the same BrowserView instance resolved for this call. */
	async isViewVisible(viewId: string): Promise<boolean | null> {
		const view = this.browserViewMainService.tryGetBrowserView(viewId);
		if (!view || view.webContents.isDestroyed()) {
			return null;
		}
		const visible = view.getState().visible;
		return this.browserViewMainService.tryGetBrowserView(viewId) === view && !view.webContents.isDestroyed() ? visible : null;
	}

	/**
	 * バインド済みビューのスクリーンショットを撮り、base64エンコードした画像データを返す。
	 * CDPゲートウェイが `Page.captureScreenshot` をインターセプトして委譲してくる
	 * （ゲートウェイの素通し経路では WebContentsView が非表示のとき Chromium の
	 * サーフェスコピーが失敗するため、upstream 自身の回避策付き実装
	 * `BrowserView.captureScreenshot()`—可視化キック + capturePage(stayHidden) +
	 * UnknownVizError リトライ、fullPage 時のピンチズーム復元—をそのまま使う）。
	 * ビューが存在しない場合はnull。capture/validation失敗は呼び出し元へ伝播する。
	 */
	async captureScreenshot(viewId: string, options: IParadisCdpScreenshotOptions): Promise<string | null> {
		const view = this.browserViewMainService.tryGetBrowserView(viewId);
		if (!view || view.webContents.isDestroyed()) {
			return null;
		}
		const buffer = await view.captureScreenshot({
			format: options.format,
			quality: options.quality,
			fullPage: options.fullPage,
			pageRect: options.pageRect ? { ...options.pageRect } : undefined,
			captureBeyondViewport: options.captureBeyondViewport,
		});
		if (this.browserViewMainService.tryGetBrowserView(viewId) !== view || view.webContents.isDestroyed()) {
			return null;
		}
		return encodeBase64(buffer);
	}

	/**
	 * バインド済みビューの backgroundThrottling を切り替える。
	 * バインド確立時に false（非表示状態でも rAF/タイマーが抑制されず、MCPの
	 * navigate / wait_for が停滞しない）、アンバインド時に true（Electron既定）へ戻す。
	 */
	async setBackgroundThrottling(viewId: string, enabled: boolean): Promise<void> {
		try {
			this.browserViewMainService.tryGetBrowserView(viewId)?.webContents.setBackgroundThrottling(enabled);
		} catch {
			// ビューが破棄済み等。スロットリング設定はベストエフォートなので無視
		}
	}
}

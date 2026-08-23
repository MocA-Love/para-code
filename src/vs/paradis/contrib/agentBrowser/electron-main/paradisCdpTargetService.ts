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
import { timeout } from '../../../../base/common/async.js';
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
	IParadisAgentCursorEvent,
	IParadisExactBrowserViewDescriptor,
	PARADIS_EXACT_VIEW_LEASE_MAX_LENGTH,
	PARADIS_EXACT_VIEW_TARGET_ID_MAX_LENGTH,
	paradisParseExactBrowserViewDescriptor,
	paradisParseExactBrowserViewId,
	paradisParseExactBrowserViewWindowId,
	paradisParseExactCdpScreenshotOptions,
	paradisParseCdpInputCommand,
} from '../common/paradisAgentBrowser.js';
import {
	PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_INTERVAL_MS,
	ParadisExactViewFrameKeepaliveRegistry,
} from '../common/paradisExactViewFrameKeepalive.js';
import { ParadisCdpUpstreamPortPin } from './paradisCdpUpstreamPortPin.js';
import { ParadisCursorOverlayController } from './paradisCursorOverlayController.js';

/** 上流ポートの問い合わせに答えるまでの上限。確定が間に合わなければ「まだ無い」と返す。 */
const UPSTREAM_PORT_ANSWER_TIMEOUT_MS = 1_500;

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
/** CSS ビューポートの寸法と、それを測った時刻。 */
interface IParadisCursorViewport {
	readonly width: number;
	readonly height: number;
	readonly at: number;
}

/**
 * ビューポート寸法の控えを使い回す時間 (ms)。
 *
 * リサイズやズームで変わるが、その頻度は入力より桁違いに低い。長くすると変化直後の数手が
 * ずれ、短くすると入力のたびに CDP 往復が増える。
 */
const CURSOR_VIEWPORT_TTL_MS = 2_000;

export class ParadisCdpTargetService implements IParadisCdpExactViewService {

	private readonly frameSubs = new Map<string, IFrameSubState>();
	/** Hidden agent-bound views that need a periodic draw so viz keeps sending them BeginFrames. */
	private readonly frameKeepalive = new ParadisExactViewFrameKeepaliveRegistry();
	private frameKeepaliveTimer: ReturnType<typeof setInterval> | undefined;
	/** Concrete BrowserView object → opaque lease. Weak keys must never be reversed into strong view references. */
	private readonly viewLeases = new WeakMap<object, string>();
	private readonly _onDidFrame = new Emitter<IParadisCdpFrameEvent>();
	/** beginFrameSubscription 由来のフレーム（base64 JPEG）。全購読ターゲット共通、targetIdで振り分ける。 */
	readonly onDidFrame: Event<IParadisCdpFrameEvent> = this._onDidFrame.event;

	/** CSS ビューポート寸法の控え。入力のたびにページへ問い合わせないため。 */
	private readonly cursorViewports = new WeakMap<BrowserView, IParadisCursorViewport>();
	/**
	 * カーソルを取り下げるたびに進む世代。
	 *
	 * 寸法の測り直しを挟む回だけ `move` の発火が非同期になり、その隙に「取り下げ」が
	 * 割り込むと、消したはずのカーソルが後から復活してしまう。測る前の世代と突き合わせて落とす。
	 */
	private readonly cursorGenerations = new WeakMap<BrowserView, number>();
	private readonly _onDidChangeAgentCursor = new Emitter<IParadisAgentCursorEvent>();
	/**
	 * カーソル演出の写し。
	 *
	 * 演出そのものはページの中に描かれるので、そのページが画面に出ている限りは何もしなくても
	 * 映像に写る。写らないのは非表示のビューで、Chromium がフレームを作らないためカーソルの
	 * 移動も波紋もフラッシュも進まない。ブラウザ一覧はそういうページこそ見張る場所なので、
	 * 座標だけをここから流して、縮小映像の上へ描き直せるようにする。
	 */
	readonly onDidChangeAgentCursor: Event<IParadisAgentCursorEvent> = this._onDidChangeAgentCursor.event;

	constructor(
		private readonly browserViewMainService: IBrowserViewMainService,
		private readonly createViewLease: () => string = generateUuid,
		private readonly upstreamPortPin: ParadisCdpUpstreamPortPin = new ParadisCdpUpstreamPortPin(),
		/** エージェント操作を見せる合成カーソル演出。既定は「常に有効」（app.tsが設定を渡す）。 */
		private readonly cursorOverlay: ParadisCursorOverlayController = new ParadisCursorOverlayController(),
	) { }

	/**
	 * カーソル演出を取り下げる。ページ側と一覧側の写しを必ず同時に片付ける。
	 *
	 * 別々に呼ぶと、片方だけ残った状態 (もう誰も操作していないページに一覧側のカーソルだけが
	 * 最大1分残る) が作れてしまう。
	 */
	private removeCursorOverlay(viewId: string, view: BrowserView): void {
		this.cursorOverlay.removeOverlay(view);
		this.cursorGenerations.set(view, (this.cursorGenerations.get(view) ?? 0) + 1);
		this._onDidChangeAgentCursor.fire({ viewId, kind: 'gone' });
	}

	/**
	 * マウス入力に合わせてカーソルの写しを流す。
	 *
	 * 座標はここで 0..1 へ正規化する。受け側 (別プロセスの一覧ウィンドウ) は、そのページの
	 * CSS ビューポートがどれだけの大きさか・どのディスプレイの倍率で撮られたかを知らない。
	 * ページのズームや端末エミュレーションが効いていると、撮影画像の寸法から逆算しても合わない。
	 *
	 * 寸法はページに聞く (`Page.getLayoutMetrics`) が、入力のたびに往復すると配送が遅れるので
	 * 短い間だけ覚えておく (モバイルミラーが同じ間引き方をしている)。まだ寸法を知らない間は
	 * 何も送らない —— 位置の分からないカーソルを出すより、1手ぶん遅れて出る方がよい。
	 */
	private async fireAgentCursorMove(viewId: string, view: BrowserView, params: Readonly<Record<string, unknown>>, durationMs: number): Promise<void> {
		const { type, x, y } = params;
		if (type !== 'mousePressed' && type !== 'mouseMoved') {
			return;
		}
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
			return;
		}
		if (!this.cursorOverlay.isOverlayEnabled()) {
			return;
		}
		const generation = this.cursorGenerations.get(view) ?? 0;
		const viewport = await this.resolveCursorViewport(view);
		if (!viewport || (this.cursorGenerations.get(view) ?? 0) !== generation) {
			// 測っている間にページが手を離れた。ここで出すと、消したカーソルが復活する。
			return;
		}
		const nx = x / viewport.width;
		const ny = y / viewport.height;
		if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
			return;
		}
		this._onDidChangeAgentCursor.fire(type === 'mousePressed'
			? { viewId, kind: 'press', nx, ny }
			: { viewId, kind: 'move', nx, ny, durationMs });
	}

	/**
	 * CSS ビューポートの寸法。{@link CURSOR_VIEWPORT_TTL_MS} の間は前回の値を使い回す。
	 *
	 * `cssLayoutViewport` はスクロールバーを含まないが、サムネイルはビュー全幅の撮影なので、
	 * 右端では割合がわずかに 1 を超える。スクロールバーの上をホバーした一瞬だけカーソルが
	 * 消えるが、そこを直すために別の寸法を測りに行くほどのことではない。
	 */
	private async resolveCursorViewport(view: BrowserView): Promise<IParadisCursorViewport | undefined> {
		const cached = this.cursorViewports.get(view);
		const at = Date.now();
		if (cached && at - cached.at < CURSOR_VIEWPORT_TTL_MS) {
			return cached;
		}
		try {
			const metrics = await view.debugger.sendCommand('Page.getLayoutMetrics') as { readonly cssLayoutViewport?: { readonly clientWidth?: unknown; readonly clientHeight?: unknown } };
			const width = metrics?.cssLayoutViewport?.clientWidth;
			const height = metrics?.cssLayoutViewport?.clientHeight;
			if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
				return undefined;
			}
			const viewport = { width, height, at: Date.now() };
			this.cursorViewports.set(view, viewport);
			return viewport;
		} catch {
			// ページ遷移中などで測れないことがある。次の入力で測り直す。
			return undefined;
		}
	}

	/**
	 * 上流ポートの確定を始める（待たない）。app.ts が起動直後に1度だけ呼ぶ。
	 *
	 * `DevToolsActivePort` を2つ目のプロセスが上書きするより先に読むのが唯一の確実な手なので、
	 * shared process から聞かれるのを待たずに走らせる。コンストラクタでやらないのは、この
	 * サービスを組み立てるだけで Electron とファイルシステムに触りに行かせないため。
	 */
	pinUpstreamPort(): void {
		void this.upstreamPortPin.pin().catch(() => undefined);
	}

	/**
	 * shared process の CDP ゲートウェイが使う上流ポート。詳細は {@link ParadisCdpUpstreamPortPin}。
	 *
	 * 確定を待ち切らずに短く区切るのは、呼び出し側がブラウザ操作の途中にいるため。上流が使えない
	 * 構成では確定が成功しないので、待たせると操作のたびに固まって見える。取り逃しても確定は裏で
	 * 続き、次の問い合わせで返せる（そのときまでは従来どおり `DevToolsActivePort` へ落ちる）。
	 */
	async resolveUpstreamPort(): Promise<number | null> {
		return await this.upstreamPortPin.resolveWithin(UPSTREAM_PORT_ANSWER_TIMEOUT_MS) ?? null;
	}

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
		// カーソル演出は撮影結果に写さない（既定）。撮影経路は非表示ビューも一時的に可視化して
		// 撮るため、可視かどうかに関わらず先に隠しておく必要がある。撮り終えたら元に戻し、
		// 「撮った」ことが分かるフラッシュを出す（フラッシュは撮影後なので画像には入らない）。
		await this.cursorOverlay.hideForCapture(view);
		let captured = false;
		try {
			const buffer = await view.captureScreenshot(options);
			captured = this.resolveExistingExactView(descriptor) === view;
			return captured ? encodeBase64(buffer) : null;
		} catch (error) {
			if (this.resolveExistingExactView(descriptor) !== view) {
				return null;
			}
			throw error;
		} finally {
			// 復帰は必ず行い、フラッシュは本当に撮れたときだけ。所有権を失ったページや
			// 失敗した撮影で光らせると、ユーザーが今使っているページが理由もなく光る。
			// 一覧側の合図は、ページ側が実際に光ったときだけ出す。設定OFFと連射スロットル
			// (FLASH_MIN_INTERVAL_MS) の判断を2箇所に複製しないため、戻り値をそのまま使う。
			// 返るのは「光らせるコマンドを投げた」時点なので、ページ側の eval が失敗しても
			// 一覧は光る。判断を複製しない方を採った結果で、承知のうえの非対称。
			if (this.cursorOverlay.afterCapture(view, captured)) {
				this._onDidChangeAgentCursor.fire({ viewId: descriptor.viewId, kind: 'captured' });
			}
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
		} catch {
			return false;
		}
		// Throttling is disabled exactly while an agent holds this view, which is also exactly when
		// the view needs the periodic nudge. Ride that signal instead of adding a second lifecycle.
		if (enabledValue) {
			this.frameKeepalive.remove(descriptor);
			// 同じ信号がエージェントの手離れも意味するので、置きっぱなしのカーソルもここで片付ける。
			this.removeCursorOverlay(descriptor.viewId, view);
		} else {
			this.frameKeepalive.add(descriptor);
		}
		this.updateFrameKeepaliveTimer();
		return true;
	}

	/** Start or stop the keepalive timer so it only runs while at least one view is tracked. */
	private updateFrameKeepaliveTimer(): void {
		if (this.frameKeepalive.size === 0) {
			if (this.frameKeepaliveTimer !== undefined) {
				clearInterval(this.frameKeepaliveTimer);
				this.frameKeepaliveTimer = undefined;
			}
			return;
		}
		if (this.frameKeepaliveTimer !== undefined) {
			return;
		}
		const timer = setInterval(
			() => this.runFrameKeepalive(),
			PARADIS_EXACT_VIEW_FRAME_KEEPALIVE_INTERVAL_MS,
		);
		this.frameKeepaliveTimer = timer;
		// Pure maintenance: never let it be the reason the process stays alive.
		// Electron main returns a Node timer, while the renderer-based unit harness returns a number.
		(timer as unknown as { unref?(): void }).unref?.();
	}

	/**
	 * Give every tracked hidden view one chance to be drawn.
	 *
	 * See {@link BrowserView.nudgeHiddenFrame} for why this is needed. Views that have gone away
	 * drop out of the ledger here, which is also what eventually stops the timer.
	 */
	private runFrameKeepalive(): void {
		for (const descriptor of this.frameKeepalive.snapshot()) {
			const view = this.resolveExistingExactView(descriptor);
			if (!view) {
				this.frameKeepalive.remove(descriptor);
				continue;
			}
			try {
				view.nudgeHiddenFrame();
			} catch {
				// A nudge is best-effort: a view that cannot be drawn right now gets another chance
				// on the next tick, and one that is gone for good is dropped above.
			}
		}
		this.updateFrameKeepaliveTimer();
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
				// ユーザーが自分で操作し始めた合図。エージェントのカーソルを残すと、実カーソルの
				// 横で固まったまま「止まっている」ように見えるので、ここで片付ける。
				this.removeCursorOverlay(descriptor.viewId, view);
				return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: the bound BrowserView is focused by the user' };
			}
		} catch {
			return { status: 'retryable', message: 'PARA_BROWSER_RETRYABLE: exact BrowserView focus state is unavailable' };
		}

		// エージェントが操作していることを見せる合成カーソル。実際の配送より先にカーソルを
		// 目標座標へ滑らせ、着いてから配送することで、ホバーやクリックが「カーソルが着いた瞬間」に
		// 効いているように見せる。待ち時間は上限つきで、演出が失敗しても0になるだけ。
		// この後の commit 手順は毎回 authority と focus を取り直すので、ここで待つのは安全。
		if (command.method === 'Input.dispatchMouseEvent') {
			const cursorWaitMs = await this.cursorOverlay.onMouseEvent(view, command.params);
			void this.fireAgentCursorMove(descriptor.viewId, view, command.params, cursorWaitMs);
			if (cursorWaitMs > 0) {
				await timeout(cursorWaitMs);
			}
		} else if (command.method === 'Input.dispatchKeyEvent' || command.method === 'Input.insertText') {
			// キー入力には座標が無いので、フォーカスされている要素へ寄せるようページ側へ頼む。
			// 配送は待たせない。
			this.cursorOverlay.onKeyEvent(view);
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

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

import { NativeImage, WebContents, webContents } from 'electron';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { IParadisCdpFrameEvent, IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';

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
export class ParadisCdpTargetService {

	private readonly frameSubs = new Map<string, IFrameSubState>();
	private readonly _onDidFrame = new Emitter<IParadisCdpFrameEvent>();
	/** beginFrameSubscription 由来のフレーム（base64 JPEG）。全購読ターゲット共通、targetIdで振り分ける。 */
	readonly onDidFrame: Event<IParadisCdpFrameEvent> = this._onDidFrame.event;

	constructor(private readonly browserViewMainService: IBrowserViewMainService) { }

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
		const wc = webContents.fromDevToolsTargetId(targetId);
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

	/** 購読の参照を1つ返す。最後の参照が消えたら endFrameSubscription する。 */
	async stopFrameSubscription(targetId: string): Promise<void> {
		const state = this.frameSubs.get(targetId);
		if (state && --state.refCount <= 0) {
			this.teardownFrameSubscription(targetId);
		}
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
	 * バインド済みビューのスクリーンショットを撮り、base64エンコードした画像データを返す。
	 * CDPゲートウェイが `Page.captureScreenshot` をインターセプトして委譲してくる
	 * （ゲートウェイの素通し経路では WebContentsView が非表示のとき Chromium の
	 * サーフェスコピーが失敗するため、upstream 自身の回避策付き実装
	 * `BrowserView.captureScreenshot()`—可視化キック + capturePage(stayHidden) +
	 * UnknownVizError リトライ、fullPage 時のピンチズーム復元—をそのまま使う）。
	 * ビューが存在しない・キャプチャに失敗した場合は null（呼び出し元が上流へフォールバックする）。
	 */
	async captureScreenshot(viewId: string, options: IParadisCdpScreenshotOptions): Promise<string | null> {
		const view = this.browserViewMainService.tryGetBrowserView(viewId);
		if (!view) {
			return null;
		}
		try {
			const buffer = await view.captureScreenshot({
				format: options.format,
				quality: options.quality,
				fullPage: options.fullPage,
				pageRect: options.pageRect ? { ...options.pageRect } : undefined,
			});
			return encodeBase64(buffer);
		} catch {
			return null;
		}
	}

	/**
	 * バインド済みビューの webContents へChromium内部フォーカスを強制する。
	 * CDPゲートウェイが `Input.*` の転送直前に呼ぶ（内部フォーカスが別の
	 * webContents—ターミナル等—にあると合成入力がそちらへ飛ぶElectronの
	 * 既知問題への対策。Superset cdp-filter-proxy の移植）。失敗は握りつぶす。
	 */
	async focusView(viewId: string): Promise<void> {
		try {
			this.browserViewMainService.tryGetBrowserView(viewId)?.webContents.focus();
		} catch {
			// ビューが破棄済み等。フォーカスはベストエフォートなので無視
		}
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

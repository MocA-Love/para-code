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

import { encodeBase64 } from '../../../../base/common/buffer.js';
import { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { IParadisCdpScreenshotOptions } from '../common/paradisAgentBrowser.js';

/**
 * shared process から `PARADIS_CDP_TARGET_CHANNEL` 経由で呼ばれるサービス。
 * ProxyChannel.fromService でそのままチャネル化できるよう、公開メソッドはasyncのみ。
 */
export class ParadisCdpTargetService {

	constructor(private readonly browserViewMainService: IBrowserViewMainService) { }

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

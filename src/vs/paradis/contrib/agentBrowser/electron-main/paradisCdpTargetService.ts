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

import { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';

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
}

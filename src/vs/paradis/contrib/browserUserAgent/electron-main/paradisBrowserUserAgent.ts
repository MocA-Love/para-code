/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのUser-Agentから `Electron/x.y.z` と（既定で）`ParaCode/<ver>` トークンを除去し、
// 素のChromeに見せる。GoogleなどはUA中のElectronシグネチャを検出して埋め込みブラウザでのログインを
// ブロックする（「このブラウザまたはアプリは安全でない可能性があります」）ため。アプリ名トークンも
// 一部サイトで「対応していないブラウザ」と判定される原因になる。
// 呼び出し元は browserSession.ts の configure()（PARA-PATCH 1行）。

import { app } from 'electron';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { paradisConfigureBrowserUserAgentWithAppName } from './paradisBrowserUserAgentCore.js';

/**
 * 内蔵ブラウザ用のElectronセッションのUser-AgentをChrome風に書き換える。
 * セッション単位で設定するため、そのセッション上の全ビュー・全ナビゲーションに効く。
 */
export function paradisApplyChromeLikeUserAgent(session: Electron.Session, configurationService: IConfigurationService): void {
	paradisConfigureBrowserUserAgentWithAppName(session, configurationService, app.getName());
}

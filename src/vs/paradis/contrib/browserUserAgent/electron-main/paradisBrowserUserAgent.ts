/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの User-Agent は既定で Para Code のアプリ名を残す。
// Chrome と同じ形にすると Google のログインが拒否されるため、ブラウザの識別を保つ。
// Chrome 形式に切り替える既存の設定は、明示的な互換性オプションとして残す。
// 呼び出し元は browserSession.ts の configure()（PARA-PATCH 1行）。

import { app } from 'electron';
import { Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_DEFAULT, PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY } from '../common/paradisBrowserUserAgent.js';
import { paradisConfigureBrowserUserAgentWithAppName } from './paradisBrowserUserAgentCore.js';
import { paradisInstallChromeClientHintHeaders } from './paradisChromeIdentity.js';

/**
 * 内蔵ブラウザのセッションへ、アプリ名を残す設定と対応する Client Hints 方針を適用する。
 * セッション単位で設定するため、そのセッション上の全ビュー・全ナビゲーションに効く。
 */
export function paradisApplyChromeLikeUserAgent(session: Electron.Session, configurationService: IConfigurationService): void {
	paradisConfigureBrowserUserAgentWithAppName(session, configurationService, app.getName());
	// Client Hints（brands）も Chrome の値にそろえる。Para Code と名乗る設定のときは Electron のまま。
	paradisInstallChromeClientHintHeaders(
		session,
		() => !(configurationService.getValue<boolean>(PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY) ?? PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_DEFAULT),
		Event.filter(configurationService.onDidChangeConfiguration, e => e.affectsConfiguration(PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY)),
	);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのセッションへ UA を適用する本体。Electron main 専用の値（app.getName()）は
// 呼び出し側（paradisBrowserUserAgent.ts）から渡し、ここはテストから直接呼べるようにしている。

import type { Session } from 'electron';
import { markAsSingleton } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY, paradisBuildBrowserUserAgent } from '../common/paradisBrowserUserAgent.js';

interface IConfiguredSession {
	readonly session: WeakRef<Session>;
	/** 書き換える前の Electron 既定 UA。設定を切り替えたときはここから組み立て直す。 */
	readonly originalUA: string;
	readonly appName: string;
}

const configuredSessions = new WeakMap<Session, IConfiguredSession>();
const liveSessions = new Set<IConfiguredSession>();
/** 設定変更の購読は configurationService ごとに1本だけ張る（セッション数だけ積み上げない）。 */
const listeningServices = new WeakSet<IConfigurationService>();

function apply(entry: IConfiguredSession, session: Session, configurationService: IConfigurationService): void {
	const includeAppToken = configurationService.getValue<boolean>(PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY) === true;
	session.setUserAgent(paradisBuildBrowserUserAgent(entry.originalUA, entry.appName, includeAppToken));
}

/**
 * 内蔵ブラウザ用の Electron セッションの UA を Chrome 風に書き換える。
 * `paradis.browser.userAgent.includeParaCodeToken` の変更は、以後に開くタブへ反映する
 * （Electron の仕様で、既に開いている WebContents の UA は変わらない）。
 */
export function paradisConfigureBrowserUserAgentWithAppName(session: Session, configurationService: IConfigurationService, appName: string): void {
	if (configuredSessions.has(session)) {
		return;
	}
	const originalUA = session.getUserAgent();
	if (!/\sElectron\//.test(originalUA)) {
		// Electron 側の UA 形式が変わり `Electron/x.y.z` トークンが消えている等で、置換が
		// no-op になっている。気付く手段がなく、ログインブロックが再発しうるので報告する。
		reportParadisDiagnosticError('owned', 'browser-user-agent', 'ua-still-electron', new Error('chrome-like User-Agent rewrite did not change the User-Agent string'), { safe_ua_length: originalUA.length }, 'warning');
	}
	const entry: IConfiguredSession = { session: new WeakRef(session), originalUA, appName };
	configuredSessions.set(session, entry);
	liveSessions.add(entry);
	apply(entry, session, configurationService);

	if (!listeningServices.has(configurationService)) {
		listeningServices.add(configurationService);
		// main プロセスと同じ寿命の購読（BrowserSession は破棄されず GC で消えるだけなので、
		// セッション側は WeakRef で持ち、消えたものはここで掃除する）。
		markAsSingleton(configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(PARADIS_BROWSER_UA_INCLUDE_APP_TOKEN_KEY)) {
				return;
			}
			for (const live of [...liveSessions]) {
				const liveSession = live.session.deref();
				if (liveSession) {
					apply(live, liveSession, configurationService);
				} else {
					liveSessions.delete(live);
				}
			}
		}));
	}
}

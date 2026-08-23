/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのUser-Agentから `Electron/x.y.z` トークンを除去し、素のChromeに見せる。
// GoogleなどはUA中のElectronシグネチャを検出して埋め込みブラウザでのログインを
// ブロックする（「このブラウザまたはアプリは安全でない可能性があります」）ため。
// 呼び出し元は browserSession.ts の configure()（PARA-PATCH 1行）。

import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * 内蔵ブラウザ用のElectronセッションのUser-AgentをChrome風に書き換える。
 * セッション単位で設定するため、そのセッション上の全ビュー・全ナビゲーションに効く。
 */
export function paradisApplyChromeLikeUserAgent(session: Electron.Session): void {
	const originalUA = session.getUserAgent();
	const chromeLikeUA = originalUA.replace(/\sElectron\/\S+/g, '').trim();
	if (chromeLikeUA === originalUA) {
		// Electron側のUA形式が変わり `Electron/x.y.z` トークンが消えている等で、この置換が
		// no-opになっている。setUserAgentは呼ばれ続けるので気付く手段がなく、UAに
		// Electronシグネチャが残ったままログインブロックが再発する。
		reportParadisDiagnosticError('owned', 'browser-user-agent', 'ua-still-electron', new Error('chrome-like User-Agent rewrite did not change the User-Agent string'), { safe_ua_length: originalUA.length }, 'warning');
	}
	session.setUserAgent(chromeLikeUA);
}

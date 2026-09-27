/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// AIリミットモニターのプロバイダーロゴ(インラインSVG)。CSP/trusted types対応のため
// innerHTMLではなくcreateElementNSで組み立てる。
// パスデータは @dev.icons/react/mono (MIT) の ClaudeCode / OpenaiIcon から移植。
// どちらも fill="currentColor" で、地色バッジは持たずテーマの前景色にそのまま追従する。

import * as dom from '../../../../base/browser/dom.js';
import { ParadisLimitsProvider } from '../common/paradisLimitsMonitor.js';
import { PARADIS_CLAUDE_LOGO_PATH, PARADIS_CODEX_LOGO_PATH } from '../../../common/paradisAgentLogoPaths.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * エージェントCLI(Claude Code / Codex)の本物のロゴSVG(グリフのみ)をcontainerへ追加して返す。
 * サイズはcontainer側のCSSで指定する(このヘルパはCSSクラスに依存しない)ため、
 * limitsMonitorのタイトルバーウィジェットとagentBrowserのバインディングダイアログの両方から使える。
 */
export function appendParadisAgentLogoSvg(container: HTMLElement, provider: ParadisLimitsProvider): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 600 600');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', provider === 'claude' ? PARADIS_CLAUDE_LOGO_PATH : PARADIS_CODEX_LOGO_PATH);
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	container.appendChild(svg);
	return svg;
}

/** プロバイダーロゴ(グリフのみ、地色バッジなし)をcontainerへ追加して返す。 */
export function appendParadisLimitsLogo(container: HTMLElement, provider: ParadisLimitsProvider): HTMLElement {
	const badge = dom.append(container, dom.$(`.paradis-limits-logo.${provider}`));
	appendParadisAgentLogoSvg(badge, provider);
	return badge;
}

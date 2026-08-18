/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// サービスステータスチップのロゴ(インラインSVG)。Claude/Codexは limitsMonitor が既に持つ
// 本物のロゴ(appendParadisAgentLogoSvg)をそのまま流用し、ここでは重複させない。GitHubの
// Octocatだけ、同じ流儀(createElementNSでCSP/trusted types対応)でここに追加する。

import * as dom from '../../../../base/browser/dom.js';
import { appendParadisAgentLogoSvg } from '../../limitsMonitor/electron-browser/paradisLimitsLogos.js';
import { ParadisServiceStatusProvider } from '../common/paradisServiceStatus.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** primer/octicons "mark-github" (MIT)。viewBox 0 0 16 16。 */
const GITHUB_PATH = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8Z';

function appendGithubLogoSvg(container: HTMLElement): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', GITHUB_PATH);
	path.setAttribute('fill', '#ffffff');
	svg.appendChild(path);
	container.appendChild(svg);
	return svg;
}

/** プロバイダーロゴ(角丸地＋グリフ)をcontainerへ追加して返す。 */
export function appendParadisServiceStatusLogo(container: HTMLElement, provider: ParadisServiceStatusProvider): HTMLElement {
	const badge = dom.append(container, dom.$(`.paradis-service-status-logo.${provider}`));
	if (provider === 'github') {
		appendGithubLogoSvg(badge);
	} else {
		appendParadisAgentLogoSvg(badge, provider);
	}
	return badge;
}

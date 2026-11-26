/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示のエージェントの顔に置くロゴ。limitsMonitor の appendParadisAgentLogoSvg と同じ組み立てだが、
// あちらは electron-browser にあり browser のチャット表示からは読めないので、共通のパス（src/vs/paradis/common）から組む。

import { ParadisAgentLogo, paradisAgentLogoGlyph } from '../../../common/paradisAgentLogoPaths.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** エージェントのロゴ（グリフだけ、色は fill="currentColor"）を container へ足して返す。大きさは CSS で決める。 */
export function paradisAppendAgentLogoSvg(container: HTMLElement, logo: ParadisAgentLogo): SVGSVGElement {
	const glyph = paradisAgentLogoGlyph(logo);
	const document = container.ownerDocument;
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', glyph.viewBox);
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', glyph.path);
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	container.appendChild(svg);
	return svg;
}

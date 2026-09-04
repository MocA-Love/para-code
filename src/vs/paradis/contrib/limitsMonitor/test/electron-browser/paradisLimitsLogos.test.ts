/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as dom from '../../../../../base/browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisLimitsProvider } from '../../common/paradisLimitsMonitor.js';
import { appendParadisAgentLogoSvg, appendParadisLimitsLogo } from '../../electron-browser/paradisLimitsLogos.js';
import { appendParadisServiceStatusLogo } from '../../../serviceStatus/electron-browser/paradisServiceStatusLogos.js';

suite('ParadisLimitsLogos', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function describeSvg(svg: SVGSVGElement) {
		const path = svg.querySelector('path');
		return {
			viewBox: svg.getAttribute('viewBox'),
			ariaHidden: svg.getAttribute('aria-hidden'),
			fill: path?.getAttribute('fill'),
			hasPathData: (path?.getAttribute('d')?.length ?? 0) > 0,
		};
	}

	// ロゴは地色バッジを持たず、テーマの前景色に追従する。ここを色のリテラル(以前の '#ffffff')へ
	// 戻すと、ライトテーマで白いロゴが白背景に溶けて見えなくなる。
	test('every agent logo follows the theme foreground instead of a baked-in color', () => {
		for (const provider of ['claude', 'codex'] satisfies ParadisLimitsProvider[]) {
			const container = dom.$('div');
			assert.deepStrictEqual(describeSvg(appendParadisAgentLogoSvg(container, provider)), {
				viewBox: '0 0 600 600',
				ariaHidden: 'true',
				fill: 'currentColor',
				hasPathData: true,
			}, provider);
		}
	});

	test('gives claude and codex distinct glyphs', () => {
		const claude = appendParadisAgentLogoSvg(dom.$('div'), 'claude').querySelector('path')?.getAttribute('d');
		const codex = appendParadisAgentLogoSvg(dom.$('div'), 'codex').querySelector('path')?.getAttribute('d');
		assert.ok(claude && codex && claude !== codex);
	});

	test('the service status logo is built the same way', () => {
		const container = dom.$('div');
		const badge = appendParadisServiceStatusLogo(container, 'github');
		const svg = badge.querySelector('svg');
		assert.ok(svg);
		assert.deepStrictEqual(describeSvg(svg), {
			viewBox: '0 0 600 600',
			ariaHidden: 'true',
			fill: 'currentColor',
			hasPathData: true,
		});
	});

	test('wraps the glyph in a provider specific badge the stylesheet can size', () => {
		const container = dom.$('div');
		const badge = appendParadisLimitsLogo(container, 'codex');
		assert.deepStrictEqual({
			parent: badge.parentElement === container,
			classes: [...badge.classList].sort(),
			svgCount: badge.querySelectorAll('svg').length,
		}, {
			parent: true,
			classes: ['codex', 'paradis-limits-logo'],
			svgCount: 1,
		});
	});
});

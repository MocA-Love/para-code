/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { suite, test } from 'node:test';
import { buildParadisUiBaseline, findParadisUiViolations, PARADIS_FOCUS_RULES_FILE, reportParadisUiRules } from '../stylelint/paradisUiRules.ts';

const FILE = 'src/vs/paradis/contrib/example/browser/media/paradisExample.css';
const HINT = 'If you only changed the selector or declaration of a rule already listed in build/lib/stylelint/paradis-ui-baseline.json (or renamed its file), run `node build/lib/stylelint/paradisUiRules.ts --update-baseline` and check that the JSON diff only replaces entries without adding any';

const CSS = [
	'/* z-index: 9999; #ffffff :focus in a comment */',
	'.paradis-a { z-index: 2; position: relative; }',
	'.paradis-b {',
	'\tz-index: 2600;',
	'\tcolor: #fff;',
	'\tcontent: "#abc";',
	'}',
	'.paradis-c { z-index: var(--paradis-z-modal); z-index: calc(var(--paradis-z-inspect) + 1); background: var(--vscode-paradis-surface); }',
	'.paradis-d:focus-visible { outline: 1px solid var(--vscode-paradis-focus); }',
	'.paradis-e .codicon { font-size: 14px; }',
	'.paradis-f .codicon { font-size: 16px; }',
	'@media (prefers-reduced-motion: reduce) { .paradis-g { z-index: -1; } }',
].join('\n');

suite('Paradis UI kit stylelint rules', () => {

	test('finds layer numbers above 3, focus selectors, near-miss codicon sizes and hex colors, but not comments, strings or variables', () => {
		assert.deepStrictEqual(findParadisUiViolations(FILE, CSS).map(finding => `${finding.line} ${finding.rule}`), [
			'4 z-index',
			'5 hex-color',
			'9 focus',
			'10 codicon-size',
			'12 z-index',
		]);
	});

	test('allows focus rules in the focus file only, and ignores CSS outside src/vs/paradis and the vendored extension', () => {
		const focus = '.paradis-d:focus-within { outline: 1px solid var(--vscode-paradis-focus); }';
		assert.deepStrictEqual([
			findParadisUiViolations(PARADIS_FOCUS_RULES_FILE, focus).length,
			findParadisUiViolations('src/vs/workbench/browser/media/style.css', CSS).length,
			findParadisUiViolations('src/vs/paradis/contrib/browserExtensions/electron-main/media/panel.css', CSS).length,
			findParadisUiViolations('src\\vs\\paradis\\contrib\\example\\browser\\media\\paradisExample.css', focus).length,
		], [0, 0, 0, 1]);
	});

	test('reports only the findings beyond the baseline, matched by selector and declaration rather than line', () => {
		const baseline = buildParadisUiBaseline([{ path: FILE, contents: CSS }]);
		const moved = '\n\n' + CSS;
		const added = CSS + '\n.paradis-h { z-index: 2600; }\n.paradis-b { z-index: 2600; }';
		const reported: string[] = [];
		const counts = [moved, added].map(contents => reportParadisUiRules(FILE, contents, message => reported.push(message), baseline));
		assert.deepStrictEqual({ counts, reported }, {
			counts: [0, 2],
			reported: [
				`${FILE}(13,1): [paradis-ui z-index] z-index 2600: use a layer variable (--paradis-z-*, table in src/vs/paradis/browser/paradisModal.ts); only 0 to 3 may be written as numbers. ${HINT}`,
				`${FILE}(14,1): [paradis-ui z-index] z-index 2600: use a layer variable (--paradis-z-*, table in src/vs/paradis/browser/paradisModal.ts); only 0 to 3 may be written as numbers. ${HINT}`,
			],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { PARADIS_ANTIGRAVITY_LOGO_PATH, paradisAgentLogoForId, paradisAgentLogoGlyph } from '../../common/paradisAgentLogoPaths.js';

suite('paradisAgentLogoPaths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('draws the Antigravity logo with the same path as the SVG asset, in the theme color', () => {
		const svg = readFileSync(FileAccess.asFileUri('vs/paradis/common/media/paradisAntigravityLogo.svg').fsPath, 'utf8');
		const paths = [...svg.matchAll(/<path d="(?<d>[^"]+)" fill="(?<fill>[^"]+)"/g)].map(match => ({ d: match.groups?.d, fill: match.groups?.fill }));
		assert.deepStrictEqual(paths, [{ d: PARADIS_ANTIGRAVITY_LOGO_PATH, fill: 'currentColor' }]);
	});

	test('picks a logo by agent id, and none for agents without one', () => {
		assert.deepStrictEqual({
			logos: ['claude', 'codex', 'antigravity', 'gemini', 'my-agent', 'none'].map(paradisAgentLogoForId),
			viewBoxes: (['claude', 'codex', 'antigravity'] as const).map(logo => paradisAgentLogoGlyph(logo).viewBox),
		}, {
			logos: ['claude', 'codex', 'antigravity', undefined, undefined, undefined],
			viewBoxes: ['0 0 600 600', '0 0 600 600', '13 15 154 154'],
		});
	});
});

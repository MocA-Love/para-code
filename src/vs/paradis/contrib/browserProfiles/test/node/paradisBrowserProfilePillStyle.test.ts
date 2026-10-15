/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { readFileSync } from 'fs';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const PROFILES_CSS: AppResourcePath = 'vs/paradis/contrib/browserProfiles/electron-browser/media/paradisBrowserProfiles.css';
const ZOOM_CSS: AppResourcePath = 'vs/paradis/contrib/browserZoomIndicator/electron-browser/media/paradisBrowserZoomIndicator.css';

/** CSS のファイルから、セレクタがちょうどその文字列の規則の宣言（プロパティ → 値）を読む。 */
function declarations(path: AppResourcePath, selector: string): Record<string, string> {
	const css = readFileSync(FileAccess.asFileUri(path).fsPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const start = css.indexOf(`${selector} {`);
	assert.notStrictEqual(start, -1, `no rule for ${selector}`);
	const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
	return Object.fromEntries(body.split(';').map(line => line.trim()).filter(line => line.length > 0).map(line => {
		const colon = line.indexOf(':');
		return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
	}));
}

suite('ParadisBrowserProfilePill style', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the profile pill has the same frame as the zoom stepper next to it, in theme tokens only', () => {
		const pill = declarations(PROFILES_CSS, '.browser-root .paradis-browser-profile-pill');
		const zoom = declarations(ZOOM_CSS, '.monaco-workbench .paradis-browser-zoom-stepper');
		const css = readFileSync(FileAccess.asFileUri(PROFILES_CSS).fsPath, 'utf8');
		assert.deepStrictEqual({
			height: pill.height,
			border: pill.border,
			radius: pill['border-radius'],
			background: pill['background-color'],
			literalColors: Object.values(pill).filter(value => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(value)),
			badgeRules: /pbp-pill-badge|agent-controlled/.test(css),
		}, {
			height: zoom.height,
			border: zoom.border,
			radius: zoom['border-radius'],
			background: 'transparent',
			literalColors: [],
			badgeRules: false,
		});
	});
});

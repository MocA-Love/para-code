/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';

const root = path.join(import.meta.dirname, '..', '..', '..');

/**
 * Para Code ships the non-versioned Windows layout (product.json has no `win32VersionedUpdate`),
 * so a background update installs the new files into `{app}\_` (`GetDestDir` in code.iss) and
 * relies on inno_updater's traditional `_` folder move. inno_updater 0.26.0 (upstream
 * microsoft/inno-updater #78) removed that path and fails every in-app update with
 * "New executable not found". An upstream merge must not bring such a binary back.
 */
suite('Para Code Windows background updater', () => {
	test('the bundled inno_updater.exe still supports the non-versioned layout', () => {
		const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')) as { win32VersionedUpdate?: boolean };
		const updater = fs.readFileSync(path.join(root, 'build', 'win32', 'inno_updater.exe'));

		if (product.win32VersionedUpdate) {
			return; // the versioned layout uses the rename path that every inno_updater version has
		}
		assert.deepStrictEqual({
			legacyMoveFallback: updater.includes('using traditional update method'),
			moveUpdate: updater.includes('move_update'),
		}, {
			legacyMoveFallback: true,
			moveUpdate: true,
		});
	});
});

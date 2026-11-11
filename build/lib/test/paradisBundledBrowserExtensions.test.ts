/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { suite, test } from 'node:test';

/**
 * Lists every `_metadata` folder below `folder` (paths relative to `root`, forward slashes).
 */
function findMetadataFolders(root: string, folder: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const child = path.join(folder, entry.name);
		if (entry.name === '_metadata') {
			found.push(path.relative(root, child).replace(/\\/g, '/'));
		} else {
			found.push(...findMetadataFolders(root, child));
		}
	}
	return found;
}

suite('Para Code bundled browser extensions', () => {
	// Electron's LoadUnpacked (shell/browser/extensions/electron_extension_loader.cc) deletes the `_metadata`
	// folder of an unpacked extension every time `session.extensions.loadExtension` reads it. A bundled
	// extension lives inside the signed app, so the deletion breaks the macOS code signature seal
	// (`codesign --verify --deep --strict`: "a sealed resource is missing or invalid").
	test('no extension shipped inside the app has a _metadata folder', () => {
		const root = path.join(import.meta.dirname, '..', '..', '..');
		assert.deepStrictEqual(findMetadataFolders(root, path.join(root, 'src', 'vs', 'paradis')), []);
	});
});

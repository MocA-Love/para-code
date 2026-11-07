/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInstalledForThisWindow } from '../../common/paradisDefaultExtensionsTarget.js';

suite('Paradis default extensions target', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const installed = [
		{ id: 'git-graph', onRemote: false, ui: false },
		{ id: 'theme', onRemote: false, ui: true },
		{ id: 'eslint', onRemote: true, ui: false },
	];

	test('an SSH window counts only what is on the remote or runs locally; a local window counts everything', () => {
		const ids = (isRemoteWindow: boolean) => paradisInstalledForThisWindow(installed, isRemoteWindow, extension => extension.onRemote, extension => extension.ui).map(extension => extension.id);
		assert.deepStrictEqual({ remote: ids(true), local: ids(false) }, { remote: ['theme', 'eslint'], local: ['git-graph', 'theme', 'eslint'] });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBotInstancesInWindow, paradisBotPaneTokenHashInWindow } from '../../browser/paradisBotPaneHash.js';

suite('Paradis bot pane hash', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ウィンドウのハッシュは shared process と同じ値で、合うペインだけを返す', async () => {
		const panes = { listPaneTokens: () => [{ instanceId: 1, token: 'pane-A' }, { instanceId: 2, token: 'pane-B' }, { instanceId: 3, token: 'pane-C' }] };
		assert.deepStrictEqual({
			hash: await paradisBotPaneTokenHashInWindow('pane-A'),
			matched: await paradisBotInstancesInWindow(panes, ['595738e51f96f4da3b0bd4c0fa10ee3a1519a6d53e5632f5419c215b3d1740c4', 'ffff']),
			none: await paradisBotInstancesInWindow(panes, []),
		}, {
			hash: '1b780c2005e24c7adab28a00c48fd437c37580c140f7b9585d87f54e78b59cff',
			matched: [2],
			none: [],
		});
	});
});

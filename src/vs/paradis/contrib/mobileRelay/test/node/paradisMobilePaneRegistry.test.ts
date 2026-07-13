/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobilePaneRegistry } from '../../node/paradisMobilePaneRegistry.js';

suite('ParadisMobilePaneRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('旧Rendererの遅延disposeで新Rendererの対応表を消さない', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'old', [{ terminalId: 1, token: 'pane' }]);
		registry.syncWindow(1, 'current', [{ terminalId: 8, token: 'pane' }]);

		assert.strictEqual(registry.removeWindow(1, 'old'), false);
		assert.deepStrictEqual(registry.ownerOf('pane', 8), { windowId: 1, windowSession: 'current', terminalId: 8, token: 'pane' });
	});

	test('生存中Rendererの空同期後に作成されたペインを同じsessionで登録できる', () => {
		const registry = new ParadisMobilePaneRegistry();
		assert.strictEqual(registry.syncWindow(1, 'current', []), true);
		assert.strictEqual(registry.syncWindow(1, 'current', [{ terminalId: 8, token: 'pane' }]), true);

		assert.deepStrictEqual(registry.ownerOf('pane', 8), { windowId: 1, windowSession: 'current', terminalId: 8, token: 'pane' });
	});

	test('current sessionのremoveだけが対応表を削除する', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'current', [{ terminalId: 8, token: 'pane' }]);

		assert.strictEqual(registry.removeWindow(1, 'current'), true);
		assert.strictEqual(registry.ownerOf('pane', 8), undefined);
		assert.strictEqual(registry.syncWindow(1, 'current', [{ terminalId: 9, token: 'late' }]), false);
	});

	test('同じtokenを複数の生存ウィンドウが登録した場合は解決しない', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'one', [{ terminalId: 1, token: 'pane' }]);
		registry.syncWindow(2, 'two', [{ terminalId: 1, token: 'pane' }]);

		assert.strictEqual(registry.ownerOf('pane', 1), undefined);
	});
});

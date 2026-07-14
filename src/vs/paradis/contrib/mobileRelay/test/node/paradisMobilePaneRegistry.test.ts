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
		registry.syncWindow(1, 'old', 1, 1, [{ terminalId: 1, token: 'pane' }]);
		registry.syncWindow(1, 'current', 2, 1, [{ terminalId: 8, token: 'pane' }]);

		assert.strictEqual(registry.removeWindow(1, 'old', 1), false);
		assert.deepStrictEqual(registry.ownerOf('pane', 8), { windowId: 1, windowSession: 'current', rendererGeneration: 2, terminalId: 8, token: 'pane' });
	});

	test('生存中Rendererの空同期後に作成されたペインを同じsessionで登録できる', () => {
		const registry = new ParadisMobilePaneRegistry();
		assert.strictEqual(registry.syncWindow(1, 'current', 2, 1, []), true);
		assert.strictEqual(registry.syncWindow(1, 'current', 2, 2, [{ terminalId: 8, token: 'pane' }]), true);

		assert.deepStrictEqual(registry.ownerOf('pane', 8), { windowId: 1, windowSession: 'current', rendererGeneration: 2, terminalId: 8, token: 'pane' });
	});

	test('current sessionのremoveだけが対応表を削除する', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'current', 2, 1, [{ terminalId: 8, token: 'pane' }]);

		assert.strictEqual(registry.removeWindow(1, 'current', 2), true);
		assert.strictEqual(registry.ownerOf('pane', 8), undefined);
		assert.strictEqual(registry.syncWindow(1, 'current', 2, 2, [{ terminalId: 9, token: 'late' }]), false);
	});

	test('同じtokenを複数の生存ウィンドウが登録した場合は解決しない', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'one', 1, 1, [{ terminalId: 1, token: 'pane' }]);
		registry.syncWindow(2, 'two', 2, 1, [{ terminalId: 1, token: 'pane' }]);

		assert.strictEqual(registry.ownerOf('pane', 1), undefined);
	});

	test('新世代の後から届いた旧世代syncとdisposeを拒否する', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'new', 2, 1, [{ terminalId: 2, token: 'new-pane' }]);

		assert.strictEqual(registry.syncWindow(1, 'old', 1, 2, [{ terminalId: 1, token: 'old-pane' }]), false);
		assert.strictEqual(registry.removeWindow(1, 'old', 1), false);
		assert.deepStrictEqual(registry.ownerOf('new-pane', 2), {
			windowId: 1, windowSession: 'new', rendererGeneration: 2, terminalId: 2, token: 'new-pane',
		});
	});

	test('terminal hint ownerをexact Renderer leaseとwindow内terminalIdで解決する', () => {
		const registry = new ParadisMobilePaneRegistry();
		registry.syncWindow(1, 'session-a', 4, 1, [{ terminalId: 9, token: 'token-a' }]);
		registry.syncWindow(2, 'session-b', 5, 1, [{ terminalId: 9, token: 'token-b' }]);

		assert.strictEqual(registry.ownerOfTerminal(1, 'session-a', 4, 9)?.token, 'token-a');
		assert.strictEqual(registry.ownerOfTerminal(2, 'session-b', 5, 9)?.token, 'token-b');
		assert.strictEqual(registry.ownerOfTerminal(1, 'session-a', 3, 9), undefined);
	});

	test('同じRenderer世代で古いsnapshot revisionの後着を拒否する', () => {
		const registry = new ParadisMobilePaneRegistry();
		assert.strictEqual(registry.syncWindow(1, 'session', 4, 2, [{ terminalId: 9, token: 'current' }]), true);
		assert.strictEqual(registry.syncWindow(1, 'session', 4, 1, [{ terminalId: 8, token: 'stale' }]), false);
		assert.strictEqual(registry.ownerOf('current', 9)?.token, 'current');
		assert.strictEqual(registry.ownerOf('stale', 8), undefined);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

suite('ParadisMobileTerminalRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じ数値IDを持つ別ウィンドウのターミナルをterminalKeyで分離する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'window-session-1', {
			activeWs: 'repo-a',
			workspaces: [{ id: 'repo-a', name: 'A' }],
			terminals: [{ terminalKey: 'terminal-a', id: 1, title: 'Codex A', ws: 'repo-a' }],
		});
		registry.syncWindow(2, 'window-session-2', {
			activeWs: 'repo-b',
			workspaces: [{ id: 'repo-b', name: 'B' }],
			terminals: [{ terminalKey: 'terminal-b', id: 1, title: 'Codex B', ws: 'repo-b' }],
		});

		assert.deepStrictEqual(registry.ownerOf('terminal-a'), { windowId: 1, windowSession: 'window-session-1', terminalId: 1 });
		assert.deepStrictEqual(registry.ownerOf('terminal-b'), { windowId: 2, windowSession: 'window-session-2', terminalId: 1 });
		assert.deepStrictEqual(registry.desktopState().terminals.map(terminal => terminal.terminalKey), ['terminal-a', 'terminal-b']);
	});

	test('交代済みRenderer sessionからの解除を無視する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'old-session', {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [{ terminalKey: 'terminal-key', id: 1, title: 'Before', ws: 'repo' }],
		});
		registry.syncWindow(1, 'new-session', {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [{ terminalKey: 'terminal-key', id: 8, title: 'After', ws: 'repo' }],
		});

		assert.strictEqual(registry.removeWindow(1, 'old-session'), false);
		assert.deepStrictEqual(registry.ownerOf('terminal-key'), { windowId: 1, windowSession: 'new-session', terminalId: 8 });
	});

	test('同じterminalKeyが複数ウィンドウに現れた場合はルーティングしない', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		for (const windowId of [1, 2]) {
			registry.syncWindow(windowId, `session-${windowId}`, {
				activeWs: `repo-${windowId}`,
				workspaces: [{ id: `repo-${windowId}`, name: `Repo ${windowId}` }],
				terminals: [{ terminalKey: 'duplicate-key', id: windowId, title: `Terminal ${windowId}`, ws: `repo-${windowId}` }],
			});
		}

		assert.strictEqual(registry.ownerOf('duplicate-key'), undefined);
		assert.deepStrictEqual(registry.conflictingTerminalKeys(), ['duplicate-key']);
		assert.deepStrictEqual(registry.desktopState().terminals, []);

		assert.strictEqual(registry.removeWindow(2, 'session-2'), true);
		assert.deepStrictEqual(registry.ownerOf('duplicate-key'), { windowId: 1, windowSession: 'session-1', terminalId: 1 });
		assert.deepStrictEqual(registry.desktopState().terminals.map(terminal => terminal.terminalKey), ['duplicate-key']);
	});

	test('登録済みウィンドウだけを作成先として公開する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(3, 'session', { activeWs: undefined, workspaces: [], terminals: [] });

		assert.strictEqual(registry.hasWindow(3), true);
		assert.strictEqual(registry.hasWindow(4), false);
	});

	test('状態変更ごとにrevisionを増やしdesktopEpochを維持する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		const before = registry.desktopState();
		registry.syncWindow(1, 'session', { activeWs: undefined, workspaces: [], terminals: [] });
		const after = registry.desktopState();

		assert.strictEqual(before.desktopEpoch, 'desktop-epoch');
		assert.strictEqual(after.desktopEpoch, 'desktop-epoch');
		assert.strictEqual(after.revision, before.revision + 1);
	});
});

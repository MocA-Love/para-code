/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMobileWindowRoute } from '../../common/paradisMobileRelay.js';
import { ParadisMobileTerminalRegistry } from '../../node/paradisMobileTerminalRegistry.js';

suite('ParadisMobileTerminalRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('同じ数値IDを持つ別ウィンドウのターミナルをterminalKeyで分離する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'window-session-1', 1, {
			activeWs: 'repo-a',
			workspaces: [{ id: 'repo-a', name: 'A' }],
			terminals: [{ terminalKey: 'terminal-a', id: 1, title: 'Codex A', ws: 'repo-a' }],
		});
		registry.syncWindow(2, 'window-session-2', 2, {
			activeWs: 'repo-b',
			workspaces: [{ id: 'repo-b', name: 'B' }],
			terminals: [{ terminalKey: 'terminal-b', id: 1, title: 'Codex B', ws: 'repo-b' }],
		});

		assert.deepStrictEqual(registry.ownerOf('terminal-a'), { windowId: 1, windowSession: 'window-session-1', rendererGeneration: 1, terminalId: 1 });
		assert.deepStrictEqual(registry.ownerOf('terminal-b'), { windowId: 2, windowSession: 'window-session-2', rendererGeneration: 2, terminalId: 1 });
		assert.deepStrictEqual(registry.desktopState().terminals.map(terminal => terminal.terminalKey), ['terminal-a', 'terminal-b']);
	});

	test('交代済みRenderer sessionからの解除を無視する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'old-session', 1, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [{ terminalKey: 'terminal-key', id: 1, title: 'Before', ws: 'repo' }],
		});
		registry.syncWindow(1, 'new-session', 2, {
			activeWs: 'repo',
			workspaces: [{ id: 'repo', name: 'Repo' }],
			terminals: [{ terminalKey: 'terminal-key', id: 8, title: 'After', ws: 'repo' }],
		});

		assert.strictEqual(registry.removeWindow(1, 'old-session', 1), false);
		assert.deepStrictEqual(registry.ownerOf('terminal-key'), { windowId: 1, windowSession: 'new-session', rendererGeneration: 2, terminalId: 8 });
	});

	test('同じterminalKeyが複数ウィンドウに現れた場合はルーティングしない', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		for (const windowId of [1, 2]) {
			registry.syncWindow(windowId, `session-${windowId}`, windowId, {
				activeWs: `repo-${windowId}`,
				workspaces: [{ id: `repo-${windowId}`, name: `Repo ${windowId}` }],
				terminals: [{ terminalKey: 'duplicate-key', id: windowId, title: `Terminal ${windowId}`, ws: `repo-${windowId}` }],
			});
		}

		assert.strictEqual(registry.ownerOf('duplicate-key'), undefined);
		assert.deepStrictEqual(registry.conflictingTerminalKeys(), ['duplicate-key']);
		assert.deepStrictEqual(registry.desktopState().terminals, []);

		assert.strictEqual(registry.removeWindow(2, 'session-2', 2), true);
		assert.deepStrictEqual(registry.ownerOf('duplicate-key'), { windowId: 1, windowSession: 'session-1', rendererGeneration: 1, terminalId: 1 });
		assert.deepStrictEqual(registry.desktopState().terminals.map(terminal => terminal.terminalKey), ['duplicate-key']);
	});

	test('登録済みウィンドウだけを作成先として公開する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(3, 'session', 1, { activeWs: 'repo', workspaces: [{ id: 'repo', name: 'Repo' }], terminals: [] });

		assert.strictEqual(registry.hasWindow(3), true);
		assert.strictEqual(registry.hasWindow(4), false);
		assert.deepStrictEqual(registry.leaseOfWindow(3), { windowId: 3, windowSession: 'session', rendererGeneration: 1 });
		assert.deepStrictEqual(registry.ownerOfWorkspace(3, 'repo'), { windowId: 3, windowSession: 'session', rendererGeneration: 1 });
		assert.strictEqual(registry.ownerOfWorkspace(3, 'missing'), undefined);
	});

	test('交代済みRenderer sessionを現在のleaseとして返さない', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(3, 'old-session', 1, { activeWs: undefined, workspaces: [], terminals: [] });
		registry.syncWindow(3, 'new-session', 2, { activeWs: undefined, workspaces: [], terminals: [] });

		assert.deepStrictEqual(registry.leaseOfWindow(3), { windowId: 3, windowSession: 'new-session', rendererGeneration: 2 });
		assert.strictEqual(paradisMobileWindowRoute(3, 'new-session', 2), 'window:3:2:new-session');
	});

	test('状態変更ごとにrevisionを増やしdesktopEpochを維持する', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		const before = registry.desktopState();
		registry.syncWindow(1, 'session', 1, { activeWs: undefined, workspaces: [], terminals: [] });
		const after = registry.desktopState();

		assert.strictEqual(before.desktopEpoch, 'desktop-epoch');
		assert.strictEqual(after.desktopEpoch, 'desktop-epoch');
		assert.strictEqual(after.revision, before.revision + 1);
	});

	test('新Rendererの後から届いた旧Rendererの初回syncで世代を巻き戻さない', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'new-session', 2, {
			activeWs: undefined, workspaces: [], terminals: [{ terminalKey: 'new-terminal', id: 2, title: 'new' }],
		});
		registry.syncWindow(1, 'old-session', 1, {
			activeWs: undefined, workspaces: [], terminals: [{ terminalKey: 'old-terminal', id: 1, title: 'old' }],
		});

		assert.deepStrictEqual(registry.leaseOfWindow(1), { windowId: 1, windowSession: 'new-session', rendererGeneration: 2 });
		assert.strictEqual(registry.ownerOf('old-terminal'), undefined);
		assert.strictEqual(registry.ownerOf('new-terminal')?.rendererGeneration, 2);
	});

	test('active manifestの全leaseが同期済みの時だけdesktop stateをcompleteにする', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		assert.strictEqual(registry.isComplete(), true);
		registry.syncWindow(1, 'one', 1, { activeWs: undefined, workspaces: [], terminals: [] });
		const manifest = {
			revision: 1, entries: [
				{ windowId: 1, windowSession: 'one', rendererGeneration: 1, windowRevision: 1, claimed: true },
				{ windowId: 2, windowSession: 'two', rendererGeneration: 2, windowRevision: 1, claimed: true },
			]
		};

		registry.reconcile(manifest);
		assert.strictEqual(registry.desktopState().complete, false);
		registry.syncWindow(2, 'two', 2, { activeWs: undefined, workspaces: [], terminals: [] });
		assert.strictEqual(registry.desktopState().complete, true);
		assert.deepStrictEqual(registry.desktopState().renderers, [
			{ windowId: 1, rendererGeneration: 1, ready: true },
			{ windowId: 2, rendererGeneration: 2, ready: true },
		]);
	});

	test('pending Rendererをcompleteに数えず古いmanifestで新stateを除去しない', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		const validation = { valid: true, manifestRevision: 3, windowRevision: 3 };
		registry.syncWindow(1, 'new', 2, { activeWs: undefined, workspaces: [], terminals: [] }, validation);
		registry.reconcile({ revision: 2, entries: [{ windowId: 1, rendererGeneration: 1, windowRevision: 2, claimed: false }] });
		assert.deepStrictEqual(registry.leaseOfWindow(1), { windowId: 1, windowSession: 'new', rendererGeneration: 2 });

		registry.reconcile({ revision: 4, entries: [{ windowId: 1, rendererGeneration: 3, windowRevision: 4, claimed: false }] });
		assert.strictEqual(registry.leaseOfWindow(1), undefined);
		assert.strictEqual(registry.desktopState().complete, false);
		assert.deepStrictEqual(registry.desktopState().renderers, [{ windowId: 1, rendererGeneration: 3, ready: false }]);
	});

	test('最後のwindow破棄後は空のcomplete stateでモバイルの旧状態を削除できる', () => {
		const registry = new ParadisMobileTerminalRegistry('desktop-epoch');
		registry.syncWindow(1, 'closed', 1, {
			activeWs: undefined,
			workspaces: [],
			terminals: [{ terminalKey: 'closed-terminal', id: 1, title: 'closed' }],
		});

		const removed = registry.reconcile({ revision: 1, entries: [] });
		assert.deepStrictEqual(removed, [{ windowId: 1, windowSession: 'closed', rendererGeneration: 1 }]);
		assert.strictEqual(registry.desktopState().complete, true);
		assert.deepStrictEqual(registry.desktopState().terminals, []);
	});
});

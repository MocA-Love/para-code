/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisFreezableBrowserView, IParadisFreezeTimer, ParadisBrowserViewFreezer, paradisSetExtensionDebuggerAttached, paradisThawBrowserView } from '../../electron-main/paradisBrowserViewFreezer.js';

class FakeTimer implements IParadisFreezeTimer {
	private next = 1;
	readonly pending = new Map<number, () => void>();
	set(callback: () => void): unknown {
		const handle = this.next++;
		this.pending.set(handle, callback);
		return handle;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	fireAll(): void {
		const callbacks = [...this.pending.values()];
		this.pending.clear();
		callbacks.forEach(callback => callback());
	}
}

suite('ParadisBrowserViewFreezer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(options: { visible?: boolean; audible?: boolean; held?: boolean; enabled?: boolean; notifications?: string; now?: () => number } = {}) {
		const disposables = store.add(new DisposableStore());
		const commands: string[] = [];
		const state = { visible: options.visible ?? true, audible: options.audible ?? false, held: options.held ?? false, enabled: options.enabled ?? true };
		const onDidChangeVisibility = disposables.add(new Emitter<{ visible: boolean }>());
		const onDidClose = disposables.add(new Emitter<void>());
		const onDidCreateBrowserView = disposables.add(new Emitter<{ info: { id: string } }>());
		const webContents = {
			isDestroyed: () => false,
			isCurrentlyAudible: () => state.audible,
			isDevToolsOpened: () => false,
			isBeingCaptured: () => false,
			getURL: () => 'https://chat.example.com/room/1',
		};
		const captures = { lastAt: undefined as number | undefined, listener: undefined as ((view: object) => void) | undefined };
		const view: IParadisFreezableBrowserView = {
			webContents,
			debugger: {
				sendCommandRaw: async (method: string, params?: unknown) => {
					commands.push(`${method} ${(params as { state: string }).state}`);
					return {};
				},
			},
			onDidChangeVisibility: onDidChangeVisibility.event,
			onDidClose: onDidClose.event,
			getState: () => ({ visible: state.visible }),
			session: { permissions: { serialize: () => ({ origins: options.notifications ? { [options.notifications]: { notifications: 'allow' } } : {} }) } },
		};
		const timer = new FakeTimer();
		const freezer = disposables.add(new ParadisBrowserViewFreezer(
			{ onDidCreateBrowserView: onDidCreateBrowserView.event, tryGetBrowserView: () => view },
			() => state.enabled, 1000, timer, () => state.held,
			() => captures.lastAt,
			listener => { captures.listener = listener; return () => captures.listener = undefined; },
			options.now ?? (() => 10_000_000),
		));
		onDidCreateBrowserView.fire({ info: { id: 'view-1' } });
		const setVisible = (visible: boolean) => {
			state.visible = visible;
			onDidChangeVisibility.fire({ visible });
		};
		return { commands, state, timer, freezer, view, setVisible, close: () => onDidClose.fire(), captures };
	}

	test('freezes a tab hidden for the delay and makes it active again as soon as it is shown', async () => {
		const { commands, timer, freezer, setVisible } = create();
		setVisible(false);
		timer.fireAll();
		await Promise.resolve();
		assert.strictEqual(freezer.frozenCount, 1);
		setVisible(true);
		await Promise.resolve();
		assert.deepStrictEqual({ commands, frozen: freezer.frozenCount, pending: timer.pending.size }, {
			commands: ['Page.setWebLifecycleState frozen', 'Page.setWebLifecycleState active'],
			frozen: 0,
			pending: 0,
		});
	});

	test('counts a tab opened in the background, and a tab shown again before the delay is not frozen', () => {
		const { commands, timer, setVisible } = create({ visible: false });
		assert.strictEqual(timer.pending.size, 1);
		setVisible(true);
		timer.fireAll();
		assert.deepStrictEqual(commands, []);
	});

	test('does not freeze a tab an agent holds, a tab playing sound, or any tab when the setting is off, and looks again later', async () => {
		for (const blocker of ['held', 'audible', 'enabled'] as const) {
			const { commands, state, timer, setVisible } = create();
			setVisible(false);
			if (blocker === 'enabled') {
				state.enabled = false;
			} else {
				state[blocker] = true;
			}
			timer.fireAll();
			assert.deepStrictEqual({ blocker, commands, pending: timer.pending.size }, { blocker, commands: [], pending: 1 });
			if (blocker === 'enabled') {
				state.enabled = true;
			} else {
				state[blocker] = false;
			}
			timer.fireAll();
			await Promise.resolve();
			assert.deepStrictEqual({ blocker, commands }, { blocker, commands: ['Page.setWebLifecycleState frozen'] });
		}
	});

	test('wakes a frozen tab when an agent takes it, and forgets a closed tab', async () => {
		const { commands, timer, freezer, view, setVisible, close } = create();
		setVisible(false);
		timer.fireAll();
		paradisThawBrowserView(view);
		await Promise.resolve();
		setVisible(false);
		close();
		timer.fireAll();
		assert.deepStrictEqual({ commands, frozen: freezer.frozenCount }, { commands: ['Page.setWebLifecycleState frozen', 'Page.setWebLifecycleState active'], frozen: 0 });
	});

	test('does not freeze a tab whose site may show notifications, or a tab captured recently (live window tile), and wakes a frozen tab before a capture', async () => {
		const notifying = create({ notifications: 'https://chat.example.com' });
		notifying.setVisible(false);
		notifying.timer.fireAll();
		const clock = { now: 10_000_000 };
		const watched = create({ now: () => clock.now });
		watched.setVisible(false);
		watched.captures.lastAt = clock.now; // the editor's placeholder shot at the moment it hides does not count
		clock.now += 30 * 60_000;
		watched.timer.fireAll();
		const hiddenShotOnly = watched.commands.length;
		watched.captures.listener?.(watched.view);
		await Promise.resolve();
		watched.commands.length = 0;
		watched.setVisible(true);
		watched.setVisible(false);
		watched.captures.lastAt = clock.now + 60_000; // a live window tile took it after it hid
		clock.now += 120_000;
		watched.timer.fireAll();
		const captured = create();
		captured.setVisible(false);
		captured.timer.fireAll();
		await Promise.resolve();
		captured.captures.listener?.(captured.view);
		await Promise.resolve();
		assert.deepStrictEqual({
			hiddenShotOnly,
			notifying: notifying.commands,
			watched: watched.commands,
			captured: captured.commands,
			capturedFrozen: captured.freezer.frozenCount,
			capturedPending: captured.timer.pending.size,
		}, {
			hiddenShotOnly: 1,
			notifying: [],
			watched: [],
			captured: ['Page.setWebLifecycleState frozen', 'Page.setWebLifecycleState active'],
			capturedFrozen: 0,
			capturedPending: 1,
		});
	});

	test('wakes a frozen tab when an extension attaches a debugger, and leaves it running until the extension detaches', async () => {
		const { commands, timer, view, setVisible } = create();
		setVisible(false);
		timer.fireAll();
		paradisSetExtensionDebuggerAttached(view.webContents, true);
		await Promise.resolve();
		setVisible(true);
		setVisible(false);
		timer.fireAll();
		const whileAttached = [...commands];
		paradisSetExtensionDebuggerAttached(view.webContents, false);
		timer.fireAll();
		await Promise.resolve();
		assert.deepStrictEqual({ whileAttached, after: commands.slice(whileAttached.length) }, {
			whileAttached: ['Page.setWebLifecycleState frozen', 'Page.setWebLifecycleState active'],
			after: ['Page.setWebLifecycleState frozen'],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisMenuBarReport, ParadisMenuBarRequest, PARADIS_MENU_BAR_ICON_SETTING, PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING } from '../../common/paradisMenuBar.js';
import { ParadisMenuBarAction, ParadisMenuBarMenuItem } from '../../common/paradisMenuBarModel.js';
import { IParadisMenuBarHost, IParadisMenuBarMenuHandlers, IParadisMenuBarTray, IParadisMenuBarWindow, IParadisMenuBarWindows, ParadisMenuBar } from '../../electron-main/paradisMenuBarMain.js';

/** 描き直しは次の周回（setImmediate）なので、それを待つ。 */
function flush(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}

class FakeTray implements IParadisMenuBarTray {
	title = '';
	items: readonly ParadisMenuBarMenuItem[] = [];
	handlers: IParadisMenuBarMenuHandlers | undefined;
	private destroyed = false;
	setImage(): void { }
	setTitle(title: string): void { this.title = title; }
	setToolTip(): void { }
	setMenu(items: readonly ParadisMenuBarMenuItem[], _plain: boolean, handlers: IParadisMenuBarMenuHandlers): void {
		this.items = items;
		this.handlers = handlers;
	}
	onClick(): void { }
	isDestroyed(): boolean { return this.destroyed; }
	destroy(): void { this.destroyed = true; }

	/** メニューの行の文字（区切りは '---'、サブメニューは名前だけ）。 */
	labels(): string[] {
		return this.items.map(item => item.kind === 'separator' ? '---' : item.label);
	}

	run(action: ParadisMenuBarAction): void {
		this.handlers!.run(action);
	}
}

class FakeHost implements IParadisMenuBarHost {
	readonly platform = 'macOS';
	tray: FakeTray | undefined;
	isDarkTheme(): boolean { return false; }
	onDidChangeTheme(): IDisposable { return { dispose() { } }; }
	createTray(): IParadisMenuBarTray {
		this.tray = new FakeTray();
		return this.tray;
	}
}

class FakeWindow implements IParadisMenuBarWindow {
	focused = 0;
	constructor(readonly id: number, readonly config: { readonly isSessionsWindow?: boolean } | undefined = {}) { }
	focus(): void { this.focused++; }
}

class FakeWindows implements IParadisMenuBarWindows {
	readonly countEmitter = new Emitter<{ readonly newCount: number }>();
	readonly onDidChangeWindowsCount = this.countEmitter.event;
	windows: FakeWindow[] = [];
	lastActive: FakeWindow | undefined;
	emptyWindowsOpened = 0;
	getWindows(): readonly IParadisMenuBarWindow[] { return this.windows; }
	getLastActiveWindow(): IParadisMenuBarWindow | undefined { return this.lastActive; }
	async openEmptyWindow(): Promise<unknown> {
		this.emptyWindowsOpened++;
		return [];
	}

	/** ウィンドウを閉じる（残すものを渡す）。 */
	close(remaining: FakeWindow[]): void {
		this.windows = remaining;
		this.lastActive = remaining[0];
		this.countEmitter.fire({ newCount: remaining.length });
	}
}

function report(revision: number, attention: number, working: number, usage?: { readonly percent: number; readonly fetchedAt: number }): IParadisMenuBarReport {
	return {
		inbox: {
			attentionCount: attention, blockingCount: attention, revision,
			items: Array.from({ length: attention }, (_, index) => ({ entryId: `e${index}`, kind: 'permission' as const, location: `space-${index}`, at: Date.now() })),
		},
		working,
		...(usage ? {
			usage: {
				key: 'local', remote: false, fetchedAt: usage.fetchedAt,
				accounts: [{ provider: 'claude' as const, key: 'claude|work', name: 'work', active: true, fiveHour: { percent: usage.percent }, fetchedAt: usage.fetchedAt }],
			},
		} : {}),
	};
}

suite('Paradis menu bar (main)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(): { menuBar: ParadisMenuBar; host: FakeHost; windows: FakeWindows } {
		const host = new FakeHost();
		const windows = new FakeWindows();
		const disposables = store.add(new DisposableStore());
		disposables.add(windows.countEmitter);
		const configuration = new TestConfigurationService({ [PARADIS_MENU_BAR_ICON_SETTING]: true, [PARADIS_MENU_BAR_MENU_WORKING_COUNT_SETTING]: true });
		const menuBar = disposables.add(new ParadisMenuBar(windows, configuration, new NullLogService(), host));
		return { menuBar, host, windows };
	}

	test('keeps the newest inbox and usage when windows report out of order', async () => {
		const { menuBar, host } = create();
		const now = Date.now();
		menuBar.update('window:1', report(2, 1, 0, { percent: 40, fetchedAt: now - 1000 }));
		// 別のウィンドウから、古い台帳と古い使用量が遅れて届く
		menuBar.update('window:2', report(1, 0, 0, { percent: 90, fetchedAt: now - 5000 }));
		await flush();
		assert.deepStrictEqual({ title: host.tray?.title, header: host.tray?.labels()[0] }, { title: 'C 40%', header: '要対応 1 件' });
	});

	test('forgets the panes of closed windows, and keeps the usage after the last window closes', async () => {
		const { menuBar, host, windows } = create();
		const first = new FakeWindow(1);
		const second = new FakeWindow(2);
		windows.windows = [first, second];
		menuBar.update('window:1', report(1, 1, 2, { percent: 40, fetchedAt: Date.now() }));
		menuBar.update('window:2', report(1, 1, 1));
		await flush();
		const before = host.tray!.labels()[0];
		windows.close([first]);
		await flush();
		const afterOne = host.tray!.labels()[0];
		windows.close([]);
		await flush();
		assert.deepStrictEqual({ before, afterOne, afterAll: host.tray!.labels().slice(0, 4), title: host.tray!.title }, {
			before: '要対応 1 件・作業中 3',
			afterOne: '要対応 1 件・作業中 2',
			// 要対応は台帳を読むウィンドウが無いので空にし、使用量は最後の値を残す
			afterAll: ['要対応はありません', '---', '使用量', 'Claude Code  work  5時間 40%・週 -'],
			title: 'C 40%',
		});
	});

	test('hands a click to the last normal window, or keeps it for the next window to report', async () => {
		const { menuBar, host, windows } = create();
		const requests: ParadisMenuBarRequest[] = [];
		const listener = menuBar.onDidRequest(request => requests.push(request));
		const sessions = new FakeWindow(5, { isSessionsWindow: true });
		const normal = new FakeWindow(7);
		windows.windows = [sessions, normal];
		windows.lastActive = sessions;
		menuBar.update('window:7', report(1, 0, 0));
		await flush();
		// Agent Sessions ウィンドウは受け手がいないので外す
		host.tray!.run('openSettings');
		const toNormal = { requests: [...requests], focused: normal.focused, opened: windows.emptyWindowsOpened };

		// 普通のウィンドウが無いときは、空のウィンドウを開いて、次に中身を送ってきたウィンドウへ頼む
		windows.windows = [sessions];
		host.tray!.run('openUsagePanel');
		const pending = menuBar.update('window:8', report(1, 0, 0));
		const afterwards = menuBar.update('window:8', report(1, 0, 0));
		listener.dispose();
		assert.deepStrictEqual({ toNormal, opened: windows.emptyWindowsOpened, fired: requests.length, pending, afterwards }, {
			toNormal: { requests: [{ type: 'openSettings', windowId: 7 }], focused: 1, opened: 0 },
			opened: 1,
			fired: 1,
			pending: { request: 'openUsagePanel' },
			afterwards: {},
		});
		await flush();
	});
});

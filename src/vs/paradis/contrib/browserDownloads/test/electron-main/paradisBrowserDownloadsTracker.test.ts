/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsOpenableDownload } from '../../common/paradisBrowserDownloads.js';
import { IParadisDownloadsShell, IParadisTrackedDownloadItem, ParadisBrowserDownloadsTracker } from '../../electron-main/paradisBrowserDownloadsTracker.js';

class FakeDownloadItem implements IParadisTrackedDownloadItem {
	state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing';
	received = 0;
	cancelled = 0;
	private readonly _listeners = new Map<string, (() => void)[]>();

	constructor(private readonly _filename: string, public savePath: string, private readonly _total = 100) { }

	getFilename(): string { return this._filename; }
	getSavePath(): string { return this.savePath; }
	getURL(): string { return `https://example.com/${this._filename}`; }
	getState() { return this.state; }
	getReceivedBytes(): number { return this.received; }
	getTotalBytes(): number { return this._total; }
	getStartTime(): number { return 1_000; }
	cancel(): void { this.cancelled++; }
	on(event: 'updated' | 'done', listener: () => void): unknown {
		const list = this._listeners.get(event) ?? [];
		list.push(listener);
		this._listeners.set(event, list);
		return this;
	}
	finish(state: 'completed' | 'cancelled' | 'interrupted'): void {
		this.state = state;
		for (const listener of this._listeners.get('done') ?? []) {
			listener();
		}
	}
}

function createShell(existing: ReadonlySet<string>) {
	const opened: string[] = [];
	const shown: string[] = [];
	const quarantined: string[] = [];
	const shell: IParadisDownloadsShell = {
		openPath: async path => { opened.push(path); return ''; },
		showItemInFolder: path => { shown.push(path); },
		exists: path => existing.has(path),
		ensureQuarantine: async path => { quarantined.push(path); },
	};
	return { shell, opened, shown, quarantined };
}

suite('ParadisBrowserDownloadsTracker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists downloads newest first and only opens finished files of an openable type', async () => {
		const { shell, opened, shown, quarantined } = createShell(new Set(['/dl/report.pdf', '/dl/setup.command', '/dl']));
		const tracker = store.add(new ParadisBrowserDownloadsTracker(shell, () => '/dl'));
		const report = new FakeDownloadItem('report.pdf', '/dl/report.pdf');
		const setup = new FakeDownloadItem('setup.command', '/dl/setup.command');
		tracker.track(report);
		tracker.track(setup);

		assert.strictEqual(await tracker.open('download-1'), false, 'a download still in progress must not open');
		report.finish('completed');
		setup.finish('completed');

		const items = await tracker.list();
		assert.deepStrictEqual(items.map(item => [item.id, item.filename, item.state, item.openable]), [
			['download-2', 'setup.command', 'completed', false],
			['download-1', 'report.pdf', 'completed', true],
		]);
		assert.strictEqual(await tracker.open('download-2'), false, 'types outside the allow list are never opened');
		assert.strictEqual(await tracker.open('download-1'), true);
		assert.strictEqual(await tracker.showInFolder('download-2'), true);
		assert.strictEqual(await tracker.open('download-99'), false);
		assert.strictEqual(await tracker.openDownloadsFolder(), true);
		assert.deepStrictEqual({ opened, shown, quarantined }, { opened: ['/dl/report.pdf', '/dl'], shown: ['/dl/setup.command'], quarantined: ['/dl/report.pdf', '/dl/setup.command'] });
	});

	test('cancels running items, keeps them until finished, and drops dialogs the user closed', async () => {
		const { shell } = createShell(new Set());
		const tracker = store.add(new ParadisBrowserDownloadsTracker(shell, () => '/dl'));
		const running = new FakeDownloadItem('a.zip', '/dl/a.zip');
		const dismissedDialog = new FakeDownloadItem('b.zip', '');
		tracker.track(running);
		tracker.track(dismissedDialog);

		await tracker.remove('download-1');
		await tracker.clearFinished();
		assert.strictEqual((await tracker.list()).length, 2, 'running downloads cannot be removed');

		await tracker.cancel('download-1');
		assert.strictEqual(running.cancelled, 1);
		running.finish('cancelled');
		dismissedDialog.finish('cancelled');
		assert.deepStrictEqual((await tracker.list()).map(item => [item.id, item.state]), [['download-1', 'cancelled']]);

		await tracker.clearFinished();
		assert.deepStrictEqual(await tracker.list(), []);
	});

	test('fires change events when downloads start and finish', async () => {
		const { shell } = createShell(new Set());
		const tracker = store.add(new ParadisBrowserDownloadsTracker(shell, () => '/dl'));
		const seen: string[][] = [];
		store.add(tracker.onDidChangeDownloads(items => seen.push(items.map(item => item.state))));
		const item = new FakeDownloadItem('a.txt', '/dl/a.txt');
		tracker.track(item);
		item.finish('interrupted');
		assert.deepStrictEqual(seen, [['progressing'], ['interrupted']]);
	});

	test('never opens a file downloaded in an agent-only session, even of an openable type', async () => {
		const { shell, opened } = createShell(new Set(['/dl/notes.pdf']));
		const tracker = store.add(new ParadisBrowserDownloadsTracker(shell, () => '/dl'));
		const item = new FakeDownloadItem('notes.pdf', '/dl/notes.pdf');
		tracker.track(item, { agentSession: true });
		item.finish('completed');
		const [listed] = await tracker.list();
		assert.deepStrictEqual([listed.fromAgentSession, listed.openable, await tracker.open(listed.id), opened], [true, true, false, []]);
	});

	test('only allow-listed types are openable', () => {
		assert.deepStrictEqual(
			['report.PDF', 'photo.jpeg', 'data.csv', 'archive.zip', 'Setup.EXE', 'tool.app', 'x.dmg', 'disk.iso', 'help.chm', 'page.html', 'image.svg', 'macro.docm', 'link.webloc', 'profile.mobileconfig', 'LICENSE', 'trailing.pdf. ', 'double.pdf.exe'].map(paradisIsOpenableDownload),
			[true, true, true, true, false, false, false, false, false, false, false, false, false, false, false, true, false],
		);
	});
});

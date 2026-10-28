/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { BrowserViewStorageScope, IBrowserViewLoadError } from '../../common/browserView.js';
import { IParaBrowserViewLoadStallReport, ParaBrowserViewLoadWatchdogWebContents, paraGetBrowserViewLoadStall, paraInstallBrowserViewLoadWatchdog, paraOnDidChangeBrowserViewLoadStall, paraRespondToBrowserViewLoadStall, paraSetBrowserViewLoadStallReporter } from '../../electron-main/paraBrowserViewLoadWatchdog.js';

const TIMEOUT_MS = 20;

type Listener = (...args: unknown[]) => void;

/** The handful of `WebContents` members the watchdog uses, driven by the test. */
class FakeWebContents {
	private readonly listeners = new Map<string, Listener[]>();
	loadingMainFrame = false;
	stops = 0;
	url = 'about:blank';

	on(event: string, listener: Listener): this {
		this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
		return this;
	}
	removeListener(event: string, listener: Listener): this {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter(candidate => candidate !== listener));
		return this;
	}
	isDestroyed(): boolean { return false; }
	isLoadingMainFrame(): boolean { return this.loadingMainFrame; }
	getURL(): string { return this.url; }
	getOSProcessId(): number { return 1; }
	stop(): void {
		this.stops++;
		this.loadingMainFrame = false;
		this.emit('did-fail-load', {}, -3, 'ERR_ABORTED', this.url, true);
		this.emit('did-stop-loading');
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
	navigate(url: string): void {
		this.loadingMainFrame = true;
		this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
		this.emit('did-start-loading');
	}
	commit(url: string): void {
		this.url = url;
		this.emit('did-navigate');
		this.loadingMainFrame = false;
		this.emit('did-finish-load');
		this.emit('did-stop-loading');
	}
}

suite('paraBrowserViewLoadWatchdog', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let reports: Pick<IParaBrowserViewLoadStallReport, 'outcome' | 'waits' | 'agentTab' | 'remoteAuthority' | 'tunnelProxy' | 'sample'>[];
	let changes: { viewId: string; waits: number | undefined }[];
	let errors: Pick<IBrowserViewLoadError, 'url' | 'errorCode'>[];

	setup(() => {
		reports = [];
		changes = [];
		errors = [];
		paraSetBrowserViewLoadStallReporter({
			sample: () => ({ safe_main_rss_mb: 100 }),
			report: ({ outcome, waits, agentTab, remoteAuthority, tunnelProxy, sample }) => reports.push({ outcome, waits, agentTab, remoteAuthority, tunnelProxy, sample }),
		});
		store.add(paraOnDidChangeBrowserViewLoadStall(change => changes.push({ viewId: change.viewId, waits: change.stall?.waits })));
	});

	teardown(() => paraSetBrowserViewLoadStallReporter(undefined));

	function install(viewId: string, storageScope = BrowserViewStorageScope.Global): FakeWebContents {
		const webContents = new FakeWebContents();
		store.add(paraInstallBrowserViewLoadWatchdog(webContents as unknown as ParaBrowserViewLoadWatchdogWebContents, new NullLogService(), error => errors.push({ url: error.url, errorCode: error.errorCode }), {
			viewId,
			timeoutMs: TIMEOUT_MS,
			context: () => ({ remoteAuthority: 'ssh-remote+example', tunnelProxy: true, storageScope }),
		}));
		return webContents;
	}

	test('asks instead of stopping, waits on request, and stops with a timeout when told to', async () => {
		const webContents = install('view-1');
		webContents.navigate('http://localhost:3000/');
		await timeout(TIMEOUT_MS * 3);
		const asked = paraGetBrowserViewLoadStall('view-1');
		assert.ok(paraRespondToBrowserViewLoadStall('view-1', 'wait'));
		await timeout(TIMEOUT_MS * 3);
		assert.ok(paraRespondToBrowserViewLoadStall('view-1', 'stop'));

		assert.deepStrictEqual({
			askedWaits: asked?.waits,
			changes,
			stops: webContents.stops,
			errors,
			reports,
			stillAsking: paraGetBrowserViewLoadStall('view-1'),
			answerAfterStop: paraRespondToBrowserViewLoadStall('view-1', 'wait'),
		}, {
			askedWaits: 0,
			changes: [
				{ viewId: 'view-1', waits: 0 },
				{ viewId: 'view-1', waits: undefined },
				{ viewId: 'view-1', waits: 1 },
				{ viewId: 'view-1', waits: undefined },
			],
			stops: 1,
			errors: [{ url: 'http://localhost:3000/', errorCode: -7 }],
			reports: [{ outcome: 'stopped', waits: 1, agentTab: false, remoteAuthority: 'ssh-remote+example', tunnelProxy: true, sample: { safe_main_rss_mb: 100 } }],
			stillAsking: undefined,
			answerAfterStop: false,
		});
	});

	test('clears the question and reports when the server answers after all', async () => {
		const webContents = install('view-2');
		webContents.navigate('http://localhost:3000/');
		await timeout(TIMEOUT_MS * 3);
		webContents.commit('http://localhost:3000/');

		assert.deepStrictEqual({ changes, stops: webContents.stops, errors, outcomes: reports.map(report => report.outcome) }, {
			changes: [{ viewId: 'view-2', waits: 0 }, { viewId: 'view-2', waits: undefined }],
			stops: 0,
			errors: [],
			outcomes: ['responded'],
		});
	});

	test('stops an agent-only tab without asking', async () => {
		const webContents = install('view-3', BrowserViewStorageScope.Agent);
		webContents.navigate('https://example.com/');
		await timeout(TIMEOUT_MS * 3);

		assert.deepStrictEqual({ changes, stops: webContents.stops, errors, outcomes: reports.map(report => `${report.outcome}:${report.agentTab}`) }, {
			changes: [],
			stops: 1,
			errors: [{ url: 'https://example.com/', errorCode: -7 }],
			outcomes: ['agent-stopped:true'],
		});
	});

	test('a load that commits in time is neither asked about nor reported', async () => {
		const webContents = install('view-4');
		webContents.navigate('https://example.com/');
		webContents.commit('https://example.com/');
		await timeout(TIMEOUT_MS * 3);

		assert.deepStrictEqual({ changes, stops: webContents.stops, errors, reports }, { changes: [], stops: 0, errors: [], reports: [] });
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import type { WebContents } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paraBrowserViewEmulationParams, paraBrowserViewScalesByZoom, paraSetBrowserViewEmulationZoom, paraSetBrowserViewUserZoom, paraCreateBrowserZoomHelperForTest, paraSetBrowserZoomIsolatorForTest } from '../../electron-main/paraBrowserViewZoom.js';

/** A tab whose zoom is either per site (shared by every tab on it) or, once isolated, its own until the next navigation. */
class FakeTab extends EventEmitter {
	readonly zoomCalls: { readonly factor: number; readonly isolated: boolean }[] = [];
	isolated = false;
	readonly session = {};
	readonly id = 7;
	isDestroyed(): boolean { return false; }
	setZoomFactor(factor: number): void { this.zoomCalls.push({ factor, isolated: this.isolated }); }
	navigate(): void {
		this.isolated = false;
		this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
		this.emit('did-navigate');
	}
	startDownload(): void {
		// a navigation that ends in a download (or a 204, or is cancelled) never commits: no did-navigate, no did-fail-load
		this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
	}
	failLoad(): void {
		this.isolated = false;
		this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
		this.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/', true);
	}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

suite('paraBrowserViewZoom', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let isolationWorks = true;
	let hold: Promise<void> | undefined;
	setup(() => {
		isolationWorks = true;
		hold = undefined;
		paraSetBrowserZoomIsolatorForTest({
			isolate: async webContents => {
				await hold;
				(webContents as unknown as FakeTab).isolated = isolationWorks;
				return isolationWorks;
			},
		});
	});
	teardown(() => paraSetBrowserZoomIsolatorForTest(undefined));

	const request = (tab: FakeTab, pageScale: number, onReady: () => void = () => { }) => paraBrowserViewEmulationParams(tab as unknown as WebContents, {
		width: 1920, height: 1080, pageScale, mobile: false, deviceScaleFactor: 2, onReady,
	});

	test('a fixed size is shrunk by the emulation scale until the tab is isolated, then by its own zoom with a full devicePixelRatio', async () => {
		const tab = new FakeTab();
		let ready = 0;
		const before = request(tab, 0.5, () => ready++);
		await flush();
		const after = request(tab, 0.5);
		await flush();
		assert.deepStrictEqual({
			before: [before.scale, before.viewSize],
			ready,
			after: [after.scale, after.viewSize, after.screenSize, after.deviceScaleFactor],
			scalesByZoom: paraBrowserViewScalesByZoom(tab as unknown as WebContents),
			zoom: tab.zoomCalls.at(-1),
		}, {
			before: [0.5, { width: 1920, height: 1080 }],
			ready: 1,
			// The page still lays out at 1920 x 1080 CSS px; the view is 960 x 540 and the page devicePixelRatio stays 2.
			after: [1, { width: 960, height: 540 }, { width: 1920, height: 1080 }, 4],
			scalesByZoom: true,
			zoom: { factor: 0.5, isolated: true },
		});
	});

	test('a size that fits needs no shrinking, and going back to the editor size or switching sizes does not stack factors', async () => {
		const tab = new FakeTab();
		request(tab, 0.5);
		await flush();
		request(tab, 0.5);
		await flush();
		request(tab, 0.75);
		await flush();
		const fits = request(tab, 1);
		await flush();
		const afterFit = tab.zoomCalls.at(-1);
		request(tab, 0.5);
		await flush();
		paraSetBrowserViewEmulationZoom(tab as unknown as WebContents, 1);
		assert.deepStrictEqual({ fits: [fits.scale, fits.viewSize], afterFit, back: tab.zoomCalls.at(-1), scalesByZoom: paraBrowserViewScalesByZoom(tab as unknown as WebContents) }, {
			fits: [1, { width: 1920, height: 1080 }],
			afterFit: { factor: 1, isolated: true },
			back: { factor: 1, isolated: true },
			scalesByZoom: false,
		});
	});

	test('the user zoom multiplies with the shrink, stays on the tab, and is isolated again after a navigation before it is set', async () => {
		const tab = new FakeTab();
		paraSetBrowserViewUserZoom(tab as unknown as WebContents, 1.25);
		await flush();
		request(tab, 0.5);
		await flush();
		request(tab, 0.5);
		await flush();
		const combined = tab.zoomCalls.at(-1);
		tab.navigate();
		// browserView.ts re-applies its stored zoom on did-navigate: it waits for the new document to be isolated
		paraSetBrowserViewUserZoom(tab as unknown as WebContents, 1.25);
		await flush();
		assert.deepStrictEqual({ combined, afterNavigation: tab.zoomCalls.at(-1), everyNonDefaultZoomWasIsolated: tab.zoomCalls.every(call => call.isolated || call.factor === 1) }, {
			combined: { factor: 0.625, isolated: true },
			afterNavigation: { factor: 0.625, isolated: true },
			everyNonDefaultZoomWasIsolated: true,
		});
	});

	test('when the tab cannot be isolated, the fixed size keeps the emulation scale and the user zoom stays per site as before', async () => {
		isolationWorks = false;
		const tab = new FakeTab();
		const params = request(tab, 0.5);
		await flush();
		paraSetBrowserViewUserZoom(tab as unknown as WebContents, 1.25);
		await flush();
		assert.deepStrictEqual({ scale: params.scale, again: request(tab, 0.5).scale, zoom: tab.zoomCalls, scalesByZoom: paraBrowserViewScalesByZoom(tab as unknown as WebContents) }, {
			scale: 0.5,
			again: 0.5,
			zoom: [{ factor: 1.25, isolated: false }],
			scalesByZoom: false,
		});
	});
	test('an isolation that a navigation overtook sets nothing, so a user zoom never lands on the whole site', async () => {
		const tab = new FakeTab();
		let release: () => void = () => { };
		hold = new Promise(resolve => release = resolve);
		paraSetBrowserViewUserZoom(tab as unknown as WebContents, 1.25);
		tab.navigate();
		release();
		await flush();
		// the re-apply after the navigation isolates the new document first
		hold = undefined;
		paraSetBrowserViewUserZoom(tab as unknown as WebContents, 1.25);
		await flush();
		// nothing was set at the site's level, and the zoom reached the new document once it was isolated
		assert.deepStrictEqual({ calls: [...new Set(tab.zoomCalls.map(call => JSON.stringify(call)))] }, { calls: ['{"factor":1.25,"isolated":true}'] });
	});

	test('a navigation that ends on an error page drops the isolation and isolates the tab again before re-applying', async () => {
		const tab = new FakeTab();
		request(tab, 0.5);
		await flush();
		request(tab, 0.5);
		await flush();
		tab.failLoad();
		const scalesWhileReisolating = paraBrowserViewScalesByZoom(tab as unknown as WebContents);
		await flush();
		assert.deepStrictEqual({ scalesWhileReisolating, last: tab.zoomCalls.at(-1), scalesAfter: paraBrowserViewScalesByZoom(tab as unknown as WebContents) }, {
			scalesWhileReisolating: false,
			last: { factor: 0.5, isolated: true },
			scalesAfter: true,
		});
	});
	test('a navigation that never commits (a download) keeps the tab isolated, so the reported scale matches the shrunk page', async () => {
		const tab = new FakeTab();
		request(tab, 0.5);
		await flush();
		request(tab, 0.5);
		await flush();
		const calls = tab.zoomCalls.length;
		tab.startDownload();
		await flush();
		assert.deepStrictEqual({ scalesByZoom: paraBrowserViewScalesByZoom(tab as unknown as WebContents), newCalls: tab.zoomCalls.length - calls, params: request(tab, 0.5).scale }, {
			scalesByZoom: true,
			newCalls: 0,
			params: 1,
		});
	});
	test('the zoom helper opens its page again when the page it kept was destroyed, and reports why it could not isolate', async () => {
		const opened: { destroyed: boolean; disposed: boolean }[] = [];
		let openWorks = true;
		const helper = paraCreateBrowserZoomHelperForTest(async () => {
			if (!openWorks) {
				return undefined;
			}
			const page = { destroyed: false, disposed: false };
			opened.push(page);
			return {
				contents: { isDestroyed: () => page.destroyed, executeJavaScript: async () => true } as unknown as Pick<WebContents, 'isDestroyed' | 'executeJavaScript'>,
				dispose: () => { page.disposed = true; },
			};
		});
		const tab = new FakeTab() as unknown as WebContents;
		const first = await helper.isolate(tab);
		// the page went away between two navigations (garbage collected view, crashed extension process)
		opened[0].destroyed = true;
		const second = await helper.isolate(tab);
		opened[1].destroyed = true;
		openWorks = false;
		const third = await helper.isolate(tab);
		assert.deepStrictEqual({ first, second, third, pages: opened }, {
			first: true,
			second: true,
			third: 'the zoom helper page is not open',
			pages: [{ destroyed: true, disposed: true }, { destroyed: true, disposed: true }],
		});
	});
});

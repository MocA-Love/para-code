/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { EventEmitter } from 'events';
import type { WebContents } from 'electron';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { paraBrowserViewEmulationParams, paraBrowserViewScalesByZoom, paraSetBrowserViewEmulationZoom, paraSetBrowserViewUserZoom, paraSetBrowserZoomIsolatorForTest } from '../../electron-main/paraBrowserViewZoom.js';

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
		this.emit('did-navigate');
	}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

suite('paraBrowserViewZoom', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let isolations = 0;
	let isolationWorks = true;
	setup(() => {
		isolations = 0;
		isolationWorks = true;
		paraSetBrowserZoomIsolatorForTest({
			isolate: async webContents => {
				isolations++;
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
});

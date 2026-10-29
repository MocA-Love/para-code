/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDeniesExtensionWindowOpen } from '../../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { ParadisGuardedWebContents, paradisGuardChildWebContents, paradisSetExtensionNavigationGuard } from '../../electron-main/paradisExtensionNavigationGuard.js';

const EXTENSION_PAGE = 'chrome-extension://aeblfdkhhhdcdjpifhhbdiojplfjncoa/options.html';

/** The events and calls of the webContents the guard uses. */
class FakeWebContents extends EventEmitter {
	stops = 0;
	destroyed = false;
	stop(): void { this.stops++; }
	isDestroyed(): boolean { return this.destroyed; }
}

suite('paradisExtensionNavigationGuard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('cancels moves to extension pages only while an agent holds the tab, and stops navigations it cannot cancel', () => {
		const contents = new FakeWebContents();
		const scheduled: Array<() => void> = [];
		let notified = 0;
		let now = 0;
		const guard = (held: boolean) => paradisSetExtensionNavigationGuard(contents as unknown as ParadisGuardedWebContents, held, { schedule: callback => scheduled.push(callback), onBlocked: () => notified++, now: () => now });
		const cancellable = (event: string, url: string) => {
			let prevented = false;
			contents.emit(event, { url, preventDefault: () => { prevented = true; } });
			return prevented;
		};
		const started = (url: string, isSameDocument = false, isMainFrame = true) => {
			contents.emit('did-start-navigation', { url, isSameDocument, isMainFrame });
			const count = scheduled.length;
			scheduled.splice(0).forEach(callback => callback());
			return count;
		};

		const beforeHeld = [cancellable('will-frame-navigate', EXTENSION_PAGE), started(EXTENSION_PAGE)];
		guard(true);
		guard(true); // Listeners are installed once.
		const whileHeld = [
			cancellable('will-frame-navigate', EXTENSION_PAGE),
			cancellable('will-frame-navigate', 'https://example.test/'),
			cancellable('will-redirect', `BLOB:${EXTENSION_PAGE}`),
			started(EXTENSION_PAGE),
			started('https://example.test/'),
			started(EXTENSION_PAGE, true),
			// An iframe is cancelled by will-frame-navigate; stopping the whole tab would also fail its images.
			started(EXTENSION_PAGE, false, false),
		];
		const notifiedWhileHeld = notified;
		now = 10_000;
		cancellable('will-frame-navigate', EXTENSION_PAGE);
		const notifiedAfterInterval = notified;
		contents.emit('did-redirect-navigation', { url: EXTENSION_PAGE });
		contents.destroyed = true;
		scheduled.splice(0).forEach(callback => callback());
		contents.destroyed = false;
		guard(false);
		const afterRelease = [cancellable('will-frame-navigate', EXTENSION_PAGE), started(EXTENSION_PAGE)];
		assert.deepStrictEqual({ beforeHeld, whileHeld, notified: [notifiedWhileHeld, notifiedAfterInterval], afterRelease, stops: contents.stops, listeners: contents.listenerCount('will-frame-navigate') }, {
			beforeHeld: [false, 0],
			whileHeld: [true, false, true, 1, 0, 0, 0],
			// Notified once for the burst, and again once the interval has passed.
			notified: [1, 2],
			afterRelease: [false, 0],
			// One stop for the started navigation; none for the redirect that arrived after the tab was destroyed.
			stops: 1,
			listeners: 1,
		});
	});
	test('guards a tab opened by a held tab from the moment it exists, and refuses window.open of extension pages', () => {
		const opener = new FakeWebContents();
		const child = new FakeWebContents();
		const stranger = new FakeWebContents();
		const blocked: string[] = [];
		const scheduled: Array<() => void> = [];
		const deniedBeforeHold = paradisDeniesExtensionWindowOpen(opener, EXTENSION_PAGE);
		paradisSetExtensionNavigationGuard(opener as unknown as ParadisGuardedWebContents, true, { schedule: callback => scheduled.push(callback), onBlocked: () => blocked.push('opener') });
		paradisGuardChildWebContents(child as unknown as ParadisGuardedWebContents, opener, { schedule: callback => scheduled.push(callback), onBlocked: () => blocked.push('child') });
		paradisGuardChildWebContents(stranger as unknown as ParadisGuardedWebContents, new FakeWebContents(), { schedule: callback => scheduled.push(callback) });
		// A web page that redirects the new tab to an extension page.
		let prevented = false;
		child.emit('will-redirect', { url: EXTENSION_PAGE, preventDefault: () => { prevented = true; } });
		stranger.emit('did-start-navigation', { url: EXTENSION_PAGE, isMainFrame: true });
		scheduled.splice(0).forEach(callback => callback());
		assert.deepStrictEqual({
			deniedBeforeHold,
			denied: [paradisDeniesExtensionWindowOpen(opener, `${EXTENSION_PAGE}?popup`), paradisDeniesExtensionWindowOpen(opener, 'https://example.test/'), paradisDeniesExtensionWindowOpen(stranger, EXTENSION_PAGE)],
			childPrevented: prevented,
			blocked,
			strangerStops: stranger.stops,
		}, {
			deniedBeforeHold: false,
			denied: [true, false, false],
			childPrevented: true,
			blocked: ['child', 'opener'],
			strangerStops: 0,
		});
	});
});

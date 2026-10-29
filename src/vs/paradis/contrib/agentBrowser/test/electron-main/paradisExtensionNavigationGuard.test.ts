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
		const cancellable = (event: string, url: string, isMainFrame = true) => {
			let prevented = false;
			contents.emit(event, { url, isMainFrame, preventDefault: () => { prevented = true; } });
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
		// An extension's in-page iframe is cancelled without telling the user.
		const iframeCancelled = cancellable('will-frame-navigate', EXTENSION_PAGE, false);
		const notifiedForIframe = notified;
		cancellable('will-frame-navigate', EXTENSION_PAGE);
		const notifiedAfterInterval = notified;
		contents.emit('did-redirect-navigation', { url: EXTENSION_PAGE });
		contents.destroyed = true;
		scheduled.splice(0).forEach(callback => callback());
		contents.destroyed = false;
		guard(false);
		const afterRelease = [cancellable('will-frame-navigate', EXTENSION_PAGE), started(EXTENSION_PAGE)];
		assert.deepStrictEqual({ beforeHeld, whileHeld, iframe: [iframeCancelled, notifiedForIframe], notified: [notifiedWhileHeld, notifiedAfterInterval], afterRelease, stops: contents.stops, listeners: contents.listenerCount('will-frame-navigate') }, {
			beforeHeld: [false, 0],
			whileHeld: [true, false, true, 1, 0, 0, 0],
			iframe: [true, 1],
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
	test('lets go of a new tab the agent never received, when its opener is released or after the grace period, and of the tabs it opened', () => {
		const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
		const startTimer = (callback: () => void) => {
			const timer = { callback, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		};
		const fire = () => timers.splice(0).forEach(timer => { if (!timer.cancelled) { timer.callback(); } });
		const options = { startTimer, schedule: () => { } };
		const guarded = (contents: FakeWebContents) => paradisDeniesExtensionWindowOpen(contents, EXTENSION_PAGE);

		// 1. The opener is released before the agent ever received the child (or the grandchild it opened).
		const opener = new FakeWebContents();
		const child = new FakeWebContents();
		const grandchild = new FakeWebContents();
		paradisSetExtensionNavigationGuard(opener as unknown as ParadisGuardedWebContents, true, options);
		paradisGuardChildWebContents(child as unknown as ParadisGuardedWebContents, opener, options);
		paradisGuardChildWebContents(grandchild as unknown as ParadisGuardedWebContents, child, options);
		const beforeRelease = [guarded(child), guarded(grandchild)];
		paradisSetExtensionNavigationGuard(opener as unknown as ParadisGuardedWebContents, false, options);
		const afterOpenerRelease = [guarded(opener), guarded(child), guarded(grandchild)];
		timers.length = 0;

		// 2. The grace period passes without the agent receiving the child.
		const opener2 = new FakeWebContents();
		const late = new FakeWebContents();
		paradisSetExtensionNavigationGuard(opener2 as unknown as ParadisGuardedWebContents, true, options);
		paradisGuardChildWebContents(late as unknown as ParadisGuardedWebContents, opener2, options);
		fire();
		const afterGrace = [guarded(opener2), guarded(late)];

		// 3. The agent receives the child in time: it stays guarded until the child itself is released.
		const granted = new FakeWebContents();
		paradisGuardChildWebContents(granted as unknown as ParadisGuardedWebContents, opener2, options);
		paradisSetExtensionNavigationGuard(granted as unknown as ParadisGuardedWebContents, true, options);
		fire();
		paradisSetExtensionNavigationGuard(opener2 as unknown as ParadisGuardedWebContents, false, options);
		const grantedAfter = guarded(granted);
		paradisSetExtensionNavigationGuard(granted as unknown as ParadisGuardedWebContents, false, options);

		assert.deepStrictEqual({ beforeRelease, afterOpenerRelease, afterGrace, grantedAfter, grantedReleased: guarded(granted) }, {
			beforeRelease: [true, true],
			afterOpenerRelease: [false, false, false],
			afterGrace: [true, false],
			grantedAfter: true,
			grantedReleased: false,
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
import assert from 'assert';
import { EventEmitter } from 'events';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisGuardedWebContents, paradisSetExtensionNavigationGuard } from '../../electron-main/paradisExtensionNavigationGuard.js';

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
		const guard = (held: boolean) => paradisSetExtensionNavigationGuard(contents as unknown as ParadisGuardedWebContents, held, callback => scheduled.push(callback));
		const cancellable = (event: string, url: string) => {
			let prevented = false;
			contents.emit(event, { url, preventDefault: () => { prevented = true; } });
			return prevented;
		};
		const started = (url: string, isSameDocument = false) => {
			contents.emit('did-start-navigation', { url, isSameDocument });
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
		];
		contents.emit('did-redirect-navigation', { url: EXTENSION_PAGE });
		contents.destroyed = true;
		scheduled.splice(0).forEach(callback => callback());
		contents.destroyed = false;
		guard(false);
		const afterRelease = [cancellable('will-frame-navigate', EXTENSION_PAGE), started(EXTENSION_PAGE)];
		assert.deepStrictEqual({ beforeHeld, whileHeld, afterRelease, stops: contents.stops, listeners: contents.listenerCount('will-frame-navigate') }, {
			beforeHeld: [false, 0],
			whileHeld: [true, false, true, 1, 0, 0],
			afterRelease: [false, 0],
			// One stop for the started navigation; none for the redirect that arrived after the tab was destroyed.
			stops: 1,
			listeners: 1,
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPowerSaveBlocker, ParadisKeepAwakeBlockerRegistry, ParadisPowerSaveBlockerType } from '../../common/paradisKeepAwakeBlockers.js';

class TestBlocker implements IParadisPowerSaveBlocker {
	private nextId = 1;
	readonly active = new Set<number>();

	start(_type: ParadisPowerSaveBlockerType): number {
		const id = this.nextId++;
		this.active.add(id);
		return id;
	}

	stop(id: number): boolean {
		return this.active.delete(id);
	}
}

suite('ParadisKeepAwakeBlockerRegistry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('stops only the blockers of the window that reloaded or closed, and never those of another window', () => {
		const blocker = new TestBlocker();
		const registry = new ParadisKeepAwakeBlockerRegistry(blocker);
		const first = registry.start('window:1', 'prevent-app-suspension');
		const second = registry.start('window:1', 'prevent-display-sleep');
		const other = registry.start('window:2', 'prevent-app-suspension');

		const stoppedByOtherWindow = registry.stop('window:2', first);
		const stoppedByOwner = registry.stop('window:1', first);
		// window:1 が再読み込みした（新しい renderer は古い id を知らない）
		const released = registry.release('window:1');
		const releasedAgain = registry.release('window:1');

		assert.deepStrictEqual({ stoppedByOtherWindow, stoppedByOwner, released, releasedAgain, active: [...blocker.active] }, {
			stoppedByOtherWindow: false,
			stoppedByOwner: true,
			released: [second],
			releasedAgain: [],
			active: [other],
		});
	});

	test('releases every window when main shuts the registry down', () => {
		const blocker = new TestBlocker();
		const registry = new ParadisKeepAwakeBlockerRegistry(blocker);
		registry.start('window:1', 'prevent-app-suspension');
		registry.start('window:2', 'prevent-display-sleep');
		registry.releaseAll();
		assert.deepStrictEqual([...blocker.active], []);
	});
});

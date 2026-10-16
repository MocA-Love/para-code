/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisReviveGate } from '../../common/paradisReviveGate.js';

suite('ParadisReviveGate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** 時計と setTimeout を手で進める。 */
	function manualClock() {
		let now = 0;
		const timers: { at: number; callback: () => void }[] = [];
		return {
			now: () => now,
			setTimeout: (callback: () => void, ms: number) => { timers.push({ at: now + ms, callback }); },
			advance(ms: number) {
				now += ms;
				for (const timer of timers.splice(0)) {
					if (timer.at <= now) {
						timer.callback();
					} else {
						timers.push(timer);
					}
				}
			},
		};
	}

	test('an editor tab that asks before the startup revive is done gets the revived pty, not its old id', async () => {
		// PC を再起動した直後の順番の再現: タブの繋ぎ直しが先に始まり、保存した画面の起こし直しが後から済む
		const clock = manualClock();
		const gate = new ParadisReviveGate(10_000, clock.now, clock.setTimeout);
		const revivedIdByOldId = new Map<number, number>();
		const attached: number[] = [];
		const attachToRevivedProcess = async (oldId: number) => {
			await gate.whenOpen();
			attached.push(revivedIdByOldId.get(oldId) ?? oldId);
		};

		const attaching = attachToRevivedProcess(55);
		await Promise.resolve();
		revivedIdByOldId.set(55, 6);
		gate.open();
		await attaching;

		assert.deepStrictEqual(attached, [6]);
	});

	test('opens even when the revive throws halfway, so editor tabs do not wait out the limit', async () => {
		const clock = manualClock();
		const gate = new ParadisReviveGate(10_000, clock.now, clock.setTimeout);
		const waiting = gate.whenOpen();

		const failure = await gate.openAfter(async () => { throw new Error('saved screens could not be read'); }).then(() => undefined, (error: Error) => error.message);

		assert.deepStrictEqual({ failure, timedOut: await waiting, isOpen: gate.isOpen }, { failure: 'saved screens could not be read', timedOut: false, isOpen: true });
	});

	test('opens by itself at the limit, and does not hold back callers after opening', async () => {
		const clock = manualClock();
		const neverRevived = new ParadisReviveGate(10_000, clock.now, clock.setTimeout);
		const waiting = neverRevived.whenOpen();
		clock.advance(10_000);
		const lateCaller = await neverRevived.whenOpen();

		const opened = new ParadisReviveGate(10_000, clock.now, clock.setTimeout);
		opened.open();
		opened.open();

		assert.deepStrictEqual({ timedOut: await waiting, lateCaller, afterOpen: await opened.whenOpen(), isOpen: opened.isOpen }, { timedOut: true, lateCaller: true, afterOpen: false, isOpen: true });
	});
});

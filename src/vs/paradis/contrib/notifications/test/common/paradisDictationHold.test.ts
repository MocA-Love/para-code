/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDictationHoldTimers, ParadisDictationHold } from '../../common/paradisDictationHold.js';

/** 手で進める時計。 */
class ManualTimers implements IParadisDictationHoldTimers {
	now = 0;
	private readonly pending = new Set<{ at: number; callback: () => void }>();

	set(callback: () => void, ms: number) {
		const timer = { at: this.now + ms, callback };
		this.pending.add(timer);
		return { dispose: () => this.pending.delete(timer) };
	}

	advance(ms: number): void {
		this.now += ms;
		for (const timer of [...this.pending].sort((a, b) => a.at - b.at)) {
			if (timer.at <= this.now && this.pending.delete(timer)) {
				timer.callback();
			}
		}
	}

	get size(): number {
		return this.pending.size;
	}
}

suite('Paradis dictation hold', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('holds while any window dictates and expires each window on its own', () => {
		const timers = new ManualTimers();
		const events: string[] = [];
		const hold = new ParadisDictationHold(held => events.push(`held:${held}`), client => events.push(`expired:${client}`), timers, 10);

		hold.set('window:1', true);
		timers.advance(9);
		hold.set('window:2', true);
		// window:1 だけが上限に達する。window:2 はまだ止めている
		timers.advance(1);
		const afterFirstExpiry = hold.held;
		// window:2 が状態の変化でもう一度知らせてくると、そこから数え直す
		timers.advance(5);
		hold.set('window:2', true);
		timers.advance(9);
		const beforeSecondExpiry = hold.held;
		timers.advance(1);
		// 再読み込みした window:1 が改めて音声入力を始め、終える
		hold.set('window:1', true);
		hold.set('window:1', false);
		hold.dispose();

		assert.deepStrictEqual({ events, afterFirstExpiry, beforeSecondExpiry, pendingTimers: timers.size }, {
			events: ['held:true', 'expired:window:1', 'expired:window:2', 'held:false', 'held:true', 'held:false'],
			afterFirstExpiry: true,
			beforeSecondExpiry: true,
			pendingTimers: 0,
		});
	});
});

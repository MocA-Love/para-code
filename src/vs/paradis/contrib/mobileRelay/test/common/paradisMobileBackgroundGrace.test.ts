/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_BACKGROUND_REPUSH_WINDOW_MS, PARADIS_BACKGROUND_SESSION_EXPIRY_MS, ParadisBackgroundSessionWatch, ParadisRecentTrustedNotifies } from '../../common/paradisMobileBackgroundGrace.js';

class ManualClock {
	now = 0;
	private next = 1;
	private readonly pending = new Map<number, { at: number; handler: () => void }>();
	setTimeout(handler: () => void, ms: number): unknown {
		const id = this.next++;
		this.pending.set(id, { at: this.now + ms, handler });
		return id;
	}
	clearTimeout(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	advance(ms: number): void {
		this.now += ms;
		for (const [id, timer] of [...this.pending]) {
			if (timer.at <= this.now) {
				this.pending.delete(id);
				timer.handler();
			}
		}
	}
	get size(): number {
		return this.pending.size;
	}
}

suite('paradisMobileBackgroundGrace (W2-34)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// iOS が裏のアプリを止めると、アプリの30秒のタイマーは動かない。PC 側の期限でセッションを捨てる。
	test('drops a backgrounded session that does not come back, but not one that does', () => {
		const clock = new ManualClock();
		const watch = new ParadisBackgroundSessionWatch(clock);
		const expired: string[] = [];
		watch.begin('gone', () => expired.push('gone'));
		watch.begin('back', () => expired.push('back'));
		clock.advance(10_000);
		watch.end('back');
		clock.advance(PARADIS_BACKGROUND_SESSION_EXPIRY_MS);
		// 張り直した期限は前の期限を捨てる
		watch.begin('again', () => expired.push('again-1'));
		watch.begin('again', () => expired.push('again-2'));
		clock.advance(PARADIS_BACKGROUND_SESSION_EXPIRY_MS);
		watch.begin('disposed', () => expired.push('disposed'));
		watch.dispose();
		clock.advance(PARADIS_BACKGROUND_SESSION_EXPIRY_MS);
		assert.deepStrictEqual({ expired, pending: clock.size, longerThanAppGrace: PARADIS_BACKGROUND_SESSION_EXPIRY_MS > 30_000 }, { expired: ['gone', 'again-2'], pending: 0, longerThanAppGrace: true });
	});

	test('keeps only the trusted notifications of the last few seconds for a re-push', () => {
		const recent = new ParadisRecentTrustedNotifies();
		const bytes = (text: string) => new TextEncoder().encode(text);
		recent.add('m1', bytes('old'), 0);
		recent.add('m1', bytes('new'), 5_000);
		recent.add('m2', bytes('other'), 5_000);
		const taken = recent.take('m1', 5_000 + PARADIS_BACKGROUND_REPUSH_WINDOW_MS).map(entry => new TextDecoder().decode(entry));
		assert.deepStrictEqual({ taken, again: recent.take('m1', 5_000).length, tooLate: recent.take('m2', 5_000 + PARADIS_BACKGROUND_REPUSH_WINDOW_MS + 1).length }, { taken: ['new'], again: 0, tooLate: 0 });
	});
});

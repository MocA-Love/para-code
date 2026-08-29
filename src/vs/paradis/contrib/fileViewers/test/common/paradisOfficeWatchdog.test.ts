/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_OFFICE_MAX_RENDER_TIMEOUT_MS,
	PARADIS_OFFICE_RENDER_TIMEOUT_MS,
	PARADIS_OFFICE_SOURCE_TIMEOUT_MS,
	ParadisOfficeRenderWatchdog,
	paradisOfficeRenderTimeout,
	type IParadisOfficeRenderTimeoutEvent,
} from '../../common/paradisOfficeWatchdog.js';

/** 実時間に依らずに時計を進めるための差し替え。`arm` が前の予約を捨てたかまで見える。 */
class FakeClock {

	private nextHandle = 1;
	private readonly pending = new Map<number, { readonly handler: () => void; readonly at: number }>();
	time = 0;

	readonly schedule = (handler: () => void, delay: number): number => {
		const handle = this.nextHandle++;
		this.pending.set(handle, { handler, at: this.time + delay });
		return handle;
	};

	readonly cancel = (handle: number): void => {
		this.pending.delete(handle);
	};

	readonly now = (): number => this.time;

	/** 予約されたまま残っている数。解き忘れ・二重予約はここに出る。 */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** `milliseconds` だけ進め、期限の来た予約を発火させる。 */
	advance(milliseconds: number): void {
		this.time += milliseconds;
		for (const [handle, entry] of [...this.pending]) {
			if (entry.at <= this.time) {
				this.pending.delete(handle);
				entry.handler();
			}
		}
	}
}

suite('ParadisOfficeWatchdog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createWatchdog(clock: FakeClock, fired: IParadisOfficeRenderTimeoutEvent[]): ParadisOfficeRenderWatchdog {
		return new ParadisOfficeRenderWatchdog(event => fired.push(event), clock.schedule, clock.cancel, clock.now);
	}

	test('the render budget grows with the document and stops at the cap', () => {
		// 固定の予算だと、巨大な文書を正常に解析している最中を「返ってこない」と誤判定して
		// 作り直してしまう（作り直すほど遅くなる悪循環になる）。
		assert.deepStrictEqual({
			unknown: paradisOfficeRenderTimeout(0),
			small: paradisOfficeRenderTimeout(1024),
			oneStep: paradisOfficeRenderTimeout(5 * 1024 * 1024),
			capped: paradisOfficeRenderTimeout(4096 * 1024 * 1024),
		}, {
			unknown: PARADIS_OFFICE_RENDER_TIMEOUT_MS,
			small: PARADIS_OFFICE_RENDER_TIMEOUT_MS,
			oneStep: PARADIS_OFFICE_RENDER_TIMEOUT_MS * 2,
			capped: PARADIS_OFFICE_MAX_RENDER_TIMEOUT_MS,
		});
	});

	test('an unanswered render reports its generation once and leaves nothing pending', () => {
		const clock = new FakeClock();
		const fired: IParadisOfficeRenderTimeoutEvent[] = [];
		const watchdog = createWatchdog(clock, fired);

		watchdog.armSource(7);
		clock.advance(PARADIS_OFFICE_SOURCE_TIMEOUT_MS);
		// 鳴った後も進め続ける。二度鳴るなら、ここで2件目が積まれる。
		clock.advance(PARADIS_OFFICE_SOURCE_TIMEOUT_MS);

		assert.deepStrictEqual({
			fired,
			pendingCount: clock.pendingCount,
			pendingGeneration: watchdog.pendingGeneration,
		}, {
			fired: [{
				generation: 7,
				elapsedMilliseconds: PARADIS_OFFICE_SOURCE_TIMEOUT_MS,
				budgetMilliseconds: PARADIS_OFFICE_SOURCE_TIMEOUT_MS,
				totalBytes: 0,
			}],
			pendingCount: 0,
			pendingGeneration: undefined,
		});
		watchdog.dispose();
	});

	test('disarming before the budget elapses keeps the timer silent', () => {
		// 成功して描き終わった表示を、時間切れとして作り直しにいかないこと。
		const clock = new FakeClock();
		const fired: IParadisOfficeRenderTimeoutEvent[] = [];
		const watchdog = createWatchdog(clock, fired);

		watchdog.armRender(3, 0);
		watchdog.disarm();
		clock.advance(PARADIS_OFFICE_MAX_RENDER_TIMEOUT_MS * 2);

		assert.deepStrictEqual({ fired, pendingCount: clock.pendingCount, pendingGeneration: watchdog.pendingGeneration },
			{ fired: [], pendingCount: 0, pendingGeneration: undefined });
		watchdog.dispose();
	});

	test('re-arming replaces the previous timer instead of stacking one', () => {
		// 読み直しが重なるたびに時計が増えると、古い世代の分まで鳴って作り直しが暴れる。
		const clock = new FakeClock();
		const fired: IParadisOfficeRenderTimeoutEvent[] = [];
		const watchdog = createWatchdog(clock, fired);

		watchdog.armSource(1);
		watchdog.armRender(2, 0);
		clock.advance(PARADIS_OFFICE_SOURCE_TIMEOUT_MS * 2);

		assert.deepStrictEqual({ generations: fired.map(event => event.generation), pendingCount: clock.pendingCount },
			{ generations: [2], pendingCount: 0 });
		watchdog.dispose();
	});

	test('only the generation being waited on can disarm the timer', () => {
		// 読み直しをまたいで届いた古い応答で解くと、新しい世代が無防備になる。
		const clock = new FakeClock();
		const fired: IParadisOfficeRenderTimeoutEvent[] = [];
		const watchdog = createWatchdog(clock, fired);

		watchdog.armRender(5, 0);
		const staleMatches = watchdog.pendingGeneration === 4;
		const currentMatches = watchdog.pendingGeneration === 5;
		clock.advance(PARADIS_OFFICE_RENDER_TIMEOUT_MS);

		assert.deepStrictEqual({ staleMatches, currentMatches, generations: fired.map(event => event.generation) },
			{ staleMatches: false, currentMatches: true, generations: [5] });
		watchdog.dispose();
	});

	test('disposing cancels a pending timer', () => {
		// ペインを閉じた後に鳴ると、既に居ないエディタへ作り直しを要求することになる。
		const clock = new FakeClock();
		const fired: IParadisOfficeRenderTimeoutEvent[] = [];
		const watchdog = createWatchdog(clock, fired);

		watchdog.armSource(9);
		watchdog.dispose();
		clock.advance(PARADIS_OFFICE_SOURCE_TIMEOUT_MS * 2);

		assert.deepStrictEqual({ fired, pendingCount: clock.pendingCount }, { fired: [], pendingCount: 0 });
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { createTermWriteCoalescer, TERM_WRITE_FLUSH_WINDOW_MS, TERM_WRITE_MAX_PENDING_CHARS, type TermWriteClock } from './termWriteCoalescer.js';

/** 手で進める時計。 */
function fakeClock() {
	let now = 1_000;
	let nextId = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const clock: TermWriteClock = {
		now: () => now,
		setTimeout: (callback, ms) => {
			const id = nextId++;
			timers.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: handle => { timers.delete(handle as number); },
	};
	const advance = (ms: number) => {
		now += ms;
		for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
			if (timer.at <= now && timers.has(id)) {
				timers.delete(id);
				timer.callback();
			}
		}
	};
	return { clock, advance, pendingTimers: () => timers.size };
}

describe('createTermWriteCoalescer', () => {
	it('delivers the first chunk at once and batches the rest into one write per window', () => {
		const { clock, advance } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		coalescer.write('b');
		advance(10);
		coalescer.write('c');
		expect(delivered).toEqual(['a']);
		advance(TERM_WRITE_FLUSH_WINDOW_MS);
		expect(delivered).toEqual(['a', 'bc']);
	});

	it('delivers at once again after the stream has been idle for a window', () => {
		const { clock, advance } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		advance(TERM_WRITE_FLUSH_WINDOW_MS);
		coalescer.write('b');
		expect(delivered).toEqual(['a', 'b']);
	});

	it('flushes without waiting once more than 512K characters are pending', () => {
		const { clock, pendingTimers } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('x');
		const big = 'y'.repeat(TERM_WRITE_MAX_PENDING_CHARS);
		coalescer.write(big);
		expect(delivered).toEqual(['x']);
		coalescer.write('z');
		expect(delivered).toEqual(['x', `${big}z`]);
		expect(pendingTimers()).toBe(0);
	});

	it('flushNow writes what is pending before the caller applies a snapshot', () => {
		const { clock, pendingTimers } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		coalescer.write('b');
		coalescer.flushNow();
		coalescer.flushNow();
		expect({ delivered, pending: coalescer.pendingChars, timers: pendingTimers() }).toEqual({ delivered: ['a', 'b'], pending: 0, timers: 0 });
	});

	it('clear drops pending output and lets the next chunk through at once', () => {
		const { clock, advance } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		coalescer.write('stale');
		coalescer.clear();
		advance(TERM_WRITE_FLUSH_WINDOW_MS * 2);
		coalescer.write('fresh');
		expect(delivered).toEqual(['a', 'fresh']);
	});

	it('flushes on the next write once the window has passed, even when the timer has not run (a busy JS thread)', () => {
		const { clock, advance, pendingTimers } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		coalescer.write('b');
		// 時計だけ進み、タイマーは JS が詰まっていて走らない。
		const now = clock.now;
		const late = now() + TERM_WRITE_FLUSH_WINDOW_MS * 3;
		clock.now = () => late;
		coalescer.write('c');
		clock.now = now;
		expect({ delivered, timers: pendingTimers() }).toEqual({ delivered: ['a', 'bc'], timers: 0 });
		advance(1);
	});

	it('does not wait longer than one window when the clock jumps backwards', () => {
		const { clock, advance } = fakeClock();
		const delivered: string[] = [];
		const coalescer = createTermWriteCoalescer(data => delivered.push(data), clock);
		coalescer.write('a');
		// 時計が戻っても、次の窓より長くは待たない。
		const originalNow = clock.now;
		const base = originalNow();
		clock.now = () => base - 60_000;
		coalescer.write('b');
		clock.now = originalNow;
		advance(TERM_WRITE_FLUSH_WINDOW_MS);
		expect(delivered).toEqual(['a', 'b']);
	});
});

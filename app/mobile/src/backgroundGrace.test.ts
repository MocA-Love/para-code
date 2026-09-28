// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { BACKGROUND_GRACE_ACK_TIMEOUT_MS, BACKGROUND_GRACE_MS, BackgroundGrace, type BackgroundGraceTarget } from './backgroundGrace.js';

class Clock {
	now = 1_000;
	private next = 1;
	readonly pending = new Map<number, { at: number; handler: () => void }>();
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
}

function target(id: string, options: { canHold?: boolean; ack?: boolean | 'never' }, calls: string[]): BackgroundGraceTarget & { ackNow(value: boolean): void } {
	let resolveAck: ((value: boolean) => void) | undefined;
	return {
		id,
		canHold: () => options.canHold ?? true,
		requestGrace: timeoutMs => {
			calls.push(`${id}:request(${timeoutMs})`);
			return new Promise<boolean>(resolve => {
				resolveAck = resolve;
				if (options.ack !== undefined && options.ack !== 'never') {
					resolve(options.ack);
				}
			});
		},
		suspend: () => calls.push(`${id}:suspend`),
		resume: () => calls.push(`${id}:resume`),
		sendForeground: () => calls.push(`${id}:foreground`),
		ackNow: value => resolveAck?.(value),
	};
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('background grace (W2-34)', () => {
	test('holds only PCs that acknowledged, closes the rest at once, and ends after 30 seconds', async () => {
		const clock = new Clock();
		const calls: string[] = [];
		const logs: string[] = [];
		const grace = new BackgroundGrace(clock, () => clock.now, (id, event) => logs.push(`${id}:${event.kind}`));
		grace.enterBackground([target('a', { ack: true }, calls), target('b', { ack: false }, calls), target('old', { canHold: false }, calls)]);
		await flush();
		expect(calls).toEqual([`a:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, `b:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, 'old:suspend', 'b:suspend']);
		expect([grace.isHolding('a'), grace.isHolding('b')]).toEqual([true, false]);
		clock.advance(BACKGROUND_GRACE_MS - 1);
		expect(calls.includes('a:suspend')).toBe(false);
		clock.advance(1);
		expect(calls.at(-1)).toBe('a:suspend');
		expect(logs).toEqual(['a:grace-requested', 'b:grace-requested', 'a:grace-held', 'b:grace-refused', 'a:grace-ended']);
	});

	test('coming back within the grace keeps the socket and tells the PC it is in front again', async () => {
		const clock = new Clock();
		const calls: string[] = [];
		const grace = new BackgroundGrace(clock, () => clock.now);
		const a = target('a', { ack: true }, calls);
		grace.enterBackground([a]);
		await flush();
		clock.advance(10_000);
		grace.enterForeground([a]);
		clock.advance(BACKGROUND_GRACE_MS);
		expect(calls).toEqual([`a:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, 'a:resume', 'a:foreground']);
	});

	test('if JS was frozen past the deadline, it closes and reconnects when coming back', async () => {
		const clock = new Clock();
		const calls: string[] = [];
		const grace = new BackgroundGrace(clock, () => clock.now);
		const a = target('a', { ack: true }, calls);
		grace.enterBackground([a]);
		await flush();
		// タイマーが走らないまま時間だけ過ぎた
		clock.now += BACKGROUND_GRACE_MS + 5_000;
		grace.enterForeground([a]);
		expect(calls).toEqual([`a:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, 'a:suspend', 'a:resume']);
	});

	test('a late acknowledgement after coming back is ignored', async () => {
		const clock = new Clock();
		const calls: string[] = [];
		const grace = new BackgroundGrace(clock, () => clock.now);
		const a = target('a', { ack: 'never' }, calls);
		grace.enterBackground([a]);
		grace.enterForeground([a]);
		a.ackNow(true);
		await flush();
		clock.advance(BACKGROUND_GRACE_MS);
		expect([calls, grace.isHolding('a')]).toEqual([[`a:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, 'a:resume', 'a:foreground'], false]);
	});

	test('end() closes a held PC (unpairing)', async () => {
		const clock = new Clock();
		const calls: string[] = [];
		const grace = new BackgroundGrace(clock, () => clock.now);
		grace.enterBackground([target('a', { ack: true }, calls)]);
		await flush();
		grace.end('a');
		clock.advance(BACKGROUND_GRACE_MS);
		expect(calls).toEqual([`a:request(${BACKGROUND_GRACE_ACK_TIMEOUT_MS})`, 'a:suspend']);
	});
});

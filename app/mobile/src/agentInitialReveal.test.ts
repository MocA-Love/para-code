// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { AgentInitialRevealGate, INITIAL_REVEAL_DEADLINE_MS, INITIAL_REVEAL_QUIET_MS, type RevealTimers } from './agentInitialReveal.js';

/**
 * 手で進める時計。実時間を待たずに静穏時間・上限時間の境目を踏める。
 *
 * advance() は「その時点で期限が来ているもの」を先に確定してから流すため、
 * ハンドラの中で新しく張られたタイマーは同じ advance() では発火しない
 * （実機の1フレーム分に相当する。上限のテストはこの性質を利用している）。
 */
class ManualTimers implements RevealTimers {
	private nextHandle = 1;
	private now = 0;
	private readonly pending = new Map<number, { at: number; handler: () => void }>();

	setTimeout(handler: () => void, ms: number): unknown {
		const handle = this.nextHandle++;
		this.pending.set(handle, { at: this.now + ms, handler });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === 'number') {
			this.pending.delete(handle);
		}
	}

	advance(ms: number): void {
		this.now += ms;
		const due = [...this.pending.entries()]
			.filter(([, timer]) => timer.at <= this.now)
			.sort((a, b) => a[1].at - b[1].at);
		for (const [handle, timer] of due) {
			this.pending.delete(handle);
			timer.handler();
		}
	}

	get pendingCount(): number {
		return this.pending.size;
	}
}

function createGate(): { gate: AgentInitialRevealGate; timers: ManualTimers; reveals: () => number } {
	const timers = new ManualTimers();
	let count = 0;
	const gate = new AgentInitialRevealGate(() => { count++; }, timers, INITIAL_REVEAL_QUIET_MS, INITIAL_REVEAL_DEADLINE_MS);
	return { gate, timers, reveals: () => count };
}

describe('agent detail initial reveal', () => {
	it('keeps the list hidden until the content stops growing', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();

		timers.advance(100);
		gate.noteGrowth();
		timers.advance(100);
		gate.noteGrowth();
		const whileGrowing = { revealed: gate.isRevealed, reveals: reveals() };

		timers.advance(INITIAL_REVEAL_QUIET_MS);

		expect({ whileGrowing, settled: { revealed: gate.isRevealed, reveals: reveals() } }).toEqual({
			whileGrowing: { revealed: false, reveals: 0 },
			settled: { revealed: true, reveals: 1 },
		});
	});

	it('waits for the first growth before measuring quiet time', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();

		// 重い端末で最初の描画通知が遅れても、静穏だけで先に見せてしまわない。
		timers.advance(INITIAL_REVEAL_QUIET_MS * 2);
		const beforeGrowth = { revealed: gate.isRevealed, reveals: reveals() };

		gate.noteGrowth();
		timers.advance(INITIAL_REVEAL_QUIET_MS);

		expect({ beforeGrowth, settled: { revealed: gate.isRevealed, reveals: reveals() } }).toEqual({
			beforeGrowth: { revealed: false, reveals: 0 },
			settled: { revealed: true, reveals: 1 },
		});
	});

	it('reveals at the deadline even while the content keeps growing', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();

		for (let elapsed = 0; elapsed < INITIAL_REVEAL_DEADLINE_MS; elapsed += 100) {
			timers.advance(100);
			gate.noteGrowth();
		}

		expect({ revealed: gate.isRevealed, reveals: reveals() }).toEqual({ revealed: true, reveals: 1 });
	});

	it('still reveals at the deadline when begin repeats faster than the quiet time', () => {
		const { gate, timers, reveals } = createGate();

		// 再接続直後などに chat が none ⇄ snapshot でばたつくと begin が連続する。
		// 上限まで引き直されると隠れたまま戻らなくなる。
		for (let elapsed = 0; elapsed < INITIAL_REVEAL_DEADLINE_MS; elapsed += 50) {
			gate.begin();
			timers.advance(50);
		}

		expect({ revealed: gate.isRevealed, reveals: reveals() }).toEqual({ revealed: true, reveals: 1 });
	});

	it('reveals immediately when asked, and only once', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();

		gate.revealNow();
		gate.revealNow();
		timers.advance(1000);

		expect({ revealed: gate.isRevealed, reveals: reveals(), pending: timers.pendingCount }).toEqual({
			revealed: true,
			reveals: 1,
			pending: 0,
		});
	});

	it('never reveals or re-arms a timer after the screen is left', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();
		gate.dispose();

		// アンマウント直後にネイティブ側の描画通知が旧クロージャへ届いても、
		// タイマーを張り直して消えた画面を更新しにいかない。
		gate.noteGrowth();
		gate.revealNow();
		timers.advance(1000);

		expect({ reveals: reveals(), pending: timers.pendingCount }).toEqual({ reveals: 0, pending: 0 });
	});

	it('ignores growth notifications that arrive before it starts hiding', () => {
		const { gate, timers, reveals } = createGate();

		gate.noteGrowth();
		timers.advance(1000);

		expect({ revealed: gate.isRevealed, reveals: reveals(), pending: timers.pendingCount }).toEqual({
			revealed: true,
			reveals: 0,
			pending: 0,
		});
	});

	it('hides again when switching to another agent', () => {
		const { gate, timers, reveals } = createGate();
		gate.begin();
		gate.noteGrowth();
		timers.advance(INITIAL_REVEAL_QUIET_MS);

		gate.begin();
		const afterSwitch = gate.isRevealed;
		gate.noteGrowth();
		timers.advance(INITIAL_REVEAL_QUIET_MS);

		expect({ afterSwitch, revealed: gate.isRevealed, reveals: reveals() }).toEqual({
			afterSwitch: false,
			revealed: true,
			reveals: 2,
		});
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { LiveActivityState } from '../modules/para-live-activity/index.js';
import {
	attentionDetail,
	buildLiveActivityState,
	decideLiveActivity,
	EMPTY_LIVE_MEMORY,
	fitLiveActivityBudget,
	isOfflineConfirmed,
	LIVE_ACTIVITY_MAX_BYTES,
	LIVE_DONE_LINGER_MS,
	LIVE_OFFLINE_GRACE_MS,
	liveActivityAttributes,
	liveActivityBytes,
	liveActivityContentKey,
	nextLiveMemory,
	nextUnreachableSince,
	runningTool,
	toOfflineState,
	type LiveChatInput,
	type LiveMemory,
	type LiveStatusSince,
	type LiveTerminalInput,
} from './liveActivityState.js';

const T0 = 1_000_000;

function terminal(key: string, agentStatus: string | undefined, extra: Partial<LiveTerminalInput> = {}): LiveTerminalInput {
	return { terminalKey: key, title: `作業 ${key}`, ws: '1:w1', agent: true, ...(agentStatus !== undefined ? { agentStatus } : {}), ...extra };
}

function since(entries: readonly [string, string | undefined, number | undefined][]): LiveStatusSince {
	return new Map(entries.map(([key, status, at]) => [key, { status, since: at }]));
}

function build(terminals: readonly LiveTerminalInput[], opts: { chats?: Map<string, LiveChatInput>; statusSince?: LiveStatusSince; memory?: LiveMemory; now?: number } = {}) {
	return buildLiveActivityState({
		terminals,
		chats: opts.chats ?? new Map(),
		statusSince: opts.statusSince ?? new Map(),
		memory: opts.memory ?? EMPTY_LIVE_MEMORY,
		now: opts.now ?? T0,
	});
}

describe('buildLiveActivityState', () => {
	it('要対応があれば attention。一番長く待たせているものを先頭にし、時刻の分からないものは後ろ', () => {
		const state = build([
			terminal('a', 'question'),
			terminal('b', 'permission'),
			terminal('c', 'question'),
			terminal('d', 'working'),
		], { statusSince: since([['b', 'permission', T0 - 5_000], ['c', 'question', T0 - 60_000]]) });
		expect(state.phase).toBe('attention');
		expect(state.waitingCount).toBe(3);
		expect(state.runningCount).toBe(1);
		expect(state.attention.map(item => item.key)).toEqual(['c', 'b']);
		expect(state.attention[0]).toMatchObject({ kind: 'question', since: T0 - 60_000, space: '1:w1', name: '作業 c' });
		expect(state.running.map(item => item.key)).toEqual(['d']);
	});

	it('実行中だけなら running。新しく始めたものを先頭に最大2件', () => {
		const state = build([
			terminal('a', 'working'),
			terminal('b', 'working'),
			terminal('c', 'working'),
		], { statusSince: since([['a', 'working', T0 - 1_500_000], ['b', 'working', T0 - 760_000]]) });
		expect(state.phase).toBe('running');
		expect(state.runningCount).toBe(3);
		expect(state.running.map(item => item.key)).toEqual(['b', 'a']);
		expect(state.attention).toEqual([]);
	});

	it('状態が変わっていない時刻（別の状態のときの記録）は使わない', () => {
		const state = build([terminal('a', 'working')], { statusSince: since([['a', 'permission', T0 - 1_000]]) });
		expect(state.running[0]?.since).toBeUndefined();
	});

	it('エージェントでないターミナルは数えない', () => {
		const state = build([terminal('a', 'working', { agent: false }), terminal('b', undefined)]);
		expect(state.phase).toBe('done');
		expect(state.runningCount).toBe(0);
		expect(state.doneCount).toBe(0);
	});

	it('要対応の中身は先頭の1件だけに載せる', () => {
		const chats = new Map<string, LiveChatInput>([
			['a', { interaction: { kind: 'approval', title: 'Bash', detail: 'pnpm test --filter relay' } }],
			['b', { interaction: { kind: 'approval', title: 'Bash', detail: 'git status' } }],
		]);
		const state = build([terminal('a', 'permission'), terminal('b', 'permission')], {
			chats,
			statusSince: since([['a', 'permission', T0 - 10_000], ['b', 'permission', T0 - 5_000]]),
		});
		expect(state.attention[0]).toMatchObject({ tool: 'Bash', detail: 'pnpm test --filter relay' });
		expect(state.attention[1]?.tool).toBeUndefined();
		expect(state.attention[1]?.detail).toBeUndefined();
	});

	it('名前は上限で切り、空ならエージェントと出す', () => {
		const state = build([terminal('a', 'working', { title: 'あ'.repeat(60) }), terminal('b', 'working', { title: '  ' })]);
		expect(state.running[0]?.name).toHaveLength(40);
		expect(state.running[0]?.name.endsWith('…')).toBe(true);
		expect(state.running[1]?.name).toBe('エージェント');
	});

	it('バッテリーは整数に丸めて載せる', () => {
		const state = buildLiveActivityState({ terminals: [terminal('a', 'working')], chats: new Map(), statusSince: new Map(), memory: EMPTY_LIVE_MEMORY, battery: { level: 63.6, charging: true }, now: T0 });
		expect(state.battery).toEqual({ level: 64, charging: true });
	});
});

describe('attentionDetail / runningTool', () => {
	it('許可待ちは承認のタイトルと詳細、無ければ実行中の状態の許可待ちから取る', () => {
		expect(attentionDetail('permission', { interaction: { kind: 'approval', title: 'コマンドの実行許可', detail: 'git add src/a.ts\n2行目' } }))
			.toEqual({ tool: 'コマンドの実行許可', detail: 'git add src/a.ts' });
		expect(attentionDetail('permission', { live: { phase: 'permission', tool: 'Bash', detail: 'rm -rf dist' } }))
			.toEqual({ tool: 'Bash', detail: 'rm -rf dist' });
	});

	it('質問は最後の質問の本文。会話の写しが無ければ何も出さない', () => {
		expect(attentionDetail('question', { messages: [{ kind: 'question', text: '古い質問' }, { kind: 'text', text: '本文' }, { kind: 'question', text: '再接続の上限回数は何回にしますか' }] }))
			.toEqual({ detail: '再接続の上限回数は何回にしますか' });
		expect(attentionDetail('question', undefined)).toEqual({});
		expect(attentionDetail('question', { none: true, messages: [{ kind: 'question', text: 'x' }] })).toEqual({});
	});

	it('長い詳細は 80 字で切る', () => {
		const detail = attentionDetail('permission', { interaction: { kind: 'approval', title: 'Bash', detail: 'x'.repeat(200) } }).detail;
		expect(detail).toHaveLength(80);
	});

	it('実行中のツールはツールを動かしている間だけ', () => {
		expect(runningTool({ live: { phase: 'tool', tool: 'Edit', detail: 'src/ui/diffTheme.ts' } })).toEqual({ tool: 'Edit', target: 'src/ui/diffTheme.ts' });
		expect(runningTool({ live: { phase: 'thinking', tool: 'Edit' } })).toEqual({});
		expect(runningTool(undefined)).toEqual({});
	});
});

describe('nextLiveMemory', () => {
	it('作業中だったものが未確認になったら「終わった」へ移し、かかった時間を持つ', () => {
		let memory = nextLiveMemory(EMPTY_LIVE_MEMORY, { pcId: 'pc', terminals: [terminal('a', 'working')], statusSince: since([['a', 'working', T0]]), alive: false, now: T0 });
		expect(memory.working.get('a')).toEqual({ start: T0 });
		memory = nextLiveMemory(memory, { pcId: 'pc', terminals: [terminal('a', 'permission')], statusSince: since([['a', 'permission', T0 + 1_000]]), alive: true, now: T0 + 1_000 });
		expect(memory.working.get('a')).toEqual({ start: T0 });
		memory = nextLiveMemory(memory, { pcId: 'pc', terminals: [terminal('a', 'done')], statusSince: since([['a', 'done', T0 + 760_000]]), alive: true, now: T0 + 760_000 });
		expect(memory.working.has('a')).toBe(false);
		expect(memory.finished.get('a')).toEqual({ at: T0 + 760_000, took: 760_000 });
	});

	it('始まりを見ていなければ、かかった時間は持たない', () => {
		let memory = nextLiveMemory(EMPTY_LIVE_MEMORY, { pcId: 'pc', terminals: [terminal('a', 'working')], statusSince: since([['a', 'working', undefined]]), alive: false, now: T0 });
		memory = nextLiveMemory(memory, { pcId: 'pc', terminals: [terminal('a', 'done')], statusSince: new Map(), alive: true, now: T0 + 5 });
		expect(memory.finished.get('a')).toEqual({ at: T0 + 5 });
	});

	it('前から未確認のもの（この Live Activity の間に終わっていない）は数えない', () => {
		const memory = nextLiveMemory(EMPTY_LIVE_MEMORY, { pcId: 'pc', terminals: [terminal('a', 'done')], statusSince: new Map(), alive: true, now: T0 });
		expect(memory.finished.size).toBe(0);
	});

	it('確認済み（待機）になった・消えたものは落とす', () => {
		const base: LiveMemory = { pcId: 'pc', working: new Map(), finished: new Map([['a', { at: T0 }], ['b', { at: T0 }]]) };
		const memory = nextLiveMemory(base, { pcId: 'pc', terminals: [terminal('a', undefined)], statusSince: new Map(), alive: true, now: T0 });
		expect(memory.finished.size).toBe(0);
	});

	it('出していないときに作業が始まったら、前回の「終わった」は捨てる', () => {
		const base: LiveMemory = { pcId: 'pc', working: new Map(), finished: new Map([['a', { at: T0 }]]) };
		const memory = nextLiveMemory(base, { pcId: 'pc', terminals: [terminal('a', 'done'), terminal('b', 'working')], statusSince: new Map(), alive: false, now: T0 });
		expect(memory.finished.size).toBe(0);
		expect(memory.working.has('b')).toBe(true);
	});

	it('PC が変わったら記録を捨てる', () => {
		const base: LiveMemory = { pcId: 'pc-1', working: new Map([['a', { start: T0 }]]), finished: new Map([['b', { at: T0 }]]) };
		const memory = nextLiveMemory(base, { pcId: 'pc-2', terminals: [terminal('a', 'done'), terminal('b', 'done')], statusSince: new Map(), alive: true, now: T0 });
		expect(memory.pcId).toBe('pc-2');
		expect(memory.finished.size).toBe(0);
	});

	it('完了の要約は新しい順に最大3件、件数は全部', () => {
		const memory: LiveMemory = {
			pcId: 'pc',
			working: new Map(),
			finished: new Map([['a', { at: T0 + 1 }], ['b', { at: T0 + 4, took: 485_000 }], ['c', { at: T0 + 3 }], ['d', { at: T0 + 2 }]]),
		};
		const state = build(['a', 'b', 'c', 'd'].map(key => terminal(key, 'done')), { memory });
		expect(state.phase).toBe('done');
		expect(state.doneCount).toBe(4);
		expect(state.done.map(item => item.key)).toEqual(['b', 'c', 'd']);
		expect(state.done[0]).toMatchObject({ at: T0 + 4, took: 485_000, name: '作業 b' });
	});
});

describe('decideLiveActivity', () => {
	const running = build([terminal('a', 'working')]);
	const done: LiveActivityState = { ...build([]), doneCount: 2 };
	const empty = build([]);

	it('要対応・実行中なら出す', () => {
		expect(decideLiveActivity({ kind: 'none' }, running, 'pc', T0)).toEqual({ action: { kind: 'show', state: running }, mode: { kind: 'active', pcId: 'pc' } });
	});

	it('全部終わったら要約を載せて終え、15 分残す', () => {
		const result = decideLiveActivity({ kind: 'active', pcId: 'pc' }, done, 'pc', T0);
		expect(result.action).toEqual({ kind: 'finish', state: { ...done, endsAt: T0 + LIVE_DONE_LINGER_MS }, dismissAt: T0 + LIVE_DONE_LINGER_MS });
		expect(result.mode).toEqual({ kind: 'finished', pcId: 'pc', until: T0 + LIVE_DONE_LINGER_MS });
	});

	it('終わったものが無ければすぐ消す（止めた・閉じた）', () => {
		expect(decideLiveActivity({ kind: 'active', pcId: 'pc' }, empty, 'pc', T0)).toEqual({ action: { kind: 'end' }, mode: { kind: 'none' } });
	});

	it('要約を残している間に全部確認されたら消す', () => {
		const mode = { kind: 'finished', pcId: 'pc', until: T0 + 1_000 } as const;
		expect(decideLiveActivity(mode, done, 'pc', T0).action).toEqual({ kind: 'keep' });
		expect(decideLiveActivity(mode, empty, 'pc', T0)).toEqual({ action: { kind: 'end' }, mode: { kind: 'none' } });
		expect(decideLiveActivity(mode, done, 'pc', T0 + 1_000)).toEqual({ action: { kind: 'keep' }, mode: { kind: 'none' } });
	});

	it('出していなければ、完了やオフラインのためには始めない', () => {
		expect(decideLiveActivity({ kind: 'none' }, done, 'pc', T0).action).toEqual({ kind: 'keep' });
		expect(decideLiveActivity({ kind: 'none' }, toOfflineState(running, undefined, T0), 'pc', T0).action).toEqual({ kind: 'keep' });
	});

	it('出している間のオフラインは出したまま灰色にする', () => {
		const offline = toOfflineState(running, T0 - 60_000, T0 + 5);
		expect(offline).toMatchObject({ phase: 'offline', asOf: T0 - 60_000, updatedAt: T0 + 5, running: running.running });
		expect(decideLiveActivity({ kind: 'active', pcId: 'pc' }, offline, 'pc', T0).action).toEqual({ kind: 'show', state: offline });
	});
});

describe('オフラインの猶予', () => {
	it('繋がらない状態が猶予を超えて続いたときだけオフライン', () => {
		const at = nextUnreachableSince(undefined, false, T0);
		expect(at).toBe(T0);
		expect(nextUnreachableSince(at, false, T0 + 5_000)).toBe(T0);
		expect(nextUnreachableSince(at, true, T0 + 5_000)).toBeUndefined();
		expect(isOfflineConfirmed(at, T0 + LIVE_OFFLINE_GRACE_MS - 1)).toBe(false);
		expect(isOfflineConfirmed(at, T0 + LIVE_OFFLINE_GRACE_MS)).toBe(true);
		expect(isOfflineConfirmed(undefined, T0)).toBe(false);
	});
});

describe('fitLiveActivityBudget', () => {
	it('上限に収まっていれば何もしない', () => {
		const attributes = liveActivityAttributes('pc', 'MacBook Pro');
		const state = build([terminal('a', 'working')]);
		expect(fitLiveActivityBudget(attributes, state)).toBe(state);
	});

	it('一番大きくなる組み合わせでも上限に収める', () => {
		const longKey = (n: number) => `terminal-${'k'.repeat(54)}${n}`;
		const title = '長い作業名'.repeat(20);
		const terminals = [
			...[1, 2].map(n => terminal(longKey(n), 'permission', { title, ws: `space-${'s'.repeat(40)}` })),
			...[3, 4].map(n => terminal(longKey(n), 'working', { title, ws: `space-${'s'.repeat(40)}` })),
			...[5, 6, 7].map(n => terminal(longKey(n), 'done', { title, ws: `space-${'s'.repeat(40)}` })),
		];
		const chats = new Map<string, LiveChatInput>(terminals.map(t => [t.terminalKey, {
			interaction: { kind: 'approval', title: 'ツール名'.repeat(10), detail: 'コマンド'.repeat(60) },
			live: { phase: 'tool', tool: 'ツール'.repeat(10), detail: 'パス/'.repeat(60) },
		}]));
		const memory: LiveMemory = { pcId: 'pc', working: new Map(), finished: new Map([5, 6, 7].map(n => [longKey(n), { at: T0 + n, took: 123_456 }])) };
		const attributes = liveActivityAttributes(`pc-${'p'.repeat(60)}`, 'とても長いPCの名前'.repeat(10));
		const state = { ...build(terminals, { chats, memory }), battery: { level: 100, charging: true } };
		expect(liveActivityBytes(attributes, state)).toBeGreaterThan(LIVE_ACTIVITY_MAX_BYTES);
		const fitted = fitLiveActivityBudget(attributes, state);
		expect(liveActivityBytes(attributes, fitted)).toBeLessThanOrEqual(LIVE_ACTIVITY_MAX_BYTES);
		// 行き先（ID）と件数は削らない。
		expect(fitted.attention[0]?.key).toBe(state.attention[0]?.key);
		expect(fitted.waitingCount).toBe(2);
		expect(fitted.doneCount).toBe(3);
	});
});

describe('liveActivityContentKey', () => {
	it('時刻だけが進んだときは同じ鍵', () => {
		const attributes = liveActivityAttributes('pc', 'MacBook Pro');
		const a = build([terminal('a', 'working')], { now: T0 });
		const b = build([terminal('a', 'working')], { now: T0 + 60_000 });
		expect(liveActivityContentKey(attributes, a)).toBe(liveActivityContentKey(attributes, b));
		expect(liveActivityContentKey(attributes, a)).not.toBe(liveActivityContentKey(liveActivityAttributes('pc', '別の名前'), a));
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	agentDetail,
	buildWidgetSnapshot,
	clampText,
	parseWidgetOutbox,
	parseWidgetSnapshot,
	planWidgetOutbox,
	snapshotContentKey,
	sortWidgetAgents,
	statusCode,
	WIDGET_DETAIL_MAX,
	WIDGET_OUTBOX_TTL_MS,
	WIDGET_TITLE_MAX,
	widgetAgentState,
	type SnapshotActiveInput,
	type SnapshotInput,
	type WidgetSnapshot,
} from './snapshot.js';

const NOW = 1_790_000_000_000;

function active(overrides: Partial<SnapshotActiveInput> = {}): SnapshotActiveInput {
	return {
		workspaces: [{ id: '1:w1', name: 'sample-app', branch: 'main' }, { id: '1:w2', name: 'docs' }],
		terminals: [
			{ terminalKey: 't-approve', title: 'Claude 認証フロー', ws: '1:w1', agent: true, agentStatus: 'permission' },
			{ terminalKey: 't-run', title: 'Codex テスト', ws: '1:w2', agent: true, agentStatus: 'working' },
			{ terminalKey: 't-done', title: 'README', ws: '1:w2', agent: true, agentStatus: 'done' },
			{ terminalKey: 't-idle', title: 'idle', ws: '1:w1', agent: true },
			{ terminalKey: 't-plain', title: 'zsh', ws: '1:w1' },
		],
		chats: new Map([
			['t-approve', { agent: 'claude', interaction: { kind: 'approval' as const, title: 'Bash', detail: 'pnpm test --filter relay' } }],
		]),
		statusSince: new Map(),
		scm: new Map(),
		...overrides,
	};
}

function input(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
	return {
		ready: true,
		pcs: [
			{ id: 'pc-a', name: 'Laptop', connection: 'online', pcOnline: true, waiting: 1, lastOnlineAt: NOW - 1_000, battery: { level: 76.4, charging: false } },
			{ id: 'pc-b', name: 'Desktop', connection: 'offline', pcOnline: false, waiting: 2, lastOnlineAt: undefined, battery: undefined },
		],
		activePcId: 'pc-a',
		active: active(),
		includeDetail: false,
		outbox: [],
		...overrides,
	};
}

describe('widgetAgentState', () => {
	it('maps the PC states the same way as the home list', () => {
		expect(widgetAgentState(true, 'permission')).toBe('approve');
		expect(widgetAgentState(true, 'question')).toBe('question');
		expect(widgetAgentState(true, 'working')).toBe('running');
		expect(widgetAgentState(true, 'done')).toBe('unread');
		expect(widgetAgentState(true, undefined)).toBe('idle');
		expect(widgetAgentState(false, 'working')).toBe('idle');
	});
});

describe('clampText', () => {
	it('collapses whitespace and cuts with an ellipsis', () => {
		expect(clampText('  a\n b  ', 10)).toBe('a b');
		expect(clampText('abcdef', 4)).toBe('abc…');
		expect(clampText('   ', 4)).toBeUndefined();
		expect(clampText(undefined, 4)).toBeUndefined();
	});
});

describe('buildWidgetSnapshot', () => {
	it('builds the active PC in detail, agents only, attention first', () => {
		const snapshot = buildWidgetSnapshot(input(), undefined, NOW);
		expect(snapshot.v).toBe(1);
		expect(snapshot.paired).toBe(true);
		expect(snapshot.activePcId).toBe('pc-a');
		const pc = snapshot.pcs[0];
		expect(pc?.online).toBe(true);
		expect(pc?.updatedAt).toBe(NOW);
		expect(pc?.battery).toEqual({ level: 76, charging: false });
		expect(pc?.agents.map(a => [a.key, a.state])).toEqual([
			['t-approve', 'approve'],
			['t-run', 'running'],
			['t-done', 'unread'],
			['t-idle', 'idle'],
		]);
		expect(pc?.attention).toBe(1);
		expect(pc?.agents[0]?.kind).toBe('claude');
		expect(pc?.spaces.map(s => s.id)).toEqual(['1:w1', '1:w2']);
	});

	it('leaves out question text and commands unless the setting allows them', () => {
		const hidden = buildWidgetSnapshot(input(), undefined, NOW);
		expect(hidden.pcs[0]?.agents[0]?.detail).toBeUndefined();
		const shown = buildWidgetSnapshot(input({ includeDetail: true }), undefined, NOW);
		expect(shown.pcs[0]?.agents[0]?.detail).toBe('Bash: pnpm test --filter relay');
	});

	it('drops kept question text of other PCs when the setting is turned off', () => {
		const previous: WidgetSnapshot = {
			v: 1, writtenAt: NOW - 10_000, source: 'app', paired: true, activePcId: 'pc-b',
			pcs: [{ id: 'pc-b', name: 'Desktop', online: true, updatedAt: NOW - 10_000, attention: 1, agents: [{ key: 'x', title: 'X', kind: 'codex', state: 'question', detail: 'secret question' }], spaces: [] }],
		};
		const snapshot = buildWidgetSnapshot(input({ includeDetail: false }), previous, NOW);
		const other = snapshot.pcs.find(pc => pc.id === 'pc-b');
		expect(other?.agents[0]?.detail).toBeUndefined();
		// 見ていない PC の中身と時刻は前回のまま。件数と接続だけ新しくなる。
		expect(other?.updatedAt).toBe(NOW - 10_000);
		expect(other?.attention).toBe(2);
		expect(other?.online).toBe(false);
	});

	it('clamps long names', () => {
		const long = 'あ'.repeat(100);
		const snapshot = buildWidgetSnapshot(input({ active: active({ terminals: [{ terminalKey: 'k', title: long, agent: true, agentStatus: 'question' }] }) }), undefined, NOW);
		expect(snapshot.pcs[0]?.agents[0]?.title.length).toBe(WIDGET_TITLE_MAX);
	});

	it('shows dismissed agents as idle until the PC catches up', () => {
		const snapshot = buildWidgetSnapshot(input({ outbox: [{ t: 'dismiss', pcId: 'pc-a', key: 't-done', at: NOW }] }), undefined, NOW);
		expect(snapshot.pcs[0]?.agents.find(a => a.key === 't-done')?.state).toBe('idle');
	});

	it('keeps the time a state started from the previous snapshot only while the state stays the same', () => {
		const first = buildWidgetSnapshot(input({ active: active({ statusSince: new Map([['t-run', { status: 'working', since: NOW - 60_000 }]]) }) }), undefined, NOW);
		expect(first.pcs[0]?.agents.find(a => a.key === 't-run')?.since).toBe(NOW - 60_000);
		const same = buildWidgetSnapshot(input(), first, NOW + 1_000);
		expect(same.pcs[0]?.agents.find(a => a.key === 't-run')?.since).toBe(NOW - 60_000);
		const changed = buildWidgetSnapshot(input({ active: active({ terminals: [{ terminalKey: 't-run', title: 'x', agent: true, agentStatus: 'done' }] }) }), first, NOW + 2_000);
		expect(changed.pcs[0]?.agents[0]?.since).toBeUndefined();
	});

	it('marks unpaired when there is no PC', () => {
		const snapshot = buildWidgetSnapshot(input({ pcs: [], activePcId: undefined, active: undefined }), undefined, NOW);
		expect(snapshot.paired).toBe(false);
		expect(snapshot.pcs).toEqual([]);
	});

	it('adds changes and commits of spaces when they were fetched', () => {
		const scm = new Map([['1:w1', { branch: 'feature', files: [{ x: ' ', y: 'M', path: 'src/a.ts' }, { x: '?', y: '?', path: 'b.ts' }], commits: [{ subject: 'first', at: NOW - 5 }], at: NOW }]]);
		const snapshot = buildWidgetSnapshot(input({ active: active({ scm }) }), undefined, NOW);
		const space = snapshot.pcs[0]?.spaces[0];
		expect(space?.branch).toBe('feature');
		expect(space?.changes).toBe(2);
		expect(space?.files).toEqual([{ code: 'M', path: 'src/a.ts' }, { code: 'A', path: 'b.ts' }]);
		expect(space?.commits).toEqual([{ subject: 'first', at: NOW - 5 }]);
		expect(snapshot.pcs[0]?.spaces[1]?.changes).toBeUndefined();
	});

	it('ignores only the write time when comparing contents', () => {
		const a = buildWidgetSnapshot(input(), undefined, NOW);
		const b = buildWidgetSnapshot(input(), undefined, NOW + 5_000);
		expect(snapshotContentKey(a)).toBe(snapshotContentKey(b));
	});
});

describe('agentDetail', () => {
	it('uses the last question text for questions', () => {
		const chat = { messages: [{ kind: 'question', text: 'old' }, { kind: 'text', text: 'x' }, { kind: 'question', text: '30 秒でよいですか' }] };
		expect(agentDetail('question', chat)).toBe('30 秒でよいですか');
		expect(agentDetail('running', chat)).toBeUndefined();
		expect(agentDetail('question', undefined)).toBeUndefined();
	});

	it('cuts to the upper limit', () => {
		const chat = { messages: [{ kind: 'question', text: 'q'.repeat(500) }] };
		expect(agentDetail('question', chat)?.length).toBe(WIDGET_DETAIL_MAX);
	});
});

describe('sortWidgetAgents', () => {
	it('puts attention first and the longest waiting first', () => {
		const sorted = sortWidgetAgents([
			{ state: 'running' as const, since: 1 },
			{ state: 'question' as const, since: 20 },
			{ state: 'approve' as const },
			{ state: 'approve' as const, since: 5 },
		]);
		expect(sorted.map(a => `${a.state}:${a.since ?? '-'}`)).toEqual(['approve:5', 'approve:-', 'question:20', 'running:1']);
	});
});

describe('statusCode', () => {
	it('prefers the working tree and shows untracked files as added', () => {
		expect(statusCode(' ', 'M')).toBe('M');
		expect(statusCode('A', ' ')).toBe('A');
		expect(statusCode('?', '?')).toBe('A');
		expect(statusCode(' ', ' ')).toBe('M');
	});
});

describe('widget outbox', () => {
	it('keeps only well-formed and recent entries', () => {
		const raw = JSON.stringify({ v: 1, entries: [
			{ t: 'dismiss', pcId: 'pc-a', key: 'k1', at: NOW },
			{ t: 'dismiss', pcId: 'pc-a', key: 'k2', at: NOW - WIDGET_OUTBOX_TTL_MS - 1 },
			{ t: 'other', pcId: 'pc-a', key: 'k3', at: NOW },
			{ t: 'dismiss', pcId: '', key: 'k4', at: NOW },
			'broken',
		] });
		expect(parseWidgetOutbox(raw, NOW)).toEqual([{ t: 'dismiss', pcId: 'pc-a', key: 'k1', at: NOW }]);
		expect(parseWidgetOutbox('not json', NOW)).toEqual([]);
		expect(parseWidgetOutbox(undefined, NOW)).toEqual([]);
	});

	it('sends dismissals only to the connected active PC and clears the finished ones', () => {
		const entries = [
			{ t: 'dismiss' as const, pcId: 'pc-a', key: 't-done', at: NOW },
			{ t: 'dismiss' as const, pcId: 'pc-a', key: 't-run', at: NOW },
			{ t: 'dismiss' as const, pcId: 'pc-a', key: 'gone', at: NOW },
			{ t: 'dismiss' as const, pcId: 'pc-b', key: 't-done', at: NOW },
		];
		const terminals = active().terminals;
		const plan = planWidgetOutbox({ entries, activePcId: 'pc-a', online: true, terminals, alreadySent: new Set() });
		expect(plan.send).toEqual(['t-done']);
		expect(plan.remove).toEqual([{ pcId: 'pc-a', key: 't-run' }, { pcId: 'pc-a', key: 'gone' }]);
		const offline = planWidgetOutbox({ entries, activePcId: 'pc-a', online: false, terminals, alreadySent: new Set() });
		expect(offline).toEqual({ send: [], remove: [] });
		const again = planWidgetOutbox({ entries, activePcId: 'pc-a', online: true, terminals, alreadySent: new Set(['pc-a\u0000t-done']) });
		expect(again.send).toEqual([]);
	});
});

describe('parseWidgetSnapshot', () => {
	it('reads back what buildWidgetSnapshot wrote', () => {
		const snapshot = buildWidgetSnapshot(input({ includeDetail: true }), undefined, NOW);
		expect(parseWidgetSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
	});

	it('rejects other versions and drops broken entries', () => {
		expect(parseWidgetSnapshot(JSON.stringify({ v: 2, writtenAt: NOW, pcs: [] }))).toBeUndefined();
		expect(parseWidgetSnapshot('{')).toBeUndefined();
		const parsed = parseWidgetSnapshot(JSON.stringify({ v: 1, writtenAt: NOW, source: 'nse', paired: true, pcs: [
			{ id: 'pc-a', name: 'A', online: true, attention: 0, agents: [{ key: 'k', title: 't', state: 'bogus' }, { key: 'k2', title: 't2', state: 'error', kind: 'x' }], spaces: 'nope' },
			{ name: 'no id' },
		] }));
		expect(parsed?.source).toBe('nse');
		expect(parsed?.pcs).toHaveLength(1);
		expect(parsed?.pcs[0]?.agents).toEqual([{ key: 'k2', title: 't2', kind: 'agent', state: 'error' }]);
		expect(parsed?.pcs[0]?.spaces).toEqual([]);
	});
});

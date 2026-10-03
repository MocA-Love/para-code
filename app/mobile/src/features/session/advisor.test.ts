// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { activityMenuHint, hasAgentActivity } from '../activity/activityModel.js';
import { parseAgentActivityAdvisors, parseAgentAdvisorInfo, type AgentActivityState, type AgentChatMessage } from '../../store.js';
import { advisorCallSummary, advisorListMeta, advisorLiveLabel, advisorModelLabel, describeAdvisorCall, isAdvisorLive } from './advisor.js';
import { buildChatRows } from './chatRows.js';

let rev = 0;
function msg(kind: AgentChatMessage['kind'], extra: Partial<AgentChatMessage> = {}): AgentChatMessage {
	rev++;
	return { rev, role: kind === 'text' ? 'assistant' : 'tool', kind, text: `${kind}-${rev}`, ...extra };
}

const use = (id: string, ts = 10_000) => msg('tool_use', { tool: 'Advisor', toolUseId: id, text: 'claude-opus-5-5', ts, advisor: { model: 'claude-opus-5-5' } });
const result = (id: string, advisor: AgentChatMessage['advisor'], ts = 24_000) => msg('tool_result', { toolUseId: id, ts, advisor });

describe('Advisor の会話の行', () => {
	test('呼び出しと結果を 1 行にまとめ、ツールのまとまりに混ぜない', () => {
		const read = msg('tool_use', { tool: 'Read', toolUseId: 'r1' });
		const rows = buildChatRows([read, use('srv1'), result('srv1', { model: 'claude-opus-5-5', outcome: 'redacted' }), msg('tool_use', { tool: 'Edit', toolUseId: 'e1' })]);
		expect(rows.map(row => row.type === 'advisor' ? { advisor: [row.use?.toolUseId, row.result?.toolUseId] } : row.type === 'group' ? { group: row.msgs.map(m => m.toolUseId) } : { type: row.type })).toEqual([
			{ group: ['r1'] },
			{ advisor: ['srv1', 'srv1'] },
			{ group: ['e1'] },
		]);
	});

	test('印の無い「Advisor」という名前のツールはふつうのツールのまま', () => {
		const rows = buildChatRows([msg('tool_use', { tool: 'Advisor', toolUseId: 'x' })]);
		expect(rows.map(row => row.type)).toEqual(['group']);
	});

	test('状態と要約（レビュー済み・失敗・相談中・返答なし）', () => {
		const now = 40_000;
		const late = 10_000 + 120_000;
		const done = describeAdvisorCall(use('a'), result('a', { model: 'claude-opus-5-5', outcome: 'redacted' }), undefined, false, now);
		const failed = describeAdvisorCall(use('b'), result('b', { outcome: 'error', errorCode: 'too_many_requests' }, 13_000), undefined, false, now);
		const running = describeAdvisorCall(use('c'), undefined, undefined, true, late);
		const listedRunning = describeAdvisorCall(use('d'), undefined, { status: 'running' }, false, late);
		// 呼び出しの行が届いたばかりで、一覧も生成中の表示もまだ追いついていない
		const justCalled = describeAdvisorCall(use('e'), undefined, undefined, false, now);
		const lost = describeAdvisorCall(use('f'), undefined, undefined, false, late);
		// mod の行にはモデル名が無いことがある。一覧の値で補う
		const fromList = describeAdvisorCall(msg('tool_use', { tool: 'Advisor', toolUseId: 'g', ts: 10_000, advisor: {} }), undefined, { status: 'running', model: 'claude-opus-4-7' }, false, now);
		expect([done, failed, running, listedRunning, justCalled, lost, fromList].map(call => [call.status, advisorCallSummary(call, now)])).toEqual([
			['completed', '会話をレビューしました · Opus 5.5 · 14秒'],
			['failed', 'too_many_requests · Opus 5.5 · 3秒'],
			['running', 'Opus 5.5 に相談中 · 30秒'],
			['running', 'Opus 5.5 に相談中 · 30秒'],
			['running', 'Opus 5.5 に相談中 · 30秒'],
			['interrupted', '返答なし · Opus 5.5'],
			['running', 'Opus 4.7 に相談中 · 30秒'],
		]);
	});

	test('モデル名の呼び名と生成中の表示', () => {
		expect([
			advisorModelLabel('claude-opus-4-7'),
			advisorModelLabel('claude-sonnet-5-5-20260101'),
			advisorModelLabel('claude-fable'),
			advisorModelLabel('gpt-x'),
			advisorModelLabel(undefined),
		]).toEqual(['Opus 4.7', 'Sonnet 5.5', 'Fable', 'gpt-x', undefined]);
		const live = { phase: 'tool' as const, source: 'transcript' as const, startedAt: 0, updatedAt: 0, tool: 'Advisor', detail: 'claude-opus-5-5' };
		expect([isAdvisorLive(live), advisorLiveLabel(live), isAdvisorLive({ ...live, tool: 'Bash' })]).toEqual([true, 'Advisor（Opus 5.5）に相談中', false]);
	});

	test('届いた印は検証して読む', () => {
		expect([
			parseAgentAdvisorInfo({ model: 'claude-opus-5-5', outcome: 'error', errorCode: 'overloaded' }),
			parseAgentAdvisorInfo({ model: 'bad model!', outcome: 'other', errorCode: 1 }),
			parseAgentAdvisorInfo('x'),
		]).toEqual([{ model: 'claude-opus-5-5', outcome: 'error', errorCode: 'overloaded' }, {}, undefined]);
	});
});

describe('サブエージェントの画面のアドバイザー', () => {
	const advisorOnly: AgentActivityState = {
		agents: [], tasks: [], compactions: [], startedAt: 0, updatedAt: 0,
		advisors: [{ id: 'srv1', model: 'claude-opus-5-5', status: 'running', startedAt: new Date(2026, 9, 4, 10, 42, 8).getTime(), updatedAt: 0 }],
	};

	test('一覧の相談を検証して読み、平文の返答は一覧に持たない', () => {
		expect(parseAgentActivityAdvisors([
			{ id: 'srvtoolu_1', model: 'claude-opus-4-7', status: 'completed', outcome: 'text', text: '本文', ownerId: 'a-sub', startedAt: 1, updatedAt: 2 },
			{ id: 'bad id', status: 'completed', startedAt: 1, updatedAt: 2 },
			{ id: 'srvtoolu_2', status: 'unknown', startedAt: 1, updatedAt: 2 },
			{ id: 'srvtoolu_3', status: 'failed', outcome: 'error', errorCode: 'too_many_requests', startedAt: 'x', updatedAt: 2 },
			'x',
		])).toEqual([{ id: 'srvtoolu_1', model: 'claude-opus-4-7', status: 'completed', outcome: 'text', ownerId: 'a-sub', startedAt: 1, updatedAt: 2 }]);
		expect([parseAgentActivityAdvisors([]), parseAgentActivityAdvisors('x')]).toEqual([undefined, undefined]);
	});

	test('Advisor しか無い会話でもメニューを出し、補足に件数を出す', () => {
		expect([hasAgentActivity(advisorOnly), activityMenuHint(advisorOnly), hasAgentActivity({ ...advisorOnly, advisors: [] })]).toEqual([
			true, '実行中 1 · エージェント 0 · アドバイザー 1 · タスク 0', false,
		]);
	});

	test('行の 2 段目（相談中は開始の時刻に「〜」、失敗は error_code）', () => {
		const started = advisorOnly.advisors![0]!;
		expect([
			advisorListMeta(started, started.startedAt + 12_000),
			advisorListMeta({ ...started, status: 'failed', errorCode: 'too_many_requests', updatedAt: started.startedAt + 3_000 }, 0),
		]).toEqual(['Opus 5.5 · 12秒 · 10:42〜', 'Opus 5.5 · 3秒 · 10:42 · too_many_requests']);
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextBreakdownDisplay, contextCategoryLines, contextHeadline, contextRowLabel, parseContextBreakdownReply, shownRows } from './agentContextBreakdown.js';

const golden = JSON.parse(readFileSync(new URL('../../protocol/test/golden/agent.json', import.meta.url), 'utf8')) as { toMobile: Record<string, unknown>[] };

describe('agentContextBreakdown', () => {
	it('PC の返事（ゴールデン）を読み、使っている分・余白・空きの順と、使用率に数えない分を分ける', () => {
		const reply = parseContextBreakdownReply(golden.toMobile.find(message => message.t === 'context-breakdown')!);
		if (reply.kind !== 'ok') {
			throw new Error('expected a breakdown');
		}
		const { counted, deferred } = contextCategoryLines(reply.breakdown);
		expect({
			live: reply.live,
			headline: contextHeadline(reply.breakdown),
			counted: counted.map(line => [line.label, line.tokens, line.share.toFixed(1), line.kind]),
			deferred: deferred.map(line => line.label),
			memory: reply.breakdown.memoryFiles.map(row => row.name),
			mcp: reply.breakdown.mcpServers.map(row => contextRowLabel(row, 'mcp')),
		}).toEqual({
			live: true,
			headline: '35%（353.9K / 1M）',
			counted: [
				['会話', 261100, '26.1', 'used'],
				['メモリファイル', 43700, '4.4', 'used'],
				['自動圧縮の余白', 33000, '3.3', 'buffer'],
				['空き', 610600, '61.1', 'free'],
			],
			deferred: ['MCP ツール（必要なときに読み込む）'],
			memory: ['/Users/example/.claude/CLAUDE.md'],
			mcp: ['para-browser（ツール 12）'],
		});
	});

	it('取れない理由ごとの文。PC の文があればそれ、無ければ理由から作る。形が違う返事は取得できない扱い', () => {
		const reasons = (['agent', 'remote', 'none', 'unavailable', 'other'] as const).map(reason => parseContextBreakdownReply({ t: 'context-breakdown', reason }));
		expect({
			reasons: reasons.map(reply => reply.kind === 'unavailable' ? [reply.reason, reply.message] : undefined),
			fromPc: parseContextBreakdownReply({ reason: 'none', error: 'まだありません' }),
			broken: parseContextBreakdownReply({ breakdown: { sessionId: 's', at: 1, totalTokens: 1, window: 0, percent: 1 } }),
		}).toEqual({
			reasons: [
				['agent', 'Claude Code の会話でだけ取れます'],
				['remote', 'このペインでは取れません'],
				['none', 'まだありません（応答が終わると取れます）'],
				['unavailable', '内訳を取得できません'],
				['unavailable', '内訳を取得できません'],
			],
			fromPc: { kind: 'unavailable', reason: 'none', message: 'まだありません' },
			broken: { kind: 'unavailable', reason: 'unavailable', message: '内訳を取得できません' },
		});
	});

	it('一覧は多い順に 5 行まで出し、残りの数を返す', () => {
		const reply = parseContextBreakdownReply({
			breakdown: {
				sessionId: 's', at: 1, totalTokens: 10, window: 100, percent: 10, categories: [],
				skills: Array.from({ length: 8 }, (_, index) => ({ name: `skill-${index}`, tokens: index })),
			},
		});
		if (reply.kind !== 'ok') {
			throw new Error('expected a breakdown');
		}
		const { shown, rest } = shownRows(reply.breakdown.skills);
		expect({ shown: shown.map(row => row.name), rest }).toEqual({ shown: ['skill-7', 'skill-6', 'skill-5', 'skill-4', 'skill-3'], rest: 3 });
	});

	it('取り直しの間と失敗のあとも前の内訳を残し、端末を替えた直後は前の端末の内訳も失敗も出さない', () => {
		const reply = parseContextBreakdownReply({ breakdown: { sessionId: 's', at: 1, totalTokens: 10, window: 100, percent: 10, categories: [] } });
		if (reply.kind !== 'ok') {
			throw new Error('expected a breakdown');
		}
		const loaded = { terminalKey: 'a', reply };
		const summary = (display: ReturnType<typeof contextBreakdownDisplay>) => display.kind === 'shown' ? { kind: display.kind, refreshing: display.refreshing, failedMessage: display.failedMessage } : display;
		expect([
			contextBreakdownDisplay('a', { kind: 'loading', terminalKey: 'a' }, undefined),
			contextBreakdownDisplay('a', { kind: 'failed', terminalKey: 'a', message: '理由' }, undefined),
			contextBreakdownDisplay('a', { kind: 'done', terminalKey: 'a' }, loaded),
			contextBreakdownDisplay('a', { kind: 'loading', terminalKey: 'a' }, loaded),
			contextBreakdownDisplay('a', { kind: 'failed', terminalKey: 'a', message: '応答なし' }, loaded),
			contextBreakdownDisplay('b', { kind: 'failed', terminalKey: 'a', message: '応答なし' }, loaded),
			contextBreakdownDisplay('b', { kind: 'done', terminalKey: 'a' }, loaded),
			contextBreakdownDisplay(undefined, { kind: 'failed', terminalKey: undefined, message: '内訳を取得できません' }, loaded),
		].map(summary)).toEqual([
			{ kind: 'spinner' },
			{ kind: 'reason', message: '理由' },
			{ kind: 'shown', refreshing: false, failedMessage: undefined },
			{ kind: 'shown', refreshing: true, failedMessage: undefined },
			{ kind: 'shown', refreshing: false, failedMessage: '応答なし' },
			{ kind: 'spinner' },
			{ kind: 'spinner' },
			{ kind: 'reason', message: '内訳を取得できません' },
		]);
	});
});

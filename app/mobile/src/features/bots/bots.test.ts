// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	appendBotDraft,
	botAskFor,
	botItemActRequest,
	botItemGroups,
	botPaneOf,
	botSectionRows,
	botFieldChange,
	botStatusLine,
	botUpdateRequest,
	parseBotFileReply,
	parseBotItemReply,
	parseBotItemsReply,
	parseBotSuggestionsReply,
	parseBotUpdateReply,
	parseMobileBots,
	type MobileBot,
} from './bots.js';

const bot = (id: string, patch: Partial<MobileBot> = {}): MobileBot => ({
	id, name: id, agent: 'claude', faceColor: 'blue', faceShape: 'circle', paused: false, pinned: false,
	needsYou: 0, openItems: 0, openSuggestions: 0, activity: 'idle', lastActivityAt: 0, ...patch,
});

describe('Bot の State', () => {
	test('ゴールデンの State の bots を読み、壊れた 1 件・同じ id・知らない顔は落とすか既定にする', () => {
		const golden = JSON.parse(readFileSync(new URL('../../../../protocol/test/golden/state.json', import.meta.url), 'utf8')) as { current: { bots: unknown[]; terminals: { botId?: unknown }[] } };
		const parsed = parseMobileBots([...golden.current.bots, { id: 'x' }, golden.current.bots[0], { id: 'y', name: 'Y', faceColor: 'gold', faceShape: 'star', needsYou: -2 }]);
		expect({
			parsed: parsed?.map(entry => [entry.id, entry.name, entry.faceColor, entry.faceShape, entry.needsYou, entry.pinned]),
			notArray: parseMobileBots({}),
			botId: golden.current.terminals[0]?.botId,
		}).toEqual({
			parsed: [['bot-1', 'リリース係', 'blue', 'drop', 1, true], ['y', 'Y', 'blue', 'circle', 0, false]],
			notArray: undefined,
			botId: 'bot-1',
		});
	});

	test('節の並び（ピン留めが先、一時停止中は畳む側）と様子の文、検索語', () => {
		const bots = [bot('a'), bot('b', { pinned: true }), bot('c', { paused: true, needsYou: 2 }), bot('d', { needsYou: 3 }), bot('e', { activity: 'patrolling' })];
		const rows = botSectionRows(bots, '');
		expect({
			active: rows.active.map(entry => entry.id),
			paused: rows.paused.map(entry => entry.id),
			lines: bots.map(botStatusLine),
			query: botSectionRows(bots, 'D').active.map(entry => entry.id),
		}).toEqual({
			active: ['b', 'a', 'd', 'e'],
			paused: ['c'],
			lines: ['待機中', '待機中', '一時停止中', '3 件が要対応', '見回り中'],
			query: ['d'],
		});
	});
});

describe('Bot の項目', () => {
	test('一覧の応答を群に分け、台帳の鍵で問いを探す', () => {
		const rows = parseBotItemsReply({
			t: 'botItems', items: [
				{ uid: 'u1', number: 1, title: '答えて', status: 'needs_you', waits: true, lastActivityAt: 5 },
				{ uid: 'u2', number: 2, title: '作業', status: 'working', waits: false, lastActivityAt: 4 },
				{ uid: 'u3', number: 3, title: '予定', status: 'planned', waits: false, lastActivityAt: 3 },
				{ uid: 'u4', number: 4, title: '後で', status: 'working', waits: false, snoozedUntil: 2_000, lastActivityAt: 2 },
				{ uid: 'u5', number: 5, title: '済み', status: 'done', waits: false, lastActivityAt: 1, closedAt: 1 },
				{ uid: 'bad' },
			],
		}) ?? [];
		const groups = botItemGroups(rows, 1_000);
		expect({
			groups: Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, (list as { uid: string }[]).map(row => row.uid)])),
			ask: botAskFor([{ key: 'bot:u10.3' }, { key: 'bot:u1.7' }], 'u1')?.key,
		}).toEqual({
			groups: { you: ['u1'], working: ['u2'], planned: ['u3'], snoozed: ['u4'], closed: ['u5'] },
			ask: 'bot:u1.7',
		});
	});

	test('項目のページ・提案・ファイル・設定の応答を読む', () => {
		expect({
			page: parseBotItemReply({ item: { uid: 'u1', number: 42, botId: 'b', title: 'T', status: 'needs_you', ask: { eventId: 3, questions: [] }, links: [{ kind: 'pr', ref: 'o/r#1' }, { kind: 1 }], events: [{ id: 1, kind: 'made', actor: 'bot', at: 1 }, { id: 'x' }], lastActivityAt: 1, locked: true } }),
			suggestions: parseBotSuggestionsReply({ suggestions: [{ id: 's1', title: 'T', request: 'R', state: 'open', createdAt: 1 }, { id: 's2', title: 'T', request: 'R', state: 'dismissed', createdAt: 1 }] })?.map(entry => entry.id),
			file: [parseBotFileReply({ text: 'a', conflict: true }), parseBotFileReply({ duplicate: true }), parseBotFileReply({})],
			update: [parseBotUpdateReply({ applied: true }), parseBotUpdateReply({ duplicate: true }), parseBotUpdateReply({ needsConfirmation: true, detail: 'D', permission: 'wider' }), parseBotUpdateReply({ needsConfirmation: true })],
		}).toEqual({
			page: { uid: 'u1', number: 42, botId: 'b', title: 'T', status: 'needs_you', waits: true, lastActivityAt: 1, askEventId: 3, links: [{ kind: 'pr', ref: 'o/r#1' }], events: [{ id: 1, kind: 'made', actor: 'bot', at: 1 }], locked: true },
			suggestions: ['s1'],
			file: [{ text: 'a', conflict: true }, 'duplicate', undefined],
			update: [{ kind: 'applied' }, { kind: 'applied' }, { kind: 'confirm', detail: 'D', wider: true }, undefined],
		});
	});
});

describe('Bot の要求', () => {
	// PC の検め（paradisBotsMobileProtocol.ts の paradisParseMobileBotItemAct・paradisParseMobileBotUpdate）が読む欄の名前と同じ。
	// PC のモジュールはサービスの宣言まで読み込むので、ここでは形を値で固定する（PC 側は paradisBotsMobileRequests.test.ts）
	test('項目の操作と設定の変更は、PC が受け取る欄の名前で送る', () => {
		expect({
			comment: botItemActRequest('o1', 'u1', { action: 'comment', text: 'ok' }),
			snooze: botItemActRequest('o2', 'u1', { action: 'snooze', until: 5_000 }),
			name: botUpdateRequest('o3', 'b', { name: '新しい名前' }, false),
			agent: botUpdateRequest('o4', 'b', { agent: 'codex', permission: null }, true),
		}).toEqual({
			comment: { t: 'botItemAct', opId: 'o1', uid: 'u1', action: 'comment', text: 'ok' },
			snooze: { t: 'botItemAct', opId: 'o2', uid: 'u1', action: 'snooze', until: 5_000 },
			name: { t: 'botUpdate', botId: 'b', changes: { name: '新しい名前' }, opId: 'o3' },
			agent: { t: 'botUpdate', botId: 'b', changes: { agent: 'codex', permission: null }, opId: 'o4', confirmed: true },
		});
	});

	test('設定のタブは触った欄だけを送る（名前を変えても既定でない権限は送らない）', () => {
		const current = { name: 'リリース係', agent: 'claude', permissionId: 'bypass' };
		expect([
			botFieldChange(current, { name: ' リリース係 ' }),
			botFieldChange(current, { name: '  ' }),
			botFieldChange(current, { name: '係' }),
			botFieldChange(current, { permissionId: 'bypass' }),
			botFieldChange(current, { permissionId: 'default' }),
			botFieldChange({ ...current, permissionId: undefined }, { permissionId: 'default' }),
			botFieldChange(current, { agent: 'codex' }),
			botFieldChange(current, { agent: 'claude' }),
		]).toEqual([
			undefined,
			undefined,
			{ name: '係' },
			undefined,
			{ permission: null },
			undefined,
			{ agent: 'codex', permission: null },
			undefined,
		]);
	});
});

describe('Bot の会話', () => {
	test('ペインは botId で探し、下書きは書きかけの後ろへ空行を挟んで足す', () => {
		const terminals = [{ terminalKey: 't1', id: 1, windowId: 1, rendererGeneration: 1, title: 'a' }, { terminalKey: 't2', id: 2, windowId: 1, rendererGeneration: 1, title: 'b', botId: 'b' }];
		expect({
			pane: botPaneOf(terminals, 'b')?.terminalKey,
			none: botPaneOf(terminals, 'c'),
			drafts: [appendBotDraft('', 'X'), appendBotDraft('  \n', 'X'), appendBotDraft('書きかけ\n', 'X')],
		}).toEqual({ pane: 't2', none: undefined, drafts: ['X', 'X', '書きかけ\n\nX'] });
	});
});

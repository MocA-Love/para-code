// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	BotHeldChoice,
	appendBotDraft,
	botConfirmedItemAction,
	botConfirmMessage,
	botFaceState,
	botSendConfirmedChange,
	botAskFor,
	botItemActRequest,
	botItemGroups,
	botPaneOf,
	botSectionRows,
	botFieldChange,
	botStatusLine,
	botSuggestionActRequest,
	botUpdateRequest,
	parseBotFileReply,
	parseBotItemReply,
	parseBotItemsReply,
	parseBotSuggestionsReply,
	parseBotUpdateReply,
	parseMobileBots,
	type BotChanges,
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

	test('眠っている・止まっている理由（bots.status.v1）を読み、PC の帯と同じ文と顔にする。広告しない PC の顔は今までのまま', () => {
		const parsed = parseMobileBots([
			{ id: 's', name: 's', activity: 'idle', sleeping: true },
			{ id: 'sp', name: 'sp', activity: 'patrolling', sleeping: true },
			{ id: 'so', name: 'so', activity: 'stopped', sleeping: true },
			{ id: 'o', name: 'o', activity: 'stopped' },
			{ id: 'e', name: 'e', activity: 'idle', halt: { kind: 'exited', exitCode: 2 } },
			{ id: 'e0', name: 'e0', activity: 'idle', halt: { kind: 'exited', exitCode: 0 } },
			{ id: 'n', name: 'n', activity: 'idle', halt: { kind: 'notFound' } },
			{ id: 'u', name: 'u', activity: 'idle', halt: { kind: 'needsUser' } },
			{ id: 'x', name: 'x', activity: 'idle', sleeping: 'yes', halt: { kind: 'boom' } },
			{ id: 'w', name: 'w', activity: 'working', sleeping: true },
			{ id: 'a', name: 'a', activity: 'stopped', sleeping: true, needsYou: 1 },
			{ id: 'p', name: 'p', activity: 'stopped', sleeping: true, paused: true },
		]) ?? [];
		expect(parsed.map(entry => [entry.id, botStatusLine(entry), botFaceState(entry, true), botFaceState(entry, false)])).toEqual([
			['s', '眠っています', 'sleep', undefined],
			['sp', '眠っています・見回り中', 'patrol', undefined],
			['so', '眠っています', 'sleep', undefined],
			['o', '起動していません', 'off', undefined],
			['e', '終了しました（コード 2）', 'halt', undefined],
			['e0', '終了しました', 'halt', undefined],
			['n', '見つかりません', 'halt', undefined],
			['u', '操作が要ります', 'need', undefined],
			['x', '待機中', 'idle', undefined],
			['w', '作業中', 'work', undefined],
			['a', '1 件が要対応', 'ask', undefined],
			['p', '一時停止中', 'paused', undefined],
		]);
	});
});

describe('設定の変更の確認の本文', () => {
	test('権限が広がるとき、PC の本文の先頭に同じ文があれば足さず、無ければ（古い PC）先頭に足す', () => {
		const now = '権限が広がります。Bot が確認なしでできることが増えます。\n権限: 既定 → すべて許可';
		expect([
			botConfirmMessage(now, true),
			botConfirmMessage('権限: 既定 → すべて許可', true),
			botConfirmMessage('モデル: opus → sonnet', false),
		]).toEqual([
			now,
			'権限が広がります。\n\n権限: 既定 → すべて許可',
			'モデル: opus → sonnet',
		]);
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
			file: [parseBotFileReply({ text: 'a', conflict: true }), parseBotFileReply({ duplicate: true }), parseBotFileReply({}), parseBotFileReply({ text: 'b', conflict: true, duplicate: true })],
			update: [parseBotUpdateReply({ applied: true }), parseBotUpdateReply({ duplicate: true }), parseBotUpdateReply({ needsConfirmation: true, detail: 'D', permission: 'wider' }), parseBotUpdateReply({ needsConfirmation: true })],
		}).toEqual({
			page: { uid: 'u1', number: 42, botId: 'b', title: 'T', status: 'needs_you', waits: true, lastActivityAt: 1, askEventId: 3, links: [{ kind: 'pr', ref: 'o/r#1' }], events: [{ id: 1, kind: 'made', actor: 'bot', at: 1 }], locked: true },
			suggestions: ['s1'],
			file: [{ text: 'a', conflict: true }, 'duplicate', undefined, { text: 'b', conflict: true }],
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

describe('確認のシート', () => {
	// ConfirmDrawer は閉じ切ってから onConfirm を呼ぶ。表示用の state を閉じるときに消しても、控えた操作で送る
	test('「完了にする」を確かめると done を送り、取り消して閉じたら何も送らない', () => {
		const held = new BotHeldChoice<'done' | 'cancel'>();
		let sheet: 'done' | 'cancel' | undefined = 'done';
		held.hold('done');
		sheet = undefined; // onClose が先に走る
		const confirmed = botConfirmedItemAction(held);
		held.hold('cancel');
		held.take(); // 取り消して閉じた
		expect({ sheet, confirmed, afterCancel: botConfirmedItemAction(held), request: botItemActRequest('o1', 'u1', confirmed!) }).toEqual({
			sheet: undefined,
			confirmed: { action: 'done' },
			afterCancel: undefined,
			request: { t: 'botItemAct', opId: 'o1', uid: 'u1', action: 'done' },
		});
	});

	test('権限の変更を確かめると、同じ opId で confirmed: true を送り直す（名前の変更に確認を求められても捨てない）', () => {
		const held = new BotHeldChoice<{ readonly changes: BotChanges; readonly opId: string }>();
		const sent: unknown[] = [];
		const send = (changes: BotChanges, confirmed: boolean, opId: string) => sent.push(botUpdateRequest(opId, 'b', changes, confirmed));
		held.hold({ changes: { permission: 'bypass' }, opId: 'o7' });
		botSendConfirmedChange(held, send);
		held.hold({ changes: { name: '係' }, opId: 'o8' });
		botSendConfirmedChange(held, send);
		botSendConfirmedChange(held, send);
		expect(sent).toEqual([
			{ t: 'botUpdate', botId: 'b', changes: { permission: 'bypass' }, opId: 'o7', confirmed: true },
			{ t: 'botUpdate', botId: 'b', changes: { name: '係' }, opId: 'o8', confirmed: true },
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

	test('提案は「始める」で文を取り、入力欄へ入れた後の started で「始めた」にする', () => {
		expect([botSuggestionActRequest('o1', 's1', 'start'), botSuggestionActRequest('o2', 's1', 'started')]).toEqual([
			{ t: 'botSuggestionAct', opId: 'o1', id: 's1', action: 'start' },
			{ t: 'botSuggestionAct', opId: 'o2', id: 's1', action: 'started' },
		]);
	});
});

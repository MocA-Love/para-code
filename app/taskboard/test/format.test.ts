// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { taskBoardSanitizeAddTask } from '@engine/paradisTaskBoard.js';
import { botOriginLabel, emptyInboxText, rpcErrorText } from '../src/format.js';

describe('emptyInboxText', () => {
	// 動いているエージェントが居ないのに「エージェントが進めています」と書かない
	test('says agents are working only when some are', () => {
		expect([emptyInboxText(2, 0), emptyInboxText(0, 3), emptyInboxText(0, 0)]).toEqual([
			'エージェントが進めています。質問や承認が来たらここに並びます。',
			'動いているエージェントもありません。未着手の 3 件から着手できます。',
			'動いているエージェントもありません。タスクを足して着手すると、質問や承認がここに並びます。',
		]);
	});
});

describe('rpcErrorText', () => {
	test('network の失敗は、HTTP の状態があれば添えて出す', () => {
		expect([
			rpcErrorText('network', 'HTTP 502'),
			rpcErrorText('network', 'Failed to fetch'),
			rpcErrorText('network', 'unauthorized'),
		]).toEqual([
			'サーバーが応答しませんでした（HTTP 502）',
			'サーバーにつながりません',
			'サーバーのトークンが変わりました。ターミナルの URL を開き直してください',
		]);
	});
});

describe('bot origin', () => {
	test('labels the card and checks what a bot may put on the board', () => {
		const origin = { kind: 'bot', botId: 'b-1', botName: ' リリース\n係 ', itemNumber: 35 };
		expect([
			botOriginLabel({ kind: 'bot', botId: 'b-1', botName: 'リリース係', itemNumber: 35 }),
			taskBoardSanitizeAddTask({ title: ' 変更\t履歴 ', body: '本文', origin }),
			taskBoardSanitizeAddTask({ title: 'T', origin: { ...origin, botName: 'x'.repeat(80) } })?.origin.botName.length,
			taskBoardSanitizeAddTask({ title: '   ', origin }),
			taskBoardSanitizeAddTask({ title: 'x'.repeat(301), origin }),
			taskBoardSanitizeAddTask({ title: 'T', body: 'x'.repeat(20_001), origin }),
			taskBoardSanitizeAddTask({ title: 'T', origin: { ...origin, itemNumber: 0 } }),
			taskBoardSanitizeAddTask({ title: 'T', origin: { ...origin, botId: '../x' } }),
			taskBoardSanitizeAddTask({ title: 'T', origin: { ...origin, kind: 'human' } }),
			taskBoardSanitizeAddTask({ title: 'T' }),
		]).toEqual([
			'Bot: リリース係 · 項目 #35',
			{ title: '変更 履歴', body: '本文', origin: { kind: 'bot', botId: 'b-1', botName: 'リリース 係', itemNumber: 35 } },
			64,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});

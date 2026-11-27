// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { emptyInboxText, rpcErrorText } from '../src/format.js';

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

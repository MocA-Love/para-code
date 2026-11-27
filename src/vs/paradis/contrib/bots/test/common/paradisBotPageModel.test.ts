/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ParadisBotGithubStatus } from '../../common/paradisBotGithub.js';
import { IParadisBotItem } from '../../common/paradisBotItems.js';
import { paradisBotChatGuide, paradisBotGithubStatusText, paradisBotItemEventLabel, paradisBotItemGroups, paradisBotItemStatusLabel, paradisBotSuggestionText } from '../../common/paradisBotPageModel.js';

function item(number: number, patch: Partial<IParadisBotItem> = {}): IParadisBotItem {
	return {
		uid: `u${number}`, number, botId: 'b', title: `t${number}`, status: 'working', links: [], events: [], lastEventId: 0,
		lastActivityAt: number, createdAt: 1, updatedAt: 1,
		...patch,
	};
}

const ASK = { eventId: 3, questions: [{ prompt: 'p', options: [{ label: 'A' }, { label: 'B' }] }] };

suite('Paradis bots page', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('項目の群', () => {
		const groups = paradisBotItemGroups([
			item(1, { status: 'needs_you', ask: ASK }),
			item(2, { status: 'needs_you' }),
			item(3, { status: 'planned' }),
			item(4, { status: 'working', snoozedUntil: 2000 }),
			item(5, { status: 'done' }),
			item(6, { status: 'canceled' }),
			item(7, { status: 'needs_you', ask: ASK, snoozedUntil: 2000 }),
			item(8),
			item(9, { status: 'waiting' }),
		], 1000);
		const ids = (list: readonly IParadisBotItem[]) => list.map(entry => entry.number);
		assert.deepStrictEqual([ids(groups.you), ids(groups.working), ids(groups.planned), ids(groups.snoozed), ids(groups.closed)], [[1], [9, 8, 2], [3], [7, 4], [6, 5]]);
	});

	test('状態と記録の文', () => {
		assert.deepStrictEqual([
			['planned', 'working', 'waiting', 'needs_you', 'done', 'canceled', 'later'].map(status => paradisBotItemStatusLabel({ status })),
			paradisBotItemEventLabel({ id: 1, kind: 'made', actor: 'bot', at: 0 }, 'リリース係'),
			paradisBotItemEventLabel({ id: 2, kind: 'status', actor: 'owner', at: 0, from: 'working', to: 'done' }, 'x'),
			paradisBotItemEventLabel({ id: 3, kind: 'commented', actor: 'owner', at: 0, text: 'A', answers: 2 }, 'x'),
			paradisBotItemEventLabel({ id: 4, kind: 'commented', actor: 'owner', at: 0, skipped: true }, 'x'),
		], [
			['予定', '進行中', '外の返事待ち', 'あなたの番', '完了', '取りやめ', 'later'],
			'リリース係が作りました',
			'あなたが「完了」にしました',
			'あなたが答えました: A',
			'あなたが問いを飛ばしました',
		]);
	});

	test('GitHub の見張りの様子（見張っていない Bot には出さない、止まっている理由は目立たせる）', () => {
		const time = (at: number) => `t${at}`;
		const view = (status: ParadisBotGithubStatus) => ({ status, pullRequests: {} });
		const watching = { watchGithub: true as const, paused: false };
		assert.deepStrictEqual([
			paradisBotGithubStatusText({ paused: false }, view({ state: 'ok' }), time),
			paradisBotGithubStatusText({ ...watching, paused: true }, view({ state: 'no-gh' }), time),
			paradisBotGithubStatusText(watching, view({ state: 'ok' }), time)?.attention,
			paradisBotGithubStatusText(watching, view({ state: 'no-gh' }), time)?.attention,
			paradisBotGithubStatusText(watching, view({ state: 'auth', message: 'x' }), time)?.text.includes('gh auth login'),
			paradisBotGithubStatusText(watching, view({ state: 'rate-limited', retryAt: 5 }), time)?.text.includes('t5'),
			paradisBotGithubStatusText(watching, view({ state: 'failed', message: 'x', retryAt: 7 }), time)?.text.includes('t7'),
			paradisBotGithubStatusText(watching, undefined, time)?.attention,
		], [undefined, { text: '一時停止中は見張りません。', attention: false }, false, true, true, true, true, false]);
	});

	test('提案の文: 制御文字と貼り付けの囲いを落とし、bracketed paste で無ければ 1 行にする', () => {
		const text = '一行目\r\n二行目\x1b[201~rm -rf ~\x1b]0;title\x07\x00';
		assert.deepStrictEqual([paradisBotSuggestionText(text, true), paradisBotSuggestionText(text, false), paradisBotSuggestionText('  a\n\n  b  ', false)], [
			'一行目\n二行目rm -rf ~',
			'一行目 二行目rm -rf ~',
			'a b',
		]);
	});

	test('会話が見つかるまでの案内: 止まっている理由があるか、しばらく見つからなければ「ターミナルを開く」の帯を出す', () => {
		const guide = (halt: Parameters<typeof paradisBotChatGuide>[0]['halt'], waitedLong = false, agent: 'claude' | 'codex' | 'antigravity' = 'codex') => {
			const value = paradisBotChatGuide({ agent, halt }, waitedLong);
			return `${value.notice}${value.band !== undefined ? ` / ${value.band.title} / ${value.band.detail}` : ''}${value.sendable ? '（送れる）' : ''}`;
		};
		assert.deepStrictEqual([
			guide(undefined),
			// Codex は起動の hook が無いので、しばらく会話が無ければ帯を出す（入力欄は止めない）。Claude Code は hook の needsUser に任せる
			guide(undefined, true),
			guide(undefined, true, 'claude'),
			guide(undefined, true, 'antigravity'),
			guide({ kind: 'needsUser' }),
			guide({ kind: 'notFound' }),
			guide({ kind: 'exited', exitCode: 1 }, false, 'claude'),
		], [
			'起こしています…（送れる）',
			'まだ会話はありません / ターミナルで操作が要ります / 会話を吹き出しで読めません。起動の画面で止まっていないか確かめてください（送れる）',
			'起こしています…（送れる）',
			'まだ会話はありません / ターミナルで操作が要ります / 会話を吹き出しで読めません。起動の画面で止まっていないか確かめてください',
			'まだ会話はありません / ターミナルで操作が要ります / 初回設定・ログイン・許可の画面で止まっています',
			'まだ会話はありません / Codex が見つかりません / ターミナルで確かめてください',
			'まだ会話はありません / エージェントは終了しました / ターミナルで確かめてください',
		]);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EMPTY_PARADIS_BOT_SUGGESTIONS_STATE,
	IParadisBotSuggestionsState,
	paradisBotOpenSuggestions,
	paradisBotSuggestionAdd,
	paradisBotSuggestionDismiss,
	paradisBotSuggestionsRemoveBot,
	paradisBotSuggestionsRunEnded,
	paradisBotSuggestionStart,
	paradisParseBotSuggestionsState,
} from '../../common/paradisBotSuggestions.js';

const DAY = 24 * 60 * 60 * 1000;

suite('Paradis bot suggestions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** 見回り `run` で題を順に出し、通ったものの数と断った理由を返す。 */
	function offer(state: IParadisBotSuggestionsState, run: string, titles: string[], now = 1000): { state: IParadisBotSuggestionsState; codes: string[] } {
		const codes: string[] = [];
		for (const title of titles) {
			const result = paradisBotSuggestionAdd(state, { id: `${run}-${title}`, botId: 'b1', run, title, request: `${title}をして` }, now);
			codes.push(result.ok ? 'ok' : result.code);
			if (result.ok) {
				state = result.state;
			}
		}
		return { state, codes };
	}

	test('1 回の見回りで 5 件まで、その Bot の最初の見回りは 3 件まで', () => {
		const first = offer(EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, 'r1', ['a', 'b', 'c', 'd']);
		const second = offer(paradisBotSuggestionsRunEnded(first.state, 'b1'), 'r2', ['e', 'f', 'g', 'h', 'i', 'j']);
		assert.deepStrictEqual({ first: first.codes, second: second.codes, open: paradisBotOpenSuggestions(second.state, 'b1').length }, {
			first: ['ok', 'ok', 'ok', 'limit'],
			second: ['ok', 'ok', 'ok', 'ok', 'ok', 'limit'],
			open: 8,
		});
	});

	test('見送った題は 30 日出さない（大文字小文字・空白の違いも同じ題）。始めると依頼の文を返す。同じ題が待っていれば断る', () => {
		let state = offer(EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, 'r1', ['PR #1108 の返事', 'Sentry の NK']).state;
		const dismissed = paradisBotSuggestionDismiss(state, 'r1-PR #1108 の返事', 2000);
		assert.ok(dismissed.ok);
		state = paradisBotSuggestionsRunEnded(dismissed.state, 'b1');
		const started = paradisBotSuggestionStart(state, 'r1-Sentry の NK', 3000);
		assert.ok(started.ok);
		const again = (title: string, now: number) => {
			const result = paradisBotSuggestionAdd(started.state, { id: 'x', botId: 'b1', run: 'r2', title, request: 'する' }, now);
			return result.ok ? 'ok' : result.code;
		};
		assert.deepStrictEqual({
			started: [started.value.state, started.value.request],
			twice: (() => { const result = paradisBotSuggestionStart(started.state, 'r1-Sentry の NK', 4000); return result.ok ? 'ok' : result.code; })(),
			within30Days: again('  pr #1108   の返事 ', 2000 + 29 * DAY),
			after30Days: again('PR #1108 の返事', 2000 + 31 * DAY),
			duplicate: offer(EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, 'r1', ['同じ', '同じ']).codes,
		}, {
			started: ['started', 'Sentry の NKをして'],
			twice: 'decided',
			within30Days: 'dismissed',
			after30Days: 'ok',
			duplicate: ['ok', 'duplicate'],
		});
	});

	test('Bot を消すと提案と見送りの記録も消える。保存した値は 1 件ずつ読み、新しい版は書かない', () => {
		const state = offer(EMPTY_PARADIS_BOT_SUGGESTIONS_STATE, 'r1', ['a']).state;
		const removed = paradisBotSuggestionsRemoveBot(state, 'b1');
		const parsed = paradisParseBotSuggestionsState(JSON.parse(JSON.stringify({ ...state, suggestions: [...state.suggestions, { id: 'bad' }] })));
		const newer = paradisParseBotSuggestionsState({ version: 2, suggestions: [{ id: 'x' }] });
		assert.deepStrictEqual({
			removed: removed.suggestions.length,
			parsed: parsed?.suggestions.map(suggestion => suggestion.id),
			newer,
			newerWrite: newer && (() => { const result = paradisBotSuggestionAdd(newer, { id: 'y', botId: 'b1', run: 'r', title: 't', request: 'r' }, 1); return result.ok ? 'ok' : result.code; })(),
		}, {
			removed: 0,
			parsed: ['r1-a'],
			newer: { version: 2, suggestions: [], dismissed: [], seenBots: [] },
			newerWrite: 'read_only',
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisStripAgentInvisibleCharacters } from '../../common/paradisAgentInvisibleText.js';
import { paradisSendAgentMessageToTui } from '../../common/paradisAgentMessageSender.js';

suite('ParadisAgentMessageSender', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sends bracketed paste and Enter as separate writes after validation', async () => {
		const events: string[] = [];
		const outcome = await paradisSendAgentMessageToTui(
			'一回目',
			async (text, execute, bracketedPasteMode) => { events.push(`send:${JSON.stringify([text, execute, bracketedPasteMode])}`); },
			async () => { events.push('validate'); return true; },
			async () => { events.push('delay'); },
		);
		assert.deepStrictEqual({ outcome, events }, {
			outcome: { consumed: true, executed: true },
			events: ['validate', 'send:["一回目",false,true]', 'delay', 'validate', 'send:["\\r",false,false]'],
		});
	});

	test('reports a consumed draft without Enter when the session changes during the paste delay', async () => {
		const sent: string[] = [];
		const validations = [true, false];
		const outcome = await paradisSendAgentMessageToTui(
			'一回目', async text => { sent.push(text); }, async () => validations.shift() ?? false, async () => { },
		);
		assert.deepStrictEqual({ outcome, sent }, { outcome: { consumed: true, executed: false }, sent: ['一回目'] });
	});

	test('does not paste when the session is already stale', async () => {
		const sent: string[] = [];
		const outcome = await paradisSendAgentMessageToTui('一回目', async text => { sent.push(text); }, async () => false, async () => { });
		assert.deepStrictEqual({ outcome, sent }, { outcome: { consumed: false, executed: false }, sent: [] });
	});

	test('pastes the text without the invisible characters Claude Code would hold back for review', async () => {
		const sent: string[] = [];
		const outcome = await paradisSendAgentMessageToTui('ゼロ幅\u200bスペース', async text => { sent.push(text); }, async () => true, async () => { });
		assert.deepStrictEqual({ outcome, sent }, { outcome: { consumed: true, executed: true }, sent: ['ゼロ幅スペース', '\r'] });
	});

	test('strips the characters Claude Code 2.1.293 removes and keeps the ones it keeps', () => {
		// 2.1.293 の対話の画面で、貼り付け + Enter 1 回で確認が出たもの（removed）と出なかったもの（kept）
		const removed = {
			zeroWidthSpace: 'ゼロ幅\u200bスペース',
			wordJoiner: '語結合子\u2060入り',
			ideographicVariation: '葛\u{E0100}と辻\u{E0101}',
			tags: 'タグ\u{E0041}\u{E0042}文字',
			joinerBetweenLetters: 'a\u200db',
			byteOrderMark: 'BOM\ufeff入り',
			trailingJoiner: '👍🏽\u200d',
			bidiOverride: 'abc\u202edef',
			lineSeparator: 'a\u2028b',
			loneSurrogate: 'a\ud800b',
		};
		const kept = {
			plain: '日本語の普通の文です',
			family: '👨\u200d👩\u200d👧\u200d👦',
			kiss: '👩\u200d❤\ufe0f\u200d👨',
			emojiPresentation: '❤\ufe0f と 1\ufe0f\u20e3',
			scotlandFlag: '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
			persianNonJoiner: 'می\u200cخواهم',
			thaiZeroWidthSpace: 'ไทย\u200bภาษา',
			crlf: '1行目\r\n2行目',
		};
		const strip = (cases: Record<string, string>) => Object.fromEntries(Object.entries(cases).map(([name, text]) => [name, paradisStripAgentInvisibleCharacters(text)]));
		assert.deepStrictEqual({ removed: strip(removed), kept: strip(kept) }, {
			removed: {
				zeroWidthSpace: 'ゼロ幅スペース',
				wordJoiner: '語結合子入り',
				ideographicVariation: '葛と辻',
				tags: 'タグ文字',
				joinerBetweenLetters: 'ab',
				byteOrderMark: 'BOM入り',
				trailingJoiner: '👍🏽',
				bidiOverride: 'abcdef',
				lineSeparator: 'a\nb',
				loneSurrogate: 'a�b',
			},
			kept,
		});
	});
});

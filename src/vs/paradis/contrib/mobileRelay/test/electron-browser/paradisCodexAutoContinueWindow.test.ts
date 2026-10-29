/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisComposerBuffer, paradisCodexComposerState, paradisIsTypedTerminalInput } from '../../electron-browser/paradisCodexAutoContinueWindow.js';

/** 行の文字と、薄い（dim）文字の印（`d`）から画面を作る。 */
function screen(rows: readonly (readonly [string, string?])[]): IParadisComposerBuffer {
	return {
		length: rows.length,
		getLine: y => {
			const row = rows[y];
			if (row === undefined) {
				return undefined;
			}
			const [text, dim = ''] = row;
			return {
				length: text.length,
				translateToString: trimRight => trimRight ? text.trimEnd() : text,
				getCell: x => x < text.length ? { getChars: () => text[x] === ' ' ? '' : text[x], isDim: () => dim[x] === 'd' ? 1 : 0 } : undefined,
			};
		},
	};
}

// Codex 0.165.0 の画面（偽の API サーバーで動かして xterm で描いたもの。2026-10-29）の形
const footer: readonly (readonly [string, string?])[] = [[''], ['  fake-model default · /workspace'], ['  ? for shortcuts']];

suite('paradisCodexAutoContinueWindow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the Codex composer as empty only when everything after the marker is the dim placeholder', () => {
		assert.deepStrictEqual({
			placeholder: paradisCodexComposerState(screen([['› hello there', 'd'], ['• Selected model is at capacity.'], [''], ['› Ask Codex to do anything', '  ddd ddddd dd dd dddddddd'], ...footer])),
			draft: paradisCodexComposerState(screen([['› Ask Codex to do anything', '  ddd ddddd dd dd dddddddd'], [''], ['› abc def'], ...footer])),
			multiLineDraft: paradisCodexComposerState(screen([['› '], ['  second line'], ...footer])),
			// 履歴に残った発言の行（印が薄い）だけで、入力欄が無い（シェルに戻った・別の画面）
			historyOnly: paradisCodexComposerState(screen([['› hello there', 'd'], ['$ ']])),
			// コマンドを打ち始めると印が `/` に変わる（0.164 から）。確かめられないので送らない
			slash: paradisCodexComposerState(screen([['/ model'], ...footer])),
			// 書きかけの先頭が空行（`\n\nfoo`。実画面では印の行の後に空行、その下に本文）
			leadingBlankDraft: paradisCodexComposerState(screen([['›'], [''], ['  foo'], [''], ['  fake-model default · /workspace']])),
			// 大きな貼り付けと画像の札（実画面では薄くない）。薄く描かれても書きかけとみなす
			pastedContent: paradisCodexComposerState(screen([['› [Pasted Content 1500 chars]'], [''], ['  fake-model default · /workspace']])),
			dimPastedContent: paradisCodexComposerState(screen([['› [Pasted Content 1500 chars]', '  ddddddddddddddddddddddddddd'], ...footer])),
			dimImage: paradisCodexComposerState(screen([['› [Image #1]', '  dddddddddd'], ...footer])),
			// 案内の行との間に空行が無い（形が違う）ときは、案内の行も入力欄として見る（送らない側へ倒す）
			footerAdjacent: paradisCodexComposerState(screen([['› Ask Codex to do anything', '  ddd ddddd dd dd dddddddd'], ['  gpt-6 · ~/repo']])),
		}, {
			placeholder: 'empty', draft: 'text', multiLineDraft: 'text', historyOnly: 'unknown', slash: 'unknown',
			leadingBlankDraft: 'text', pastedContent: 'text', dimPastedContent: 'text', dimImage: 'text', footerAdjacent: 'text',
		});
	});

	test('counts keystrokes and pastes as input, but not the reports the terminal sends by itself', () => {
		assert.deepStrictEqual([
			'a', '\r', '\x1b[A', '\x1b[200~text\x1b[201~',
			'\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[<0;10;5M\x1b[<0;10;5m', '\x1b[M !!', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[I\x1b[12;1R',
		].map(paradisIsTypedTerminalInput), [true, true, true, true, false, false, false, false, false, false, false, false]);
	});
});

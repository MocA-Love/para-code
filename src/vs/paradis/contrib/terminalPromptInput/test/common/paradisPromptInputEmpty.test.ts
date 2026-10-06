/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisPromptBaseline, IParadisPromptInputSnapshot, PARADIS_PROMPT_BASELINE_START, paradisIsPromptInputEmpty, paradisNextPromptBaseline } from '../../common/paradisPromptInputEmpty.js';

/** 入力の始まりを 10 列目、幅 40 の端末の右端に `user@host` を出したときの `value`（upstream と同じく行末まで読む）。 */
const RPROMPT = `${' '.repeat(21)}user@host`;

/** 右プロンプトの開始列と終わりの列（633;H / 633;I）。 */
const KNOWN = { rightPromptStartX: 31, rightPromptEndX: 40 };

function snapshot(overrides: Partial<IParadisPromptInputSnapshot>): IParadisPromptInputSnapshot {
	return { value: '', cursorIndex: 0, commandStartX: 10, rightPromptStartX: undefined, rightPromptEndX: undefined, baseline: undefined, ...overrides };
}

/** プロンプトが出てから入力欄が変わった順に基準を更新する。 */
function baselineAfter(states: readonly { readonly value: string; readonly cursorIndex: number }[]): IParadisPromptBaseline {
	return states.reduce(paradisNextPromptBaseline, PARADIS_PROMPT_BASELINE_START);
}

suite('paradisPromptInputEmpty', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the input as empty only when nothing but the right prompt follows the input start', () => {
		assert.deepStrictEqual({
			noRightPrompt: paradisIsPromptInputEmpty(snapshot({ value: '' })),
			onlySpaces: paradisIsPromptInputEmpty(snapshot({ value: '   ', cursorIndex: 3 })),
			typedWithoutRightPrompt: paradisIsPromptInputEmpty(snapshot({ value: 'ls', cursorIndex: 2 })),
			// 633;H あり
			rightPromptKnown: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, ...KNOWN })),
			rightPromptKnownTyping: paradisIsPromptInputEmpty(snapshot({ value: `ls${RPROMPT.substring(2)}`, cursorIndex: 2, ...KNOWN })),
			rightPromptKnownCursorMovedHome: paradisIsPromptInputEmpty(snapshot({ value: `ls${RPROMPT.substring(2)}`, cursorIndex: 0, ...KNOWN })),
			rightPromptKnownLeadingSpacesThenText: paradisIsPromptInputEmpty(snapshot({ value: `    ls${RPROMPT.substring(6)}`, cursorIndex: 0, ...KNOWN })),
			rightPromptKnownWideText: paradisIsPromptInputEmpty(snapshot({ value: `あ${RPROMPT.substring(2)}`, cursorIndex: 0, ...KNOWN })),
			rightPromptKnownMultiLine: paradisIsPromptInputEmpty(snapshot({ value: `${RPROMPT}\necho`, cursorIndex: 0, ...KNOWN })),
			// zsh の続きの行は `\n` なしで足されることがある
			rightPromptKnownFollowedByContinuation: paradisIsPromptInputEmpty(snapshot({ value: `${RPROMPT}npm publish`, ...KNOWN })),
			rightPromptKnownWideFollowedByContinuation: paradisIsPromptInputEmpty(snapshot({ value: `${' '.repeat(21)}ユーザー@hab`, rightPromptStartX: 31, rightPromptEndX: 41 })),
			rightPromptKnownWide: paradisIsPromptInputEmpty(snapshot({ value: `${' '.repeat(21)}ユーザー@h`, rightPromptStartX: 31, rightPromptEndX: 41 })),
			// `value` の始まりが右へずれている（入力の始まりの列が実際より左に記録された）
			rightPromptKnownValueShiftedRight: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT.substring(2), ...KNOWN })),
			rightPromptStartWithoutEnd: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, rightPromptStartX: 31 })),
			rightPromptStartWithoutEndMatchingBaseline: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, rightPromptStartX: 31, baseline: RPROMPT })),
			// 633;H なし
			unknownWithoutBaseline: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT })),
			unknownMatchingBaseline: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, baseline: RPROMPT })),
			unknownCursorNotAtStart: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, cursorIndex: 1, baseline: RPROMPT })),
			unknownDifferentFromBaseline: paradisIsPromptInputEmpty(snapshot({ value: `ls${RPROMPT.substring(2)}`, baseline: RPROMPT })),
			unknownWidthChanged: paradisIsPromptInputEmpty(snapshot({ value: `${' '.repeat(31)}user@host`, baseline: RPROMPT })),
			// シェル統合で入力の始まりが分からない
			noCommandStart: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, commandStartX: undefined, ...KNOWN })),
		}, {
			noRightPrompt: true,
			onlySpaces: true,
			typedWithoutRightPrompt: false,
			rightPromptKnown: true,
			rightPromptKnownTyping: false,
			rightPromptKnownCursorMovedHome: false,
			rightPromptKnownLeadingSpacesThenText: false,
			rightPromptKnownWideText: false,
			rightPromptKnownMultiLine: false,
			rightPromptKnownFollowedByContinuation: false,
			rightPromptKnownWideFollowedByContinuation: false,
			rightPromptKnownWide: true,
			rightPromptKnownValueShiftedRight: false,
			rightPromptStartWithoutEnd: false,
			rightPromptStartWithoutEndMatchingBaseline: true,
			unknownWithoutBaseline: false,
			unknownMatchingBaseline: true,
			unknownCursorNotAtStart: false,
			unknownDifferentFromBaseline: false,
			unknownWidthChanged: false,
			noCommandStart: false,
		});
	});

	test('also requires the baseline on the right prompt path when the baseline is known', () => {
		// 右プロンプトが空白で終わり、その幅に収まる文字が後ろに続いた
		const padded = `${RPROMPT}  `;
		assert.deepStrictEqual({
			matchingBaseline: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, ...KNOWN, baseline: RPROMPT })),
			followedWithinWidth: paradisIsPromptInputEmpty(snapshot({ value: `${RPROMPT}ab`, rightPromptStartX: 31, rightPromptEndX: 42, baseline: padded })),
			followedWithinWidthWithoutBaseline: paradisIsPromptInputEmpty(snapshot({ value: `${RPROMPT}ab`, rightPromptStartX: 31, rightPromptEndX: 42 })),
		}, {
			matchingBaseline: true,
			followedWithinWidth: false,
			followedWithinWidthWithoutBaseline: true,
		});
	});

	test('keeps the value shown right after the prompt as the baseline and stops updating it once typing starts', () => {
		const typed = `ls${RPROMPT.substring(2)}`;
		const widened = `${' '.repeat(31)}user@host`;
		assert.deepStrictEqual({
			rightPromptDrawn: baselineAfter([{ value: '', cursorIndex: 0 }, { value: RPROMPT, cursorIndex: 0 }]),
			noRightPrompt: baselineAfter([{ value: '', cursorIndex: 0 }]),
			typedBeforeRightPrompt: baselineAfter([{ value: 'l', cursorIndex: 1 }, { value: `l${RPROMPT.substring(1)}`, cursorIndex: 0 }]),
			typedAndCursorMovedHome: baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: typed, cursorIndex: 2 }, { value: typed, cursorIndex: 0 }]),
			typedThenErased: baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: typed, cursorIndex: 2 }, { value: RPROMPT, cursorIndex: 0 }]),
			widthChangedBeforeTyping: baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: widened, cursorIndex: 0 }]),
			widthChangedAfterTyping: baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: typed, cursorIndex: 2 }, { value: RPROMPT, cursorIndex: 0 }, { value: widened, cursorIndex: 0 }]),
			afterExecute: baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: RPROMPT, cursorIndex: -1 }]),
		}, {
			rightPromptDrawn: { value: RPROMPT, frozen: false },
			noRightPrompt: { value: undefined, frozen: false },
			typedBeforeRightPrompt: { value: undefined, frozen: true },
			typedAndCursorMovedHome: { value: RPROMPT, frozen: true },
			typedThenErased: { value: RPROMPT, frozen: true },
			widthChangedBeforeTyping: { value: widened, frozen: false },
			widthChangedAfterTyping: { value: RPROMPT, frozen: true },
			afterExecute: { value: RPROMPT, frozen: true },
		});
	});

	test('reads typing then erasing as empty but typing then moving the cursor home as not empty', () => {
		const typed = `ls${RPROMPT.substring(2)}`;
		const baseline = baselineAfter([{ value: RPROMPT, cursorIndex: 0 }, { value: typed, cursorIndex: 2 }]).value;
		assert.deepStrictEqual({
			erased: paradisIsPromptInputEmpty(snapshot({ value: RPROMPT, baseline })),
			cursorMovedHome: paradisIsPromptInputEmpty(snapshot({ value: typed, baseline })),
		}, {
			erased: true,
			cursorMovedHome: false,
		});
	});
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	askQuestionFeatures, attachQuestionNotes, formatQuestionPreview, partialQuestionAnswers, previewNeedsFullView, questionHasPreview,
	questionOutcomeFromResult, questionTakesNotes, showOtherOption,
} from './agentQuestionMod.js';

const withPreview = { options: [{ label: 'Toast', preview: '# Toast' }, { label: 'Inline' }] };
const plain = { options: [{ label: 'A' }, { label: 'B' }] };
const multiWithPreview = { multiSelect: true, options: [{ label: 'A', preview: '# A' }] };

describe('agentQuestionMod', () => {
	it('preview を描くのは単一選択の質問だけ。メモと「話す」は mod が待っているときだけ、「その他」はキー注入の preview 付きの質問で隠す', () => {
		const viaMod = askQuestionFeatures({ kind: 'question', answerVia: 'mod' }, true, true);
		const viaKeys = askQuestionFeatures({ kind: 'question', answerVia: 'keys' }, true, true);
		const oldPc = askQuestionFeatures({ kind: 'question' }, false, false);
		expect({
			hasPreview: [questionHasPreview(withPreview), questionHasPreview(plain), questionHasPreview(multiWithPreview), questionHasPreview({ options: [{ label: 'x', preview: '' }] })],
			features: [viaMod, viaKeys, oldPc, askQuestionFeatures({ kind: 'question', answerVia: 'mod' }, false, true)],
			other: [showOtherOption(withPreview, viaMod), showOtherOption(withPreview, viaKeys), showOtherOption(plain, viaKeys), showOtherOption(withPreview, oldPc)],
			notes: [questionTakesNotes(withPreview, viaMod), questionTakesNotes(plain, viaMod), questionTakesNotes(withPreview, viaKeys)],
		}).toEqual({
			hasPreview: [true, false, false, true],
			features: [
				{ notes: true, chat: true, viaMod: true },
				{ notes: false, chat: false, viaMod: false },
				{ notes: false, chat: false, viaMod: false },
				{ notes: false, chat: true, viaMod: true },
			],
			other: [true, false, true, false],
			notes: [true, false, false],
		});
	});

	it('メモを回答に添え、選んでいなければメモだけの回答にする。取り下げには途中までの回答を null 混じりで添える', () => {
		expect({
			withOption: attachQuestionNotes({ kind: 'option', index: 1 }, '  短めに ', true),
			notesOnly: attachQuestionNotes(undefined, 'どちらでもない', true),
			blank: attachQuestionNotes({ kind: 'option', index: 0 }, '   ', true),
			notTaken: attachQuestionNotes({ kind: 'option', index: 0 }, 'メモ', false),
			nothing: attachQuestionNotes(undefined, '', true),
			partial: partialQuestionAnswers([{ kind: 'option', index: 0 }, undefined, undefined], ['メモ', '', 'x'], index => index !== 2),
		}).toEqual({
			withOption: { kind: 'option', index: 1, notes: '短めに' },
			notesOnly: { kind: 'notes', notes: 'どちらでもない' },
			blank: { kind: 'option', index: 0 },
			notTaken: { kind: 'option', index: 0 },
			nothing: undefined,
			partial: [{ kind: 'option', index: 0, notes: 'メモ' }, null, null],
		});
	});

	it('preview は見出しの # とコードフェンスの記号を外し、空白と罫線はそのまま残す。末尾の空行は落とす', () => {
		const lines = formatQuestionPreview('# Toast\n\n┌────┐\n│ ok │\n└────┘\n```tsx\n  <Text />\n```\n\n');
		expect({
			lines,
			long: [previewNeedsFullView(formatQuestionPreview(Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n'))), previewNeedsFullView(lines)],
		}).toEqual({
			lines: [
				{ text: 'Toast', heading: true },
				{ text: '', heading: false },
				{ text: '┌────┐', heading: false },
				{ text: '│ ok │', heading: false },
				{ text: '└────┘', heading: false },
				{ text: '  <Text />', heading: false },
			],
			long: [true, false],
		});
	});

	it('ツールの結果から取り下げを読む（Claude Code 2.1.288 で確かめた文面）', () => {
		expect([
			questionOutcomeFromResult('The user responded: その前に画面を見せて', false),
			questionOutcomeFromResult('<tool_use_error>The user wants to clarify these questions.\n    This means …</tool_use_error>', true),
			questionOutcomeFromResult('Your questions have been answered: "Q"="A". You can now continue with these answers in mind.', false),
			questionOutcomeFromResult('The user responded: x', true),
			questionOutcomeFromResult('The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    This means …', true),
			questionOutcomeFromResult('The user wants to clarify these questions.', false),
		]).toEqual([
			{ kind: 'withdrawnWithMessage', text: 'その前に画面を見せて' },
			{ kind: 'withdrawn' },
			undefined,
			undefined,
			{ kind: 'withdrawn' },
			undefined,
		]);
	});
});

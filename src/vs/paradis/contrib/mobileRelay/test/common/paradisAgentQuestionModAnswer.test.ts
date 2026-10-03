/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAgentQuestionClarifyDeny, paradisBuildModQuestionAnswer } from '../../common/paradisAgentQuestionModAnswer.js';

suite('paradisAgentQuestionModAnswer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const truncate = (label: string) => label.length > 5 ? `${label.slice(0, 5)}…` : label;
	const sources = [
		{ question: '見せ方は？', options: [{ label: 'トースト', preview: '# Toast' }, { label: 'インラインで出す', preview: '# Inline' }] },
		{ question: '入れるものは？', options: [{ label: 'CI' }, { label: 'Storybook' }] },
		{ question: '名前は？', options: [{ label: 'A' }] },
	];
	const shown = sources.map(source => source.options.map(option => truncate(option.label)));

	test('切り詰めたラベルから元のラベルと preview を引き、メモと一緒に annotations にする。メモだけは (notes only)', () => {
		assert.deepStrictEqual({
			full: paradisBuildModQuestionAnswer(sources, shown, [{ kind: 'option', index: 1, notes: ' 短めに ' }, { kind: 'multi', indices: [0, 1] }, { kind: 'text', optionCount: 1, text: '独自' }], truncate),
			notesOnly: paradisBuildModQuestionAnswer(sources, shown, [{ kind: 'notes', notes: 'どちらでもない' }, { kind: 'multi', indices: [1] }, { kind: 'option', index: 0 }], truncate),
			unknownOption: paradisBuildModQuestionAnswer(sources, shown, [{ kind: 'option', index: 5 }, { kind: 'multi', indices: [1] }, { kind: 'option', index: 0 }], truncate),
			wrongCount: paradisBuildModQuestionAnswer(sources, shown, [{ kind: 'option', index: 0 }], truncate),
		}, {
			full: {
				answers: { '見せ方は？': 'インラインで出す', '入れるものは？': 'CI, Storybook', '名前は？': '独自' },
				annotations: { '見せ方は？': { preview: '# Inline', notes: '短めに' } },
			},
			notesOnly: {
				answers: { '見せ方は？': '(notes only)', '入れるものは？': 'Storybook', '名前は？': 'A' },
				annotations: { '見せ方は？': { notes: 'どちらでもない' } },
			},
			unknownOption: undefined,
			wrongCount: undefined,
		});
	});

	test('取り下げの拒否は TUI の「Chat about this」と同じ文面で、途中までの回答と preview のある質問のメモを添える', () => {
		assert.strictEqual(
			paradisAgentQuestionClarifyDeny(sources, shown, [{ kind: 'option', index: 0, notes: 'もっと短く' }, undefined, { kind: 'notes', notes: '無視される' }], truncate, index => index === 0),
			[
				'The user wants to clarify these questions.',
				'    This means they may have additional information, context or questions for you.',
				'    Take their response into account and then reformulate the questions if appropriate.',
				'    Start by asking them what they would like to clarify.',
				'',
				'    Questions asked:',
				'- "見せ方は？"',
				'  Answer: トースト',
				'  User notes: もっと短く',
				'- "入れるものは？"',
				'  (No answer provided)',
				'- "名前は？"',
				'  (No answer provided)',
			].join('\n'),
		);
	});
});

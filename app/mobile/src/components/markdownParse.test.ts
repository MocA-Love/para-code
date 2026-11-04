// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { parseBlocks } from './markdownParse.js';

describe('parseBlocks', () => {
	it('reads quotes, rules and nested bullets instead of leaving the marks in the text', () => {
		expect(parseBlocks([
			'> PC の設定を先に確かめる',
			'> 2 行目',
			'',
			'---',
			'',
			'- 親の項目',
			'  - 子の項目',
			'    - 孫の項目',
			'  - 子の 2 つ目',
			'',
			'- 次の親',
			'1. 番号',
			'   2) 入れ子の番号',
		].join('\n'))).toEqual([
			{ kind: 'quote', blocks: [{ kind: 'para', text: 'PC の設定を先に確かめる\n2 行目' }] },
			{ kind: 'rule' },
			{ kind: 'bullet', marker: '•', text: '親の項目', depth: 0 },
			{ kind: 'bullet', marker: '◦', text: '子の項目', depth: 1 },
			{ kind: 'bullet', marker: '▪', text: '孫の項目', depth: 2 },
			{ kind: 'bullet', marker: '◦', text: '子の 2 つ目', depth: 1 },
			{ kind: 'bullet', marker: '•', text: '次の親', depth: 0 },
			{ kind: 'bullet', marker: '1.', text: '番号', depth: 0 },
			{ kind: 'bullet', marker: '2.', text: '入れ子の番号', depth: 1 },
		]);
	});

	it('treats every rule spelling as a rule, not as a bullet', () => {
		expect(parseBlocks('***\n\n* * *\n\n___\n\n- - -')).toEqual([{ kind: 'rule' }, { kind: 'rule' }, { kind: 'rule' }, { kind: 'rule' }]);
	});

	it('makes a line under a paragraph a heading, like CommonMark and the PC preview', () => {
		expect(parseBlocks('節の名前\n---\n本文\n\n大きい見出し\n===')).toEqual([
			{ kind: 'heading', level: 2, text: '節の名前' },
			{ kind: 'para', text: '本文' },
			{ kind: 'heading', level: 1, text: '大きい見出し' },
		]);
	});

	it('keeps tables and code inside quotes, and nests quotes', () => {
		expect(parseBlocks('> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n>\n> > 内側\n> ```ts\n> const x = 1;\n> ```')).toEqual([
			{
				kind: 'quote', blocks: [
					{ kind: 'table', header: ['a', 'b'], aligns: ['left', 'left'], rows: [['1', '2']] },
					{ kind: 'quote', blocks: [{ kind: 'para', text: '内側' }] },
					{ kind: 'code', text: 'const x = 1;', lang: 'ts' },
				],
			},
		]);
	});

	it('leaves marks inside code fences alone', () => {
		expect(parseBlocks('```\n> not a quote\n---\n  - not a bullet\n```')).toEqual([
			{ kind: 'code', text: '> not a quote\n---\n  - not a bullet' },
		]);
	});

	it('stops nesting quotes at the limit and shows the rest as text', () => {
		expect(parseBlocks('>>>>> deep')).toEqual([
			{ kind: 'quote', blocks: [{ kind: 'quote', blocks: [{ kind: 'quote', blocks: [{ kind: 'quote', blocks: [{ kind: 'para', text: '> deep' }] }] }] }] },
		]);
	});
});

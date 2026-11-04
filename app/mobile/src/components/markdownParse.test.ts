// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { markdownCopyParts, markdownPlainText, parseBlocks } from './markdownParse.js';

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

describe('markdownPlainText', () => {
	it('drops the marks but keeps the list shape, link targets and table cells', () => {
		expect(markdownPlainText([
			'## 変えたこと',
			'**太字**と`code`と[説明](https://example.com/a)と[src/app.ts](src/app.ts:4)',
			'- 親',
			'  - 子',
			'',
			'> 引用の文',
			'',
			'---',
			'| a | b |',
			'| --- | --- |',
			'| 1 | **2** |',
			'```ts',
			'const x = 1;',
			'```',
		].join('\n'))).toBe([
			'変えたこと',
			'',
			'太字とcodeと説明 (https://example.com/a)とsrc/app.ts',
			'',
			'• 親',
			'  ◦ 子',
			'',
			'引用の文',
			'',
			'a\tb',
			'1\t2',
			'',
			'const x = 1;',
		].join('\n'));
	});
});

describe('markdownCopyParts', () => {
	it('lists paragraphs and code blocks separately with a one-line label', () => {
		expect(markdownCopyParts('最初の段落はとても長い文章で、四十文字を超えたところで切られて末尾に省略の印が付きます。\n\n```bash\nnpm test -- login\nnpm run lint\n```\n\n- 項目')).toEqual({
			paragraphs: [
				{ label: '最初の段落はとても長い文章で、四十文字を超えたところで切られて末尾に省略の印が付…', text: '最初の段落はとても長い文章で、四十文字を超えたところで切られて末尾に省略の印が付きます。' },
				{ label: '• 項目', text: '• 項目' },
			],
			codes: [{ label: 'bash · npm test -- login', text: 'npm test -- login\nnpm run lint' }],
		});
	});
});

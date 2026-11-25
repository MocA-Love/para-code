/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisComputerUseDiffTree, paradisComputerUseTreeLineIndex } from '../../common/paradisComputerUseTreeDiff.js';

function tree(count: number, change: (index: number) => string | undefined = () => undefined): string {
	const lines = ['[0] AXWindow "Doc"'];
	for (let index = 1; index < count; index++) {
		lines.push(change(index) ?? `  [${index}] AXButton "Item ${index}" @0,${index * 20} 80x20 actions=AXPress`);
	}
	return lines.join('\n');
}

suite('Paradis Computer Use: accessibility tree changes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the element number of a line', () => {
		assert.deepStrictEqual(['[0] AXWindow', '    [42] AXButton "[7]"', '... (tree truncated)', 'AXButton [3]'].map(paradisComputerUseTreeLineIndex), [0, 42, undefined, undefined]);
	});

	test('lists changed, new and gone elements by number, and nothing else', () => {
		const before = tree(40);
		const after = [
			...tree(40, index => index === 5 ? '  [5] AXButton "Item 5" @0,100 80x20 disabled actions=AXPress' : undefined).split('\n').slice(0, 39),
			'  [40] AXStaticText "Saved"',
			'... (3 unnamed containers hidden; their numbers still work)',
		].join('\n');
		assert.deepStrictEqual({
			changed: paradisComputerUseDiffTree(before, after),
			same: paradisComputerUseDiffTree(before, `${before}\n... (2 unnamed containers hidden; their numbers still work)`),
		}, {
			changed: {
				kind: 'changes', elements: 40, lines: [
					'~   [5] AXButton "Item 5" @0,100 80x20 disabled actions=AXPress',
					'+   [40] AXStaticText "Saved"',
					'- [39] AXButton "Item 39" @0,780 80x20 actions=AXPress',
				],
			},
			same: { kind: 'unchanged', elements: 40 },
		});
	});

	// 上に 1 行増えると、それより下の番号は別の要素を指す。ずれた行は全部「変わった」になるので、差分にせず全文を返す
	// （差分に出ない番号が別の要素を指すことが無いように）
	test('falls back to the whole tree when numbers shifted, much changed, the tree was cut or there is no earlier tree', () => {
		const before = tree(40);
		const shifted = ['[0] AXWindow "Doc"', '  [1] AXStaticText "New banner"', ...before.split('\n').slice(1).map(line => line.replace(/\[(\d+)\]/, (_match, index: string) => `[${Number(index) + 1}]`))].join('\n');
		assert.deepStrictEqual([
			paradisComputerUseDiffTree(before, shifted),
			paradisComputerUseDiffTree(before, tree(40, index => index % 2 ? `  [${index}] AXButton "Other ${index}"` : undefined)),
			paradisComputerUseDiffTree(before, `${before}\n... (tree truncated)`),
			paradisComputerUseDiffTree(`${before}\n... (tree truncated)`, before),
			paradisComputerUseDiffTree(undefined, before),
			// 小さなツリーでは、数行の変化なら差分にする
			paradisComputerUseDiffTree(tree(4), tree(4, index => `  [${index}] AXButton "X"`)).kind,
		].map(diff => typeof diff === 'string' ? diff : diff.kind), ['full', 'full', 'full', 'full', 'full', 'changes']);
	});
});

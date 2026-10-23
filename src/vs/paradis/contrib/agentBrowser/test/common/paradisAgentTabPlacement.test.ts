/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentTabGroupInfo, paradisChooseAgentTabPlacement, paradisEstimateHiddenAgentTabSize, paradisNormalizeMinSplitWidth, paradisPredictSplitWidth } from '../../common/paradisAgentTabPlacement.js';

function group(id: number, width: number, options: Partial<Omit<IParadisAgentTabGroupInfo, 'id' | 'width'>> = {}): IParadisAgentTabGroupInfo {
	const hasPaneTerminal = options.hasPaneTerminal ?? false;
	return { id, width, hasPaneTerminal, hasTerminal: options.hasTerminal ?? hasPaneTerminal, hasOwnAgentTab: options.hasOwnAgentTab ?? false, ...(options.splitWidth !== undefined ? { splitWidth: options.splitWidth } : {}) };
}

suite('Paradis agent tab placement', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('chooses the group of an earlier own tab, a split beside the terminal, the widest group without a terminal, or a background tab next to the terminal', () => {
		const terminalAlone = group(1, 1600, { hasPaneTerminal: true });
		assert.deepStrictEqual({
			// エディタ 1 枚（1600px）: 分割すると 800px なので分割する
			split: paradisChooseAgentTabPlacement([terminalAlone], 600),
			// 前に開いたタブのグループがあれば、分割せずにそこへ足す
			ownTab: paradisChooseAgentTabPlacement([terminalAlone, group(2, 800, { hasOwnAgentTab: true })], 600),
			// 前に開いたタブがターミナルと同じグループにあるなら、裏に足す
			ownTabWithTerminal: paradisChooseAgentTabPlacement([group(1, 1600, { hasPaneTerminal: true, hasOwnAgentTab: true })], 600),
			// 2 列（800px ずつ）: 分割すると 400px なので、ターミナルの無いグループへ足す
			twoColumns: paradisChooseAgentTabPlacement([group(1, 800, { hasPaneTerminal: true }), group(2, 800)], 600),
			// ターミナルの無いグループのうち一番広いもの（同じ幅なら新しく使った方）
			widestFree: paradisChooseAgentTabPlacement([group(1, 400, { hasPaneTerminal: true }), group(2, 300), group(3, 500), group(4, 500), group(5, 300, { hasTerminal: true })], 600),
			// ターミナルしか無ければ、ペインのターミナルのグループへ裏のタブとして足す
			terminalOnly: paradisChooseAgentTabPlacement([group(1, 1000, { hasTerminal: true }), group(2, 800, { hasPaneTerminal: true })], 600),
			// ペインのターミナルがエディタ領域に無く、どのグループにもターミナルがあるなら、一番広いグループの裏
			terminalElsewhere: paradisChooseAgentTabPlacement([group(1, 700, { hasTerminal: true }), group(2, 900, { hasTerminal: true })], 600),
			// ちょうど最小幅になる分割はする。1px 足りなければしない
			exactlyMinimum: paradisChooseAgentTabPlacement([group(1, 1200, { hasPaneTerminal: true })], 600),
			belowMinimum: paradisChooseAgentTabPlacement([group(1, 1199, { hasPaneTerminal: true })], 600),
			// 最小幅を下げれば、狭くても分割する
			lowerMinimum: paradisChooseAgentTabPlacement([group(1, 800, { hasPaneTerminal: true }), group(2, 800)], 400),
			noGroups: paradisChooseAgentTabPlacement([], 600),
			// 均等に割り直す設定で、分割後が 533px にしかならないなら分割しない
			distributedTooNarrow: paradisChooseAgentTabPlacement([group(1, 1400, { hasPaneTerminal: true, splitWidth: 533 }), group(2, 200)], 600),
		}, {
			split: { kind: 'split', besideGroupId: 1 },
			ownTab: { kind: 'group', groupId: 2, inactive: false, rule: 'ownTab' },
			ownTabWithTerminal: { kind: 'group', groupId: 1, inactive: true, rule: 'ownTab' },
			twoColumns: { kind: 'group', groupId: 2, inactive: false, rule: 'widestFree' },
			widestFree: { kind: 'group', groupId: 3, inactive: false, rule: 'widestFree' },
			terminalOnly: { kind: 'group', groupId: 2, inactive: true, rule: 'terminalOnly' },
			terminalElsewhere: { kind: 'group', groupId: 2, inactive: true, rule: 'terminalOnly' },
			exactlyMinimum: { kind: 'split', besideGroupId: 1 },
			belowMinimum: { kind: 'group', groupId: 1, inactive: true, rule: 'terminalOnly' },
			lowerMinimum: { kind: 'split', besideGroupId: 1 },
			noGroups: undefined,
			distributedTooNarrow: { kind: 'group', groupId: 2, inactive: false, rule: 'widestFree' },
		});
	});

	test('falls back to the default minimum width for values that are not usable', () => {
		assert.deepStrictEqual(
			[paradisNormalizeMinSplitWidth(800), paradisNormalizeMinSplitWidth(0), paradisNormalizeMinSplitWidth(-1), paradisNormalizeMinSplitWidth('600'), paradisNormalizeMinSplitWidth(Number.NaN), paradisNormalizeMinSplitWidth(undefined)],
			[800, 0, 600, 600, 600, 600],
		);
	});

	test('estimates the size of a tab kept hidden for a space that is not on screen', () => {
		assert.deepStrictEqual(
			[paradisEstimateHiddenAgentTabSize(1600, 900.6, 600), paradisEstimateHiddenAgentTabSize(1000, 700, 600), paradisEstimateHiddenAgentTabSize(0, 0, 600)],
			[{ width: 800, height: 900 }, { width: 1000, height: 700 }, { width: 1, height: 1 }],
		);
	});

	test('predicts the width of a split from the editor split sizing setting', () => {
		assert.deepStrictEqual({
			split: paradisPredictSplitWidth(1400, [1400, 200], 'split'),
			distribute: paradisPredictSplitWidth(1400, [1400, 200], 'distribute'),
			autoUneven: paradisPredictSplitWidth(1400, [1400, 200], 'auto'),
			autoEven: paradisPredictSplitWidth(800, [800, 801], 'auto'),
			autoAlone: paradisPredictSplitWidth(1600, [1600], undefined),
			noRow: paradisPredictSplitWidth(1600, [], 'distribute'),
		}, {
			split: 700,
			distribute: 533,
			autoUneven: 700,
			autoEven: 533,
			autoAlone: 800,
			noRow: 800,
		});
	});
});

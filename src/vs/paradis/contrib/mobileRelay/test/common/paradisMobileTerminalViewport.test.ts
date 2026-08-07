/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsValidTerminalViewportMessage, paradisReadTerminalViewport, paradisResolveTerminalViewport } from '../../common/paradisMobileTerminalViewport.js';

suite('paradisMobileTerminalViewport', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('申告なしは正当（寸法合わせをしない／やめる指定）', () => {
		assert.deepStrictEqual(
			[paradisIsValidTerminalViewportMessage({}), paradisReadTerminalViewport({})],
			[true, undefined],
		);
	});

	test('桁だけの申告は通し、行だけ・範囲外・非整数は弾く', () => {
		assert.deepStrictEqual([
			paradisIsValidTerminalViewportMessage({ viewCols: 59 }),
			paradisIsValidTerminalViewportMessage({ viewRows: 42 }),
			paradisIsValidTerminalViewportMessage({ viewCols: 1, viewRows: 42 }),
			paradisIsValidTerminalViewportMessage({ viewCols: 59, viewRows: 100_000 }),
			paradisIsValidTerminalViewportMessage({ viewCols: 59.5, viewRows: 42 }),
			paradisIsValidTerminalViewportMessage({ viewCols: '59', viewRows: 42 }),
			paradisIsValidTerminalViewportMessage({ viewCols: 59, viewRows: 42 }),
		], [true, false, false, false, false, false, true]);
	});

	test('桁だけの申告は行を持たない形で読み出す（PC側の行数のまま）', () => {
		assert.deepStrictEqual(paradisReadTerminalViewport({ viewCols: 59 }), { cols: 59 });
	});

	test('複数のモバイルが見ているときは最小へ倒す（全員が読める側）', () => {
		assert.deepStrictEqual(
			paradisResolveTerminalViewport([{ cols: 97, rows: 32 }, { cols: 59, rows: 42 }]),
			{ cols: 59, rows: 32 },
		);
	});

	test('行を申告しない端末は行の決定に参加しない', () => {
		assert.deepStrictEqual([
			paradisResolveTerminalViewport([{ cols: 97 }, { cols: 59, rows: 42 }]),
			paradisResolveTerminalViewport([{ cols: 97 }, { cols: 59 }]),
		], [{ cols: 59, rows: 42 }, { cols: 59 }]);
	});

	test('申告のない購読者は寸法の決定に参加しない', () => {
		assert.deepStrictEqual(
			paradisResolveTerminalViewport([undefined, { cols: 59, rows: 42 }, undefined]),
			{ cols: 59, rows: 42 },
		);
	});

	test('申告が1つも無ければ undefined（＝PC側の寸法へ戻す）', () => {
		assert.deepStrictEqual(
			[paradisResolveTerminalViewport([]), paradisResolveTerminalViewport([undefined, undefined])],
			[undefined, undefined],
		);
	});
});

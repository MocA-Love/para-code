/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisReforwardConfirmRow, PARADIS_REFORWARD_CONFIRM_MAX_CHIPS, paradisReforwardConfirm, paradisReforwardOtherWindows } from '../../common/paradisPortReforwardConfirm.js';

function rows(count: number, changes: readonly number[] = []): IParadisReforwardConfirmRow[] {
	return Array.from({ length: count }, (_, index) => ({ remotePort: 21000 + index, localPort: changes.includes(index) ? 65400 + index : 21000 + index, changesLocal: changes.includes(index) }));
}

suite('paradisReforwardConfirm', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('puts the ports in chips up to the limit, keeps every row in the folded list, and shows the changed rows outside it', () => {
		const shown = [3, 20, 21].map(count => {
			const confirm = paradisReforwardConfirm({ rows: rows(count, count === 21 ? [1] : []), inUse: [], reason: undefined, asksReason: true, otherWindows: { kind: 'unknown' } });
			return {
				title: confirm.title,
				chips: confirm.chips.length,
				open: confirm.openListLabel,
				all: confirm.all.length,
				lastInList: confirm.all.at(-1)?.port,
				changed: confirm.changed,
				approve: confirm.approveLabel,
			};
		});
		assert.deepStrictEqual(shown, [
			{ title: 'エージェントが転送 3 件のつなぎ直しを求めています', chips: 3, open: '一覧を見る', all: 3, lastInList: 21002, changed: [], approve: '3 件をつなぎ直す' },
			{ title: 'エージェントが転送 20 件のつなぎ直しを求めています', chips: PARADIS_REFORWARD_CONFIRM_MAX_CHIPS, open: 'ほか 8 件と一覧を見る', all: 20, lastInList: 21019, changed: [], approve: '20 件をつなぎ直す' },
			{ title: 'エージェントが転送 21 件のつなぎ直しを求めています', chips: PARADIS_REFORWARD_CONFIRM_MAX_CHIPS, open: 'ほか 9 件と一覧を見る', all: 21, lastInList: 21020, changed: ['21001: localhost:65401 → localhost:21001（元のアドレスのタブは繋がらなくなります）'], approve: '21 件をつなぎ直す' },
		]);
	});

	test('counts other windows only when every count is known, and never claims none when one is unknown', () => {
		assert.deepStrictEqual([
			paradisReforwardOtherWindows([1, 1]),
			paradisReforwardOtherWindows([1, 3]),
			paradisReforwardOtherWindows([1, undefined]),
			paradisReforwardOtherWindows([undefined, 2]),
			paradisReforwardOtherWindows([0]),
			paradisReforwardOtherWindows([]),
		], [
			{ kind: 'none' },
			{ kind: 'some', count: 2 },
			{ kind: 'unknown' },
			{ kind: 'some', count: 1 },
			{ kind: 'unknown' },
			{ kind: 'unknown' },
		]);
	});
});

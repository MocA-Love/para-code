/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileDoNotDisturbOpLedger, paradisParseMobileDoNotDisturbSetRequest, paradisParseMobileDoNotDisturbState } from '../../common/paradisMobileDoNotDisturb.js';

suite('ParadisMobileDoNotDisturb', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('状態と要求の形を読む（壊れた値は捨て、オフの until は落とす）', () => {
		assert.deepStrictEqual({
			states: [
				{ enabled: true, until: 1_800_000_000_000 },
				{ enabled: true },
				{ enabled: false, until: 1_800_000_000_000 },
				{ enabled: true, until: -1 },
				{ enabled: true, until: 1.5 },
				{ enabled: 'yes' },
				null,
			].map(paradisParseMobileDoNotDisturbState),
			requests: [
				{ t: 'dndSet', opId: 'a', enabled: true, duration: 'morning', extra: 1 },
				{ t: 'dndSet', opId: 'a', enabled: false, duration: 'morning' },
				{ t: 'dndSet', opId: '', enabled: false },
				{ t: 'dndSet', opId: 'x'.repeat(101), enabled: false },
				{ t: 'other', opId: 'a', enabled: false },
			].map(paradisParseMobileDoNotDisturbSetRequest),
		}, {
			states: [{ enabled: true, until: 1_800_000_000_000 }, { enabled: true }, { enabled: false }, undefined, undefined, undefined, undefined],
			requests: [
				{ t: 'dndSet', opId: 'a', enabled: true, duration: 'morning' },
				{ t: 'dndSet', opId: 'a', enabled: false },
				undefined,
				undefined,
				undefined,
			],
		});
	});

	test('opId の台帳は端末ごとに見分け、上限を超えたら古いものから忘れる', () => {
		const ledger = new ParadisMobileDoNotDisturbOpLedger(2);
		assert.deepStrictEqual([
			ledger.claim('phone', 'a'),
			ledger.claim('phone', 'a'),
			ledger.claim('ipad', 'a'),
			ledger.claim('phone', 'b'),
			ledger.claim('phone', 'a'),
		], [true, false, true, true, true]);
	});
});

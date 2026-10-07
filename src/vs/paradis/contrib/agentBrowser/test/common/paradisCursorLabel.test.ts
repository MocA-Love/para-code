/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCursorLabelWidth, paradisNormalizeCursorLabel } from '../../common/paradisCursorLabel.js';

suite('Paradis cursor label', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('names are normalized, stripped of emoji and invisible characters, cut at width 12, and refused when they leak page data', () => {
		const cases = {
			plain: 'Checkout',
			japanese: '注文入力',
			fullWidthLatin: 'Ｃｈｅｃｋ',
			halfWidthKana: 'ﾁｭｳﾓﾝ',
			newlines: ' 在庫\n\t確認 ',
			emoji: '注文🛒入力',
			bidi: 'abc‮def',
			zeroWidth: 'ab​cd',
			long: '注文フォームの入力と確認',
			longLatin: 'checkout-and-confirm',
			url: 'see https://example.com',
			domain: 'example.com',
			mail: 'a.b@example.com',
			number: '注文 1234567',
			reservedJa: 'あなた',
			reservedEn: 'Para Code',
			admin: 'ADMIN',
			empty: '   ',
			short: 'a',
			filler: '\u3164\u3164',
			braille: '\u2800\u2800',
			spacedNumber: '1 2 3 4 5 6 7',
			arabicDigits: '\u0661\u0662\u0663\u0664\u0665\u0666\u0667',
			homoglyph: '\u0420\u0430ra Code',
		};
		const result = Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, paradisNormalizeCursorLabel(value)]));
		assert.deepStrictEqual(result, {
			plain: { ok: true, label: 'Checkout', truncated: false },
			japanese: { ok: true, label: '注文入力', truncated: false },
			fullWidthLatin: { ok: true, label: 'Check', truncated: false },
			halfWidthKana: { ok: true, label: 'チュウモン', truncated: false },
			newlines: { ok: true, label: '在庫 確認', truncated: false },
			emoji: { ok: true, label: '注文入力', truncated: false },
			bidi: { ok: true, label: 'abcdef', truncated: false },
			zeroWidth: { ok: true, label: 'abcd', truncated: false },
			long: { ok: true, label: '注文フォーム', truncated: true },
			longLatin: { ok: true, label: 'checkout-and', truncated: true },
			url: { ok: false, rejected: 'contains a URL' },
			domain: { ok: false, rejected: 'contains a URL' },
			mail: { ok: false, rejected: 'contains an e-mail address' },
			number: { ok: false, rejected: 'contains a long number' },
			reservedJa: { ok: false, rejected: 'reserved name' },
			reservedEn: { ok: false, rejected: 'reserved name' },
			admin: { ok: false, rejected: 'reserved name' },
			empty: { ok: false, rejected: 'empty' },
			short: { ok: false, rejected: 'too short' },
			filler: { ok: false, rejected: 'empty' },
			braille: { ok: false, rejected: 'empty' },
			spacedNumber: { ok: false, rejected: 'contains a long number' },
			arabicDigits: { ok: false, rejected: 'contains a long number' },
			homoglyph: { ok: false, rejected: 'reserved name' },
		});
		assert.deepStrictEqual([paradisCursorLabelWidth('注文'), paradisCursorLabelWidth('ab')], [4, 2]);
	});
});

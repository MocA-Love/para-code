// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { PARA_HEADER_NO_CAP, paraHeaderBoundsFor } from './paraHeaderBounds.js';

describe('paraHeaderBoundsFor', () => {
	// これが落ちるとヘッダーが画面から消える。実際に一度出荷してしまった不具合の見張り。
	test('静止しているスロットには制約を課さない（上限0と混同しない）', () => {
		expect([
			paraHeaderBoundsFor(1, 0, PARA_HEADER_NO_CAP),
			paraHeaderBoundsFor(1, 164, PARA_HEADER_NO_CAP),
			paraHeaderBoundsFor(0, 164, PARA_HEADER_NO_CAP),
		]).toEqual([
			{ minWidth: 0, maxWidth: undefined },
			{ minWidth: 0, maxWidth: undefined },
			{ minWidth: 0, maxWidth: undefined },
		]);
	});

	test('モーフの始まりでは器がいまの幅に固定され、着地すると制約が外れる', () => {
		expect([
			paraHeaderBoundsFor(0, 164, 44),
			paraHeaderBoundsFor(0.5, 164, 44),
			paraHeaderBoundsFor(1, 164, 44),
		]).toEqual([
			{ minWidth: 164, maxWidth: 164 },
			{ minWidth: 82, maxWidth: 104 },
			{ minWidth: 0, maxWidth: undefined },
		]);
	});

	test('太るときも同じ式で、着地後の幅は上限の見積もりに縛られない', () => {
		expect([
			paraHeaderBoundsFor(0, 44, 224),
			paraHeaderBoundsFor(0.5, 44, 224),
			paraHeaderBoundsFor(1, 44, 224),
		]).toEqual([
			{ minWidth: 44, maxWidth: 44 },
			{ minWidth: 22, maxWidth: 134 },
			{ minWidth: 0, maxWidth: undefined },
		]);
	});

	test('無くなるスロットは0まで縮んでそこに留まる（着地で跳ね返らない）', () => {
		expect([
			paraHeaderBoundsFor(0, 44, 0),
			paraHeaderBoundsFor(0.5, 44, 0),
			paraHeaderBoundsFor(1, 44, 0),
			paraHeaderBoundsFor(1.2, 44, 0),
		]).toEqual([
			{ minWidth: 0, maxWidth: 44 },
			{ minWidth: 0, maxWidth: 22 },
			{ minWidth: 0, maxWidth: 0 },
			{ minWidth: 0, maxWidth: 0 },
		]);
	});
});

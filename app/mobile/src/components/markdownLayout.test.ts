// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { NEUTRAL_CHAT_TEXT_SCALE } from '../chatTextScale.js';
import { estimateTextWidth, tableColumnWidths } from './markdownLayout.js';

describe('tableColumnWidths', () => {
	it('sizes each column by its longest cell, within 52 to 260, and follows the chat text size', () => {
		const block = { header: ['名前', 'x'], rows: [['とても長い説明の列です', 'a'.repeat(60)]] };
		expect([
			estimateTextWidth('ab全'),
			tableColumnWidths(block, 2, NEUTRAL_CHAT_TEXT_SCALE),
			tableColumnWidths(block, 2, { font: 1.5, layout: 1.5 }),
			tableColumnWidths({ header: ['a'], rows: [] }, 2, NEUTRAL_CHAT_TEXT_SCALE),
		]).toEqual([25.2, [154, 260], [231, 390], [52, 52]]);
	});
});

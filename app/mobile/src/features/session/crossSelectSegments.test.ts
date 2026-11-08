// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../store.js';
import type { ChatRow } from './chatRows.js';
import { space } from '../../theme.js';
import { crossSelectColumn, crossSelectSegments } from './crossSelectSegments.js';

let rev = 0;
function row(role: AgentChatMessage['role'], text: string, extra: Partial<AgentChatMessage> = {}): ChatRow {
	rev++;
	return { type: 'msg', m: { rev, role, kind: 'text', text, ...extra } };
}
const tool: ChatRow = { type: 'group', key: 'g', msgs: [] };

describe('crossSelectSegments', () => {
	it('lists the text messages around the pressed one and skips tools, notices and empty messages', () => {
		const rows = [row('user', '直して'), tool, row('assistant', '直しました'), row('assistant', 'お知らせ', { notice: true }), row('assistant', '  '), row('assistant', 'peer', { kind: 'peer_message' }), row('user', '次も')];
		expect(crossSelectSegments(rows, 2)).toEqual({
			segments: [
				{ text: '直して', markdown: false, label: 'あなた' },
				{ text: '直しました', markdown: true, label: 'エージェント' },
				{ text: 'peer', markdown: true, label: 'チームメイト' },
				{ text: '次も', markdown: false, label: 'あなた' },
			],
			anchor: 1,
		});
		expect(crossSelectSegments(rows, 1)).toBeUndefined();
	});

	it('takes the neighbours in turn up to the count and character limits, keeping the pressed one', () => {
		const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(text => row('assistant', text));
		const shown = (result: ReturnType<typeof crossSelectSegments>) => ({ texts: result?.segments.map(segment => segment.text), anchor: result?.anchor });
		expect([
			shown(crossSelectSegments(rows, 1, 4)),
			shown(crossSelectSegments(rows, 3, 3)),
			shown(crossSelectSegments([row('assistant', 'x'.repeat(10)), row('assistant', 'long'.repeat(10)), row('assistant', 'yy')], 1, 30, 11)),
		]).toEqual([
			{ texts: ['a', 'b', 'c', 'd'], anchor: 1 },
			{ texts: ['c', 'd', 'e'], anchor: 1 },
			{ texts: ['x'.repeat(10), 'long'.repeat(10)], anchor: 1 },
		]);
	});
});

describe('crossSelectColumn', () => {
	it('uses the pressed agent message frame, and the chat column for a right-aligned user bubble', () => {
		const frame = { pageX: 216, pageY: 300, width: 160, height: 40 };
		expect([
			crossSelectColumn(true, { ...frame, pageX: 116, width: 343 }, { pageX: 100, width: 375 }, false),
			crossSelectColumn(false, frame, { pageX: 100, width: 375 }, false),
			crossSelectColumn(false, frame, { pageX: 0, width: 1000 }, true),
		]).toEqual([
			{ left: 16, width: 343 },
			{ left: space.lg, width: 375 - space.lg * 2 },
			{ left: 120 + space.lg, width: 760 - space.lg * 2 },
		]);
	});
});

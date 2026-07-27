// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { parseSpaceNote, spaceNoteSummary, toggleSpaceNoteTask } from './spaceNote.js';

describe('spaceNote', () => {
	it('parses headings, checklists and plain text', () => {
		expect(parseSpaceNote('## いまここ\n- [x] 済み\n- [ ] やること\n\nメモ')).toEqual([
			{ index: 0, kind: 'heading', text: 'いまここ', done: false },
			{ index: 1, kind: 'task', text: '済み', done: true },
			{ index: 2, kind: 'task', text: 'やること', done: false },
			{ index: 3, kind: 'blank', text: '', done: false },
			{ index: 4, kind: 'text', text: 'メモ', done: false },
		]);
	});

	it('counts open and done tasks', () => {
		expect(spaceNoteSummary('- [ ] a\n- [x] b\n- [ ] c')).toEqual({ open: 2, done: 1 });
		expect(spaceNoteSummary('')).toEqual({ open: 0, done: 0 });
	});

	it('toggles only the addressed checklist line', () => {
		const note = '- [ ] a\nただの行\n- [x] b';
		expect(toggleSpaceNoteTask(note, 0)).toBe('- [x] a\nただの行\n- [x] b');
		expect(toggleSpaceNoteTask(note, 2)).toBe('- [ ] a\nただの行\n- [ ] b');
		expect(toggleSpaceNoteTask(note, 1)).toBeUndefined();
		expect(toggleSpaceNoteTask(note, 9)).toBeUndefined();
	});

	it('matches the desktop parser on the shapes people actually type', () => {
		expect(parseSpaceNote('  - [X] 大文字\n* [ ] アスタリスク\n- [] 未対応').map(line => `${line.kind}:${line.done}`)).toEqual([
			'task:true',
			'task:false',
			'text:false',
		]);
	});
});

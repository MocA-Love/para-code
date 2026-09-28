// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { appendNoteChange, replaceNoteChange, spaceNoteConflictKind, spaceNoteSetOptions, toggleNoteChange } from './spaceNoteSave.js';

describe('spaceNoteSave', () => {
	it('チェックの切り替えは、切り替えた行とその中身を操作として持つ', () => {
		expect(toggleNoteChange('# 見出し\n- [ ] a', 1)).toEqual({ next: '# 見出し\n- [x] a', op: { kind: 'toggle', line: 1, lineText: '- [ ] a' } });
		expect(toggleNoteChange('# 見出し', 0)).toBeUndefined();
	});

	it('追加は足す行だけを操作として持つ（継続行も含める）', () => {
		expect(appendNoteChange('- [ ] a\n', 'b\n補足', 'task')).toEqual({ next: '- [ ] a\n- [ ] b\n  補足', op: { kind: 'append', entry: '- [ ] b\n  補足' } });
		expect(appendNoteChange('- [ ] a', '  ', 'task')).toBeUndefined();
	});

	it('PC が扱えるときだけ、操作か版を付ける', () => {
		const toggle = toggleNoteChange('- [ ] a', 0)!;
		expect({
			oldPc: spaceNoteSetOptions(toggle, 5, false),
			op: spaceNoteSetOptions(toggle, 5, true),
			replace: spaceNoteSetOptions(replaceNoteChange('x'), 5, true),
			replaceWithoutVersion: spaceNoteSetOptions(replaceNoteChange('x'), undefined, true),
		}).toEqual({
			oldPc: undefined,
			op: { op: { kind: 'toggle', line: 0, lineText: '- [ ] a' } },
			replace: { base: 5 },
			replaceWithoutVersion: undefined,
		});
	});

	it('書かれなかった変更の種類', () => {
		expect([
			spaceNoteConflictKind(toggleNoteChange('- [ ] a', 0)!, false),
			spaceNoteConflictKind(replaceNoteChange('x'), true),
			spaceNoteConflictKind(replaceNoteChange('x'), false),
		]).toEqual(['op', 'replaceCopied', 'replace']);
	});
});

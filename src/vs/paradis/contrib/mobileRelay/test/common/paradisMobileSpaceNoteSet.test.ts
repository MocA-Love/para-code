/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSpaceNote, IParadisSpaceNotesService, IParadisSpaceNoteSummary, PARADIS_SPACE_NOTE_MAX_LENGTH, paradisSpaceNoteSummary } from '../../../workspaceSwitch/common/paradisSpaceNotes.js';
import { paradisMobileNoteGet, paradisMobileNoteSet, paradisParseMobileNoteOp } from '../../common/paradisMobileSpaceNoteSet.js';

/** 書くたびに版を1つ進めるメモ置き場（本物は時刻だが、増えることだけが大事）。 */
class FakeNotes implements IParadisSpaceNotesService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeNotes = Event.None;
	private readonly notes = new Map<string, IParadisSpaceNote>();
	private version = 100;
	/** メモのあるスペースの数が上限に達している（新しいスペースのメモを受け付けない。本物の上限は 512 件）。 */
	full = false;

	read(stateKey: string): string {
		return this.notes.get(stateKey)?.text ?? '';
	}

	readEntry(stateKey: string): IParadisSpaceNote | undefined {
		return this.notes.get(stateKey);
	}

	summary(stateKey: string): IParadisSpaceNoteSummary {
		return paradisSpaceNoteSummary(this.read(stateKey));
	}

	write(stateKey: string, text: string): void {
		if (text.trim().length === 0) {
			this.notes.delete(stateKey);
		} else if (this.full && !this.notes.has(stateKey)) {
			return;
		} else if (text !== this.read(stateKey)) {
			this.notes.set(stateKey, { text, updatedAt: ++this.version });
		}
	}

	toggleTask(): void { }
	removeTask(): void { }
	updateTaskText(): void { }
	remove(): void { }
}

suite('ParadisMobileSpaceNoteSet', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the version with the text, 0 when there is no note', () => {
		const notes = new FakeNotes();
		const empty = paradisMobileNoteGet(notes, 'ws');
		notes.write('ws', '- [ ] a');
		assert.deepStrictEqual([empty, paradisMobileNoteGet(notes, 'ws')], [
			{ t: 'note', ws: 'ws', text: '', updatedAt: 0 },
			{ t: 'note', ws: 'ws', text: '- [ ] a', updatedAt: 101 },
		]);
	});

	test('overwrites without base (old apps) and compares the version with base', () => {
		const notes = new FakeNotes();
		notes.write('ws', 'from pc');
		const legacy = paradisMobileNoteSet(notes, 'ws', { text: 'from old app' });
		const stale = paradisMobileNoteSet(notes, 'ws', { text: 'from phone', base: 101 });
		const fresh = paradisMobileNoteSet(notes, 'ws', { text: 'from phone', base: 102 });
		assert.deepStrictEqual({ legacy, stale, fresh }, {
			legacy: { t: 'note', ws: 'ws', text: 'from old app', updatedAt: 102 },
			stale: { t: 'note', ws: 'ws', text: 'from old app', updatedAt: 102, conflict: true },
			fresh: { t: 'note', ws: 'ws', text: 'from phone', updatedAt: 103 },
		});
	});

	test('applies an operation to the latest text instead of the full text sent', () => {
		const notes = new FakeNotes();
		notes.write('ws', '- [ ] added on pc\n- [ ] a');
		// スマホは PC の書き足しを知らないまま、古い全文と「a を切り替えた」を送ってくる
		const toggled = paradisMobileNoteSet(notes, 'ws', { text: '- [x] a', op: { kind: 'toggle', line: 0, lineText: '- [ ] a' } });
		const appended = paradisMobileNoteSet(notes, 'ws', { text: '- [x] a\n- [ ] b', op: { kind: 'append', entry: '- [ ] b' } });
		const gone = paradisMobileNoteSet(notes, 'ws', { text: 'x', op: { kind: 'toggle', line: 0, lineText: '- [ ] removed' } });
		assert.deepStrictEqual({ toggled, appended, gone }, {
			toggled: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a', updatedAt: 102, opLine: 1 },
			appended: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a\n- [ ] b', updatedAt: 103 },
			gone: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a\n- [ ] b', updatedAt: 103, conflict: true },
		});
	});

	test('removes and edits a task on the latest text (note.task-ops.v1)', () => {
		const notes = new FakeNotes();
		notes.write('ws', '- [ ] added on pc\n- [ ] a\n- [ ] b');
		const edited = paradisMobileNoteSet(notes, 'ws', { text: '- [ ] A\n- [ ] b', op: { kind: 'edit', line: 0, lineText: '- [ ] a', text: 'A', baseText: '- [ ] a\n- [ ] b' } });
		const removed = paradisMobileNoteSet(notes, 'ws', { text: '- [ ] A', op: { kind: 'remove', line: 1, lineText: '- [ ] b', baseText: '- [ ] A\n- [ ] b' } });
		const gone = paradisMobileNoteSet(notes, 'ws', { text: '', op: { kind: 'remove', line: 0, lineText: '- [ ] b', baseText: '- [ ] b' } });
		// 同じ文言への書き換えは書かずに最新を返す（版を進めず、conflict も付けない）
		const same = paradisMobileNoteSet(notes, 'ws', { text: '- [ ] added on pc\n- [ ] A', op: { kind: 'edit', line: 1, lineText: '- [ ] A', text: 'A', baseText: '- [ ] added on pc\n- [ ] A' } });
		assert.deepStrictEqual({ edited, removed, gone, same, badEdit: paradisParseMobileNoteOp({ kind: 'edit', line: 0, lineText: 'x' }), noBaseRemove: paradisParseMobileNoteOp({ kind: 'remove', line: 0, lineText: 'x' }), noBaseEdit: paradisParseMobileNoteOp({ kind: 'edit', line: 0, lineText: 'x', text: 'y' }), badBase: paradisParseMobileNoteOp({ kind: 'remove', line: 0, lineText: 'x', baseText: 1 }) }, {
			edited: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [ ] A\n- [ ] b', updatedAt: 102, opLine: 1 },
			removed: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [ ] A', updatedAt: 103, opLine: 2 },
			gone: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [ ] A', updatedAt: 103, conflict: true },
			same: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [ ] A', updatedAt: 103, opLine: 1 },
			badEdit: undefined,
			// remove / edit は baseText が必須（同じ中身の別の項目を消さないため）
			noBaseRemove: undefined,
			noBaseEdit: undefined,
			badBase: undefined,
		});
	});

	test('tells apart tasks with the same text by the text the app read (baseText)', () => {
		const notes = new FakeNotes();
		const base = '- [ ] same\n- [ ] same';
		notes.write('ws', `- [ ] added on pc\n${base}`);
		const removed = paradisMobileNoteSet(notes, 'ws', { text: '- [ ] same', op: { kind: 'remove', line: 1, lineText: '- [ ] same', baseText: base } });
		assert.deepStrictEqual(removed, { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [ ] same', updatedAt: 102, opLine: 2 });
	});

	test('rejects malformed requests', () => {
		const notes = new FakeNotes();
		assert.deepStrictEqual([
			paradisMobileNoteSet(notes, 'ws', {}),
			paradisMobileNoteSet(notes, 'ws', { text: 'a', base: 'x' }),
			paradisMobileNoteSet(notes, 'ws', { text: 'a', op: { kind: 'toggle', line: -1, lineText: '' } }),
			paradisParseMobileNoteOp({ kind: 'remove', line: 0 }),
			paradisParseMobileNoteOp(null),
		], [{ error: 'text is required' }, { error: 'invalid base' }, { error: 'invalid op' }, undefined, undefined]);
	});

	// 上限を超えた本文を黙って切らない・受け付けなかった書き込みを成功のように返さない
	test('refuses a note over the length limit and reports a write the PC did not accept', () => {
		const notes = new FakeNotes();
		notes.write('ws', 'kept');
		const tooLong = paradisMobileNoteSet(notes, 'ws', { text: 'x'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH + 1), base: 101 });
		const atLimit = paradisMobileNoteSet(notes, 'ws', { text: 'y'.repeat(PARADIS_SPACE_NOTE_MAX_LENGTH), base: 101 });
		notes.full = true;
		const newSpace = paradisMobileNoteSet(notes, 'other', { text: 'new', base: 0 });
		const newSpaceOp = paradisMobileNoteSet(notes, 'other', { text: '- [ ] a', op: { kind: 'append', entry: 'a' } });
		const existingSpace = paradisMobileNoteSet(notes, 'ws', { text: 'edited', base: 102 });
		const full = { error: 'このスペースのメモを PC に保存できませんでした（メモのあるスペースの数が上限に達しています）' };
		assert.deepStrictEqual({
			tooLong,
			atLimit: { ...atLimit, text: (atLimit as { text?: string }).text?.length },
			newSpace,
			newSpaceOp,
			existingSpace,
			other: notes.read('other'),
		}, {
			tooLong: { error: `メモが長すぎるため保存しませんでした（${PARADIS_SPACE_NOTE_MAX_LENGTH} 文字まで）` },
			atLimit: { t: 'note', ws: 'ws', text: PARADIS_SPACE_NOTE_MAX_LENGTH, updatedAt: 102 },
			newSpace: full,
			newSpaceOp: full,
			existingSpace: { t: 'note', ws: 'ws', text: 'edited', updatedAt: 103 },
			other: '',
		});
	});
});

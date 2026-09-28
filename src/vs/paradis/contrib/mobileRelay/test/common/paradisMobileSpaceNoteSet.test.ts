/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSpaceNote, IParadisSpaceNotesService, IParadisSpaceNoteSummary, paradisSpaceNoteSummary } from '../../../workspaceSwitch/common/paradisSpaceNotes.js';
import { paradisMobileNoteGet, paradisMobileNoteSet, paradisParseMobileNoteOp } from '../../common/paradisMobileSpaceNoteSet.js';

/** 書くたびに版を1つ進めるメモ置き場（本物は時刻だが、増えることだけが大事）。 */
class FakeNotes implements IParadisSpaceNotesService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeNotes = Event.None;
	private readonly notes = new Map<string, IParadisSpaceNote>();
	private version = 100;

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
			toggled: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a', updatedAt: 102 },
			appended: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a\n- [ ] b', updatedAt: 103 },
			gone: { t: 'note', ws: 'ws', text: '- [ ] added on pc\n- [x] a\n- [ ] b', updatedAt: 103, conflict: true },
		});
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
});

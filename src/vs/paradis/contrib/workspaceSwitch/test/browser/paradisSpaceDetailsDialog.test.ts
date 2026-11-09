/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IParadisSpaceNote, IParadisSpaceNotesService } from '../../common/paradisSpaceNotes.js';
import { IParadisWorktree, IParadisWorktreeService } from '../../common/paradisWorkspaceSwitch.js';
import { IParadisSpaceDetailsInput, ParadisSpaceDetailsDialog } from '../../browser/paradisSpaceDetailsDialog.js';

suite('ParadisSpaceDetailsDialog', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;

	setup(() => {
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(container);
	});

	teardown(() => container.remove());

	/** メモと名前の保存先の偽物。`elsewhere` を渡すと、開いた後に別の場所が書き換えたことにする。 */
	function open(input: Partial<IParadisSpaceDetailsInput> & { readonly note?: string }) {
		let note: IParadisSpaceNote | undefined = input.note !== undefined ? { text: input.note, updatedAt: 1 } : undefined;
		const written: string[] = [];
		const renamed: string[] = [];
		const opened: string[] = [];
		const notesService = {
			readEntry: () => note,
			write: (_key: string, text: string) => { written.push(text); note = { text, updatedAt: (note?.updatedAt ?? 0) + 1 }; },
		} as unknown as IParadisSpaceNotesService;
		const worktreeService = { addKnownWorktree: (worktree: IParadisWorktree) => renamed.push(worktree.name) } as unknown as IParadisWorktreeService;
		const openerService = { open: async (uri: URI) => { opened.push(uri.toString()); return true; } } as unknown as IOpenerService;
		const worktree = { repositoryId: 'repo', name: 'feature-x', branch: 'feature/x', uri: URI.file('/tmp/repo-feature-x') } as IParadisWorktree;
		const dialog = store.add(new ParadisSpaceDetailsDialog({
			worktree,
			stateKey: 'worktree:feature-x',
			pullRequest: undefined,
			issues: [],
			...input,
		}, { activeContainer: container } as unknown as ILayoutService, notesService, worktreeService, openerService));
		const modal = container.querySelector<HTMLElement>('.paradis-space-details')!;
		const nameInput = modal.querySelector<HTMLInputElement>('.paradis-field input')!;
		const noteInput = modal.querySelector<HTMLTextAreaElement>('textarea')!;
		const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
			element.value = value;
			element.dispatchEvent(new Event('input', { bubbles: true }));
		};
		const saveByKeyboard = () => modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: !isMacintosh, metaKey: isMacintosh, bubbles: true }));
		return {
			dialog, modal, nameInput, noteInput, type, saveByKeyboard, written, renamed, opened,
			isOpen: () => container.querySelector('.paradis-space-details') !== null,
			setNoteElsewhere: (text: string) => { note = { text, updatedAt: 99 }; },
		};
	}

	test('a modal dialog of the M tier with the name, the linked work and the note; links open in the browser', () => {
		const fixture = open({
			note: '- [ ] task',
			pullRequest: { number: 12, title: 'Fix the badge', url: 'https://github.com/o/r/pull/12', state: 'open' },
			issues: [{ url: 'https://github.com/o/r/issues/3', status: undefined }],
		});
		const rows = [...fixture.modal.querySelectorAll<HTMLElement>('.psdd-linked-row')];
		rows[0].click();
		assert.deepStrictEqual({
			role: fixture.modal.getAttribute('role'),
			modal: fixture.modal.getAttribute('aria-modal'),
			tier: fixture.modal.classList.contains('paradis-modal-m'),
			name: fixture.nameInput.value,
			note: fixture.noteInput.value,
			count: fixture.modal.querySelector('.psdd-count')?.textContent,
			rows: rows.map(row => row.textContent),
			opened: fixture.opened,
		}, {
			role: 'dialog',
			modal: 'true',
			tier: true,
			name: 'feature-x',
			note: '- [ ] task',
			count: '2',
			rows: ['#12Fix the badgeopen', 'https://github.com/o/r/issues/3'],
			opened: ['https://github.com/o/r/pull/12'],
		});
	});

	test('Ctrl/Cmd+Enter saves only what changed and closes; an empty name stays open with the reason', () => {
		const fixture = open({ note: 'old' });
		fixture.type(fixture.nameInput, '   ');
		fixture.saveByKeyboard();
		const afterEmpty = { open: fixture.isOpen(), renamed: [...fixture.renamed], help: fixture.modal.querySelector('.psdd-help.error')?.textContent };

		fixture.type(fixture.nameInput, 'renamed');
		fixture.type(fixture.noteInput, 'new note');
		const dirty = !(fixture.modal.querySelector<HTMLElement>('.paradis-modal-foot > .paradis-chip')!.hidden);
		fixture.saveByKeyboard();
		assert.deepStrictEqual({ afterEmpty, dirty, renamed: fixture.renamed, written: fixture.written, open: fixture.isOpen() }, {
			afterEmpty: { open: true, renamed: [], help: '名前を空にすることはできません' },
			dirty: true,
			renamed: ['renamed'],
			written: ['new note'],
			open: false,
		});
	});

	test('a note changed elsewhere on the same line is not overwritten; the dialog stays open and says why', () => {
		const fixture = open({ note: 'line' });
		fixture.type(fixture.noteInput, 'mine');
		fixture.setNoteElsewhere('theirs');
		fixture.saveByKeyboard();
		assert.deepStrictEqual({ written: fixture.written, open: fixture.isOpen(), alert: !fixture.modal.querySelector<HTMLElement>('[role="alert"]')!.hidden }, {
			written: [],
			open: true,
			alert: true,
		});
		fixture.dialog.dispose();
	});

	test('a click outside closes only when nothing changed; Ctrl/Cmd+Enter while composing text does not save', () => {
		const fixture = open({ note: 'old' });
		const backdrop = container.querySelector<HTMLElement>('.paradis-space-details-backdrop')!;
		fixture.type(fixture.noteInput, 'changed');
		backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		const afterOutsideClick = fixture.isOpen();
		fixture.modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: !isMacintosh, metaKey: isMacintosh, isComposing: true, bubbles: true }));
		const afterComposingEnter = { open: fixture.isOpen(), written: [...fixture.written] };
		fixture.type(fixture.noteInput, 'old');
		backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.deepStrictEqual({ afterOutsideClick, afterComposingEnter, afterRevertAndClick: fixture.isOpen() }, {
			afterOutsideClick: true,
			afterComposingEnter: { open: true, written: [] },
			afterRevertAndClick: false,
		});
	});

	test('the main checkout keeps its name (the field is read only)', () => {
		const fixture = open({ worktree: { repositoryId: 'repo', name: 'repo', uri: URI.file('/tmp/repo'), isMainCheckout: true } as IParadisWorktree });
		fixture.saveByKeyboard();
		assert.deepStrictEqual({ disabled: fixture.nameInput.disabled, renamed: fixture.renamed, open: fixture.isOpen() }, { disabled: true, renamed: [], open: false });
	});
});

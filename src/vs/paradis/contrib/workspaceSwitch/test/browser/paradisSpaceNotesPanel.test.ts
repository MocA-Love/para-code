/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IParadisSpaceNotesService, IParadisSpaceNoteSummary, paradisSpaceNoteSummary, paradisToggleSpaceNoteTask } from '../../common/paradisSpaceNotes.js';
import { ParadisSpaceNotesPanel } from '../../browser/paradisSpaceNotesPanel.js';

const TASK_COUNT = 40;

suite('ParadisSpaceNotesPanel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the scroll position and the focused checkbox when a task is toggled', () => {
		const { notes, panel, body } = createPanel(store);
		panel.setSpace('worktree:a', 'a', undefined);
		const bottom = scrollToBottom(body);

		// チェックボックスにフォーカスがある状態でトグルすると、描き直しの途中で blur が走る
		const check = checkAt(body, TASK_COUNT - 1);
		check.focus();
		check.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));

		assert.deepStrictEqual({
			text: notes.read('worktree:a').split('\n')[TASK_COUNT - 1],
			scrollTop: body.scrollTop,
			focusedLine: focusedLineIndex(body),
		}, {
			text: `- [x] task ${TASK_COUNT - 1}`,
			scrollTop: bottom,
			focusedLine: TASK_COUNT - 1,
		});
	});

	test('keeps the scroll position on updates from another window without taking focus', () => {
		const { notes, panel, body } = createPanel(store);
		panel.setSpace('worktree:a', 'a', undefined);
		const bottom = scrollToBottom(body);

		notes.write('worktree:a', notes.read('worktree:a').replace('- [ ] task 3', '- [x] task 3'));

		assert.deepStrictEqual({ scrollTop: body.scrollTop, focusedLine: focusedLineIndex(body) }, { scrollTop: bottom, focusedLine: undefined });
	});

	test('starts a different space from the top', () => {
		const { notes, panel, body } = createPanel(store);
		notes.write('worktree:b', createTasks());
		panel.setSpace('worktree:a', 'a', undefined);
		scrollToBottom(body);

		panel.setSpace('worktree:b', 'b', undefined);

		assert.strictEqual(body.scrollTop, 0);
	});
});

function createTasks(): string {
	return Array.from({ length: TASK_COUNT }, (_, index) => `- [ ] task ${index}`).join('\n');
}

function scrollToBottom(body: HTMLElement): number {
	body.scrollTop = body.scrollHeight;
	assert.ok(body.scrollTop > 0, 'the fixture must be scrollable');
	return body.scrollTop;
}

/** フィクスチャは全行がチェックリストなので、n 番目のチェックボックスが n 行目にあたる。 */
function checks(body: HTMLElement): HTMLElement[] {
	return Array.from(body.getElementsByClassName('paradis-space-notes-check')) as HTMLElement[];
}

function checkAt(body: HTMLElement, lineIndex: number): HTMLElement {
	const check = checks(body)[lineIndex];
	assert.ok(check);
	return check;
}

function focusedLineIndex(body: HTMLElement): number | undefined {
	const index = checks(body).indexOf(body.ownerDocument.activeElement as HTMLElement);
	return index === -1 ? undefined : index;
}

function createPanel(store: Pick<DisposableStore, 'add'>) {
	const notes = store.add(new TestSpaceNotesService());
	notes.write('worktree:a', createTasks());

	const container = mainWindow.document.createElement('div');
	mainWindow.document.body.appendChild(container);
	store.add({ dispose: () => container.remove() });

	const storage = store.add(new InMemoryStorageService());
	const panel = store.add(new ParadisSpaceNotesPanel(
		container,
		notes,
		storage,
		new NullLogService(),
		{} as Partial<IContextMenuService> as IContextMenuService,
		{} as Partial<IClipboardService> as IClipboardService,
	));
	panel.layout(600);

	// テストではパネルの CSS を読み込まないので、本文をスクロールできる箱にする部分だけ当てる
	const body = container.getElementsByClassName('paradis-space-notes-body')[0] as HTMLElement | undefined;
	assert.ok(body);
	body.style.height = '100px';
	body.style.overflowY = 'auto';
	return { notes, panel, body };
}

/** 本物のサービスと同じく、変更を同期で通知するメモ置き場。 */
class TestSpaceNotesService implements IParadisSpaceNotesService {
	declare readonly _serviceBrand: undefined;

	private readonly notes = new Map<string, string>();
	private readonly _onDidChangeNotes = new Emitter<readonly string[]>();
	readonly onDidChangeNotes = this._onDidChangeNotes.event;

	read(stateKey: string): string {
		return this.notes.get(stateKey) ?? '';
	}

	summary(stateKey: string): IParadisSpaceNoteSummary {
		return paradisSpaceNoteSummary(this.read(stateKey));
	}

	write(stateKey: string, text: string): void {
		this.notes.set(stateKey, text);
		this._onDidChangeNotes.fire([stateKey]);
	}

	toggleTask(stateKey: string, lineIndex: number): void {
		const toggled = paradisToggleSpaceNoteTask(this.read(stateKey), lineIndex);
		if (toggled !== undefined) {
			this.write(stateKey, toggled);
		}
	}

	removeTask(): void { }

	updateTaskText(): void { }

	remove(stateKey: string): void {
		this.notes.delete(stateKey);
	}

	dispose(): void {
		this._onDidChangeNotes.dispose();
	}
}

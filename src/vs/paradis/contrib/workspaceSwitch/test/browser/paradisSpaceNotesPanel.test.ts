/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IAction } from '../../../../../base/common/actions.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, isDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IParadisSpaceNote, IParadisSpaceNotesService, IParadisSpaceNoteSummary, paradisRemoveSpaceNoteTask, paradisReplaceSpaceNoteTaskText, paradisSpaceNoteSummary, paradisToggleSpaceNoteTask } from '../../common/paradisSpaceNotes.js';
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

	test('follows the focused task by its text when another window removes a line above it', () => {
		const { notes, panel, body } = createPanel(store);
		panel.setSpace('worktree:a', 'a', undefined);
		checkAt(body, 20).focus();

		// 上の行が消えると同じ行番号 (20) には次のタスクが来る。そこへフォーカスを乗せると Space で誤って切り替わる
		notes.write('worktree:a', notes.read('worktree:a').split('\n').slice(1).join('\n'));
		const afterShift = focusedTaskText(body);

		// フォーカスしていた行そのものが消えたら、どこにも戻さない
		notes.write('worktree:a', notes.read('worktree:a').split('\n').filter(line => line !== '- [ ] task 20').join('\n'));

		assert.deepStrictEqual({ afterShift, afterRemoval: focusedTaskText(body) }, { afterShift: 'task 20', afterRemoval: undefined });
	});

	test('does not take focus from outside the panel on updates from another window', () => {
		const { notes, panel, body } = createPanel(store);
		panel.setSpace('worktree:a', 'a', undefined);
		const outside = mainWindow.document.createElement('input');
		mainWindow.document.body.appendChild(outside);
		store.add({ dispose: () => outside.remove() });
		outside.focus();

		notes.write('worktree:a', notes.read('worktree:a').replace('- [ ] task 3', '- [x] task 3'));

		assert.strictEqual(body.ownerDocument.activeElement, outside);
	});

	test('keeps the add input visible after adding a task', () => {
		const { notes, panel, body } = createPanel(store);
		panel.setSpace('worktree:a', 'a', undefined);
		scrollToBottom(body);

		body.getElementsByClassName('paradis-space-notes-add')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const input = body.getElementsByClassName('paradis-space-notes-add-input')[0] as HTMLTextAreaElement;
		input.value = 'new task';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

		const active = body.ownerDocument.activeElement as HTMLElement;
		const bodyRect = body.getBoundingClientRect();
		const activeRect = active.getBoundingClientRect();
		assert.deepStrictEqual({
			lastLine: notes.read('worktree:a').split('\n').at(-1),
			focused: active.classList.contains('paradis-space-notes-add-input'),
			visible: activeRect.top >= bodyRect.top && activeRect.bottom <= bodyRect.bottom,
		}, { lastLine: '- [ ] new task', focused: true, visible: true });
	});

	test('returns focus to the checkbox when a single-line edit is closed from the keyboard', () => {
		const contextMenu = new TestContextMenuService();
		const { notes, panel, body } = createPanel(store, contextMenu as Partial<IContextMenuService> as IContextMenuService);
		panel.setSpace('worktree:a', 'a', undefined);
		scrollToBottom(body);

		const editLine = (lineIndex: number, key: 'Enter' | 'Escape', value?: string) => {
			checkAt(body, lineIndex).parentElement!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
			contextMenu.run('paradis.spaceNotes.task.edit');
			const input = body.getElementsByClassName('paradis-space-notes-task-input')[0] as HTMLTextAreaElement;
			if (value !== undefined) {
				input.value = value;
			}
			input.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: key === 'Enter' ? 13 : 27, bubbles: true }));
			return focusedTaskText(body);
		};

		assert.deepStrictEqual({
			committed: editLine(TASK_COUNT - 2, 'Enter', 'renamed'),
			cancelled: editLine(TASK_COUNT - 3, 'Escape'),
			line: notes.read('worktree:a').split('\n')[TASK_COUNT - 2],
		}, {
			committed: 'renamed',
			cancelled: `task ${TASK_COUNT - 3}`,
			line: '- [ ] renamed',
		});
	});
});

suite('ParadisSpaceNotesPanel editing while the note changes elsewhere', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps a change made elsewhere when the edited lines do not overlap', () => {
		const { notes, panel, container } = createPanel(store);
		notes.write('worktree:b', '- [ ] one\n- [ ] two');
		panel.setSpace('worktree:b', 'b', undefined);
		const editor = startEditing(container);

		// 編集中にモバイルが1件足し、こちらは1行目を書き換える
		notes.write('worktree:b', '- [ ] one\n- [ ] two\n- [ ] from phone');
		editor.value = '- [ ] one (edited)\n- [ ] two';
		finishEditing(editor);

		assert.strictEqual(notes.read('worktree:b'), '- [ ] one (edited)\n- [ ] two\n- [ ] from phone');
	});

	test('does not overwrite an overlapping change and lets the user choose', () => {
		const notification = new TestNotificationService();
		const { notes, panel, container } = createPanel(store, undefined, notification as INotificationService);
		notes.write('worktree:b', '- [ ] one');
		panel.setSpace('worktree:b', 'b', undefined);
		const editor = startEditing(container);

		notes.write('worktree:b', '- [x] one');
		editor.value = '- [ ] one, but longer';
		finishEditing(editor);
		const kept = notes.read('worktree:b');
		notification.choose(0);

		assert.deepStrictEqual({ kept, prompts: notification.prompts.length, afterOverwrite: notes.read('worktree:b') }, { kept: '- [x] one', prompts: 1, afterOverwrite: '- [ ] one, but longer' });
	});

	test('writes directly when nothing else changed the note', () => {
		const notification = new TestNotificationService();
		const { notes, panel, container } = createPanel(store, undefined, notification as INotificationService);
		panel.setSpace('worktree:a', 'a', undefined);
		const editor = startEditing(container);

		editor.value = '- [ ] only';
		finishEditing(editor);

		assert.deepStrictEqual({ text: notes.read('worktree:a'), prompts: notification.prompts.length }, { text: '- [ ] only', prompts: 0 });
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

/** フォーカスのあるチェックボックスの行の文言。チェックボックス以外にフォーカスがあれば undefined。 */
function focusedTaskText(body: HTMLElement): string | undefined {
	const active = body.ownerDocument.activeElement as HTMLElement | null;
	if (!active || !checks(body).includes(active)) {
		return undefined;
	}
	return active.nextElementSibling?.textContent ?? undefined;
}

function createPanel(store: Pick<DisposableStore, 'add'>, contextMenu: IContextMenuService = {} as Partial<IContextMenuService> as IContextMenuService, notification: INotificationService = {} as Partial<INotificationService> as INotificationService) {
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
		contextMenu,
		{} as Partial<IClipboardService> as IClipboardService,
		notification,
	));
	panel.layout(600);

	// テストではパネルの CSS を読み込まないので、本文をスクロールできる箱にする部分だけ当てる
	const body = container.getElementsByClassName('paradis-space-notes-body')[0] as HTMLElement | undefined;
	assert.ok(body);
	body.style.height = '100px';
	body.style.overflowY = 'auto';
	return { notes, panel, body, container };
}

/** ヘッダーのペンで全体の編集を始め、編集欄を返す。 */
function startEditing(container: HTMLElement): HTMLTextAreaElement {
	const pen = container.querySelector('.paradis-space-notes-actions .action-label') as HTMLElement | null;
	assert.ok(pen);
	pen.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	const editor = container.getElementsByClassName('paradis-space-notes-editor')[0] as HTMLTextAreaElement | undefined;
	assert.ok(editor);
	return editor;
}

function finishEditing(editor: HTMLTextAreaElement): void {
	editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
}

/** 最後に出た知らせの文と選択肢を控え、選択肢を名前で押せるようにする。 */
class TestNotificationService implements Partial<INotificationService> {
	prompts: { readonly message: string; readonly choices: readonly IPromptChoice[] }[] = [];

	prompt(_severity: Severity, message: string, choices: IPromptChoice[]): INotificationHandle {
		this.prompts.push({ message, choices });
		return {} as INotificationHandle;
	}

	choose(index: number): void {
		const choice = this.prompts.at(-1)?.choices[index];
		assert.ok(choice);
		choice.run();
	}
}

/** 本物のサービスと同じく、変更を同期で通知するメモ置き場。 */
class TestSpaceNotesService implements IParadisSpaceNotesService {
	declare readonly _serviceBrand: undefined;

	private readonly notes = new Map<string, string>();
	private readonly versions = new Map<string, number>();
	private version = 0;
	private readonly _onDidChangeNotes = new Emitter<readonly string[]>();
	readonly onDidChangeNotes = this._onDidChangeNotes.event;

	read(stateKey: string): string {
		return this.notes.get(stateKey) ?? '';
	}

	readEntry(stateKey: string): IParadisSpaceNote | undefined {
		const text = this.notes.get(stateKey);
		return text !== undefined ? { text, updatedAt: this.versions.get(stateKey) ?? 0 } : undefined;
	}

	summary(stateKey: string): IParadisSpaceNoteSummary {
		return paradisSpaceNoteSummary(this.read(stateKey));
	}

	write(stateKey: string, text: string): void {
		this.notes.set(stateKey, text);
		this.versions.set(stateKey, ++this.version);
		this._onDidChangeNotes.fire([stateKey]);
	}

	toggleTask(stateKey: string, lineIndex: number): void {
		const toggled = paradisToggleSpaceNoteTask(this.read(stateKey), lineIndex);
		if (toggled !== undefined) {
			this.write(stateKey, toggled);
		}
	}

	removeTask(stateKey: string, lineIndex: number): void {
		const removed = paradisRemoveSpaceNoteTask(this.read(stateKey), lineIndex);
		if (removed !== undefined) {
			this.write(stateKey, removed);
		}
	}

	updateTaskText(stateKey: string, lineIndex: number, taskText: string): void {
		const replaced = paradisReplaceSpaceNoteTaskText(this.read(stateKey), lineIndex, taskText);
		if (replaced !== undefined) {
			this.write(stateKey, replaced);
		}
	}

	remove(stateKey: string): void {
		this.notes.delete(stateKey);
	}

	dispose(): void {
		this._onDidChangeNotes.dispose();
	}
}

/** 右クリックメニューを出さずに、最後に渡された項目を ID で実行できるようにする。 */
class TestContextMenuService implements Partial<IContextMenuService> {
	private actions: readonly IAction[] = [];

	showContextMenu(delegate: IContextMenuDelegate): void {
		this.actions = delegate.getActions();
	}

	run(id: string): void {
		const action = this.actions.find(candidate => candidate.id === id);
		assert.ok(action, `menu item ${id}`);
		action.run();
		// 本物のメニューと同じく項目はメニューを開くたびに作られるので、使い終わったら片付ける
		for (const candidate of this.actions) {
			if (isDisposable(candidate)) {
				candidate.dispose();
			}
		}
		this.actions = [];
	}
}

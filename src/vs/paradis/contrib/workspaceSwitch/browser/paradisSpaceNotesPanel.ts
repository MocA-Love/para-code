/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Action } from '../../../../base/common/actions.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisSpaceNoteLine, IParadisSpaceNotesService, PARADIS_SPACE_NOTE_MAX_LENGTH, paradisAppendSpaceNoteTask, paradisContinueSpaceNoteList, paradisParseSpaceNote, paradisToggleSpaceNoteListMarkers } from '../common/paradisSpaceNotes.js';

const HEADER_HEIGHT = 26;
const MIN_BODY_HEIGHT = 72;
const DEFAULT_BODY_HEIGHT = 180;
/** メモ欄を広げてもツリーに必ず残す高さ。 */
const MIN_TREE_HEIGHT = 90;

const PANEL_STATE_STORAGE_KEY = 'paradis.workspaceSwitch.spaceNotesPanel.v1';

// allow-any-unicode-next-line
const STR_EDIT = localize('paradis.spaceNotes.edit', "メモを編集");

interface IPanelState {
	readonly expanded: boolean;
	readonly bodyHeight: number;
}

function parsePanelState(raw: string | undefined): IPanelState {
	const fallback: IPanelState = { expanded: true, bodyHeight: DEFAULT_BODY_HEIGHT };
	if (raw === undefined || raw.length > 256) {
		return fallback;
	}
	try {
		const value = JSON.parse(raw) as { expanded?: unknown; bodyHeight?: unknown };
		if (typeof value !== 'object' || value === null) {
			return fallback;
		}
		const height = typeof value.bodyHeight === 'number' && isFinite(value.bodyHeight) ? value.bodyHeight : DEFAULT_BODY_HEIGHT;
		return {
			expanded: typeof value.expanded === 'boolean' ? value.expanded : true,
			bodyHeight: Math.max(MIN_BODY_HEIGHT, Math.min(2_000, Math.round(height)))
		};
	} catch {
		return fallback;
	}
}

/**
 * Workspaces ビュー下部に常駐する「いま開いているスペースのメモ」欄。
 *
 * - 表示モードでは Markdown のチェックリスト (`- [ ]` / `- [x]`) をチェックボックスとして描画し、
 *   クリックで完了をトグルして即保存する
 * - 本文をクリックすると textarea による編集モードになり、フォーカスアウト / Escape で保存する
 * - ヘッダーで開閉、上端の Sash で高さを変更でき、いずれも WORKSPACE ストレージに永続化する
 */
export class ParadisSpaceNotesPanel extends Disposable {

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	/** 開閉・高さが変わったので、ビュー側にツリーの再レイアウトを促す。 */
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	private readonly root: HTMLElement;
	private readonly header: HTMLElement;
	private readonly twistie: HTMLElement;
	private readonly spaceLabel: HTMLElement;
	private readonly spaceDot: HTMLElement;
	private readonly spaceName: HTMLElement;
	private readonly badge: HTMLElement;
	private readonly actionBar: ActionBar;
	private readonly bodyElement: HTMLElement;
	private readonly editorElement: HTMLTextAreaElement;
	private readonly sash: Sash;
	private readonly bodyDisposables = this._register(new DisposableStore());

	private readonly editAction: Action;

	private stateKey: string | undefined;
	private currentColorHex: string | undefined;
	private expanded: boolean;
	private bodyHeight: number;
	private editing = false;
	/** 「やることを追加」行が入力状態か。 */
	private adding = false;
	private availableHeight = 0;

	constructor(
		container: HTMLElement,
		@IParadisSpaceNotesService private readonly notesService: IParadisSpaceNotesService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		const state = parsePanelState(this.storageService.get(PANEL_STATE_STORAGE_KEY, StorageScope.WORKSPACE));
		this.expanded = state.expanded;
		this.bodyHeight = state.bodyHeight;

		this.root = DOM.append(container, DOM.$('.paradis-space-notes'));

		const header = this.header = DOM.append(this.root, DOM.$('.paradis-space-notes-header'));
		header.tabIndex = 0;
		header.setAttribute('role', 'button');
		this.twistie = DOM.append(header, DOM.$('.codicon'));
		// allow-any-unicode-next-line
		DOM.append(header, DOM.$('.paradis-space-notes-title')).textContent = localize('paradis.spaceNotes.title', "メモ");
		this.spaceLabel = DOM.append(header, DOM.$('.paradis-space-notes-space'));
		this.spaceDot = DOM.append(this.spaceLabel, DOM.$('.paradis-space-notes-dot'));
		this.spaceName = DOM.append(this.spaceLabel, DOM.$('span.paradis-space-notes-space-name'));
		this.badge = DOM.append(header, DOM.$('.paradis-space-notes-badge'));

		const actionsContainer = DOM.append(header, DOM.$('.paradis-space-notes-actions'));
		this.actionBar = this._register(new ActionBar(actionsContainer));
		this.editAction = this._register(new Action(
			'paradis.spaceNotes.toggleEdit',
			STR_EDIT,
			ThemeIcon.asClassName(Codicon.edit),
			true,
			async () => this.toggleEditing()
		));
		this.actionBar.push(this.editAction, { icon: true, label: false });

		this.bodyElement = DOM.append(this.root, DOM.$('.paradis-space-notes-body'));
		this.editorElement = DOM.append(this.root, DOM.$('textarea.paradis-space-notes-editor')) as HTMLTextAreaElement;
		this.editorElement.spellcheck = false;
		this.editorElement.maxLength = PARADIS_SPACE_NOTE_MAX_LENGTH;
		// allow-any-unicode-next-line
		this.editorElement.setAttribute('aria-label', localize('paradis.spaceNotes.editorAriaLabel', "スペースのメモ"));

		this.sash = this._register(new Sash(this.root, { getHorizontalSashTop: () => 0 }, { orientation: Orientation.HORIZONTAL }));
		this.registerListeners(header);
		this.render();
	}

	private registerListeners(header: HTMLElement): void {
		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, event => {
			// ヘッダー右のアクション (編集トグル) は開閉と別扱いにする
			if ((event.target as HTMLElement).closest('.paradis-space-notes-actions')) {
				return;
			}
			this.setExpanded(!this.expanded);
		}));
		this._register(DOM.addDisposableListener(header, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
				DOM.EventHelper.stop(event, true);
				this.setExpanded(!this.expanded);
			}
		}));

		this._register(DOM.addDisposableListener(this.bodyElement, DOM.EventType.CLICK, event => {
			// チェックリスト行と「やることを追加」行は自前の操作を持つので、編集モードへは入らない
			const target = event.target as HTMLElement;
			if (target.closest('.paradis-space-notes-task') || target.closest('.paradis-space-notes-add')) {
				return;
			}
			this.setEditing(true);
		}));

		this._register(DOM.addDisposableListener(this.editorElement, DOM.EventType.BLUR, () => this.setEditing(false)));
		this._register(DOM.addDisposableListener(this.editorElement, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			// Escape / Cmd+Enter で編集を終える (Enter 単独は改行 or チェックリストの継続)
			if (keyboardEvent.equals(KeyCode.Escape) || keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.Enter)) {
				DOM.EventHelper.stop(event, true);
				this.setEditing(false);
				return;
			}
			// Enter: チェックリスト行なら次の行へ `- [ ] ` を継続する
			if (keyboardEvent.equals(KeyCode.Enter) && this.editorElement.selectionStart === this.editorElement.selectionEnd) {
				const continued = paradisContinueSpaceNoteList(this.editorElement.value, this.editorElement.selectionStart);
				if (continued) {
					DOM.EventHelper.stop(event, true);
					this.editorElement.value = continued.text;
					this.editorElement.setSelectionRange(continued.caret, continued.caret);
				}
				return;
			}
			// Cmd+L: 選択行をチェックリストにする / 解除する
			if (keyboardEvent.equals(KeyMod.CtrlCmd | KeyCode.KeyL)) {
				DOM.EventHelper.stop(event, true);
				const toggled = paradisToggleSpaceNoteListMarkers(this.editorElement.value, this.editorElement.selectionStart, this.editorElement.selectionEnd);
				if (toggled) {
					this.editorElement.value = toggled.text;
					this.editorElement.setSelectionRange(toggled.selectionStart, toggled.selectionEnd);
				}
			}
		}));

		this._register(this.notesService.onDidChangeNotes(changed => {
			if (this.stateKey !== undefined && changed.includes(this.stateKey) && !this.editing) {
				this.render();
			}
		}));

		// 編集中の入力は blur まで textarea の中にしかない。ウィンドウの再読み込み・終了で
		// storage が閉じる前に書き出す (サービス側の onWillSaveState からは見えないため)
		this._register(this.storageService.onWillSaveState(() => {
			if (this.editing && this.stateKey !== undefined) {
				this.notesService.write(this.stateKey, this.editorElement.value);
			}
		}));

		let sashStartHeight: number | undefined;
		this.sash.state = SashState.Enabled;
		this._register(this.sash.onDidStart(() => sashStartHeight = this.bodyHeight));
		this._register(this.sash.onDidChange(event => {
			if (sashStartHeight === undefined) {
				return;
			}
			// 上へドラッグ (currentY が小さくなる) とメモ欄が広がる
			this.bodyHeight = this.clampBodyHeight(sashStartHeight - (event.currentY - event.startY));
			this.applyHeight();
			this._onDidChangeHeight.fire();
		}));
		this._register(this.sash.onDidEnd(() => {
			sashStartHeight = undefined;
			this.sash.layout();
			this.persistPanelState();
		}));
	}

	/** 表示対象のスペースを切り替える。stateKey が undefined ならメモ欄は無効表示になる。 */
	setSpace(stateKey: string | undefined, name: string, colorHex: string | undefined): void {
		// 呼び出し元 (リポジトリ/worktree の変化、スコープ切替) は同じスペースのまま何度も来る。
		// 同一なら何もしない (編集中の入力・IME 変換・スクロール位置を巻き込まないため)
		if (this.stateKey === stateKey && this.spaceName.textContent === name && this.currentColorHex === colorHex) {
			return;
		}
		this.currentColorHex = colorHex;
		this.adding = false;
		if (this.editing) {
			// 切り替え前の編集内容は切り替え先へ持ち越さず、元のスペースへ保存する
			this.setEditing(false);
		}
		this.stateKey = stateKey;
		this.spaceName.textContent = name;
		this.spaceDot.style.backgroundColor = colorHex ?? 'transparent';
		this.spaceDot.classList.toggle('hidden', colorHex === undefined);
		this.render();
	}

	/**
	 * ビューの高さを受け取り、メモ欄が実際に使う高さを返す。呼び出し側は
	 * 残り (height - 戻り値) をツリーに割り当てる。
	 */
	layout(availableHeight: number): number {
		this.availableHeight = availableHeight;
		this.applyHeight();
		this.sash.layout();
		return this.currentHeight();
	}

	/**
	 * ビューが低すぎるときは本文を出さない。最低高さを優先して押し込むと、ツリーの取り分が
	 * 0 になってワークスペース一覧そのものが見えなくなるため (開いた状態の記憶は変えないので、
	 * ビューを広げれば元に戻る)。
	 */
	private canShowBody(): boolean {
		return this.availableHeight >= HEADER_HEIGHT + MIN_BODY_HEIGHT + MIN_TREE_HEIGHT;
	}

	private isBodyVisible(): boolean {
		return this.expanded && this.canShowBody();
	}

	private currentHeight(): number {
		return this.isBodyVisible() ? HEADER_HEIGHT + this.clampBodyHeight(this.bodyHeight) : HEADER_HEIGHT;
	}

	private clampBodyHeight(height: number): number {
		const max = Math.max(MIN_BODY_HEIGHT, this.availableHeight - HEADER_HEIGHT - MIN_TREE_HEIGHT);
		return Math.max(MIN_BODY_HEIGHT, Math.min(max, Math.round(height)));
	}

	private applyHeight(): void {
		this.root.style.height = `${this.currentHeight()}px`;
		this.root.classList.toggle('collapsed', !this.isBodyVisible());
		this.sash.state = this.isBodyVisible() ? SashState.Enabled : SashState.Disabled;
	}

	private setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		if (!expanded && this.editing) {
			this.setEditing(false);
		}
		this.applyHeight();
		this.render();
		this.persistPanelState();
		this._onDidChangeHeight.fire();
	}

	private toggleEditing(): void {
		if (this.stateKey === undefined) {
			return;
		}
		if (!this.expanded) {
			this.setExpanded(true);
		}
		this.setEditing(!this.editing);
	}

	private setEditing(editing: boolean): void {
		if (this.editing === editing) {
			return;
		}
		if (editing) {
			if (this.stateKey === undefined) {
				return;
			}
			this.editing = true;
			this.adding = false;
			this.editorElement.value = this.notesService.read(this.stateKey);
			this.render();
			this.editorElement.focus();
			const end = this.editorElement.value.length;
			this.editorElement.setSelectionRange(end, end);
			return;
		}
		this.editing = false;
		if (this.stateKey !== undefined) {
			this.notesService.write(this.stateKey, this.editorElement.value);
		}
		this.render();
	}

	private render(): void {
		this.twistie.className = `codicon ${ThemeIcon.asClassName(this.expanded ? Codicon.chevronDown : Codicon.chevronRight).replace('codicon ', '')}`;
		this.header.setAttribute('aria-expanded', String(this.expanded));
		this.editAction.enabled = this.stateKey !== undefined;
		this.editAction.class = ThemeIcon.asClassName(this.editing ? Codicon.check : Codicon.edit);
		this.editAction.label = this.editing
			// allow-any-unicode-next-line
			? localize('paradis.spaceNotes.finishEdit', "編集を終える")
			: STR_EDIT;

		const text = this.stateKey !== undefined ? this.notesService.read(this.stateKey) : '';
		const summary = this.stateKey !== undefined ? this.notesService.summary(this.stateKey) : { open: 0, done: 0 };
		const total = summary.open + summary.done;
		this.badge.textContent = total > 0 ? `${summary.open}/${total}` : '';
		this.badge.classList.toggle('hidden', total === 0);

		this.bodyElement.classList.toggle('hidden', this.editing);
		this.editorElement.classList.toggle('hidden', !this.editing);
		if (this.editing) {
			return;
		}

		this.bodyDisposables.clear();
		DOM.clearNode(this.bodyElement);
		if (this.stateKey === undefined) {
			// allow-any-unicode-next-line
			DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-placeholder')).textContent = localize('paradis.spaceNotes.noSpace', "スペースを選ぶとメモを書けます。");
			return;
		}
		if (text.trim().length === 0) {
			// allow-any-unicode-next-line
			DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-placeholder')).textContent = localize('paradis.spaceNotes.empty', "このスペースのメモはまだありません。クリックして書き始められます。");
		} else {
			for (const line of paradisParseSpaceNote(text)) {
				this.renderLine(line);
			}
		}
		this.renderAddRow();
	}

	/**
	 * 末尾の「やることを追加」行。編集モードへ入らずにチェックリストを1件足せる。
	 * Enter で確定して続けて次を入力、Shift+Enter で改行 (2行目以降は継続行として保存)、
	 * Escape で終了する。
	 */
	private renderAddRow(): void {
		const row = DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-add'));
		const icon = DOM.append(row, DOM.$('.codicon'));
		icon.className = `codicon ${ThemeIcon.asClassName(Codicon.add).replace('codicon ', '')}`;

		if (!this.adding) {
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			// allow-any-unicode-next-line
			DOM.append(row, DOM.$('span.paradis-space-notes-add-label')).textContent = localize('paradis.spaceNotes.addTask', "やることを追加");
			const start = () => { this.adding = true; this.render(); };
			this.bodyDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, event => { DOM.EventHelper.stop(event, true); start(); }));
			this.bodyDisposables.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
				const keyboardEvent = new StandardKeyboardEvent(event);
				if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
					DOM.EventHelper.stop(event, true);
					start();
				}
			}));
			return;
		}

		const input = DOM.append(row, DOM.$('textarea.paradis-space-notes-add-input')) as HTMLTextAreaElement;
		input.rows = 1;
		input.spellcheck = false;
		input.maxLength = PARADIS_SPACE_NOTE_MAX_LENGTH;
		// allow-any-unicode-next-line
		input.placeholder = localize('paradis.spaceNotes.addPlaceholder', "やること（Shift+Enter で改行）");
		const autoGrow = () => {
			input.style.height = 'auto';
			input.style.height = `${input.scrollHeight}px`;
		};
		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, autoGrow));

		const commit = () => {
			if (this.stateKey === undefined) {
				return;
			}
			const appended = paradisAppendSpaceNoteTask(this.notesService.read(this.stateKey), input.value);
			if (appended !== undefined) {
				this.notesService.write(this.stateKey, appended);
			}
			// 続けて次を入力できるよう、行は開いたままにする
			input.value = '';
			autoGrow();
			this.render();
		};

		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.equals(KeyCode.Enter)) {
				// Shift+Enter は改行なので触らない (equals は修飾キー込みで一致を見る)
				DOM.EventHelper.stop(event, true);
				commit();
				return;
			}
			if (keyboardEvent.equals(KeyCode.Escape)) {
				DOM.EventHelper.stop(event, true);
				this.adding = false;
				this.render();
			}
		}));
		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.BLUR, () => {
			// 書きかけを捨てない: 中身があれば足してから閉じる
			if (input.value.trim().length > 0) {
				commit();
			}
			this.adding = false;
			this.render();
		}));

		input.focus();
		autoGrow();
	}

	private renderLine(line: IParadisSpaceNoteLine): void {
		switch (line.kind) {
			case 'blank':
				DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-blank'));
				return;
			case 'heading':
				DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-heading')).textContent = line.text;
				return;
			case 'text':
				DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-text')).textContent = line.text;
				return;
			case 'task': {
				const row = DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-task'));
				row.classList.toggle('done', line.done);
				const check = DOM.append(row, DOM.$('.paradis-space-notes-check'));
				check.tabIndex = 0;
				check.setAttribute('role', 'checkbox');
				check.setAttribute('aria-checked', String(line.done));
				check.setAttribute('aria-label', line.text);
				const checkIcon = DOM.append(check, DOM.$('.codicon'));
				checkIcon.className = `codicon ${ThemeIcon.asClassName(Codicon.check).replace('codicon ', '')}`;
				DOM.append(row, DOM.$('.paradis-space-notes-task-label')).textContent = line.text;

				const toggle = () => {
					if (this.stateKey !== undefined) {
						this.notesService.toggleTask(this.stateKey, line.index);
					}
				};
				// 14px のチェックボックスだけを的にせず、行のどこを押してもトグルできるようにする
				this.bodyDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, event => {
					DOM.EventHelper.stop(event, true);
					toggle();
				}));
				this.bodyDisposables.add(DOM.addDisposableListener(check, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
					const keyboardEvent = new StandardKeyboardEvent(event);
					if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
						DOM.EventHelper.stop(event, true);
						toggle();
					}
				}));
				return;
			}
		}
	}

	private persistPanelState(): void {
		try {
			this.storageService.store(
				PANEL_STATE_STORAGE_KEY,
				JSON.stringify({ expanded: this.expanded, bodyHeight: this.bodyHeight } satisfies IPanelState),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch {
			try {
				this.logService.warn('[ParadisSpaceNotes] Failed to persist panel state');
			} catch {
				// Diagnostics must not interrupt editing or view disposal.
			}
		}
	}

	override dispose(): void {
		// 編集途中で閉じられても入力を失わない
		if (this.editing && this.stateKey !== undefined) {
			this.notesService.write(this.stateKey, this.editorElement.value);
			this.editing = false;
		}
		super.dispose();
	}
}

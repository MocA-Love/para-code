/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as DOM from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Action, Separator } from '../../../../base/common/actions.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../../../platform/storage/common/storage.js';
import { IParadisSpaceNoteLine, IParadisSpaceNotesService, PARADIS_SPACE_NOTE_MAX_LENGTH, paradisAppendSpaceNoteTask, paradisContinueSpaceNoteList, paradisMergeSpaceNoteEdits, paradisParseSpaceNote, paradisToggleSpaceNoteListMarkers } from '../common/paradisSpaceNotes.js';

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
 * 編集欄の中身を書き出すきっかけ。
 * - `finish`: 編集を終えた (フォーカスアウト・Escape・スペースの切り替え)。重なる変更があれば書かずに知らせる
 * - `interim`: 編集を続けたまま storage が書き出す前。他で変わっていれば書かない (終えるときに合わせる)
 * - `shutdown`: ウィンドウを閉じる直前。知らせる先が無いので、重なる変更があれば今までどおり編集欄の中身で書く
 */
type EditorSaveMode = 'finish' | 'interim' | 'shutdown';

/** 描き直しをまたいでフォーカスを戻す先のチェックリスト行。text が undefined なら行番号だけで探す。 */
interface IFocusedTask {
	readonly index: number;
	readonly text: string | undefined;
}

/**
 * Workspaces ビュー下部に常駐する「いま開いているスペースのメモ」欄。
 *
 * - 表示モードでは Markdown のチェックリスト (`- [ ]` / `- [x]`) をチェックボックスとして描画し、
 *   クリックで完了をトグルして即保存する
 * - ヘッダー右のペンを押すと textarea による編集モードになり、フォーカスアウト / Escape で保存する
 *   (本文のクリックでは編集モードに入らない)
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
	/** 「この項目を編集」で1行だけ入力状態にしているチェックリストの行番号。 */
	private editingTaskIndex: number | undefined;
	private availableHeight = 0;
	/** 本文を最後に描いたときのスペース。別のスペースへ切り替えた描き直しではスクロール位置を持ち越さない。 */
	private renderedStateKey: string | undefined;
	/** 描いたチェックボックスを行番号で引く。描き直しの後に同じ行へフォーカスを戻すのに使う。 */
	private readonly taskChecks = new Map<number, { readonly check: HTMLElement; readonly text: string }>();
	/**
	 * 次の描き直しでフォーカスを置く行。1行編集を Enter / Escape で閉じたとき、消える入力欄の代わりに
	 * その行のチェックボックスへ戻すために使う (確定の保存が描き直しを同期で起こすので、保存の前に置く)。
	 */
	private pendingTaskFocus: IFocusedTask | undefined;
	/**
	 * 編集を始めたとき (と途中で書き出したとき) のメモの本文と版。編集中に別の場所 (モバイル・エージェント・
	 * 他のウィンドウ) が同じメモを書き換えていたら、終えるときにそれを消さずに合わせるために使う (Orca W2-16)。
	 */
	private editBase: { readonly text: string; readonly updatedAt: number } = { text: '', updatedAt: 0 };

	constructor(
		container: HTMLElement,
		@IParadisSpaceNotesService private readonly notesService: IParadisSpaceNotesService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
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
				// 他ウィンドウが同じスペースを書き換えると行番号の指す先が変わりうるので、
				// 1行編集は開いたままにせず閉じる
				this.editingTaskIndex = undefined;
				this.render();
			}
		}));

		// 編集中の入力は blur まで textarea の中にしかない。ウィンドウの再読み込み・終了で
		// storage が閉じる前に書き出す (サービス側の onWillSaveState からは見えないため)
		this._register(this.storageService.onWillSaveState(event => {
			if (this.editing && this.stateKey !== undefined) {
				this.saveEditor(this.stateKey, this.editorElement.value, event.reason === WillSaveStateReason.SHUTDOWN ? 'shutdown' : 'interim');
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
		this.editingTaskIndex = undefined;
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
		if (!expanded) {
			// 畳んだ本文の中で入力欄にフォーカスが残らないようにする
			this.adding = false;
			this.editingTaskIndex = undefined;
			if (this.editing) {
				this.setEditing(false);
			}
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
			this.editingTaskIndex = undefined;
			const entry = this.notesService.readEntry(this.stateKey);
			this.editBase = { text: entry?.text ?? '', updatedAt: entry?.updatedAt ?? 0 };
			this.editorElement.value = this.editBase.text;
			this.render();
			this.editorElement.focus();
			const end = this.editorElement.value.length;
			this.editorElement.setSelectionRange(end, end);
			return;
		}
		this.editing = false;
		if (this.stateKey !== undefined) {
			this.saveEditor(this.stateKey, this.editorElement.value, 'finish');
		}
		this.render();
	}

	/**
	 * 編集欄の中身を書き出す。編集を始めてから誰も書いていなければそのまま書く。別の場所が書いていれば、
	 * 直した行が重ならない限り両方を合わせて書く。重なっていれば `mode` に従う ({@link EditorSaveMode})。
	 */
	private saveEditor(stateKey: string, value: string, mode: EditorSaveMode): void {
		const current = this.notesService.readEntry(stateKey);
		const currentText = current?.text ?? '';
		const changedElsewhere = (current?.updatedAt ?? 0) !== this.editBase.updatedAt;
		if (changedElsewhere && mode === 'interim') {
			return;
		}
		const merged = changedElsewhere ? paradisMergeSpaceNoteEdits(this.editBase.text, value, currentText) : value;
		if (merged === undefined && mode === 'finish') {
			this.editBase = { text: currentText, updatedAt: current?.updatedAt ?? 0 };
			this.notifyConflict(stateKey, value, current?.updatedAt ?? 0);
			return;
		}
		this.notesService.write(stateKey, merged ?? value);
		const written = this.notesService.readEntry(stateKey);
		this.editBase = { text: written?.text ?? '', updatedAt: written?.updatedAt ?? 0 };
	}

	/**
	 * 同じ行が別の場所でも直されていて合わせられなかったので、編集を保存せずに選んでもらう。
	 * `version` は知らせを出したときのメモの版。「上書き」を押すまでの間にさらに書き換えられていたら、
	 * 見ていない変更を消さないよう、上書きせずにもう一度知らせる。
	 */
	private notifyConflict(stateKey: string, value: string, version: number, again = false): void {
		this.notificationService.prompt(
			Severity.Warning,
			!again
				// allow-any-unicode-next-line
				? localize('paradis.spaceNotes.conflict', "メモを編集している間に、同じ行がスマホやエージェントからも書き換えられていたため、編集を保存していません。いまの表示は書き換えた後のメモです。")
				// allow-any-unicode-next-line
				: localize('paradis.spaceNotes.conflictAgain', "上書きする前に、メモがさらに書き換えられました。いまの表示を確かめてから選んでください。"),
			[
				{
					// allow-any-unicode-next-line
					label: localize('paradis.spaceNotes.conflictOverwrite', "自分の編集で上書き"),
					run: () => {
						const latest = this.notesService.readEntry(stateKey)?.updatedAt ?? 0;
						if (latest !== version) {
							this.notifyConflict(stateKey, value, latest, true);
							return;
						}
						this.notesService.write(stateKey, value);
					},
				},
				{
					// allow-any-unicode-next-line
					label: localize('paradis.spaceNotes.conflictCopy', "自分の編集をコピー"),
					run: () => this.clipboardService.writeText(value),
				},
			],
		);
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
		// 1行編集を閉じたときに置いた戻り先は、この描き直しで使わなくても持ち越さない (全体の編集へ移った後や、
		// 後の別の描き直しで古い行番号へフォーカスを戻さないため)
		const pendingTaskFocus = this.pendingTaskFocus;
		this.pendingTaskFocus = undefined;
		if (this.editing) {
			return;
		}

		// 本文は毎回作り直す。フォーカス中の要素 (チェックボックスや入力欄) を消すと、Chromium は
		// その場で blur を配って同期レイアウトを走らせ、行が抜けて高さの無い本文の scrollTop を 0 に
		// 丸める。後から行を足し直しても戻らないので、同じスペースの描き直しなら位置とフォーカスを
		// 消す前に控えて書き戻す (トグル・他ウィンドウやモバイルからの更新・1行編集の確定で共通)
		const sameSpace = this.renderedStateKey !== undefined && this.renderedStateKey === this.stateKey;
		const scrollTop = sameSpace ? this.bodyElement.scrollTop : 0;
		const focusedTask = sameSpace ? (pendingTaskFocus ?? this.focusedTask()) : undefined;
		this.renderedStateKey = this.stateKey;

		this.bodyDisposables.clear();
		this.taskChecks.clear();
		DOM.clearNode(this.bodyElement);
		if (this.stateKey === undefined) {
			// allow-any-unicode-next-line
			DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-placeholder')).textContent = localize('paradis.spaceNotes.noSpace', "スペースを選ぶとメモを書けます。");
			return;
		}
		if (text.trim().length === 0) {
			// allow-any-unicode-next-line
			DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-placeholder')).textContent = localize('paradis.spaceNotes.empty', "このスペースのメモはまだありません。右上のペンから書き始められます。");
		} else {
			for (const line of paradisParseSpaceNote(text)) {
				this.renderLine(line);
			}
		}
		this.renderAddRow();
		this.restoreScrollAndFocus(scrollTop, focusedTask);
	}

	/**
	 * 本文内のチェックボックスにフォーカスがあれば、その行を返す。ウィンドウが前面に無いときに
	 * 届く外部更新でも読めるよう、前面の document ではなくこの本文が属する document を見る。
	 */
	private focusedTask(): IFocusedTask | undefined {
		const active = this.bodyElement.ownerDocument.activeElement;
		for (const [index, task] of this.taskChecks) {
			if (task.check === active) {
				return { index, text: task.text };
			}
		}
		return undefined;
	}

	/**
	 * 描き直した後のどのチェックボックスへフォーカスを戻すか。行番号だけで戻すと、他ウィンドウで
	 * 上の行が消えたときに別のタスクへフォーカスが乗り、続く Space で違う項目を切り替えてしまう。
	 * 同じ行番号で文言も同じ → 文言が同じ行 (元の行番号に近いもの) の順で探し、無ければ戻さない。
	 */
	private findTaskCheck(task: IFocusedTask): HTMLElement | undefined {
		const sameIndex = this.taskChecks.get(task.index);
		if (sameIndex && (task.text === undefined || sameIndex.text === task.text)) {
			return sameIndex.check;
		}
		if (task.text === undefined) {
			return undefined;
		}
		let nearest: { readonly check: HTMLElement; readonly distance: number } | undefined;
		for (const [index, candidate] of this.taskChecks) {
			const distance = Math.abs(index - task.index);
			if (candidate.text === task.text && (!nearest || distance < nearest.distance)) {
				nearest = { check: candidate.check, distance };
			}
		}
		return nearest?.check;
	}

	private restoreScrollAndFocus(scrollTop: number, focusedTask: IFocusedTask | undefined): void {
		if (focusedTask !== undefined) {
			// キーボードで続けて操作できるようにフォーカスを戻す。位置は下で書き戻すのでここでは動かさない
			this.findTaskCheck(focusedTask)?.focus({ preventScroll: true });
		}
		// 別のスペースへ切り替えた描き直しでは 0 (先頭) を書く。フォーカスが無いと clearNode でも
		// 位置が丸められず、前のスペースのスクロール位置のまま開いてしまうため
		this.bodyElement.scrollTop = scrollTop;
		// 「やることを追加」や1行編集の入力欄は描き直しの中でフォーカスされる。書き戻した位置で
		// 入力欄が見えなくならないよう、本文の中だけで見える位置まで動かす (scrollIntoView は
		// 外側の overflow: hidden の祖先まで動かしてしまうので使わない)
		const active = this.bodyElement.ownerDocument.activeElement;
		if (DOM.isHTMLElement(active) && active !== this.bodyElement && this.bodyElement.contains(active) && !active.classList.contains('paradis-space-notes-check')) {
			const bodyRect = this.bodyElement.getBoundingClientRect();
			const activeRect = active.getBoundingClientRect();
			if (activeRect.bottom > bodyRect.bottom) {
				this.bodyElement.scrollTop += activeRect.bottom - bodyRect.bottom;
			} else if (activeRect.top < bodyRect.top) {
				this.bodyElement.scrollTop -= bodyRect.top - activeRect.top;
			}
		}
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

		// 見える位置へは描き直しの最後 (restoreScrollAndFocus) で本文の中だけ動かす
		input.focus({ preventScroll: true });
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
				if (this.editingTaskIndex === line.index) {
					this.renderTaskEditRow(line);
					return;
				}
				const row = DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-task'));
				row.classList.toggle('done', line.done);
				const check = this.appendTaskCheck(row);
				this.taskChecks.set(line.index, { check, text: line.text });
				check.tabIndex = 0;
				check.setAttribute('role', 'checkbox');
				check.setAttribute('aria-checked', String(line.done));
				check.setAttribute('aria-label', line.text);
				DOM.append(row, DOM.$('.paradis-space-notes-task-label')).textContent = line.text;

				const toggle = () => {
					if (this.stateKey !== undefined) {
						this.notesService.toggleTask(this.stateKey, line.index);
					}
				};
				// 14px のチェックボックスだけを的にせず、行のどこを押してもトグルできるようにする
				this.bodyDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, (event: MouseEvent) => {
					// macOS の Ctrl+クリックは右クリックと同じ扱い (メニューを出してトグルはしない)
					if (event.button !== 0 || event.ctrlKey) {
						return;
					}
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
				this.bodyDisposables.add(DOM.addDisposableListener(row, DOM.EventType.CONTEXT_MENU, (event: MouseEvent) => {
					DOM.EventHelper.stop(event, true);
					this.showTaskContextMenu(line, row, new StandardMouseEvent(DOM.getWindow(row), event));
				}));
				return;
			}
		}
	}

	private appendTaskCheck(row: HTMLElement): HTMLElement {
		const check = DOM.append(row, DOM.$('.paradis-space-notes-check'));
		const checkIcon = DOM.append(check, DOM.$('.codicon'));
		checkIcon.className = `codicon ${ThemeIcon.asClassName(Codicon.check).replace('codicon ', '')}`;
		return check;
	}

	/**
	 * 右クリックした1件だけに効くメニュー。チェックリスト行からのみ開く
	 * (見出し・本文行・「やることを追加」行では出さない)。
	 */
	private showTaskContextMenu(line: IParadisSpaceNoteLine, row: HTMLElement, anchor: StandardMouseEvent): void {
		const stateKey = this.stateKey;
		if (stateKey === undefined) {
			return;
		}
		// どの行に対するメニューなのかを、開いているあいだ見えるようにする
		row.classList.add('context-open');
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			onHide: () => row.classList.remove('context-open'),
			getActions: () => [
				new Action(
					'paradis.spaceNotes.task.toggle',
					line.done
						// allow-any-unicode-next-line
						? localize('paradis.spaceNotes.task.undone', "未完了に戻す")
						// allow-any-unicode-next-line
						: localize('paradis.spaceNotes.task.done', "完了にする"),
					undefined,
					true,
					async () => this.notesService.toggleTask(stateKey, line.index)
				),
				new Separator(),
				new Action(
					'paradis.spaceNotes.task.edit',
					// allow-any-unicode-next-line
					localize('paradis.spaceNotes.task.edit', "この項目を編集"),
					undefined,
					true,
					async () => this.startEditingTask(line.index)
				),
				new Action(
					'paradis.spaceNotes.task.copy',
					// allow-any-unicode-next-line
					localize('paradis.spaceNotes.task.copy', "テキストをコピー"),
					undefined,
					true,
					async () => this.clipboardService.writeText(line.text)
				),
				new Separator(),
				new Action(
					'paradis.spaceNotes.task.delete',
					// allow-any-unicode-next-line
					localize('paradis.spaceNotes.task.delete', "削除"),
					undefined,
					true,
					async () => this.notesService.removeTask(stateKey, line.index)
				)
			]
		});
	}

	private startEditingTask(lineIndex: number): void {
		this.adding = false;
		this.editingTaskIndex = lineIndex;
		this.render();
	}

	/**
	 * 「この項目を編集」で開く1行入力。チェック状態とぶら下がる継続行は保ったまま文言だけ差し替える。
	 * Enter で確定、Escape で取り消し、フォーカスアウトでも確定する (メモ全体の編集と揃える)。
	 */
	private renderTaskEditRow(line: IParadisSpaceNoteLine): void {
		const row = DOM.append(this.bodyElement, DOM.$('.paradis-space-notes-task.editing'));
		row.classList.toggle('done', line.done);
		this.appendTaskCheck(row);

		const input = DOM.append(row, DOM.$('textarea.paradis-space-notes-task-input')) as HTMLTextAreaElement;
		input.rows = 1;
		input.spellcheck = false;
		input.maxLength = PARADIS_SPACE_NOTE_MAX_LENGTH;
		input.value = line.text;
		// allow-any-unicode-next-line
		input.setAttribute('aria-label', localize('paradis.spaceNotes.task.editAriaLabel', "やることを編集"));
		const autoGrow = () => {
			input.style.height = 'auto';
			input.style.height = `${input.scrollHeight}px`;
		};
		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, autoGrow));

		// 確定・取り消しのどちらでも行を組み直すため、外れた入力欄からの blur で二重に走らせない
		let finished = false;
		const finish = (commit: boolean, returnFocus: boolean) => {
			// 他ウィンドウの更新などで編集が閉じられた後に届いた blur では書き戻さない
			// (行番号が指す先が変わっている可能性があるため)
			if (finished || this.editingTaskIndex !== line.index) {
				finished = true;
				return;
			}
			finished = true;
			const value = input.value;
			this.editingTaskIndex = undefined;
			// Enter / Escape で閉じたときは、消える入力欄の代わりにその行のチェックボックスへ戻す
			// (blur で閉じたときはフォーカスが既に他所へ移っているので奪わない)
			if (returnFocus) {
				this.pendingTaskFocus = { index: line.index, text: undefined };
			}
			if (commit && this.stateKey !== undefined) {
				this.notesService.updateTaskText(this.stateKey, line.index, value);
			}
			this.render();
		};

		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			// 1行のやることを直す場所なので、Shift+Enter でも行は増やさない
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyMod.Shift | KeyCode.Enter)) {
				DOM.EventHelper.stop(event, true);
				finish(true, true);
				return;
			}
			if (keyboardEvent.equals(KeyCode.Escape)) {
				DOM.EventHelper.stop(event, true);
				finish(false, true);
			}
		}));
		this.bodyDisposables.add(DOM.addDisposableListener(input, DOM.EventType.BLUR, () => finish(true, false)));

		// 見える位置へは描き直しの最後 (restoreScrollAndFocus) で本文の中だけ動かす
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
		autoGrow();
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
			this.saveEditor(this.stateKey, this.editorElement.value, 'shutdown');
			this.editing = false;
		}
		super.dispose();
	}
}

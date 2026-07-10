/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// コマンドプリセットの管理ダイアログ（一覧 ⇄ 編集フォームの2ビュー構成）。
// 保存先として「ユーザー設定（settings.json）」と「このリポジトリ（.paracode.json）」を選べる。
// ダイアログの実装様式は paradisYouTubeImportDialog.ts / paradisCreateWorktreeDialog.ts と同じ
// 自前 DOM + backdrop 方式。

import './media/paradisPresetEditorDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { getAllCodicons } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { basename } from '../../../../base/common/resources.js';
import {
	IParadisPresetDefinition,
	IParadisPresetService,
	IParadisPresetTask,
	IParadisResolvedPreset,
	paradisGetPresetTasks,
	paradisPresetCommandSignature,
	ParadisPresetLayout,
	ParadisPresetSource,
	PARADIS_WORKSPACE_PRESET_FILE,
} from '../common/paradisTerminalPresets.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.presetEditor.title', "コマンドプリセット");
// allow-any-unicode-next-line
const STR_EMPTY = localize('paradis.presetEditor.empty', "プリセットがまだありません。「新規作成」から追加できます。");
// allow-any-unicode-next-line
const STR_NEW = localize('paradis.presetEditor.new', "新規作成");
// allow-any-unicode-next-line
const STR_CLOSE = localize('paradis.presetEditor.close', "閉じる");
// allow-any-unicode-next-line
const STR_RUN = localize('paradis.presetEditor.run', "実行");
// allow-any-unicode-next-line
const STR_EDIT = localize('paradis.presetEditor.edit', "編集");
// allow-any-unicode-next-line
const STR_DELETE = localize('paradis.presetEditor.delete', "削除");
// allow-any-unicode-next-line
const STR_NAME = localize('paradis.presetEditor.name', "名前");
// allow-any-unicode-next-line
const STR_DESCRIPTION = localize('paradis.presetEditor.description', "説明（任意）");
// allow-any-unicode-next-line
const STR_TASKS = localize('paradis.presetEditor.tasks', "ターミナル（1枚ごとに名前・作業ディレクトリ・コマンドを指定）");
// allow-any-unicode-next-line
const STR_TASK_NAME = localize('paradis.presetEditor.taskName', "ターミナル名（任意）");
// allow-any-unicode-next-line
const STR_TASK_CWD = localize('paradis.presetEditor.taskCwd', "作業ディレクトリ（任意）");
// allow-any-unicode-next-line
const STR_TASK_COMMANDS_PLACEHOLDER = localize('paradis.presetEditor.taskCommands', "コマンド（1行に1つ、上から順に実行）");
// allow-any-unicode-next-line
const STR_ADD_TASK = localize('paradis.presetEditor.addTask', "＋ ターミナルを追加");
// allow-any-unicode-next-line
const STR_ICON = localize('paradis.presetEditor.icon', "アイコン（一覧をクリックして選択。入力で絞り込み）");
// allow-any-unicode-next-line
const STR_ICON_EMPTY = localize('paradis.presetEditor.iconEmpty', "一致するアイコンがありません。");
// allow-any-unicode-next-line
const STR_CWD = localize('paradis.presetEditor.cwd', "既定の作業ディレクトリ（任意。ターミナル側で未指定のときに使用。相対パスはリポジトリルート基準）");
// allow-any-unicode-next-line
const STR_LAYOUT = localize('paradis.presetEditor.layout', "ターミナルの並べ方");
// allow-any-unicode-next-line
const STR_LAYOUT_TABS = localize('paradis.presetEditor.layout.tabs', "タブで並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_SPLIT = localize('paradis.presetEditor.layout.split', "分割して並べる");
// allow-any-unicode-next-line
const STR_LAYOUT_CURRENT = localize('paradis.presetEditor.layout.current', "アクティブなターミナルで実行（全コマンド連結）");
// allow-any-unicode-next-line
const STR_PINNED = localize('paradis.presetEditor.pinned', "ターミナルタブバー右側にボタンとして表示する");
// allow-any-unicode-next-line
const STR_PINNED_LABEL = localize('paradis.presetEditor.pinnedLabel', "ボタンにアイコンの代わりに名前を表示する");
// allow-any-unicode-next-line
const STR_AUTORUN = localize('paradis.presetEditor.autoRun', "「新しいスペース（worktree）を作成」直後に自動実行する");
// allow-any-unicode-next-line
const STR_TARGET = localize('paradis.presetEditor.target', "保存先");
// allow-any-unicode-next-line
const STR_TARGET_USER = localize('paradis.presetEditor.targetUser', "ユーザー設定（すべてのリポジトリ）");
// allow-any-unicode-next-line
const strTargetWorkspace = (repoName: string) => localize('paradis.presetEditor.targetWorkspace', "このリポジトリ（{0}/.paracode.json — コミットで共有できます）", repoName);
// allow-any-unicode-next-line
const STR_APPLIES_TO = localize('paradis.presetEditor.appliesTo', "対象リポジトリ（任意。1行に1つ、フォルダ名または絶対パス。空欄は全リポジトリ）");
// allow-any-unicode-next-line
const STR_BACK = localize('paradis.presetEditor.back', "戻る");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.presetEditor.save', "保存");
// allow-any-unicode-next-line
const STR_NAME_REQUIRED = localize('paradis.presetEditor.nameRequired', "名前を入力してください。");
// allow-any-unicode-next-line
const STR_COMMANDS_REQUIRED = localize('paradis.presetEditor.commandsRequired', "コマンドを1つ以上入力してください。");
// allow-any-unicode-next-line
const strDeleteConfirm = (name: string) => localize('paradis.presetEditor.deleteConfirm', "プリセット「{0}」を削除しますか？", name);
// allow-any-unicode-next-line
const STR_SOURCE_USER = localize('paradis.presetEditor.sourceUser', "ユーザー");
// allow-any-unicode-next-line
const STR_SOURCE_WORKSPACE = localize('paradis.presetEditor.sourceWorkspace', "リポジトリ");

// アイコンピッカーに出す全codicon（アルファベット順）。モジュールロード時に一度だけ確定する。
const ALL_CODICONS = getAllCodicons().sort((a, b) => a.id.localeCompare(b.id));

const LAYOUT_LABELS: readonly { layout: ParadisPresetLayout; label: string }[] = [
	{ layout: 'tabs', label: STR_LAYOUT_TABS },
	{ layout: 'split', label: STR_LAYOUT_SPLIT },
	{ layout: 'current', label: STR_LAYOUT_CURRENT },
];

// 開いているダイアログの参照。コマンド・設定内リンク・タブバーのボタンなど複数の入り口から
// 呼ばれるため、多重に開いて重ならないようにシングルトンにする。
let paradisActivePresetEditorDialog: ParadisPresetEditorDialog | undefined;

export function openParadisPresetEditorDialog(accessor: ServicesAccessor): void {
	if (paradisActivePresetEditorDialog) {
		return;
	}
	// ダイアログは自身の close で自己 dispose する
	paradisActivePresetEditorDialog = new ParadisPresetEditorDialog(
		accessor.get(ILayoutService),
		accessor.get(IParadisPresetService),
		accessor.get(IDialogService),
		accessor.get(IWorkspaceContextService),
	);
}

class ParadisPresetEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;
	private readonly _viewStore = this._register(new DisposableStore());
	private _mode: 'list' | 'edit' = 'list';

	constructor(
		layoutService: ILayoutService,
		private readonly presetService: IParadisPresetService,
		private readonly dialogService: IDialogService,
		private readonly contextService: IWorkspaceContextService,
	) {
		super();

		this._backdrop = $('.paradis-preset-editor-backdrop');
		this._dialog = $('.paradis-preset-editor-dialog');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape') {
				e.preventDefault();
				if (this._mode === 'edit') {
					this._renderList();
				} else {
					this.dispose();
				}
			}
		}));
		this._register(this.presetService.onDidChangePresets(() => {
			if (this._mode === 'list') {
				this._renderList();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderList();
	}

	override dispose(): void {
		if (paradisActivePresetEditorDialog === this) {
			paradisActivePresetEditorDialog = undefined;
		}
		this._backdrop.remove();
		super.dispose();
	}

	// --- 一覧ビュー -------------------------------------------------------------------------------

	private _renderList(): void {
		this._mode = 'list';
		this._viewStore.clear();
		dom.clearNode(this._dialog);

		dom.append(this._dialog, $('h3.ppe-title')).textContent = STR_TITLE;

		const list = dom.append(this._dialog, $('.ppe-list'));
		const presets = this.presetService.presets;
		if (presets.length === 0) {
			dom.append(list, $('.ppe-empty')).textContent = STR_EMPTY;
		}
		for (const preset of presets) {
			const row = dom.append(list, $('.ppe-row'));
			const iconEl = dom.append(row, $('span.ppe-row-icon'));
			iconEl.classList.add(...ThemeIcon.asClassNameArray(preset.icon ? ThemeIcon.fromId(preset.icon) : ThemeIcon.fromId('play')));
			const main = dom.append(row, $('.ppe-row-main'));
			const nameLine = dom.append(main, $('.ppe-row-name'));
			nameLine.textContent = preset.name;
			const badge = dom.append(nameLine, $('span.ppe-badge'));
			badge.textContent = preset.source === 'workspace' ? STR_SOURCE_WORKSPACE : STR_SOURCE_USER;
			badge.classList.toggle('workspace', preset.source === 'workspace');
			dom.append(main, $('.ppe-row-detail')).textContent = preset.description || paradisPresetCommandSignature(preset, ' && ');

			const actions = dom.append(row, $('.ppe-row-actions'));
			const runBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
			runBtn.textContent = STR_RUN;
			this._viewStore.add(dom.addDisposableListener(runBtn, 'click', async () => {
				this.dispose();
				await this.presetService.runPreset(preset);
			}));
			const editBtn = dom.append(actions, $('button.ppe-btn')) as HTMLButtonElement;
			editBtn.textContent = STR_EDIT;
			this._viewStore.add(dom.addDisposableListener(editBtn, 'click', () => this._renderEdit(preset)));
			const deleteBtn = dom.append(actions, $('button.ppe-btn.ppe-btn-danger')) as HTMLButtonElement;
			deleteBtn.textContent = STR_DELETE;
			this._viewStore.add(dom.addDisposableListener(deleteBtn, 'click', async () => {
				const result = await this.dialogService.confirm({ message: strDeleteConfirm(preset.name), primaryButton: STR_DELETE });
				if (result.confirmed) {
					await this.presetService.deletePreset(preset);
				}
			}));
		}

		const footer = dom.append(this._dialog, $('.ppe-footer'));
		const closeBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		closeBtn.textContent = STR_CLOSE;
		this._viewStore.add(dom.addDisposableListener(closeBtn, 'click', () => this.dispose()));
		const newBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		newBtn.textContent = STR_NEW;
		this._viewStore.add(dom.addDisposableListener(newBtn, 'click', () => this._renderEdit(undefined)));
	}

	// --- 編集ビュー -------------------------------------------------------------------------------

	private _renderEdit(editing: IParadisResolvedPreset | undefined): void {
		this._mode = 'edit';
		this._viewStore.clear();
		dom.clearNode(this._dialog);

		dom.append(this._dialog, $('h3.ppe-title')).textContent = editing ? `${STR_TITLE} — ${editing.name}` : `${STR_TITLE} — ${STR_NEW}`;

		const form = dom.append(this._dialog, $('.ppe-form'));

		const field = (label: string): HTMLElement => {
			const wrap = dom.append(form, $('.ppe-field'));
			dom.append(wrap, $('label.ppe-label')).textContent = label;
			return wrap;
		};

		const nameInput = dom.append(field(STR_NAME), $('input.ppe-input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.value = editing?.name ?? '';

		const descriptionInput = dom.append(field(STR_DESCRIPTION), $('input.ppe-input')) as HTMLInputElement;
		descriptionInput.type = 'text';
		descriptionInput.value = editing?.description ?? '';

		// タスク（＝ターミナル）カードの編集領域。ドラフトは配列で持ち、追加・削除・並べ替えのたびに再描画する
		interface ITaskDraft { name: string; cwd: string; commands: string }
		const initialTasks: readonly IParadisPresetTask[] = editing ? paradisGetPresetTasks(editing).tasks : [];
		const taskDrafts: ITaskDraft[] = initialTasks.length > 0
			? initialTasks.map(task => ({ name: task.name ?? '', cwd: task.cwd ?? '', commands: task.commands.join('\n') }))
			: [{ name: '', cwd: '', commands: '' }];
		const tasksField = field(STR_TASKS);
		const tasksContainer = dom.append(tasksField, $('.ppe-tasks'));
		const addTaskBtn = dom.append(tasksField, $('button.ppe-btn.ppe-add-task')) as HTMLButtonElement;
		addTaskBtn.type = 'button';
		addTaskBtn.textContent = STR_ADD_TASK;
		// 再描画のたびにカード内リスナーを作り直すため、カード群専用の store を分ける
		const tasksStore = this._viewStore.add(new MutableDisposable<DisposableStore>());
		const renderTasks = () => {
			const store = tasksStore.value = new DisposableStore();
			dom.clearNode(tasksContainer);
			taskDrafts.forEach((draft, index) => {
				const card = dom.append(tasksContainer, $('.ppe-task-card'));
				const head = dom.append(card, $('.ppe-task-head'));
				const nameInput = dom.append(head, $('input.ppe-input.ppe-task-name')) as HTMLInputElement;
				nameInput.type = 'text';
				nameInput.placeholder = STR_TASK_NAME;
				nameInput.value = draft.name;
				store.add(dom.addDisposableListener(nameInput, 'input', () => { draft.name = nameInput.value; }));
				const cwdInput = dom.append(head, $('input.ppe-input.ppe-task-cwd')) as HTMLInputElement;
				cwdInput.type = 'text';
				cwdInput.placeholder = STR_TASK_CWD;
				cwdInput.spellcheck = false;
				cwdInput.value = draft.cwd;
				store.add(dom.addDisposableListener(cwdInput, 'input', () => { draft.cwd = cwdInput.value; }));
				const headBtn = (label: string, disabled: boolean, onClick: () => void): void => {
					const btn = dom.append(head, $('button.ppe-btn.ppe-task-btn')) as HTMLButtonElement;
					btn.type = 'button';
					btn.textContent = label;
					btn.disabled = disabled;
					store.add(dom.addDisposableListener(btn, 'click', onClick));
				};
				// allow-any-unicode-next-line
				headBtn('↑', index === 0, () => {
					[taskDrafts[index - 1], taskDrafts[index]] = [taskDrafts[index], taskDrafts[index - 1]];
					renderTasks();
				});
				// allow-any-unicode-next-line
				headBtn('↓', index === taskDrafts.length - 1, () => {
					[taskDrafts[index + 1], taskDrafts[index]] = [taskDrafts[index], taskDrafts[index + 1]];
					renderTasks();
				});
				// allow-any-unicode-next-line
				headBtn('✕', taskDrafts.length === 1, () => {
					taskDrafts.splice(index, 1);
					renderTasks();
				});
				const commandsInput = dom.append(card, $('textarea.ppe-input.ppe-commands')) as HTMLTextAreaElement;
				commandsInput.rows = 3;
				commandsInput.spellcheck = false;
				commandsInput.placeholder = STR_TASK_COMMANDS_PLACEHOLDER;
				commandsInput.value = draft.commands;
				store.add(dom.addDisposableListener(commandsInput, 'input', () => { draft.commands = commandsInput.value; }));
			});
		};
		renderTasks();
		this._viewStore.add(dom.addDisposableListener(addTaskBtn, 'click', () => {
			taskDrafts.push({ name: '', cwd: '', commands: '' });
			renderTasks();
		}));

		const layoutSelect = dom.append(field(STR_LAYOUT), $('select.ppe-input.ppe-select')) as HTMLSelectElement;
		for (const { layout, label } of LAYOUT_LABELS) {
			const option = dom.append(layoutSelect, $('option')) as HTMLOptionElement;
			option.value = layout;
			option.textContent = label;
		}
		layoutSelect.value = editing ? paradisGetPresetTasks(editing).layout : 'tabs';

		const iconField = field(STR_ICON);
		const iconRow = dom.append(iconField, $('.ppe-icon-row'));
		const iconInput = dom.append(iconRow, $('input.ppe-input.ppe-icon-input')) as HTMLInputElement;
		iconInput.type = 'text';
		iconInput.placeholder = 'play';
		iconInput.value = editing?.icon ?? '';
		const iconPreview = dom.append(iconRow, $('span.ppe-icon-preview'));
		const iconGrid = dom.append(iconField, $('.ppe-icon-grid'));
		const updateIconPreview = () => {
			iconPreview.className = 'ppe-icon-preview';
			const iconId = iconInput.value.trim() || 'play';
			iconPreview.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.fromId(iconId)));
		};
		// セルは一度だけ生成し、絞り込みは表示切替のみで行う（約750個のDOM再構築を
		// キーストロークごとに繰り返さないため）
		const iconGridEmpty = dom.append(iconGrid, $('.ppe-icon-grid-empty'));
		iconGridEmpty.textContent = STR_ICON_EMPTY;
		const iconCells: { readonly id: string; readonly cell: HTMLButtonElement }[] = [];
		for (const icon of ALL_CODICONS) {
			const cell = dom.append(iconGrid, $('button.ppe-icon-cell')) as HTMLButtonElement;
			cell.type = 'button';
			cell.title = icon.id;
			cell.dataset.iconId = icon.id;
			cell.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
			iconCells.push({ id: icon.id, cell });
		}
		const renderIconGrid = () => {
			const filter = iconInput.value.trim().toLowerCase();
			let visible = 0;
			for (const { id, cell } of iconCells) {
				const show = !filter || id.includes(filter);
				cell.style.display = show ? '' : 'none';
				cell.classList.toggle('selected', id === filter);
				if (show) {
					visible++;
				}
			}
			iconGridEmpty.style.display = visible === 0 ? '' : 'none';
		};
		updateIconPreview();
		renderIconGrid();
		this._viewStore.add(dom.addDisposableListener(iconInput, 'input', () => {
			updateIconPreview();
			renderIconGrid();
		}));
		// クリックはセルごとではなくグリッド1箇所に委譲する（絞り込みのたびのリスナー蓄積を避ける）
		this._viewStore.add(dom.addDisposableListener(iconGrid, 'click', e => {
			const cell = (e.target as HTMLElement).closest<HTMLElement>('.ppe-icon-cell');
			const iconId = cell?.dataset.iconId;
			if (iconId) {
				iconInput.value = iconId;
				updateIconPreview();
				renderIconGrid();
			}
		}));

		const cwdInput = dom.append(field(STR_CWD), $('input.ppe-input')) as HTMLInputElement;
		cwdInput.type = 'text';
		cwdInput.placeholder = './apps/web';
		cwdInput.spellcheck = false;
		cwdInput.value = editing?.cwd ?? '';

		const checkbox = (label: string, checked: boolean): HTMLInputElement => {
			const wrap = dom.append(form, $('.ppe-check-row'));
			const input = dom.append(wrap, $('input.ppe-checkbox')) as HTMLInputElement;
			input.type = 'checkbox';
			input.checked = checked;
			const labelEl = dom.append(wrap, $('label.ppe-check-label'));
			labelEl.textContent = label;
			this._viewStore.add(dom.addDisposableListener(labelEl, 'click', () => {
				input.checked = !input.checked;
				// ラベルクリックでのトグルでも change 連動（pinnedLabel の表示切替）を効かせる
				input.dispatchEvent(new Event('change'));
			}));
			return input;
		};
		const pinnedInput = checkbox(STR_PINNED, editing?.pinned !== false);
		const pinnedLabelInput = checkbox(STR_PINNED_LABEL, editing?.pinnedLabel === true);
		const pinnedLabelRow = pinnedLabelInput.parentElement as HTMLElement;
		pinnedLabelRow.classList.add('ppe-check-row-sub');
		const updatePinnedLabelVisibility = () => {
			pinnedLabelRow.style.display = pinnedInput.checked ? '' : 'none';
		};
		updatePinnedLabelVisibility();
		this._viewStore.add(dom.addDisposableListener(pinnedInput, 'change', updatePinnedLabelVisibility));
		const autoRunInput = checkbox(STR_AUTORUN, editing?.autoRun === true);

		// 保存先（既存編集時は変更不可）
		const folder = this.contextService.getWorkspace().folders[0];
		const targetField = field(STR_TARGET);
		const targetRow = dom.append(targetField, $('.ppe-target-row'));
		const makeTargetRadio = (value: ParadisPresetSource, label: string, disabled: boolean): HTMLInputElement => {
			const wrap = dom.append(targetRow, $('.ppe-check-row'));
			const input = dom.append(wrap, $('input.ppe-radio')) as HTMLInputElement;
			input.type = 'radio';
			input.name = 'ppe-target';
			input.value = value;
			input.disabled = disabled;
			const labelEl = dom.append(wrap, $('label.ppe-check-label'));
			labelEl.textContent = label;
			if (!disabled) {
				this._viewStore.add(dom.addDisposableListener(labelEl, 'click', () => {
					input.checked = true;
					updateAppliesToVisibility();
				}));
			}
			return input;
		};
		const userRadio = makeTargetRadio('user', STR_TARGET_USER, !!editing);
		const workspaceRadio = makeTargetRadio('workspace', folder ? strTargetWorkspace(basename(folder.uri)) : PARADIS_WORKSPACE_PRESET_FILE, !!editing || !folder);
		if (editing) {
			(editing.source === 'workspace' ? workspaceRadio : userRadio).checked = true;
			(editing.source === 'workspace' ? workspaceRadio : userRadio).disabled = false;
			(editing.source === 'workspace' ? userRadio : workspaceRadio).disabled = true;
		} else {
			userRadio.checked = true;
		}

		// appliesTo（保存先がユーザー設定のときのみ表示）
		const appliesToField = field(STR_APPLIES_TO);
		const appliesToInput = dom.append(appliesToField, $('textarea.ppe-input')) as HTMLTextAreaElement;
		appliesToInput.rows = 2;
		appliesToInput.spellcheck = false;
		appliesToInput.value = editing?.appliesTo?.join('\n') ?? '';
		const updateAppliesToVisibility = () => {
			appliesToField.style.display = userRadio.checked ? '' : 'none';
		};
		updateAppliesToVisibility();
		for (const radio of [userRadio, workspaceRadio]) {
			this._viewStore.add(dom.addDisposableListener(radio, 'change', updateAppliesToVisibility));
		}

		const errorEl = dom.append(this._dialog, $('.ppe-error'));

		const footer = dom.append(this._dialog, $('.ppe-footer'));
		const backBtn = dom.append(footer, $('button.ppe-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		this._viewStore.add(dom.addDisposableListener(backBtn, 'click', () => this._renderList()));
		const saveBtn = dom.append(footer, $('button.ppe-btn.ppe-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._viewStore.add(dom.addDisposableListener(saveBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				errorEl.textContent = STR_NAME_REQUIRED;
				return;
			}
			const tasks: IParadisPresetTask[] = taskDrafts
				.map(draft => ({
					name: draft.name.trim() || undefined,
					cwd: draft.cwd.trim() || undefined,
					commands: draft.commands.split('\n').map(line => line.trim()).filter(line => line.length > 0),
				}))
				.filter(task => task.commands.length > 0);
			if (tasks.length === 0) {
				errorEl.textContent = STR_COMMANDS_REQUIRED;
				return;
			}
			const appliesTo = appliesToInput.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
			// 保存は常に新形式（tasks + layout）。旧形式の commands / launchMode はここで移行される
			const definition: IParadisPresetDefinition = {
				name,
				description: descriptionInput.value.trim() || undefined,
				tasks,
				layout: layoutSelect.value as ParadisPresetLayout,
				icon: iconInput.value.trim() || undefined,
				cwd: cwdInput.value.trim() || undefined,
				pinned: pinnedInput.checked,
				pinnedLabel: pinnedInput.checked && pinnedLabelInput.checked ? true : undefined,
				autoRun: autoRunInput.checked,
				appliesTo: userRadio.checked && appliesTo.length > 0 ? appliesTo : undefined,
			};
			const target: ParadisPresetSource = workspaceRadio.checked ? 'workspace' : 'user';
			try {
				await this.presetService.savePreset(definition, target, editing?.name);
				this._renderList();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
			}
		}));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// リポジトリの Setup / Teardown スクリプト（.paracode.json の setupScript / teardownScript）を
// 編集するダイアログ。Workspaces ビューのリポジトリ行コンテキストメニューから開く。
// 背景の暗幕は paradisCreateWorktreeDialog.ts と同じ（同じ CSS の backdrop）。箱は共通の S 段（paradisModal.ts）で、
// 見出しの帯・本文・下端の帯を持ち、ボタンと閉じるボタンは本家の部品を使う。

import './media/paradisCreateWorktreeDialog.css';
import './media/paradisWorkspaceLifecycleDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisModalSize, paradisModalClasses } from '../../../browser/paradisModal.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisWorkspaceRepository } from '../common/paradisWorkspaceSwitch.js';
import { IParadisWorkspaceLifecycleConfig, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES, paradisParseWorkspaceLifecycleConfig, paradisUpdateWorkspaceLifecycleConfig } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_PROJECT_ROOT_ENV_VAR, PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';
import { IParadisWorktreeIncludeConfig, PARADIS_WORKTREE_INCLUDE_FILE, PARADIS_WORKTREE_INCLUDE_MAX_ENTRIES, paradisNormalizeWorktreeIncludePath, paradisParseWorktreeIncludeConfig, paradisParseWorktreeIncludeFile, paradisUpdateWorktreeIncludeConfig } from '../common/paradisWorktreeInclude.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.workspaceLifecycle.title', "Setup / Teardown スクリプト");
// allow-any-unicode-next-line
const STR_DESCRIPTION = localize('paradis.workspaceLifecycle.summary', "{0} に保存し、worktree の作成・削除のたびに実行します。", PARADIS_WORKSPACE_PRESET_FILE);
// allow-any-unicode-next-line
const STR_DETAILS = localize('paradis.workspaceLifecycle.details', "詳しく");
// allow-any-unicode-next-line
const STR_DETAILS_HOVER = localize('paradis.workspaceLifecycle.detailsHover', "コミットすればチーム全体・全 worktree に反映されます。どちらも対象の worktree を作業ディレクトリとして実行し、既定では最長 {1} 分で打ち切ります（{0} に setupTimeoutMinutes / teardownTimeoutMinutes を書けば変えられます）。実行時は環境変数 {2} に親リポジトリの絶対パスが渡されます。保存すると、{0} のコメントは消えます。", PARADIS_WORKSPACE_PRESET_FILE, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES, PARADIS_PROJECT_ROOT_ENV_VAR);
// allow-any-unicode-next-line
const STR_SETUP_LABEL = localize('paradis.workspaceLifecycle.setupShortLabel', "Setup（作成の直後）");
// allow-any-unicode-next-line
const STR_TEARDOWN_LABEL = localize('paradis.workspaceLifecycle.teardownShortLabel', "Teardown（削除の前）");
// allow-any-unicode-next-line
const STR_INCLUDE_TITLE = localize('paradis.workspaceLifecycle.includeTitle', "新しいスペースへ持ち込むもの");
// allow-any-unicode-next-line
const STR_INCLUDE_DESCRIPTION = localize('paradis.workspaceLifecycle.includeDescription', "git が無視しているファイルも、作成の直後に元のリポジトリから持ち込みます。");
// allow-any-unicode-next-line
const STR_INCLUDE_COPY = localize('paradis.workspaceLifecycle.includeCopy', "写す");
// allow-any-unicode-next-line
const STR_INCLUDE_LINK = localize('paradis.workspaceLifecycle.includeLink', "リンク");
// allow-any-unicode-next-line
const STR_INCLUDE_ADD = localize('paradis.workspaceLifecycle.includeAdd', "パスを追加");
// allow-any-unicode-next-line
const STR_INCLUDE_PLACEHOLDER = localize('paradis.workspaceLifecycle.includePlaceholder', "リポジトリからの相対パス（例: .env）");
// allow-any-unicode-next-line
const STR_INCLUDE_TOO_MANY = localize('paradis.workspaceLifecycle.includeTooMany', "持ち込むものは {0} 件までです。", PARADIS_WORKTREE_INCLUDE_MAX_ENTRIES);
// allow-any-unicode-next-line
const STR_INCLUDE_LINK_NOTE = localize('paradis.workspaceLifecycle.includeLinkNote', "リンクは元のフォルダを共有します（フォルダだけ）。node_modules のように並列のビルドで書き換わるフォルダは、リンクにすると作業がぶつかるので写すを選んでください。写すのは 1 回の作成で合わせて 2 GB・5 万ファイルまでです。");
// allow-any-unicode-next-line
const STR_CLOSE = localize('paradis.workspaceLifecycle.close', "閉じる");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.workspaceLifecycle.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.workspaceLifecycle.save', "保存");
// allow-any-unicode-next-line
const STR_SAVING = localize('paradis.workspaceLifecycle.saving', "保存中…");

/** リポジトリ直下の .paracode.json へ setupScript / teardownScript を書き込む。presets 等の既存フィールドは保持する。 */
export async function paradisSaveWorkspaceLifecycleConfig(fileService: IFileService, repositoryUri: URI, config: IParadisWorkspaceLifecycleConfig, include?: IParadisWorktreeIncludeConfig): Promise<void> {
	const configUri = joinPath(repositoryUri, PARADIS_WORKSPACE_PRESET_FILE);
	let existing: string | undefined;
	try {
		existing = (await fileService.readFile(configUri)).value.toString();
	} catch (error) {
		if (toFileOperationResult(error as Error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; }
	}
	const hasInclude = include !== undefined && (include.include.length > 0 || include.sharedDirectories.length > 0);
	if (existing === undefined && !config.setupScript?.trim() && !config.teardownScript?.trim() && !hasInclude) {
		return;
	}
	const lifecycleUpdated = paradisUpdateWorkspaceLifecycleConfig(existing, config);
	// 持ち込みの宣言は渡されたときだけ書き換える（渡さない呼び出し元は今の宣言を残す）
	const updated = include === undefined ? lifecycleUpdated : paradisUpdateWorktreeIncludeConfig(lifecycleUpdated, include);
	await fileService.writeFile(configUri, VSBuffer.fromString(updated));
}

// 開いているダイアログの参照。複数の入り口から呼ばれても多重に開かないようにする
let paradisActiveWorkspaceLifecycleDialog: ParadisWorkspaceLifecycleDialog | undefined;

export function openParadisWorkspaceLifecycleDialog(accessor: ServicesAccessor, repository: IParadisWorkspaceRepository): void {
	if (paradisActiveWorkspaceLifecycleDialog) {
		paradisActiveWorkspaceLifecycleDialog.focusInput();
		return;
	}
	// ダイアログは自身の close で自己 dispose する
	paradisActiveWorkspaceLifecycleDialog = new ParadisWorkspaceLifecycleDialog(
		accessor.get(ILayoutService),
		accessor.get(IFileService),
		accessor.get(IHoverService),
		repository,
	);
}

class ParadisWorkspaceLifecycleDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;

	private _setupInput!: HTMLTextAreaElement;
	private _teardownInput!: HTMLTextAreaElement;
	private _copyList!: ParadisIncludePathList;
	private _linkList!: ParadisIncludePathList;
	private _includeFileNote!: HTMLElement;
	private _errorEl!: HTMLElement;
	private _saveBtn!: Button;
	private _cancelBtn!: Button;
	private _busy = false;
	/**
	 * 今のスクリプトを読み終えたか。読み終える前に保存すると、空の入力欄で既存のスクリプトを上書きして消すので、
	 * それまで保存を押せなくする（読めなかったとき、ファイルが無いときを除き、ずっと押せない）。
	 */
	private _loaded = false;

	constructor(
		layoutService: ILayoutService,
		private readonly fileService: IFileService,
		private readonly hoverService: IHoverService,
		private readonly repository: IParadisWorkspaceRepository,
	) {
		super();

		this._backdrop = $('.paradis-create-worktree-backdrop.paradis-modal-backdrop');
		this._dialog = $('.paradis-workspace-lifecycle-dialog');
		this._dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		this._dialog.setAttribute('role', 'dialog');
		this._dialog.setAttribute('aria-modal', 'true');
		// Esc を受けるためにフォーカスできるようにする（ParadisModalFocus が中身の描き直しの後に戻す先）
		this._dialog.tabIndex = -1;
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop && !this._busy) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		// 中の欄へフォーカスを移す前に作る（開く前の場所を覚えて、閉じたらそこへ戻す）。Esc は重なった中の一番上だけが受ける
		// 別のモーダルが開いても、保存している間は閉じない（その上に重なる）
		this._register(new ParadisModalFocus({ backdrop: this._backdrop, modal: this._dialog, onEscape: () => this._onEscape(), close: () => { if (!this._busy) { this.dispose(); } } }));
		this._renderForm();
		void this._loadExisting();
	}

	/** Esc: パスを足している途中ならそれだけをやめる。保存している間は閉じない。 */
	private _onEscape(): void {
		if (this._copyList.cancelAdding() || this._linkList.cancelAdding()) {
			return;
		}
		if (!this._busy) {
			this.dispose();
		}
	}

	/** 既に開いているダイアログへの再オープン要求時に入力へフォーカスを当てる。 */
	focusInput(): void {
		this._setupInput.focus();
	}

	override dispose(): void {
		if (paradisActiveWorkspaceLifecycleDialog === this) {
			paradisActiveWorkspaceLifecycleDialog = undefined;
		}
		this._backdrop.remove();
		super.dispose();
	}

	private _renderForm(): void {
		dom.clearNode(this._dialog);

		const header = dom.append(this._dialog, $('.plc-header'));
		const title = dom.append(header, $('h3.plc-title'));
		title.textContent = STR_TITLE;
		title.id = 'paradis-lifecycle-title';
		this._dialog.setAttribute('aria-labelledby', title.id);
		const closeBar = this._register(new ActionBar(dom.append(header, $('.plc-header-actions'))));
		closeBar.push(toAction({ id: 'paradis.workspaceLifecycle.close', label: STR_CLOSE, class: ThemeIcon.asClassName(Codicon.close), run: () => { if (!this._busy) { this.dispose(); } } }), { icon: true, label: false });

		const body = dom.append(this._dialog, $('.plc-body'));
		const description = dom.append(body, $('.plc-description'));
		dom.append(description, $('span')).textContent = STR_DESCRIPTION;
		const details = dom.append(description, $('span.plc-details.paradis-focus-ring'));
		details.textContent = STR_DETAILS;
		details.tabIndex = 0;
		details.setAttribute('role', 'button');
		details.setAttribute('aria-label', STR_DETAILS_HOVER);
		// キーボードで移ったときも同じホバーを出す
		this._register(this.hoverService.setupDelayedHover(details, { content: STR_DETAILS_HOVER, container: this._backdrop }, { setupKeyboardEvents: true }));

		const include = dom.append(body, $('.plc-include'));
		dom.append(include, $('.plc-include-title')).textContent = STR_INCLUDE_TITLE;
		dom.append(include, $('.plc-include-description')).textContent = STR_INCLUDE_DESCRIPTION;
		this._copyList = this._register(new ParadisIncludePathList(include, STR_INCLUDE_COPY, () => this._totalIncludeCount(), message => { this._errorEl.textContent = message; }));
		this._linkList = this._register(new ParadisIncludePathList(include, STR_INCLUDE_LINK, () => this._totalIncludeCount(), message => { this._errorEl.textContent = message; }));
		this._includeFileNote = dom.append(include, $('.plc-include-note'));
		this._includeFileNote.hidden = true;
		dom.append(include, $('.plc-include-note')).textContent = STR_INCLUDE_LINK_NOTE;

		this._setupInput = this._appendScriptField(body, 'paradis-lifecycle-setup-input', STR_SETUP_LABEL);
		this._teardownInput = this._appendScriptField(body, 'paradis-lifecycle-teardown-input', STR_TEARDOWN_LABEL);

		this._errorEl = dom.append(body, $('.plc-error'));
		this._errorEl.setAttribute('role', 'alert');

		const footer = dom.append(this._dialog, $('.plc-footer'));
		this._cancelBtn = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		this._cancelBtn.label = STR_CANCEL;
		this._register(this._cancelBtn.onDidClick(() => this.dispose()));
		this._saveBtn = this._register(new Button(footer, { ...defaultButtonStyles }));
		this._saveBtn.label = STR_SAVE;
		this._saveBtn.enabled = false;
		this._register(this._saveBtn.onDidClick(() => void this._save()));
	}

	/** 欄の名前と、等幅のスクリプトの入力欄（3 行）。読み終えるまでは打てない（読んだ値で、打った文字を上書きしないため）。 */
	private _appendScriptField(parent: HTMLElement, id: string, labelText: string): HTMLTextAreaElement {
		const label = dom.append(parent, $('label.plc-label')) as HTMLLabelElement;
		label.textContent = labelText;
		label.htmlFor = id;
		const input = dom.append(parent, $('textarea.plc-script')) as HTMLTextAreaElement;
		input.id = id;
		input.rows = 3;
		input.spellcheck = false;
		input.readOnly = true;
		return input;
	}

	private async _loadExisting(): Promise<void> {
		try {
			const configUri = joinPath(this.repository.uri, PARADIS_WORKSPACE_PRESET_FILE);
			const content = (await this.fileService.readFile(configUri)).value.toString();
			const config = paradisParseWorkspaceLifecycleConfig(content);
			this._setupInput.value = config.setupScript ?? '';
			this._teardownInput.value = config.teardownScript ?? '';
			const include = paradisParseWorktreeIncludeConfig(content);
			this._copyList.setPaths(include.include);
			this._linkList.setPaths(include.sharedDirectories);
		} catch (error) {
			if (toFileOperationResult(error as Error) !== FileOperationResult.FILE_NOT_FOUND) {
				// 読めなかった。保存すると読めなかった中身を上書きしうるので、押せないままにする
				this._errorEl.textContent = toErrorMessage(error);
				return;
			}
		}
		if (this._store.isDisposed) {
			return;
		}
		await this._showIncludeFileNote();
		if (this._store.isDisposed) {
			return;
		}
		this._loaded = true;
		this._copyList.setEnabled(true);
		this._linkList.setEnabled(true);
		this._setupInput.readOnly = false;
		this._teardownInput.readOnly = false;
		this._saveBtn.enabled = !this._busy;
		this.focusInput();
	}

	private _totalIncludeCount(): number {
		return this._copyList.paths.length + this._linkList.paths.length;
	}

	/** リポジトリに .worktreeinclude があれば、その件数を添える（中身はこの画面では書き換えない）。 */
	private async _showIncludeFileNote(): Promise<void> {
		try {
			const content = (await this.fileService.readFile(joinPath(this.repository.uri, PARADIS_WORKTREE_INCLUDE_FILE))).value.toString();
			const count = paradisParseWorktreeIncludeFile(content).length;
			if (count > 0 && !this._store.isDisposed) {
				// allow-any-unicode-next-line
				this._includeFileNote.textContent = localize('paradis.workspaceLifecycle.includeFileNote', "リポジトリの {0} にある {1} 件も写します。", PARADIS_WORKTREE_INCLUDE_FILE, count);
				this._includeFileNote.hidden = false;
			}
		} catch {
			// 無ければ何も出さない
		}
	}

	private _setBusy(busy: boolean): void {
		this._busy = busy;
		this._saveBtn.enabled = !busy && this._loaded;
		this._cancelBtn.enabled = !busy;
		this._saveBtn.label = busy ? STR_SAVING : STR_SAVE;
	}

	private async _save(): Promise<void> {
		if (this._busy || !this._loaded) {
			return;
		}
		this._setBusy(true);
		this._errorEl.textContent = '';
		try {
			await paradisSaveWorkspaceLifecycleConfig(this.fileService, this.repository.uri, {
				setupScript: this._setupInput.value,
				teardownScript: this._teardownInput.value,
			}, { include: this._copyList.paths, sharedDirectories: this._linkList.paths });
			this.dispose();
		} catch (error) {
			this._setBusy(false);
			this._errorEl.textContent = toErrorMessage(error);
		}
	}
}

/**
 * 「写す」「リンク」の 1 行。パスの札（× で外す）と「パスを追加」を並べ、押すとその場に入力欄を出す
 * （Enter で足す、Escape でやめる）。読み終えるまでは押せない。
 */
class ParadisIncludePathList extends Disposable {

	private readonly _items: HTMLElement;
	private readonly _addButton: ParadisButton;
	private readonly _input: HTMLInputElement;
	private _paths: string[] = [];
	/** 札の × の購読。描き直すたびに捨てる。 */
	private readonly _chipListeners = this._register(new DisposableStore());

	get paths(): readonly string[] {
		return this._paths;
	}

	constructor(
		parent: HTMLElement,
		label: string,
		private readonly totalCount: () => number,
		private readonly showError: (message: string) => void,
	) {
		super();
		const row = dom.append(parent, $('.plc-include-row'));
		dom.append(row, $('span.plc-include-label')).textContent = label;
		// 札・入力欄・「パスを追加」は 1 つの折り返す箱に入れ、折り返しても名前の列の右にそろえる
		const values = dom.append(row, $('.plc-include-values'));
		this._items = dom.append(values, $('.plc-include-items'));
		this._input = dom.append(values, $('input.plc-include-input')) as HTMLInputElement;
		this._input.type = 'text';
		this._input.spellcheck = false;
		this._input.placeholder = STR_INCLUDE_PLACEHOLDER;
		this._input.setAttribute('aria-label', `${label}: ${STR_INCLUDE_PLACEHOLDER}`);
		this._input.hidden = true;
		// 札の並びの後ろに軽く置く（UI キットの ghost の小さいボタン）
		this._addButton = this._register(new ParadisButton(values, { kind: 'ghost', small: true, icon: Codicon.add, label: STR_INCLUDE_ADD, disabled: true }));
		this._register(this._addButton.onDidClick(() => this._startAdding()));
		this._register(dom.addDisposableListener(this._input, 'keydown', e => {
			// 日本語入力の変換中の Enter・Esc は変換の確定・取り消しなので、パスを足したりやめたりしない
			if (e.isComposing || e.keyCode === 229) {
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				this._commit();
			} else if (e.key === 'Escape') {
				// ダイアログごと閉じない
				e.preventDefault();
				e.stopPropagation();
				this._stopAdding();
			}
		}));
		this._register(dom.addDisposableListener(this._input, 'blur', () => {
			if (!this._input.hidden) {
				this._commit();
			}
		}));
	}

	setPaths(paths: readonly string[]): void {
		this._paths = [...paths];
		this._render();
	}

	/** パスを足している途中ならやめて true を返す（ダイアログの Esc から呼ぶ）。 */
	cancelAdding(): boolean {
		if (this._input.hidden) {
			return false;
		}
		this._stopAdding();
		return true;
	}

	setEnabled(enabled: boolean): void {
		this._addButton.enabled = enabled;
	}

	private _startAdding(): void {
		this._input.value = '';
		this._input.hidden = false;
		this._addButton.element.hidden = true;
		this._input.focus();
	}

	private _stopAdding(): void {
		this._input.hidden = true;
		this._addButton.element.hidden = false;
		this._addButton.focus();
	}

	private _commit(): void {
		const raw = this._input.value.trim();
		if (raw.length === 0) {
			this._stopAdding();
			return;
		}
		const path = paradisNormalizeWorktreeIncludePath(raw);
		if (path === undefined) {
			// allow-any-unicode-next-line
			this.showError(localize('paradis.workspaceLifecycle.includeInvalid', "「{0}」は使えません。リポジトリの中の相対パスを、* や ? を使わずに書いてください。", raw));
			return;
		}
		if (!this._paths.includes(path)) {
			if (this.totalCount() >= PARADIS_WORKTREE_INCLUDE_MAX_ENTRIES) {
				this.showError(STR_INCLUDE_TOO_MANY);
				return;
			}
			this._paths.push(path);
			this._render();
		}
		this.showError('');
		this._stopAdding();
	}

	private _render(): void {
		this._chipListeners.clear();
		dom.clearNode(this._items);
		for (const path of this._paths) {
			const chip = dom.append(this._items, $('span.plc-include-chip'));
			dom.append(chip, $('span.plc-include-chip-label')).textContent = path;
			const remove = dom.append(chip, $('button.plc-include-chip-remove.paradis-focus-ring-inset')) as HTMLButtonElement;
			remove.type = 'button';
			remove.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			// allow-any-unicode-next-line
			remove.setAttribute('aria-label', localize('paradis.workspaceLifecycle.removePath', "「{0}」を外す", path));
			this._chipListeners.add(dom.addDisposableListener(remove, 'click', () => {
				this._paths = this._paths.filter(candidate => candidate !== path);
				this._render();
			}));
		}
	}
}

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
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisModalSize, paradisModalClasses } from '../../../browser/paradisModal.js';
import { IParadisWorkspaceRepository } from '../common/paradisWorkspaceSwitch.js';
import { IParadisWorkspaceLifecycleConfig, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES, paradisParseWorkspaceLifecycleConfig, paradisUpdateWorkspaceLifecycleConfig } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_PROJECT_ROOT_ENV_VAR, PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';

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
const STR_CLOSE = localize('paradis.workspaceLifecycle.close', "閉じる");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.workspaceLifecycle.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.workspaceLifecycle.save', "保存");
// allow-any-unicode-next-line
const STR_SAVING = localize('paradis.workspaceLifecycle.saving', "保存中…");

/** リポジトリ直下の .paracode.json へ setupScript / teardownScript を書き込む。presets 等の既存フィールドは保持する。 */
export async function paradisSaveWorkspaceLifecycleConfig(fileService: IFileService, repositoryUri: URI, config: IParadisWorkspaceLifecycleConfig): Promise<void> {
	const configUri = joinPath(repositoryUri, PARADIS_WORKSPACE_PRESET_FILE);
	let existing: string | undefined;
	try {
		existing = (await fileService.readFile(configUri)).value.toString();
	} catch (error) {
		if (toFileOperationResult(error as Error) !== FileOperationResult.FILE_NOT_FOUND) { throw error; }
	}
	if (existing === undefined && !config.setupScript?.trim() && !config.teardownScript?.trim()) {
		return;
	}
	const updated = paradisUpdateWorkspaceLifecycleConfig(existing, config);
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

		this._backdrop = $('.paradis-create-worktree-backdrop');
		this._dialog = $('.paradis-workspace-lifecycle-dialog');
		this._dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		this._dialog.setAttribute('role', 'dialog');
		this._dialog.setAttribute('aria-modal', 'true');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop && !this._busy) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			if (e.key === 'Escape' && !this._busy) {
				e.preventDefault();
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderForm();
		void this._loadExisting();
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
		const details = dom.append(description, $('span.plc-details'));
		details.textContent = STR_DETAILS;
		details.tabIndex = 0;
		details.setAttribute('role', 'button');
		details.setAttribute('aria-label', STR_DETAILS_HOVER);
		// キーボードで移ったときも同じホバーを出す
		this._register(this.hoverService.setupDelayedHover(details, { content: STR_DETAILS_HOVER, container: this._backdrop }, { setupKeyboardEvents: true }));

		this._setupInput = this._appendScriptField(body, 'paradis-lifecycle-setup-input', STR_SETUP_LABEL);
		this._teardownInput = this._appendScriptField(body, 'paradis-lifecycle-teardown-input', STR_TEARDOWN_LABEL);

		this._errorEl = dom.append(body, $('.plc-error'));

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
		this._loaded = true;
		this._setupInput.readOnly = false;
		this._teardownInput.readOnly = false;
		this._saveBtn.enabled = !this._busy;
		this.focusInput();
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
			});
			this.dispose();
		} catch (error) {
			this._setBusy(false);
			this._errorEl.textContent = toErrorMessage(error);
		}
	}
}

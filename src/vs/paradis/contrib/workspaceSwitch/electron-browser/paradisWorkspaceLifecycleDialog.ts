/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// リポジトリの Setup / Teardown スクリプト（.paracode.json の setupScript / teardownScript）を
// 編集するダイアログ。Workspaces ビューのリポジトリ行コンテキストメニューから開く。
// 実装様式は paradisCreateWorktreeDialog.ts と同じ自前 DOM + backdrop 方式（同じ CSS を共有）。

import './media/paradisCreateWorktreeDialog.css';
import * as dom from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IParadisWorkspaceRepository } from '../common/paradisWorkspaceSwitch.js';
import { IParadisWorkspaceLifecycleConfig, PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES, paradisParseWorkspaceLifecycleConfig, paradisUpdateWorkspaceLifecycleConfig } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.workspaceLifecycle.title', "Setup / Teardown スクリプト");
// allow-any-unicode-next-line
const STR_DESCRIPTION = localize('paradis.workspaceLifecycle.description', "{0} に保存されます（コミットすればチーム全体・全 worktree に反映されます）。このリポジトリで worktree を作成・削除するたびに自動実行され、最長 {2} 分で打ち切られます。実行時は環境変数 {1} に親リポジトリの絶対パスが渡されます。保存時、コメント付き JSONC のコメントは保持されません。", PARADIS_WORKSPACE_PRESET_FILE, 'PARACODE_PROJECT_ROOT_PATH', PARADIS_LIFECYCLE_SCRIPT_TIMEOUT_MINUTES);
// allow-any-unicode-next-line
const STR_SETUP_LABEL = localize('paradis.workspaceLifecycle.setupLabel', "Setup スクリプト（worktree 作成直後、対象 worktree を作業ディレクトリとして実行）");
// allow-any-unicode-next-line
const STR_TEARDOWN_LABEL = localize('paradis.workspaceLifecycle.teardownLabel', "Teardown スクリプト（worktree 削除前、対象 worktree を作業ディレクトリとして実行）");
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
		repository,
	);
}

class ParadisWorkspaceLifecycleDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;

	private _setupInput!: HTMLTextAreaElement;
	private _teardownInput!: HTMLTextAreaElement;
	private _errorEl!: HTMLElement;
	private _saveBtn!: HTMLButtonElement;
	private _cancelBtn!: HTMLButtonElement;
	private _busy = false;

	constructor(
		layoutService: ILayoutService,
		private readonly fileService: IFileService,
		private readonly repository: IParadisWorkspaceRepository,
	) {
		super();

		this._backdrop = $('.paradis-create-worktree-backdrop');
		this._dialog = $('.paradis-create-worktree-dialog');
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

		dom.append(this._dialog, $('h3.pcw-title')).textContent = STR_TITLE;
		dom.append(this._dialog, $('div.pcw-label')).textContent = STR_DESCRIPTION;

		const setupLabel = dom.append(this._dialog, $('label.pcw-label')) as HTMLLabelElement;
		setupLabel.textContent = STR_SETUP_LABEL;
		setupLabel.htmlFor = 'paradis-lifecycle-setup-input';
		this._setupInput = dom.append(this._dialog, $('textarea.pcw-prompt')) as HTMLTextAreaElement;
		this._setupInput.id = 'paradis-lifecycle-setup-input';
		this._setupInput.rows = 3;
		this._setupInput.spellcheck = false;

		const teardownLabel = dom.append(this._dialog, $('label.pcw-label')) as HTMLLabelElement;
		teardownLabel.textContent = STR_TEARDOWN_LABEL;
		teardownLabel.htmlFor = 'paradis-lifecycle-teardown-input';
		this._teardownInput = dom.append(this._dialog, $('textarea.pcw-prompt')) as HTMLTextAreaElement;
		this._teardownInput.id = 'paradis-lifecycle-teardown-input';
		this._teardownInput.rows = 3;
		this._teardownInput.spellcheck = false;

		this._errorEl = dom.append(this._dialog, $('.pcw-error'));

		const footer = dom.append(this._dialog, $('.pcw-footer'));
		this._cancelBtn = dom.append(footer, $('button.pcw-btn')) as HTMLButtonElement;
		this._cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(this._cancelBtn, 'click', () => this.dispose()));
		this._saveBtn = dom.append(footer, $('button.pcw-btn.pcw-btn-primary')) as HTMLButtonElement;
		this._saveBtn.textContent = STR_SAVE;
		this._register(dom.addDisposableListener(this._saveBtn, 'click', () => void this._save()));
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
				this._errorEl.textContent = toErrorMessage(error);
			}
		}
		this.focusInput();
	}

	private _setBusy(busy: boolean): void {
		this._busy = busy;
		this._saveBtn.disabled = busy;
		this._cancelBtn.disabled = busy;
		this._saveBtn.textContent = busy ? STR_SAVING : STR_SAVE;
	}

	private async _save(): Promise<void> {
		if (this._busy) {
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

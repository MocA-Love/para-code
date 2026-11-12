/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ワークツリーの削除でブランチも片付ける（Orca W3 の G-07、Orca #13693）。
// - 削除の確認の「ブランチも削除する」の前回の選択（リポジトリごと）
// - git が「マージされていない」と断って残したブランチの台帳（リポジトリごと）と、削除の後の通知
// - 残したブランチを選んで強制的に消すダイアログ（Orca の「Review kept branches」）
// 実際の `git branch -d` / `-D` はリポジトリのあるマシンの paradisWorktreeGitChannel が行う。

import './media/paradisCreateWorktreeDialog.css';
import './media/paradisWorktreeBranchCleanup.css';
import * as dom from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Action, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisModalSize, paradisModalClasses } from '../../../browser/paradisModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';
import { IParadisForceDeleteBranchesRequest, IParadisForceDeleteBranchesResult, IParadisGitBranches } from '../common/paradisWorktreeCreate.js';
import { IParadisWorktreeGitHost, paradisWorktreeGitWriteHostResolver } from './paradisWorktreeGitChannelClient.js';

const $ = dom.$;

/** 「残したブランチを確かめる」のコマンド。引数はリポジトリの ID。 */
export const PARADIS_REVIEW_KEPT_BRANCHES_COMMAND_ID = 'paradis.workspaceSwitch.reviewKeptBranches';

/** 削除の確認で「ブランチも削除する」を外したリポジトリ（`uri.toString()` の一覧）。既定は消す。 */
const BRANCH_DELETION_SKIPPED_STORAGE_KEY = 'paradis.worktreeBranch.deletionSkipped';

/** git が消さなかったブランチの台帳（`uri.toString()` → 残したブランチの一覧）。 */
const KEPT_BRANCHES_STORAGE_KEY = 'paradis.worktreeBranch.kept';

/** 覚えておくリポジトリの数と、1 つのリポジトリで覚えておくブランチの数の上限（古いものから落とす）。 */
const MAX_REPOSITORIES = 256;
const MAX_KEPT_BRANCHES_PER_REPOSITORY = 200;

/** 残したブランチ 1 つ。 */
export interface IParadisKeptBranch {
	readonly name: string;
	/** 残したときの先頭のコミット。 */
	readonly sha: string;
}

function readJson<T>(storageService: IStorageService, key: string, fallback: T): T {
	try {
		return JSON.parse(storageService.get(key, StorageScope.APPLICATION, JSON.stringify(fallback))) as T;
	} catch {
		return fallback;
	}
}

/** ワークツリーの削除でブランチも消すかの、そのリポジトリでの前回の選択（既定は消す）。 */
export function paradisPrefersBranchDeletion(storageService: IStorageService, repositoryUri: URI): boolean {
	const skipped = readJson<unknown>(storageService, BRANCH_DELETION_SKIPPED_STORAGE_KEY, []);
	return !(Array.isArray(skipped) && skipped.includes(repositoryUri.toString()));
}

/** 削除の確認で選んだ「ブランチも削除するか」を、そのリポジトリの次回の既定として覚える。 */
export function paradisRememberBranchDeletionChoice(storageService: IStorageService, repositoryUri: URI, deleteBranch: boolean): void {
	const key = repositoryUri.toString();
	const previous = readJson<unknown>(storageService, BRANCH_DELETION_SKIPPED_STORAGE_KEY, []);
	const skipped = (Array.isArray(previous) ? previous.filter((item): item is string => typeof item === 'string') : []).filter(item => item !== key);
	if (!deleteBranch) {
		skipped.push(key);
	}
	storageService.store(BRANCH_DELETION_SKIPPED_STORAGE_KEY, JSON.stringify(skipped.slice(-MAX_REPOSITORIES)), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

function readKeptLedger(storageService: IStorageService): Record<string, IParadisKeptBranch[]> {
	const value = readJson<unknown>(storageService, KEPT_BRANCHES_STORAGE_KEY, {});
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const ledger: Record<string, IParadisKeptBranch[]> = {};
	for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(list)) {
			ledger[key] = list.filter((item): item is IParadisKeptBranch => !!item && typeof item.name === 'string' && typeof item.sha === 'string');
		}
	}
	return ledger;
}

function writeKeptLedger(storageService: IStorageService, ledger: Record<string, IParadisKeptBranch[]>): void {
	const entries = Object.entries(ledger).filter(([, list]) => list.length > 0).slice(-MAX_REPOSITORIES);
	storageService.store(KEPT_BRANCHES_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)), StorageScope.APPLICATION, StorageTarget.MACHINE);
}

/** そのリポジトリで残したブランチ（古い順）。 */
export function paradisReadKeptBranches(storageService: IStorageService, repositoryUri: URI): IParadisKeptBranch[] {
	return readKeptLedger(storageService)[repositoryUri.toString()] ?? [];
}

/** 残したブランチを台帳に足す（同じ名前は新しい方に置き換える）。 */
export function paradisRecordKeptBranch(storageService: IStorageService, repositoryUri: URI, branch: IParadisKeptBranch): void {
	const ledger = readKeptLedger(storageService);
	const key = repositoryUri.toString();
	const list = (ledger[key] ?? []).filter(item => item.name !== branch.name);
	list.push(branch);
	delete ledger[key];
	ledger[key] = list.slice(-MAX_KEPT_BRANCHES_PER_REPOSITORY);
	writeKeptLedger(storageService, ledger);
}

/** 台帳から外す（消したもの・もう無いもの）。 */
export function paradisForgetKeptBranches(storageService: IStorageService, repositoryUri: URI, names: readonly string[]): void {
	const ledger = readKeptLedger(storageService);
	const key = repositoryUri.toString();
	if (!ledger[key]) {
		return;
	}
	ledger[key] = ledger[key].filter(item => !names.includes(item.name));
	writeKeptLedger(storageService, ledger);
}

/**
 * 削除の後に、git が消さなかったブランチを知らせる（Orca の preserved-branch toast を 1 件ずつの文にしたもの）。
 * 「ブランチを確かめる」で一覧を開く。
 */
export function paradisNotifyKeptBranch(notificationService: INotificationService, commandService: ICommandService, repository: IParadisWorkspaceRepository, worktreeName: string, branch: string): void {
	notificationService.notify({
		severity: Severity.Warning,
		// allow-any-unicode-next-line
		message: localize('paradis.worktreeBranch.keptNotice', "ワークツリー「{0}」を削除し、ブランチ「{1}」を残しました。マージされていない変更があるかもしれないため、git がブランチを消しませんでした。フォルダは消えています。コミットはリポジトリに残っています。", worktreeName, branch),
		actions: {
			primary: [
				// allow-any-unicode-next-line
				new Action('paradis.worktreeBranch.keep', localize('paradis.worktreeBranch.keep', "残す"), undefined, true, async () => { }),
				// allow-any-unicode-next-line
				new Action('paradis.worktreeBranch.review', localize('paradis.worktreeBranch.review', "ブランチを確かめる"), undefined, true, async () => {
					await commandService.executeCommand(PARADIS_REVIEW_KEPT_BRANCHES_COMMAND_ID, repository.id);
				}),
			],
		},
	});
}

// 開いている一覧の参照。複数の入り口から呼ばれても多重に開かないようにする
let paradisActiveKeptBranchesDialog: ParadisKeptBranchesDialog | undefined;

class ParadisReviewKeptBranchesAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_REVIEW_KEPT_BRANCHES_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.worktreeBranch.reviewCommand', "残したブランチを確かめる..."),
			category: localize2('paradis.category', "Para Code"),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, repositoryId?: string): Promise<void> {
		if (typeof repositoryId !== 'string' || paradisActiveKeptBranchesDialog) {
			return;
		}
		const repository = accessor.get(IParadisWorkspaceSwitchService).repositories.find(candidate => candidate.id === repositoryId);
		if (!repository) {
			return;
		}
		const layoutService = accessor.get(ILayoutService);
		const storageService = accessor.get(IStorageService);
		const notificationService = accessor.get(INotificationService);
		// 強制削除は書き込みなので、別ホスト・未接続の接続先へ流さない write resolver を使う
		const host = paradisWorktreeGitWriteHostResolver(accessor)(repository.uri);
		if (!host) {
			// allow-any-unicode-next-line
			notificationService.warn(localize('paradis.worktree.unreachableHost', "「{0}」は今つないでいる接続先にありません。このリポジトリがあるマシンへ接続してから実行してください。", repository.name));
			return;
		}
		// 出す前に、まだ在るものだけに絞る（ターミナルで消したもの・別の名前で作り直したものは台帳から外す）
		let existing: readonly string[];
		try {
			existing = (await host.channel.call<IParadisGitBranches>('listBranches', [host.path(repository.uri)])).branches;
		} catch (error) {
			notificationService.error(toErrorMessage(error));
			return;
		}
		const kept = paradisReadKeptBranches(storageService, repository.uri);
		const gone = kept.filter(branch => !existing.includes(branch.name)).map(branch => branch.name);
		if (gone.length > 0) {
			paradisForgetKeptBranches(storageService, repository.uri, gone);
		}
		const branches = kept.filter(branch => existing.includes(branch.name));
		if (branches.length === 0) {
			// allow-any-unicode-next-line
			notificationService.info(localize('paradis.worktreeBranch.noneKept', "「{0}」に残したブランチはありません。", repository.name));
			return;
		}
		paradisOpenKeptBranchesDialog(layoutService, storageService, notificationService, repository, host, branches);
	}
}

/** 残したブランチの一覧を開く（既に開いていれば何もしない）。 */
export function paradisOpenKeptBranchesDialog(layoutService: ILayoutService, storageService: IStorageService, notificationService: INotificationService, repository: IParadisWorkspaceRepository, host: IParadisWorktreeGitHost, branches: readonly IParadisKeptBranch[]): void {
	if (!paradisActiveKeptBranchesDialog) {
		paradisActiveKeptBranchesDialog = new ParadisKeptBranchesDialog(layoutService, storageService, notificationService, repository, host, branches);
	}
}

registerAction2(ParadisReviewKeptBranchesAction);

/**
 * 残したブランチを選んで強制的に消すダイアログ（比較モックの「残したブランチを確かめる」）。選ばなかったものは残す。
 * 箱は共通の S 段（paradisModal.ts）で、見出しの帯・本文・下端の帯は Setup / Teardown のダイアログと同じ作り。
 */
class ParadisKeptBranchesDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _selected = new Set<string>();
	private readonly _rows = this._register(new DisposableStore());
	private _list!: HTMLElement;
	private _count!: HTMLElement;
	private _all!: HTMLInputElement;
	private _errorEl!: HTMLElement;
	private _deleteBtn!: Button;
	private _busy = false;

	constructor(
		layoutService: ILayoutService,
		private readonly storageService: IStorageService,
		private readonly notificationService: INotificationService,
		private readonly repository: IParadisWorkspaceRepository,
		private readonly host: IParadisWorktreeGitHost,
		private branches: readonly IParadisKeptBranch[],
	) {
		super();
		this._backdrop = $('.paradis-create-worktree-backdrop.paradis-modal-backdrop');
		const dialog = dom.append(this._backdrop, $('.paradis-kept-branches-dialog'));
		dialog.classList.add(...paradisModalClasses(ParadisModalSize.Small));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		// Esc を受けるためにフォーカスできるようにする（ParadisModalFocus が中身の描き直しの後に戻す先）
		dialog.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop && !this._busy) {
				this.dispose();
			}
		}));
		this._render(dialog);
		layoutService.activeContainer.appendChild(this._backdrop);
		// 中へフォーカスを移す前に作る（開く前の場所を覚えて、閉じたらそこへ戻す）。Esc は重なった中の一番上だけが受ける
		this._register(new ParadisModalFocus({
			backdrop: this._backdrop,
			modal: dialog,
			onEscape: () => {
				if (!this._busy) {
					this.dispose();
				}
			},
			close: () => this.dispose(),
		}));
		this._all.focus();
	}

	override dispose(): void {
		if (paradisActiveKeptBranchesDialog === this) {
			paradisActiveKeptBranchesDialog = undefined;
		}
		this._backdrop.remove();
		super.dispose();
	}

	private _render(dialog: HTMLElement): void {
		const header = dom.append(dialog, $('.pkb-header'));
		const title = dom.append(header, $('h3.pkb-title'));
		// allow-any-unicode-next-line
		title.textContent = localize('paradis.worktreeBranch.reviewTitle', "残したブランチを確かめる");
		title.id = 'paradis-kept-branches-title';
		dialog.setAttribute('aria-labelledby', title.id);
		const closeBar = this._register(new ActionBar(dom.append(header, $('.pkb-header-actions'))));
		// allow-any-unicode-next-line
		closeBar.push(toAction({ id: 'paradis.worktreeBranch.close', label: localize('paradis.worktreeBranch.close', "閉じる"), class: ThemeIcon.asClassName(Codicon.close), run: () => { if (!this._busy) { this.dispose(); } } }), { icon: true, label: false });

		const body = dom.append(dialog, $('.pkb-body'));
		// allow-any-unicode-next-line
		dom.append(body, $('.pkb-description')).textContent = localize('paradis.worktreeBranch.reviewDescription', "強制的に消すローカルのブランチを選んでください。選ばなかったものは残ります。");
		const box = dom.append(body, $('.pkb-box'));
		const head = dom.append(box, $('label.pkb-head'));
		this._all = dom.append(head, $('input.pkb-check')) as HTMLInputElement;
		this._all.type = 'checkbox';
		// allow-any-unicode-next-line
		dom.append(head, $('span')).textContent = localize('paradis.worktreeBranch.selectAll', "すべて選ぶ");
		this._count = dom.append(head, $('span.pkb-count'));
		this._register(dom.addDisposableListener(this._all, 'change', () => {
			this._selected.clear();
			if (this._all.checked) {
				for (const branch of this.branches) {
					this._selected.add(branch.name);
				}
			}
			this._renderRows();
		}));
		this._list = dom.append(box, $('.pkb-list'));
		this._errorEl = dom.append(body, $('.pkb-error'));
		this._errorEl.setAttribute('role', 'alert');

		const footer = dom.append(dialog, $('.pkb-footer'));
		const cancel = this._register(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		// allow-any-unicode-next-line
		cancel.label = localize('paradis.worktreeBranch.cancel', "キャンセル");
		this._register(cancel.onDidClick(() => { if (!this._busy) { this.dispose(); } }));
		// 取り消せない強制削除なので、押すボタンを危険の色にする（Button は地の色を要素へ直に書くので、CSS ではなく色の指定で渡す）
		this._deleteBtn = this._register(new Button(footer, {
			...defaultButtonStyles,
			buttonBackground: 'var(--vscode-statusBarItem-errorBackground)',
			buttonHoverBackground: 'var(--vscode-statusBarItem-errorHoverBackground, var(--vscode-statusBarItem-errorBackground))',
			buttonForeground: 'var(--vscode-statusBarItem-errorForeground)',
		}));
		this._deleteBtn.element.classList.add('pkb-danger');
		this._register(this._deleteBtn.onDidClick(() => void this._delete()));
		this._renderRows();
	}

	private _renderRows(): void {
		this._rows.clear();
		dom.clearNode(this._list);
		for (const branch of this.branches) {
			const row = dom.append(this._list, $('label.pkb-row'));
			const check = dom.append(row, $('input.pkb-check')) as HTMLInputElement;
			check.type = 'checkbox';
			check.checked = this._selected.has(branch.name);
			const text = dom.append(row, $('.pkb-row-text'));
			dom.append(text, $('.pkb-branch')).textContent = branch.name;
			dom.append(text, $('.pkb-meta')).textContent = localize('paradis.worktreeBranch.meta', "{0} · {1}", this.repository.name, branch.sha.slice(0, 7));
			// allow-any-unicode-next-line
			dom.append(row, $('span.pkb-reason')).textContent = localize('paradis.worktreeBranch.unmerged', "マージされていない可能性");
			this._rows.add(dom.addDisposableListener(check, 'change', () => {
				if (check.checked) {
					this._selected.add(branch.name);
				} else {
					this._selected.delete(branch.name);
				}
				this._updateSummary();
			}));
		}
		this._updateSummary();
	}

	private _updateSummary(): void {
		const count = this._selected.size;
		// allow-any-unicode-next-line
		this._count.textContent = localize('paradis.worktreeBranch.selectedCount', "{0} / {1} 件を選択", count, this.branches.length);
		this._all.checked = count > 0 && count === this.branches.length;
		this._all.indeterminate = count > 0 && count < this.branches.length;
		// allow-any-unicode-next-line
		this._deleteBtn.label = localize('paradis.worktreeBranch.forceDelete', "{0} 件のブランチを強制的に削除", count);
		this._deleteBtn.enabled = count > 0 && !this._busy;
	}

	private async _delete(): Promise<void> {
		if (this._busy || this._selected.size === 0) {
			return;
		}
		this._busy = true;
		this._deleteBtn.enabled = false;
		this._errorEl.textContent = '';
		const request: IParadisForceDeleteBranchesRequest = { repoPath: this.host.path(this.repository.uri), branches: [...this._selected] };
		try {
			const result = await this.host.channel.call<IParadisForceDeleteBranchesResult>('forceDeleteBranches', [request]);
			paradisForgetKeptBranches(this.storageService, this.repository.uri, result.deleted);
			if (this._store.isDisposed) {
				return;
			}
			if (result.failed.length === 0) {
				// allow-any-unicode-next-line
				this.notificationService.info(localize('paradis.worktreeBranch.deleted', "{0} 件のブランチを削除しました。", result.deleted.length));
				this.dispose();
				return;
			}
			// 消せなかったもの（別の作業ツリーで開いた・追跡先を付けた等）は一覧に残して理由を出す
			this.branches = this.branches.filter(branch => !result.deleted.includes(branch.name));
			this._selected.clear();
			this._busy = false;
			this._renderRows();
			// allow-any-unicode-next-line
			this._errorEl.textContent = localize('paradis.worktreeBranch.deleteFailed', "消せなかったブランチがあります: {0}（ほかの作業ツリーで開いている、追跡先がある、などの理由で消していません）", result.failed.join(', '));
		} catch (error) {
			this._busy = false;
			this._updateSummary();
			this._errorEl.textContent = toErrorMessage(error);
		}
	}
}

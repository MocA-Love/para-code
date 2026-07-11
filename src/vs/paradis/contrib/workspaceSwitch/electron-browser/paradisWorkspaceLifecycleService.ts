/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// リポジトリの .paracode.json から setup/teardown スクリプトを読み取り、Workspace Trust と
// スクリプト内容ごとの初回承認を強制した上で shared process の paradisWorktreeGitChannel 経由で
// 実行するオーケストレーション。

import { hash } from '../../../../base/common/hash.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IParadisWorkspaceRepository } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { IParadisWorkspaceLifecycleConfig, paradisParseWorkspaceLifecycleConfig, ParadisWorkspaceLifecycleKind } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';

/**
 * スクリプト内容ごとの承認記録（autoRun プリセットの AUTORUN_APPROVED_STORAGE_KEY と同じ方式）。
 * Workspace Trust だけでは不十分: Workspaces ビューの「Add Repository...」は Restricted Mode 回避の
 * ため追加時点でリポジトリを自動信頼する（paradisWorkspaceSwitchService.addRepository の trustUris）ので、
 * Trust チェックはリポジトリ由来スクリプトの実行ゲートとして実質機能しない。リポジトリ+種別+内容ごとの
 * 明示承認を挟み、スクリプトが変更されたら再承認を要求する。
 */
const LIFECYCLE_APPROVED_STORAGE_KEY = 'paradis.workspaceLifecycle.scriptApproved';

/** リポジトリ直下の .paracode.json から setupScript / teardownScript を読み取る。ファイル無しは空扱い。 */
export async function paradisReadWorkspaceLifecycleConfig(fileService: IFileService, repositoryUri: URI): Promise<IParadisWorkspaceLifecycleConfig> {
	const configUri = joinPath(repositoryUri, PARADIS_WORKSPACE_PRESET_FILE);
	try {
		return paradisParseWorkspaceLifecycleConfig((await fileService.readFile(configUri)).value.toString());
	} catch (error) {
		if (toFileOperationResult(error as Error) === FileOperationResult.FILE_NOT_FOUND) { return {}; }
		throw error;
	}
}

/**
 * リポジトリの setup/teardown スクリプトを対象 worktree で実行する。
 * スクリプト未定義なら何もせず false を返す。スクリプトが定義されている場合、Workspace Trust が
 * 必要（未信頼なら例外）で、さらにリポジトリ+種別+スクリプト内容ごとの初回承認ダイアログを挟む
 * （承認は APPLICATION スコープへ永続し、スクリプトが変わると再承認を要求する）。
 * ユーザーが承認しなかった場合は実行せず false を返す（呼び出し側のフローは打ち切らない）。
 */
export async function paradisRunWorkspaceLifecycleScript(accessor: ServicesAccessor, kind: ParadisWorkspaceLifecycleKind, repository: IParadisWorkspaceRepository, worktreeUri: URI): Promise<boolean> {
	const trustService = accessor.get(IWorkspaceTrustManagementService);
	const fileService = accessor.get(IFileService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	const dialogService = accessor.get(IDialogService);
	const storageService = accessor.get(IStorageService);
	const config = await paradisReadWorkspaceLifecycleConfig(fileService, repository.uri);
	const script = kind === 'setup' ? config.setupScript : config.teardownScript;
	if (!script) { return false; }
	if (!trustService.isWorkspaceTrusted()) {
		// allow-any-unicode-next-line
		throw new Error(localize('paradis.workspaceLifecycle.trustRequired', "リポジトリ定義の setup/teardown スクリプトを実行するには、ワークスペースの信頼（Workspace Trust）が必要です。"));
	}

	const approvalKey = `${repository.uri.fsPath}:${kind}:${hash(script)}`;
	let approved: string[];
	try {
		approved = JSON.parse(storageService.get(LIFECYCLE_APPROVED_STORAGE_KEY, StorageScope.APPLICATION, '[]'));
	} catch {
		approved = [];
	}
	if (!approved.includes(approvalKey)) {
		const { confirmed } = await dialogService.confirm({
			message: kind === 'setup'
				// allow-any-unicode-next-line
				? localize('paradis.workspaceLifecycle.approveSetup', "リポジトリ「{0}」の setup スクリプトを自動実行しますか？", repository.name)
				// allow-any-unicode-next-line
				: localize('paradis.workspaceLifecycle.approveTeardown', "リポジトリ「{0}」の teardown スクリプトを自動実行しますか？", repository.name),
			detail: script,
			// allow-any-unicode-next-line
			primaryButton: localize('paradis.workspaceLifecycle.approveRun', "実行")
		});
		if (!confirmed) {
			return false;
		}
		approved.push(approvalKey);
		storageService.store(LIFECYCLE_APPROVED_STORAGE_KEY, JSON.stringify(approved), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	await sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('runLifecycleScript', [{
		kind, repoPath: repository.uri.fsPath, worktreePath: worktreeUri.fsPath, script
	}]);
	return true;
}

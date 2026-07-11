/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// リポジトリの .paracode.json から setup/teardown スクリプトを読み取り、Workspace Trust を
// 強制した上で shared process の paradisWorktreeGitChannel 経由で実行するオーケストレーション。

import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IParadisWorkspaceRepository } from '../common/paradisWorkspaceSwitch.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../common/paradisWorktreeCreate.js';
import { IParadisWorkspaceLifecycleConfig, paradisParseWorkspaceLifecycleConfig, ParadisWorkspaceLifecycleKind } from '../common/paradisWorkspaceLifecycle.js';
import { PARADIS_WORKSPACE_PRESET_FILE } from '../../terminalPresets/common/paradisTerminalPresets.js';

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
 * リポジトリの setup/teardown スクリプトを対象 worktree で実行する。スクリプト未定義なら何もせず false を返す。
 * スクリプトが定義されている場合、Workspace Trust が必要（未信頼なら例外）。
 */
export async function paradisRunWorkspaceLifecycleScript(accessor: ServicesAccessor, kind: ParadisWorkspaceLifecycleKind, repository: IParadisWorkspaceRepository, worktreeUri: URI): Promise<boolean> {
	const trustService = accessor.get(IWorkspaceTrustManagementService);
	const fileService = accessor.get(IFileService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	const config = await paradisReadWorkspaceLifecycleConfig(fileService, repository.uri);
	const script = kind === 'setup' ? config.setupScript : config.teardownScript;
	if (!script) { return false; }
	if (!trustService.isWorkspaceTrusted()) {
		// allow-any-unicode-next-line
		throw new Error(localize('paradis.workspaceLifecycle.trustRequired', "リポジトリ定義の setup/teardown スクリプトを実行するには、ワークスペースの信頼（Workspace Trust）が必要です。"));
	}
	await sharedProcessService.getChannel(PARADIS_WORKTREE_GIT_CHANNEL).call('runLifecycleScript', [{
		kind, repoPath: repository.uri.fsPath, worktreePath: worktreeUri.fsPath, script
	}]);
	return true;
}

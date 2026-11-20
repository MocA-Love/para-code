/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペイン → そのペインが属するスペースのフォルダ。解き方は preview_file・メモと同じ（paradisResolveInstanceSpace）。
// 資料のツールの受け口（list_docs の「このスペース」）と、ファイルの変化の見張り（どのペインのスペースの資料か）が使う。

import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisResolveInstanceSpace } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

export interface IParadisDocPaneFolderServices {
	readonly paneTokenService: Pick<IParadisPaneTokenService, 'getInstanceForToken'>;
	readonly terminalScopeService: IParadisTerminalScopeService;
	readonly workspaceSwitchService: Pick<IParadisWorkspaceSwitchService, 'activeStateKey' | 'repositories'>;
	readonly worktreeService: IParadisWorktreeService;
	readonly workspaceContextService: Pick<IWorkspaceContextService, 'getWorkspace'>;
}

/** ペインが属するスペースのフォルダ。分からなければ undefined。 */
export function paradisDocPaneFolder(token: string, services: IParadisDocPaneFolderServices): URI | undefined {
	const instanceId = services.paneTokenService.getInstanceForToken(token);
	if (instanceId === undefined) {
		return undefined;
	}
	// 所属が決まっていない（端末の再接続中など）なら分からないとする。スペースを持たないペイン
	// （管理下でないフォルダを開いた窓）は、そのウィンドウのフォルダ（preview_file と同じ）
	const scope = services.terminalScopeService.getStateKeyForInstance(instanceId) === undefined ? services.terminalScopeService.resolveScope(instanceId) : undefined;
	if (scope?.kind === 'unscoped') {
		return services.workspaceContextService.getWorkspace().folders[0]?.uri;
	}
	const stateKey = paradisResolveInstanceSpace(services.terminalScopeService, services.workspaceSwitchService.activeStateKey, instanceId);
	return stateKey !== undefined ? paradisListSpaces(services.workspaceSwitchService.repositories, services.worktreeService).find(candidate => candidate.space === stateKey)?.uri : undefined;
}

/**
 * その資料のスペースのペイン。資料を含むフォルダのうち一番深いものに属するペインだけを返す（リポジトリのフォルダの中に
 * 置いたワークツリーの資料を、リポジトリのスペースのペインに数えない）。
 */
export function paradisDocWatchPaneTokens(resource: URI, panes: readonly { readonly token: string; readonly folder: URI | undefined }[]): string[] {
	let depth = -1;
	let tokens: string[] = [];
	for (const pane of panes) {
		if (pane.folder === undefined || !isEqualOrParent(resource, pane.folder)) {
			continue;
		}
		const length = pane.folder.path.length;
		if (length > depth) {
			depth = length;
			tokens = [pane.token];
		} else if (length === depth) {
			tokens.push(pane.token);
		}
	}
	return tokens;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルの変化の見張りから、資料（html・md）の作成・変更を shared process の台帳へ知らせる。
// エージェントがコマンド（Bash・python など）で書いた資料は、hook にも会話の記録にも書き込みとして残らないので、
// ファイルが変わったことから拾う。持ち主を決めるのは台帳の側（そのスペースで作業中の会話が 1 つだけならその会話）。
//
// 新しい見張りは張らない。ウィンドウが開いているフォルダは本体が既に見張っていて（IFileService.onDidFilesChange）、
// その知らせから拡張子で選ぶだけ。したがって拾えるのは、ウィンドウが今開いているフォルダ（表示中のスペース）の中の資料。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { FileChangesEvent, IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { ITextFileService } from '../../../../workbench/services/textfile/common/textfiles.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisDocWatchBurstGate, paradisIsWatchableDocPath } from '../common/paradisAgentDocs.js';
import { PARADIS_AGENT_DOCS_VIEW_CHANNEL, ParadisAgentDocsViewCall } from '../common/paradisAgentDocsView.js';
import { IParadisDocPaneFolderServices, paradisDocPaneFolder, paradisDocWatchPaneTokens } from './paradisAgentDocsPaneFolder.js';
import { paradisDocTargetOf, paradisWindowDocHostId } from './paradisAgentDocsView.js';

/** 利用者がエディタで保存したファイルの変化は、この時間のうちは拾わない（エージェントが書いたのではない）。 */
const USER_SAVE_WINDOW_MS = 5_000;
/** 覚えておく「利用者が保存したファイル」の上限。 */
const MAX_USER_SAVES = 200;

class ParadisAgentDocsWatchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentDocsWatch';

	private readonly _windowHostId: string | undefined;
	private readonly _gate = new ParadisDocWatchBurstGate();
	/** 利用者がエディタで保存したファイル → 保存した時刻。 */
	private readonly _userSaves = new ResourceMap<number>();
	private readonly _paneFolderServices: IParadisDocPaneFolderServices;

	constructor(
		@IFileService fileService: IFileService,
		@ITextFileService textFileService: ITextFileService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IParadisPaneTokenService private readonly _paneTokenService: IParadisPaneTokenService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
	) {
		super();
		this._windowHostId = paradisWindowDocHostId(environmentService.remoteAuthority);
		this._paneFolderServices = { paneTokenService: _paneTokenService, terminalScopeService, workspaceSwitchService, worktreeService, workspaceContextService };
		this._register(textFileService.files.onDidSave(event => this._noteUserSave(event.model.resource)));
		this._register(fileService.onDidFilesChange(event => this._onFilesChanged(event)));
	}

	private _noteUserSave(resource: URI): void {
		this._userSaves.delete(resource);
		this._userSaves.set(resource, Date.now());
		if (this._userSaves.size > MAX_USER_SAVES) {
			const oldest = this._userSaves.keys().next();
			if (oldest.done !== true) {
				this._userSaves.delete(oldest.value);
			}
		}
	}

	private _onFilesChanged(event: FileChangesEvent): void {
		// 本体が開いているフォルダを見張った知らせだけを使う（個別に張った見張りの知らせは、張った側のもの）
		if (event.hasCorrelation() || (event.rawAdded.length === 0 && event.rawUpdated.length === 0)) {
			return;
		}
		const now = Date.now();
		const docs = new ResourceMap<{ hostId: string; path: string }>();
		for (const resource of [...event.rawAdded, ...event.rawUpdated]) {
			const target = paradisDocTargetOf(resource, this._windowHostId);
			if (target === undefined || !paradisIsWatchableDocPath(target.path) || now - (this._userSaves.get(resource) ?? Number.NEGATIVE_INFINITY) <= USER_SAVE_WINDOW_MS) {
				continue;
			}
			docs.set(resource, target);
		}
		if (docs.size === 0 || !this._gate.admit(docs.size, now)) {
			return;
		}
		const paneTokens = this._paneTokenService.listPaneTokens();
		if (paneTokens.length === 0) {
			return;
		}
		const panes = paneTokens.map(pane => ({ token: pane.token, folder: paradisDocPaneFolder(pane.token, this._paneFolderServices) }));
		const channel = this._sharedProcessService.getChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL);
		for (const [resource, target] of docs) {
			const tokens = paradisDocWatchPaneTokens(resource, panes);
			if (tokens.length > 0) {
				channel.call(ParadisAgentDocsViewCall.NoteChanged, [target.hostId, target.path, tokens]).catch(() => undefined);
			}
		}
	}
}

registerWorkbenchContribution2(ParadisAgentDocsWatchContribution.ID, ParadisAgentDocsWatchContribution, WorkbenchPhase.AfterRestored);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';

const PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING = 'paradis.remote.openDefaultWorkspace';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			// allow-any-unicode-next-line
			description: localize('paradis.remote.openDefaultWorkspace', "SSH で接続したウィンドウで、接続先のマルチリポワークスペースを自動で開きます。接続先ごとにリポジトリ一覧が独立します。")
		}
	}
});

/**
 * SSH で接続したウィンドウに、接続先側のマルチリポワークスペースを開く。
 *
 * ローカルウィンドウでは windowsMainService の PARA-PATCH から electron-main の
 * paradisEnsureDefaultWorkspace が同じことをしているが、あちらは homedir() 固定で
 * 常に手元を指すため、接続したウィンドウには効かない（接続先のホームは知り得ない）。
 *
 * リポジトリ一覧は StorageScope.WORKSPACE に入り、workspace id は .code-workspace の
 * 場所から決まる。したがって接続先ごとに別のワークスペースファイルを開くだけで、
 * 手元の一覧と混ざらずに分かれる。切り替え自体は接続先をまたがないので、
 * 従来どおり updateFolders の速い経路がそのまま使える。
 */
class ParadisRemoteDefaultWorkspace extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.remoteDefaultWorkspace';

	constructor(
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@IFileService private readonly fileService: IFileService,
		@IHostService private readonly hostService: IHostService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		void this.openIfNeeded();
	}

	private async openIfNeeded(): Promise<void> {
		// 接続していないウィンドウは electron-main 側が面倒を見ている
		if (!this.environmentService.remoteAuthority) {
			return;
		}
		// 既にフォルダ／ワークスペースを開いているなら触らない。
		// 「接続先を開く」で直接フォルダを指定した場合もここで抜ける。
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			return;
		}
		if (!this.configurationService.getValue<boolean>(PARADIS_REMOTE_DEFAULT_WORKSPACE_SETTING)) {
			return;
		}

		try {
			// 接続中の userHome は接続先のホーム。fileService も vscode-remote 側を見るので、
			// ここで組み立てた URI は接続先のパスとして解決される。
			const userHome = await this.pathService.userHome();
			const workspaceFile = joinPath(userHome, '.para-code', 'para.code-workspace');
			// 未作成なら何もしない。ローカル側の paradisEnsureDefaultWorkspace と同じ判断で、
			// 初回は「Para Code: Initialize Multi-Repo Workspace」（未初期化のときに出る通知の
			// ボタンからも辿れる）に任せる。勝手にファイルを置きに行かない。
			if (!(await this.fileService.exists(workspaceFile))) {
				return;
			}
			await this.hostService.openWindow([{ workspaceUri: workspaceFile }], { forceReuseWindow: true });
		} catch (error) {
			// 開けなくても接続自体は使えるので、ウィンドウを壊さずログだけ残す
			// （接続先のホームが読めない・書き込めない構成などが該当する）
			this.logService.warn('[paradis] could not open the remote multi-repo workspace', error);
		}
	}
}

registerWorkbenchContribution2(ParadisRemoteDefaultWorkspace.ID, ParadisRemoteDefaultWorkspace, WorkbenchPhase.AfterRestored);

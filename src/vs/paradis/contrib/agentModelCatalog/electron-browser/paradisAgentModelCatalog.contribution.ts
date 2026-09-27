/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したら、インストール済みの CLI から取ったモデル一覧を shared process から受け取り、
// 新しいスペースの作成（ダイアログ・モバイルからの作成）の候補へ反映する。
//
// 利用者が `paradis.workspaceSwitch.agents` を自分で書いている間は取りに行かない（使わないので、
// CLI を起こす理由が無い）。書いた設定を消したら、その時点で取りに行く。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisAgentModelCatalog,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_WORKSPACE_AGENTS_SETTING,
	paradisIsAgentListUserDefined,
	paradisSetDiscoveredAgentModels,
} from '../common/paradisAgentModelCatalog.js';

class ParadisAgentModelCatalogLoader extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.agentModelCatalogLoader';

	private loaded = false;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_WORKSPACE_AGENTS_SETTING)) {
				this.load();
			}
		}));
		this.load();
	}

	private load(): void {
		if (this.loaded || paradisIsAgentListUserDefined(this.configurationService)) {
			return;
		}
		this.loaded = true;
		this.sharedProcessService.getChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL).call<IParadisAgentModelCatalog[]>('getCatalogs').then(catalogs => {
			if (!this._store.isDisposed) {
				paradisSetDiscoveredAgentModels(catalogs);
			}
		}, error => {
			this.loaded = false;
			this.logService.warn('[ParadisAgentModelCatalog] could not read the model lists; keeping the built-in candidates', error);
		});
	}
}

registerWorkbenchContribution2(ParadisAgentModelCatalogLoader.ID, ParadisAgentModelCatalogLoader, WorkbenchPhase.Eventually);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// インストール済みの CLI から取ったモデル一覧を shared process から受け取り、新しいスペースの
// 作成（ダイアログ・モバイルからの作成）の候補へ反映する。
//
// 起動したときと、作成ダイアログを開くたびに取り直す（shared process は 60 秒は同じ結果を返し、
// CLI を起こすのは版が変わったときだけ）。利用者が `paradis.workspaceSwitch.agents` を自分で
// 書いている間は取りに行かない（使わないので、CLI を起こす理由が無い）。

import { Emitter } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisAgentCommandTemplate } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	IParadisAgentModelCatalog,
	IParadisAgentModelCatalogService,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_WORKSPACE_AGENTS_SETTING,
	paradisIsAgentListUserDefined,
	paradisResolveAgentTemplates,
} from '../common/paradisAgentModelCatalog.js';

class ParadisAgentModelCatalogService extends Disposable implements IParadisAgentModelCatalogService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private catalogs: readonly IParadisAgentModelCatalog[] = [];
	private inFlight = false;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_WORKSPACE_AGENTS_SETTING)) {
				// 自分で書いた定義を消したら、その場で取りに行く。書いたなら一覧の組み立て直しだけ
				this._onDidChange.fire();
				this.refresh();
			}
		}));
	}

	getAgentTemplates(): readonly IParadisAgentCommandTemplate[] {
		return paradisResolveAgentTemplates(this.configurationService, this.catalogs);
	}

	refresh(): void {
		if (this.inFlight || paradisIsAgentListUserDefined(this.configurationService)) {
			return;
		}
		this.inFlight = true;
		this.sharedProcessService.getChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL).call<IParadisAgentModelCatalog[]>('getCatalogs').then(catalogs => {
			if (this._store.isDisposed) {
				return;
			}
			// 取れた日時だけが違う同じ一覧では、開いているダイアログを組み直さない
			const strip = (list: readonly IParadisAgentModelCatalog[]) => list.map(catalog => ({ ...catalog, fetchedAt: 0 }));
			if (!equals(strip(catalogs), strip(this.catalogs))) {
				this.catalogs = catalogs;
				this._onDidChange.fire();
			}
		}, error => {
			this.logService.warn('[ParadisAgentModelCatalog] could not read the model lists; keeping the current candidates', error);
		}).finally(() => {
			this.inFlight = false;
		});
	}
}

registerSingleton(IParadisAgentModelCatalogService, ParadisAgentModelCatalogService, InstantiationType.Delayed);

/** 起動したら一度取っておく（最初にダイアログを開いたときから新しい候補が並ぶように）。 */
class ParadisAgentModelCatalogWarmup implements IWorkbenchContribution {

	static readonly ID = 'paradis.agentModelCatalogWarmup';

	constructor(@IParadisAgentModelCatalogService modelCatalogService: IParadisAgentModelCatalogService) {
		modelCatalogService.refresh();
	}
}

registerWorkbenchContribution2(ParadisAgentModelCatalogWarmup.ID, ParadisAgentModelCatalogWarmup, WorkbenchPhase.AfterRestored);

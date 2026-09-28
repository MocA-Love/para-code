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
// 書いている間は取りに行かない（使わないので、CLI を起こす理由が無い）。その間はダイアログに
// 「設定で固定中」と出し、既定へ戻す操作をここで受け持つ。

import { Emitter } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
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
	paradisResetAgentListSetting,
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
		@IDialogService private readonly dialogService: IDialogService,
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

	isFixedBySettings(): boolean {
		return paradisIsAgentListUserDefined(this.configurationService);
	}

	async resetToDefault(): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			// allow-any-unicode-next-line
			message: localize('paradis.agentModelCatalog.resetConfirm', "エージェントの一覧を既定に戻しますか？"),
			// allow-any-unicode-next-line
			detail: localize('paradis.agentModelCatalog.resetConfirmDetail', "設定 {0} に書かれた一覧を消します。以後はインストール済みの Claude Code と Codex から取ったモデルの一覧を使います。", PARADIS_WORKSPACE_AGENTS_SETTING),
			// allow-any-unicode-next-line
			primaryButton: localize({ key: 'paradis.agentModelCatalog.resetConfirmButton', comment: ['&& denotes a mnemonic'] }, "既定に戻す(&&R)"),
		});
		if (!confirmed) {
			return false;
		}
		try {
			await paradisResetAgentListSetting(this.configurationService);
		} catch (error) {
			this.logService.warn('[ParadisAgentModelCatalog] could not reset the agent list setting', error);
			// allow-any-unicode-next-line
			await this.dialogService.error(localize('paradis.agentModelCatalog.resetFailed', "設定を既定に戻せませんでした。settings.json の {0} を消してください。", PARADIS_WORKSPACE_AGENTS_SETTING));
			return false;
		}
		return !this.isFixedBySettings();
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

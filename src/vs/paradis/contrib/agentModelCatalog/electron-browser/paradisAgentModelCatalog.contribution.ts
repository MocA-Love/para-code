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
// 書いていて、既定の Claude / Codex の行が1つも残っていない間は取りに行かない（使わないので、CLI を
// 起こす理由が無い）。既定と違う行がある間はダイアログに「設定で固定中」と出し、既定へ戻す操作をここで受け持つ。

import { Emitter } from '../../../../base/common/event.js';
import { equals } from '../../../../base/common/objects.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import Severity from '../../../../base/common/severity.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IPreferencesService } from '../../../../workbench/services/preferences/common/preferences.js';
import { IParadisAgentCommandTemplate } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	IParadisAgentModelCatalog,
	IParadisAgentModelCatalogService,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_WORKSPACE_AGENTS_SETTING,
	ParadisAgentListBlockedLayer,
	paradisAgentListResetPlan,
	paradisAgentListUsesCatalog,
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
		@IPreferencesService private readonly preferencesService: IPreferencesService,
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
		const plan = paradisAgentListResetPlan(this.configurationService);
		const lines: string[] = [
			// allow-any-unicode-next-line
			localize('paradis.agentModelCatalog.resetConfirmDetail', "設定 {0} の一覧を消し、インストール済みの Claude Code と Codex から取ったモデルの一覧を使います。", PARADIS_WORKSPACE_AGENTS_SETTING),
		];
		if (plan.addedIds.length > 0) {
			// allow-any-unicode-next-line
			lines.push(localize('paradis.agentModelCatalog.resetRemovesAdded', "自分で足したエージェントも消えます: {0}", plan.addedIds.join(', ')));
		}
		if (plan.modifiedIds.length > 0) {
			// allow-any-unicode-next-line
			lines.push(localize('paradis.agentModelCatalog.resetRevertsModified', "書き換えた内容は既定に戻ります: {0}", plan.modifiedIds.join(', ')));
		}
		if (plan.addedIds.length > 0 || plan.modifiedIds.length > 0) {
			// allow-any-unicode-next-line
			lines.push(localize('paradis.agentModelCatalog.resetKeepHint', "残したい内容があれば、先に「settings.json を開く」で写しておいてください。"));
		}
		const blocked = this.describeBlockedLayers(plan.blockedLayers);
		if (blocked !== undefined) {
			lines.push(blocked);
		}
		const { result } = await this.dialogService.prompt<'reset' | 'open' | undefined>({
			type: Severity.Warning,
			// allow-any-unicode-next-line
			message: localize('paradis.agentModelCatalog.resetConfirm', "エージェントの一覧を既定に戻しますか？"),
			detail: lines.join('\n'),
			buttons: [
				// allow-any-unicode-next-line
				{ label: localize({ key: 'paradis.agentModelCatalog.resetConfirmButton', comment: ['&& denotes a mnemonic'] }, "既定に戻す(&&R)"), run: () => 'reset' },
				// allow-any-unicode-next-line
				{ label: localize({ key: 'paradis.agentModelCatalog.openSettingsJson', comment: ['&& denotes a mnemonic'] }, "settings.json を開く(&&O)"), run: () => 'open' },
			],
			cancelButton: true,
		});
		const choice = await result;
		if (choice === 'open') {
			await this.preferencesService.openUserSettings({ jsonEditor: true, revealSetting: { key: PARADIS_WORKSPACE_AGENTS_SETTING, edit: false } });
			return false;
		}
		if (choice !== 'reset') {
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
		if (this.isFixedBySettings()) {
			// 消せない層に残っている。何もしなかったように見えないよう、理由を伝える
			const reason = this.describeBlockedLayers(paradisAgentListResetPlan(this.configurationService).blockedLayers)
				// allow-any-unicode-next-line
				?? localize('paradis.agentModelCatalog.resetIncompleteUnknown', "ほかの場所の設定に一覧が残っています。");
			// allow-any-unicode-next-line
			await this.dialogService.info(localize('paradis.agentModelCatalog.resetIncomplete', "一覧を既定に戻しきれませんでした"), reason);
			return false;
		}
		return true;
	}

	/** Para Code から消せない層に値があるとき、その場所と消し方の説明。無ければ undefined。 */
	private describeBlockedLayers(layers: readonly ParadisAgentListBlockedLayer[]): string | undefined {
		if (layers.length === 0) {
			return undefined;
		}
		const names = layers.map(layer => {
			switch (layer) {
				// allow-any-unicode-next-line
				case 'workspaceFolder': return localize('paradis.agentModelCatalog.layerFolder', "フォルダの設定（.vscode/settings.json）");
				// allow-any-unicode-next-line
				case 'policy': return localize('paradis.agentModelCatalog.layerPolicy', "組織のポリシー");
				// allow-any-unicode-next-line
				case 'application': return localize('paradis.agentModelCatalog.layerApplication', "アプリケーション全体の設定");
			}
		});
		// allow-any-unicode-next-line
		return localize('paradis.agentModelCatalog.resetBlocked', "{0} に書かれた一覧は Para Code からは消せません。その場所で消してください。", names.join(', '));
	}

	refresh(): void {
		if (this.inFlight || !paradisAgentListUsesCatalog(this.configurationService)) {
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

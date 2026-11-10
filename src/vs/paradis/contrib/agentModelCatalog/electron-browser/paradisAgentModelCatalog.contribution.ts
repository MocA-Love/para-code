/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// インストール済みの CLI から取ったモデル一覧を受け取り、新しいスペースの作成（ダイアログ・モバイルからの作成）の
// 候補へ反映する。手元のウィンドウは shared process（手元の CLI）から、SSH のウィンドウは接続先の REH（接続先の CLI）
// から取る。SSH のウィンドウではエージェントが接続先で動くので、手元の CLI の一覧では版が合わない。一覧のチャネルを
// 持たない古い REH では、手元の一覧に戻さず、別名だけの固定の候補を使う（どの版の CLI でも通るため）。
//
// 起動したときと、作成ダイアログを開くたびに取り直す（shared process は 60 秒は同じ結果を返し、
// CLI を起こすのは版が変わったときだけ）。利用者が `paradis.workspaceSwitch.agents` を自分で
// 書いていて、既定の Claude / Codex の行が1つも残っていない間は取りに行かない（使わないので、CLI を
// 起こす理由が無い）。既定と違う行がある間はダイアログに「設定で固定中」と出し、既定へ戻す操作をここで受け持つ。

import { Emitter } from '../../../../base/common/event.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
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
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisIsUnknownChannelError } from '../../fileTransfer/common/paradisFileTransfer.js';
import { IParadisAgentCommandTemplate } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	IParadisAgentModelCatalog,
	IParadisAgentModelCatalogService,
	PARADIS_AGENT_MODEL_CATALOG_CHANNEL,
	PARADIS_WORKSPACE_AGENTS_SETTING,
	ParadisAgentListBlockedLayer,
	ParadisAgentListResetResult,
	paradisAgentListResetPlan,
	paradisAgentListUsesCatalog,
	paradisIsAgentListUserDefined,
	paradisResetAgentListSetting,
	paradisResolveAgentTemplates,
	paradisSwitchableAgentModels,
} from '../common/paradisAgentModelCatalog.js';

export class ParadisAgentModelCatalogService extends Disposable implements IParadisAgentModelCatalogService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private catalogs: readonly IParadisAgentModelCatalog[] = [];
	private inFlight = false;
	/** 接続先が一覧のチャネルを持たない古い REH だと分かった（ウィンドウが生きている間は変わらない）。 */
	private remoteUnsupported = false;

	constructor(
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@ILogService private readonly logService: ILogService,
		@IRemoteAgentService private readonly remoteAgentService: IRemoteAgentService,
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

	getSwitchableModels(agentId: string): readonly { readonly id: string; readonly resolvedModel?: string }[] {
		return paradisSwitchableAgentModels(agentId, this.getAgentTemplates(), this.catalogs);
	}

	isFixedBySettings(): boolean {
		return paradisIsAgentListUserDefined(this.configurationService);
	}

	async openSettingsJson(): Promise<void> {
		await this.preferencesService.openUserSettings({ jsonEditor: true, revealSetting: { key: PARADIS_WORKSPACE_AGENTS_SETTING, edit: false } });
	}

	async resetToDefault(): Promise<ParadisAgentListResetResult> {
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
			// ここでは開かない。呼んだ画面が自分のダイアログを閉じてから openSettingsJson を呼ぶ
			return 'openSettings';
		}
		if (choice !== 'reset') {
			return 'unchanged';
		}
		try {
			await paradisResetAgentListSetting(this.configurationService);
		} catch (error) {
			this.logService.warn('[ParadisAgentModelCatalog] could not reset the agent list setting', error);
			// allow-any-unicode-next-line
			await this.dialogService.error(localize('paradis.agentModelCatalog.resetFailed', "設定を既定に戻せませんでした。settings.json の {0} を消してください。", PARADIS_WORKSPACE_AGENTS_SETTING));
			return 'unchanged';
		}
		if (this.isFixedBySettings()) {
			// 消せない層に残っている。何もしなかったように見えないよう、理由を伝える
			const reason = this.describeBlockedLayers(paradisAgentListResetPlan(this.configurationService).blockedLayers)
				// allow-any-unicode-next-line
				?? localize('paradis.agentModelCatalog.resetIncompleteUnknown', "ほかの場所の設定に一覧が残っています。");
			// allow-any-unicode-next-line
			await this.dialogService.info(localize('paradis.agentModelCatalog.resetIncomplete', "一覧を既定に戻しきれませんでした"), reason);
			return 'unchanged';
		}
		return 'reset';
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

	private setCatalogs(catalogs: readonly IParadisAgentModelCatalog[]): void {
		// 取れた日時だけが違う同じ一覧では、開いているダイアログを組み直さない
		const strip = (list: readonly IParadisAgentModelCatalog[]) => list.map(catalog => ({ ...catalog, fetchedAt: 0 }));
		if (!equals(strip(catalogs), strip(this.catalogs))) {
			this.catalogs = catalogs;
			this._onDidChange.fire();
		}
	}

	refresh(): void {
		if (this.inFlight || this.remoteUnsupported || !paradisAgentListUsesCatalog(this.configurationService)) {
			return;
		}
		this.inFlight = true;
		const remote = this.remoteAgentService.getConnection();
		// SSH のウィンドウでは、エージェントを起動する接続先の CLI に聞く
		const channel: IChannel = remote !== null ? remote.getChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL) : this.sharedProcessService.getChannel(PARADIS_AGENT_MODEL_CATALOG_CHANNEL);
		channel.call<IParadisAgentModelCatalog[]>('getCatalogs').then(catalogs => {
			if (this._store.isDisposed) {
				return;
			}
			this.setCatalogs(catalogs);
		}, error => {
			if (remote !== null && paradisIsUnknownChannelError(error)) {
				// 古い REH。手元の CLI の一覧は接続先の版と合わないので使わず、別名だけの固定の候補にする
				this.remoteUnsupported = true;
				this.logService.info('[ParadisAgentModelCatalog] the remote server cannot list models (older server); using the built-in model aliases');
				if (!this._store.isDisposed) {
					this.setCatalogs([]);
				}
				return;
			}
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

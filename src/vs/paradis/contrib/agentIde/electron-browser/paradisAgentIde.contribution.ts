/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// IDE 操作ツール（O1）とスキルの設置（O4）のウィンドウ側の登録。
//  - 設定 `paradis.agentIde.*` のスキーマ
//  - shared process の MCP サーバーから呼ばれるチャネル（paradisAgentIdeChannel.ts）
//  - 「設定 (Para Code)」のボタンから呼ぶ「スキルを設置」コマンド

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING,
	PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING,
	PARADIS_AGENT_IDE_CHANNEL,
	PARADIS_AGENT_IDE_SKILLS_CHANNEL,
} from '../common/paradisAgentIde.js';
import { ParadisAgentIdeChannel } from './paradisAgentIdeChannel.js';
import { IParadisAgentIdeSkillInspection, IParadisAgentIdeSkillInstallRequest, IParadisAgentIdeSkillInstallResult, paradisAgentIdeSkillInstallPlan } from '../common/paradisAgentIdeSkillPlan.js';

/** 「設定 (Para Code)」のボタンから呼ぶコマンド。 */
export const PARADIS_AGENT_IDE_INSTALL_SKILLS_COMMAND_ID = 'paradis.agentIde.installSkills';

const paradisConfigurationNodeBase = Object.freeze<IConfigurationNode>({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object'
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...paradisConfigurationNodeBase,
	properties: {
		[PARADIS_AGENT_IDE_ALLOW_ACTIONS_SETTING]: {
			type: 'boolean',
			default: false,
			// リポジトリの .vscode/settings.json から勝手にオンにされないよう、利用者の設定でだけ変えられる
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentIde.allowActions', "Para Code の MCP ツールを使って、エージェントが他のターミナルへ入力を送る・Claude Code や Codex を起動する・スペース（worktree）を作る・自分で作ったターミナルを閉じることを許可します。\n\nオフの間も、ターミナルやスペースの一覧、画面の読み取り、終わるまで待つことはできます。\n\nオンにすると、Web ページなどに仕込まれた指示を読んだエージェントが、それを別のエージェントへ伝えてしまう危険があります。許可待ち・質問中のターミナルへは送りません。"),
		},
		[PARADIS_AGENT_IDE_ACTION_SCOPE_SETTING]: {
			type: 'string',
			enum: ['space', 'window'],
			default: 'space',
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			enumDescriptions: [
				// allow-any-unicode-next-line
				localize('paradis.agentIde.actionScope.space', "同じスペースのターミナルだけ。エージェント自身が作ったターミナルとスペースには、スペースが違っても送れます。"),
				// allow-any-unicode-next-line
				localize('paradis.agentIde.actionScope.window', "同じウィンドウのすべてのターミナル。別のウィンドウへは送れません。"),
			],
			// allow-any-unicode-next-line
			markdownDescription: localize('paradis.agentIde.actionScope', "エージェントが入力を送れる範囲です。`#paradis.agentIde.allowActions#` がオンのときだけ使われます。"),
		},
	}
});

/** MCP サーバー（shared process）から呼ばれるチャネルを、このウィンドウの分だけ登録する。 */
class ParadisAgentIdeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentIde';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_IDE_CHANNEL, instantiationService.createInstance(ParadisAgentIdeChannel));
	}
}

registerWorkbenchContribution2(ParadisAgentIdeContribution.ID, ParadisAgentIdeContribution, WorkbenchPhase.AfterRestored);

// allow-any-unicode-next-line
const AGENT_LABEL: Record<IParadisAgentIdeSkillInspection['agent'], string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Claude Code と Codex のスキルの置き場所へ、Para Code のスキルファイルを置く。
 * 押したときだけ書く。置く前に場所を見せて確かめ、中身の違うファイルがあれば上書きするかを別に聞く。
 */
class ParadisInstallAgentSkillsAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_AGENT_IDE_INSTALL_SKILLS_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.agentIde.installSkills', "Claude Code と Codex に Para Code のスキルを設置"),
			category: localize2('paradis.category', "Para Code"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const channel = accessor.get(ISharedProcessService).getChannel(PARADIS_AGENT_IDE_SKILLS_CHANNEL);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		let inspections: IParadisAgentIdeSkillInspection[];
		try {
			inspections = await channel.call<IParadisAgentIdeSkillInspection[]>('inspect');
		} catch (error) {
			logService.warn('[ParadisAgentIde] skill inspection failed', error);
			// allow-any-unicode-next-line
			notificationService.notify({ severity: Severity.Error, message: localize('paradis.agentIde.skills.inspectFailed', "スキルの置き場所を確かめられませんでした。") });
			return;
		}
		const plan = paradisAgentIdeSkillInstallPlan(inspections);
		const describe = (inspection: IParadisAgentIdeSkillInspection) => {
			switch (inspection.state) {
				// allow-any-unicode-next-line
				case 'missing': return localize('paradis.agentIde.skills.stateMissing', "{0}: {1}（新しく作ります）", AGENT_LABEL[inspection.agent], inspection.path);
				// allow-any-unicode-next-line
				case 'same': return localize('paradis.agentIde.skills.stateSame', "{0}: {1}（同じ内容が既にあります）", AGENT_LABEL[inspection.agent], inspection.path);
				// allow-any-unicode-next-line
				case 'different': return localize('paradis.agentIde.skills.stateDifferent', "{0}: {1}（別の内容のファイルがあります）", AGENT_LABEL[inspection.agent], inspection.path);
				// allow-any-unicode-next-line
				case 'notAFile': return localize('paradis.agentIde.skills.stateNotAFile', "{0}: {1}（ファイルではないため触りません）", AGENT_LABEL[inspection.agent], inspection.path);
			}
		};
		const detail = inspections.map(describe).join('\n');

		if (plan.missing.length === 0 && plan.different.length === 0) {
			// allow-any-unicode-next-line
			await dialogService.info(localize('paradis.agentIde.skills.nothingToDo', "設置するものはありません。"), detail);
			return;
		}

		const { confirmed } = await dialogService.confirm({
			// allow-any-unicode-next-line
			message: localize('paradis.agentIde.skills.confirm', "Para Code のスキルファイルを設置しますか？"),
			// allow-any-unicode-next-line
			detail: localize('paradis.agentIde.skills.confirmDetail', "{0}\n\nスキルファイルは「Para Code の MCP ツールでガイドを読む」ようエージェントに伝えるだけの短い文書です。", detail),
			// allow-any-unicode-next-line
			primaryButton: localize('paradis.agentIde.skills.confirmAction', "設置"),
		});
		if (!confirmed) {
			return;
		}

		let overwrite = false;
		if (plan.different.length > 0) {
			const { result } = await dialogService.prompt<'overwrite' | 'keep' | undefined>({
				type: Severity.Warning,
				// allow-any-unicode-next-line
				message: localize('paradis.agentIde.skills.overwriteConfirm', "別の内容の SKILL.md が既にあります。上書きしますか？"),
				detail: plan.different.map(describe).join('\n'),
				buttons: [
					// allow-any-unicode-next-line
					{ label: localize('paradis.agentIde.skills.overwrite', "上書きする"), run: () => 'overwrite' as const },
					// allow-any-unicode-next-line
					{ label: localize('paradis.agentIde.skills.keep', "上書きしない"), run: () => 'keep' as const },
				],
				cancelButton: true,
			});
			if (result === undefined) {
				return;
			}
			overwrite = result === 'overwrite';
		}

		const requests: IParadisAgentIdeSkillInstallRequest[] = [...plan.missing, ...plan.different].map(inspection => ({ agent: inspection.agent, overwrite }));
		let results: IParadisAgentIdeSkillInstallResult[];
		try {
			results = await channel.call<IParadisAgentIdeSkillInstallResult[]>('install', [requests]);
		} catch (error) {
			logService.warn('[ParadisAgentIde] skill install failed', error);
			// allow-any-unicode-next-line
			notificationService.notify({ severity: Severity.Error, message: localize('paradis.agentIde.skills.installFailed', "スキルファイルを設置できませんでした。") });
			return;
		}
		const installed = results.filter(result => result.outcome === 'installed' || result.outcome === 'overwritten');
		const failed = results.filter(result => result.outcome === 'failed');
		if (failed.length > 0) {
			logService.warn('[ParadisAgentIde] some skill files were not written', failed);
		}
		notificationService.notify({
			severity: failed.length > 0 ? Severity.Warning : Severity.Info,
			message: failed.length > 0
				// allow-any-unicode-next-line
				? localize('paradis.agentIde.skills.partial', "{0} 件を設置し、{1} 件は書き込めませんでした: {2}", installed.length, failed.length, failed.map(result => result.path).join(', '))
				// allow-any-unicode-next-line
				: localize('paradis.agentIde.skills.done', "{0} 件のスキルファイルを設置しました。次に起動した Claude Code / Codex から使えます。", installed.length),
		});
	}
}

registerAction2(ParadisInstallAgentSkillsAction);

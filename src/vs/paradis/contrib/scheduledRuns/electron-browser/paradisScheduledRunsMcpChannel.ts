/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser MCP の create_scheduled_run（paradisScheduledRunToolProvider.ts）の受け口。shared process が
// 呼び出し元ペインのウィンドウだけへ送ってくる。
//
// - 作る先は呼び出し元ペインのスペースのリポジトリ（エージェントに選ばせない）
// - エージェントの id は利用者のエージェントの一覧にあるものだけ。モデル・権限は既定のまま
// - 作った定期実行は無効のまま（shared process が強制する）。どのターミナルのエージェントが作ったかを通知し、
//   通知から定期実行の画面を開ける

import { toAction } from '../../../../base/common/actions.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ParadisChannelArgs } from '../../../common/paradisChannelArgs.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { paradisBindingRestoreDisplayName } from '../../agentBrowser/common/paradisBindingRestoreController.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisResolveInstanceSpace } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisScheduledRunDraft, paradisValidateScheduledRunDraft } from '../common/paradisScheduledRuns.js';
import { IParadisScheduledRunToolRequest, PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID, PARADIS_SCHEDULED_RUNS_MCP_CHANNEL, PARADIS_SCHEDULED_RUNS_MCP_METHOD, ParadisScheduledRunToolResult } from '../common/paradisScheduledRunTools.js';
import { IParadisScheduledRunsClient } from './paradisScheduledRunsClient.js';

function fail(error: string): ParadisScheduledRunToolResult {
	return { ok: false, error };
}

function isRequest(value: unknown): value is IParadisScheduledRunToolRequest {
	return isRecord(value) && typeof value.name === 'string' && typeof value.schedule === 'string' && typeof value.prompt === 'string'
		&& (value.target === 'repository' || value.target === 'newSpace') && typeof value.dailyLimit === 'number'
		&& (value.agent === undefined || typeof value.agent === 'string')
		&& (value.baseRef === undefined || typeof value.baseRef === 'string')
		&& (value.precheck === undefined || (isRecord(value.precheck) && typeof value.precheck.command === 'string' && typeof value.precheck.timeoutSeconds === 'number'));
}

class ParadisScheduledRunsMcpChannel implements IServerChannel {

	constructor(
		private readonly paneTokenService: IParadisPaneTokenService,
		private readonly terminalService: ITerminalService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly switchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly modelCatalogService: IParadisAgentModelCatalogService,
		private readonly client: IParadisScheduledRunsClient,
		private readonly notificationService: INotificationService,
		private readonly commandService: ICommandService,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command !== PARADIS_SCHEDULED_RUNS_MCP_METHOD) {
			throw new Error(`Method not found: ${command}`);
		}
		const args = ParadisChannelArgs.from(arg);
		const paneToken = args.string(0);
		const request = args.at(1);
		if (paneToken === undefined || !isRequest(request)) {
			return fail('Para Code received a malformed scheduled run request.') as T;
		}
		return await this.create(paneToken, request) as T;
	}

	private async create(paneToken: string, request: IParadisScheduledRunToolRequest): Promise<ParadisScheduledRunToolResult> {
		const instanceId = this.paneTokenService.getInstanceForToken(paneToken);
		if (instanceId === undefined) {
			return fail('Para Code cannot find the terminal pane of this agent.');
		}
		const space = paradisResolveInstanceSpace(this.terminalScopeService, this.switchService.activeStateKey, instanceId, { strict: true });
		const entry = space !== undefined ? paradisListSpaces(this.switchService.repositories, this.worktreeService).find(candidate => candidate.space === space) : undefined;
		const repository = entry ? this.switchService.repositories.find(candidate => candidate.id === entry.repositoryId) : undefined;
		if (!repository) {
			return fail('Para Code cannot tell which repository your terminal belongs to, so it cannot create a scheduled run. Ask the user to create it in Para Code (gear menu > 定期実行).');
		}
		const agents = this.modelCatalogService.getAgentTemplates().filter(agent => agent.id !== 'none');
		const agent = request.agent !== undefined ? agents.find(candidate => candidate.id === request.agent) : agents[0];
		if (!agent) {
			return fail(agents.length === 0
				? 'The user has no agent in the Para Code agent list, so Para Code cannot create a scheduled run.'
				: `Unknown "agent". Use one of: ${agents.map(candidate => candidate.id).join(', ')}.`);
		}
		const draft: IParadisScheduledRunDraft = {
			name: request.name,
			schedule: request.schedule,
			target: {
				kind: request.target,
				repositoryUri: repository.uri.toString(),
				repositoryName: repository.name,
				...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
			},
			agentId: agent.id,
			prompt: request.prompt,
			dailyLimit: request.dailyLimit,
			...(request.precheck ? { precheck: request.precheck } : {}),
			createdByAgent: true,
		};
		// 規則（間隔・長さ・事前確認を使えるリポジトリか）の文は利用者向けの日本語なので、そのまま添えて返す
		const problem = paradisValidateScheduledRunDraft(draft);
		if (problem !== undefined) {
			return fail(`Para Code refused the scheduled run: ${problem}`);
		}
		const result = await this.client.save(draft);
		if (!result.ok || !result.definition) {
			return fail(`Para Code could not save the scheduled run: ${result.error ?? 'unknown error'}`);
		}
		const definition = result.definition;
		const instance = this.terminalService.getInstanceFromId(instanceId);
		const caller = paradisBindingRestoreDisplayName(instance?.title, localize('paradis.scheduledRuns.mcp.unknownCaller', "不明"));
		const title = paradisBindingRestoreDisplayName(definition.name, definition.name);
		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('paradis.scheduledRuns.mcp.created', "ターミナル「{0}」のエージェントが定期実行「{1}」を作りました。無効のままです。指示と事前確認のコマンドを確かめてから有効にしてください。", caller, title),
			actions: { primary: [toAction({ id: 'paradis.scheduledRuns.mcp.open', label: localize('paradis.scheduledRuns.mcp.open', "定期実行を開く"), run: () => this.commandService.executeCommand(PARADIS_OPEN_SCHEDULED_RUNS_COMMAND_ID) })] },
		});
		return {
			ok: true,
			data: {
				id: definition.id,
				name: definition.name,
				enabled: false,
				schedule: definition.schedule,
				repository: repository.name,
				target: request.target === 'newSpace' ? 'new_space' : 'repository',
				agent: agent.id,
				precheck: definition.precheck !== undefined,
				next_step: 'The scheduled run is disabled. Tell the user to review it in Para Code (gear menu > 定期実行) and turn it on there; you cannot enable it.',
			},
		};
	}
}

class ParadisScheduledRunsMcpContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisScheduledRunsMcp';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
		@ITerminalService terminalService: ITerminalService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisWorkspaceSwitchService switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisAgentModelCatalogService modelCatalogService: IParadisAgentModelCatalogService,
		@IParadisScheduledRunsClient client: IParadisScheduledRunsClient,
		@INotificationService notificationService: INotificationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_SCHEDULED_RUNS_MCP_CHANNEL, new ParadisScheduledRunsMcpChannel(
			paneTokenService, terminalService, terminalScopeService, switchService, worktreeService, modelCatalogService, client, notificationService, commandService,
		));
	}
}

registerWorkbenchContribution2(ParadisScheduledRunsMcpContribution.ID, ParadisScheduledRunsMcpContribution, WorkbenchPhase.AfterRestored);

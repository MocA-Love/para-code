/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のターミナルを起動する（ウィンドウの側）。`requestLaunch` の結果を受け、専用フォルダを cwd にエージェントを起動し、
// コマンドを送る前にペインを shared process へ報告する（paradisRunBotLaunch）。会話を開く（paradisBotsLaunch.contribution.ts）と
// 定期実行の見回り（scheduledRuns の runner）の両方が使う。

import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisBotLaunchedTerminal, paradisBotTabTitle, paradisRunBotLaunch } from '../common/paradisBotLaunchSteps.js';
import { IParadisBotLaunch, IParadisBotsService } from '../common/paradisBotsApi.js';

/**
 * タブ名の雛形を Bot の名前にする（固定の名前にするとエージェントのタイトルの購読が止まるため、雛形で付ける）。
 * terminalInstance.ts の PARA-PATCH でエージェントの CLI のタイトルが雛形より先に立つので、エージェントが動いている間は
 * エージェントの出すタイトルが、動いていない間（起動の直後・終わった後）は Bot の名前がタブに出る。
 */
export function paradisNameBotTab(instance: ITerminalInstance | undefined, name: string): void {
	if (instance === undefined || instance.isDisposed) {
		return;
	}
	const title = paradisBotTabTitle(name);
	if (instance.shellLaunchConfig.titleTemplate === title) {
		return;
	}
	instance.shellLaunchConfig.titleTemplate = title;
	// 利用者が手で付けた名前（固定タイトル）があればそちらを残す。無ければラベルを計算し直させる
	// （paradisPresetService.ts と同じやり方。rename(undefined) は固定タイトルが無い端末では再計算だけ）
	if (!instance.staticTitle) {
		void instance.rename(undefined);
	}
}

export function paradisFindBotTerminalInstance(terminalService: ITerminalService, terminalGroupService: ITerminalGroupService, instanceId: number): ITerminalInstance | undefined {
	return paradisCollectAllTerminalInstances(terminalService, terminalGroupService).find(instance => instance.instanceId === instanceId);
}

export interface IParadisBotTerminalLaunchOptions {
	/** 起動するスペース。 */
	readonly stateKey: string | undefined;
	/** 前に出さず、利用者の入力を奪わない裏のタブで起動する（スペースが要る）。 */
	readonly background: boolean;
	/** エージェントへ最初に渡す指示（見回り）。 */
	readonly prompt?: string;
}

export type ParadisBotTerminalLaunchResult =
	| { readonly ok: true; readonly terminal: IParadisBotLaunchedTerminal }
	/** `refused`: shared process が結び付けを断った。`failed`: ターミナルかエージェントを起動できなかった。 */
	| { readonly ok: false; readonly reason: 'refused' | 'failed' };

/** `requestLaunch` で受けた起動を、このウィンドウで行う。 */
export async function paradisLaunchBotTerminal(accessor: ServicesAccessor, launch: IParadisBotLaunch, options: IParadisBotTerminalLaunchOptions): Promise<ParadisBotTerminalLaunchResult> {
	const botsService = accessor.get(IParadisBotsService);
	const terminalService = accessor.get(ITerminalService);
	const terminalGroupService = accessor.get(ITerminalGroupService);
	const instantiationService = accessor.get(IInstantiationService);
	const logService = accessor.get(ILogService);
	let terminal: IParadisBotLaunchedTerminal | undefined;
	// コマンドを送る前にペインを報告する（エージェントの MCP の接続より先に、Bot の道具が出るように）
	const outcome = await paradisRunBotLaunch({
		reportLaunch: (launchId, paneToken) => botsService.reportLaunch(launchId, paneToken),
		cancelLaunch: launchId => botsService.cancelLaunch(launchId),
		launchAgent: async beforeCommand => {
			try {
				terminal = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
					rootUri: URI.file(launch.cwd),
					stateKey: options.stateKey,
					agentId: launch.agent,
					...(launch.modelId !== undefined ? { modelId: launch.modelId } : {}),
					...(launch.effortId !== undefined ? { effortId: launch.effortId } : {}),
					...(launch.permissionId !== undefined ? { permissionId: launch.permissionId } : {}),
					...(launch.extraFlags !== undefined ? { extraFlags: launch.extraFlags } : {}),
					...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
					...(options.background && options.stateKey !== undefined ? { preserveFocus: true } : {}),
					beforeCommand,
				});
				return terminal;
			} catch (error) {
				logService.error('[paradisBots] starting the bot terminal failed', error);
				throw error;
			}
		},
		nameTab: instanceId => paradisNameBotTab(paradisFindBotTerminalInstance(terminalService, terminalGroupService, instanceId), launch.name),
	}, launch.launchId);
	if (!outcome.ok || terminal === undefined) {
		return { ok: false, reason: outcome.ok ? 'failed' : outcome.reason };
	}
	return { ok: true, terminal };
}

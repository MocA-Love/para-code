/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のターミナルを起動する（ウィンドウの側）。`requestLaunch` の結果を受け、専用フォルダを cwd にエージェントを起動し、
// コマンドを送る前にペインを shared process へ報告する（paradisRunBotLaunch）。会話を開く（paradisBotsLaunch.contribution.ts）と
// 定期実行の見回り（scheduledRuns の runner）の両方が使う。

import { raceTimeout, timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
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

/** 長い起動の行（見回り・定期実行）を打つ前に、シェルの最初のプロンプトを待つ上限。 */
const SHELL_PROMPT_WAIT_MS = 10_000;
/** プロンプトが出てから行の編集が始まるまでの間（その間に届いた文字も 1 行の上限に掛からないように）。 */
const SHELL_PROMPT_SETTLE_MS = 300;

/**
 * シェルの最初のプロンプト（シェル統合のコマンドの検出が付いた時点）を待つ。起動の直後のシェルは、設定ファイルを読み終えて
 * 行の編集を始めるまで端末を 1 行ずつ受ける形（canonical）にしており、macOS ではその間に届いた 1 行は 1024 バイトで
 * 切られる。見回り・定期実行の起動の行は制限の引数と指示で 1024 バイトを超えるので、プロンプトが出てから打つ。
 * シェル統合が無いシェルでは上限まで待って打つ。
 */
async function paradisWaitForShellPrompt(instance: ITerminalInstance | undefined): Promise<void> {
	if (instance === undefined || instance.isDisposed) {
		return;
	}
	if (instance.capabilities.get(TerminalCapability.CommandDetection) === undefined) {
		const added = Event.toPromise(instance.capabilities.onDidAddCommandDetectionCapability);
		await raceTimeout(added, SHELL_PROMPT_WAIT_MS, () => added.cancel());
	}
	await timeout(SHELL_PROMPT_SETTLE_MS);
}

/**
 * 起動の行を打つ前にシェルのプロンプトを待つか。見回り・定期実行（制限の引数や長い指示が付き、段に関係なく 1024 バイトを
 * 超えうる）と、最初の指示を渡す起動は待つ。指示の無い会話の起動（短い行）は待たない。
 */
export function paradisBotLaunchWaitsForPrompt(launch: Pick<IParadisBotLaunch, 'purpose'>, prompt: string | undefined): boolean {
	return launch.purpose !== 'chat' || (prompt !== undefined && prompt.length > 0);
}

export interface IParadisBotTerminalLaunchOptions {
	/** 起動するスペース。 */
	readonly stateKey: string | undefined;
	/** 前に出さず、利用者の入力を奪わない裏のタブで起動する（スペースが要る）。 */
	readonly background: boolean;
	/** エージェントへ最初に渡す指示（見回り・定期実行）。 */
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
					// 見回り・定期実行・最初の指示つきの長い起動の行は、シェルのプロンプトが出てから打つ
					beforeCommand: paradisBotLaunchWaitsForPrompt(launch, options.prompt) ? async launched => {
						if (!await beforeCommand(launched)) {
							return false;
						}
						await paradisWaitForShellPrompt(paradisFindBotTerminalInstance(terminalService, terminalGroupService, launched.instanceId));
						return true;
					} : beforeCommand,
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

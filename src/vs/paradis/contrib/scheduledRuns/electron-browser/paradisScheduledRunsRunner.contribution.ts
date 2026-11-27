/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の1回分を、このウィンドウで起動して見張る。
//
// shared process が「開始待ち」を知らせてきたら、対象のリポジトリを開いているウィンドウだけが
// `claim` を試み、先に取れた1つが実行する。起動はフェーズ1の起動 API
// （`paradisLaunchAgentInWorkspace` / `paradisRunWorktreeCreateFlow`）をそのまま使い、指示は
// エージェントの起動引数として渡す（ターミナルへ文字を流し込まない）。
//
// 見張り:
// - エージェントの状態（hook 由来のペイン単位の状態）が review になった・状態が消えたら完了
// - permission / question の間は「要対応」。通知は既存のペイン単位の通知（PC のトーストと
//   モバイル）がそのまま出す。スマホから許可すれば working に戻り、続きを見張る
// - 起動から 30 分で終わらなければターミナルを閉じて打ち切る
// - ターミナルが閉じられたら「停止」、このウィンドウを閉じる（再読み込みを含む）ときは
//   動いている定期実行のターミナルを閉じてから「停止」と報告する（見張りの無いまま動かさない）

import { disposableTimeout, IntervalTimer } from '../../../../base/common/async.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';
import { IParadisAgentStatusStore, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisLaunchedAgentTerminal, paradisLaunchAgentInWorkspace, paradisRunWorktreeCreateFlow } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunReport,
	IParadisScheduledRunRequest,
	IParadisScheduledRunSpace,
	ParadisScheduledRunReason,
	PARADIS_SCHEDULED_RUN_HEARTBEAT_MS,
	PARADIS_SCHEDULED_RUN_TIMEOUT_MS,
	paradisScheduledRunLaunchPrompt,
	paradisScheduledRunReasonLabel,
	ParadisBotTaskTools,
} from '../common/paradisScheduledRuns.js';
import { IParadisRunWatchState, PARADIS_RUN_WATCH_INITIAL, paradisAdvanceRunWatch, paradisRunWatchTimeoutReason } from '../common/paradisScheduledRunWatch.js';
import { IParadisScheduledRunsClient } from './paradisScheduledRunsClient.js';
import { paradisBotPatrolPrompt } from '../common/paradisScheduledRunBotPatrol.js';
import { paradisBotTaskPrompt } from '../common/paradisScheduledRunBotTask.js';
import { IParadisBotsService } from '../../bots/common/paradisBotsApi.js';
import { IParadisBotLaunchedTerminal } from '../../bots/common/paradisBotLaunchSteps.js';
import { paradisLaunchBotTerminal } from '../../bots/electron-browser/paradisBotTerminalLaunch.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';

/** このウィンドウで動かしている1回分。 */
/** 制限した段の定期実行が終わってから、その会話のペインを閉じるまで（ベルの台帳へ記録する処理が終わる時間を見込む）。 */
const PARADIS_BOT_TASK_CLOSE_DELAY_MS = 60_000;

interface IActiveRun {
	readonly runId: string;
	readonly definition: IParadisScheduledRunDefinition;
	readonly startedAt: number;
	readonly store: DisposableStore;
	instance?: ITerminalInstance;
	watch: IParadisRunWatchState;
	/** 終わった（報告済み）。起動の途中で止めたときは、起動し終えたところでターミナルを閉じる。 */
	finished: boolean;
}

/** 新しいスペースのブランチ名（ASCII。重複は作成フローが番号を足して避ける）。 */
export function paradisScheduledRunBranchName(definitionId: string, at: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const id = definitionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase();
	return `scheduled-${id}-${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** 新しいスペースの表示名。 */
export function paradisScheduledRunSpaceName(definitionName: string, at: Date): string {
	// allow-any-unicode-next-line
	return localize('paradis.scheduledRuns.spaceName', "{0}（{1}/{2} {3}:{4}）", definitionName, at.getMonth() + 1, at.getDate(), at.getHours(), String(at.getMinutes()).padStart(2, '0'));
}

export class ParadisScheduledRunsRunner extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.scheduledRunsRunner';

	private readonly active = new Map<string, IActiveRun>();
	/** 制限した段の定期実行の会話のペインを閉じる時計。 */
	private readonly limitedTaskCloseTimers = new Set<ReturnType<typeof setTimeout>>();
	/** claim を投げている最中の実行（同じ依頼が2回届いても1回しか試さない）。 */
	private readonly claiming = new Set<string>();
	private ready = false;

	constructor(
		@IParadisScheduledRunsClient private readonly client: IParadisScheduledRunsClient,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentStatusStore private readonly statusStore: IParadisAgentStatusStore,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IParadisBotsService private readonly botsService: IParadisBotsService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this._register(this.client.onDidRequestRun(request => this.onRequest(request)));
		this._register(this.client.onDidRequestStop(runId => this.stop(runId, 'userStopped')));
		this._register(this.statusStore.onDidChangeAgentStatuses(() => this.onStatusesChanged()));
		const heartbeat = this._register(new IntervalTimer());
		heartbeat.cancelAndSet(() => this.sendHeartbeat(), PARADIS_SCHEDULED_RUN_HEARTBEAT_MS);
		this._register(lifecycleService.onWillShutdown(() => {
			for (const run of [...this.active.values()]) {
				this.stop(run.runId, 'windowClosed');
			}
		}));
		this.initialize();
	}

	private async initialize(): Promise<void> {
		// リポジトリ一覧とターミナルの復元が済むまで拾わない（済む前に起動すると、復元の途中の
		// スペースへターミナルを足すことになる）
		try {
			await Promise.all([this.worktreeService.initializationBarrier, this.terminalService.whenConnected]);
		} catch (error) {
			this.logService.warn('[ParadisScheduledRuns] waiting for the window to be ready failed', error);
		}
		if (this._store.isDisposed) {
			return;
		}
		this.ready = true;
		try {
			for (const request of await this.client.getPendingRequests()) {
				this.onRequest(request);
			}
		} catch (error) {
			this.logService.warn('[ParadisScheduledRuns] could not read the pending runs', error);
		}
	}

	private findRepository(definition: IParadisScheduledRunDefinition): IParadisWorkspaceRepository | undefined {
		return this.switchService.repositories.find(repository => repository.uri.toString() === definition.target.repositoryUri);
	}

	private onRequest(request: IParadisScheduledRunRequest): void {
		if (!this.ready || this.active.has(request.run.id) || this.claiming.has(request.run.id)) {
			return;
		}
		if (request.definition.target.kind === 'bot') {
			// Bot の専用フォルダはこの PC にあるので、SSH のウィンドウは手を挙げない。スペースを使っていないウィンドウも、
			// 裏のタブで開けず利用者の入力を奪うので手を挙げない
			if (this.environmentService.remoteAuthority !== undefined || this.switchService.activeStateKey === undefined) {
				return;
			}
		} else if (!this.findRepository(request.definition)) {
			// 対象のリポジトリを開いていないウィンドウは手を挙げない（開いている別のウィンドウに任せる）
			return;
		}
		this.claiming.add(request.run.id);
		this.client.claim(request.run.id).then(claimed => {
			this.claiming.delete(request.run.id);
			if (claimed && !this._store.isDisposed) {
				this.execute(claimed);
			}
		}, error => {
			this.claiming.delete(request.run.id);
			this.logService.warn('[ParadisScheduledRuns] claim failed', error);
		});
	}

	private async execute(request: IParadisScheduledRunRequest): Promise<void> {
		// 指示は打鍵されるコマンドの一部になるので、制御文字を落として 1 行にしてから渡す
		const definition = { ...request.definition, prompt: paradisScheduledRunLaunchPrompt(request.definition.prompt) };
		const run: IActiveRun = {
			runId: request.run.id,
			definition,
			startedAt: Date.now(),
			store: new DisposableStore(),
			watch: PARADIS_RUN_WATCH_INITIAL,
			finished: false,
		};
		this.active.set(run.runId, run);
		// 起動に時間がかかっても、制限時間は起動を始めた時点から数える
		run.store.add(disposableTimeout(() => this.onTimeout(run), PARADIS_SCHEDULED_RUN_TIMEOUT_MS));

		if (definition.target.kind === 'bot') {
			const task = definition.target.botTask;
			// 定期実行は Bot の会話の 1 ターン（眠った会話を続けて起こし、指示を最初の指示として渡す）。見回りは読むだけのペイン
			await this.executeBotPatrol(run, definition.target.botId ?? '', task !== undefined
				? { task: task.tools, prompt: paradisBotTaskPrompt(definition.name, request.definition.prompt, task.tools) }
				: { prompt: paradisBotPatrolPrompt(request.definition.prompt) });
			return;
		}
		const repository = this.findRepository(definition);
		if (!repository) {
			this.finish(run, { runId: run.runId, status: 'failed', reason: 'repositoryMissing' });
			return;
		}
		// 事前確認（時刻で起動する回だけ）。新しいスペースを作る前に、リポジトリのメインのチェックアウトで走らせる
		// （見送る回にスペースを残さない）。走らせるかの判断と記録は shared process が持つ
		if (definition.precheck && request.run.trigger !== 'manual') {
			let proceed = false;
			try {
				const trusted = (await this.workspaceTrustManagementService.getUriTrustInfo(repository.uri)).trusted;
				proceed = !run.finished && await this.client.runPrecheck(run.runId, trusted);
			} catch (error) {
				this.logService.warn('[ParadisScheduledRuns] the precheck failed', error);
				if (!run.finished) {
					this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: toErrorMessage(error) });
				}
				return;
			}
			if (!proceed) {
				// 見送りは shared process が記録した（止めた回は止めた側が報告した）。報告せずに手を引く
				run.finished = true;
				this.cleanup(run);
				return;
			}
		}
		let launched: IParadisLaunchedAgentTerminal | undefined;
		let space: IParadisScheduledRunSpace | undefined;
		try {
			const options = { modelId: definition.modelId, effortId: definition.effortId, permissionId: definition.permissionId };
			if (definition.target.kind === 'newSpace') {
				const now = new Date();
				const result = await this.instantiationService.invokeFunction(paradisRunWorktreeCreateFlow, {
					repositoryId: repository.id,
					name: paradisScheduledRunSpaceName(definition.name, now),
					branch: paradisScheduledRunBranchName(definition.id, now),
					baseRef: definition.target.baseRef,
					prompt: definition.prompt,
					agentId: definition.agentId,
					...options,
				}, { switchToCreated: false, preserveFocus: true });
				space = { stateKey: paradisWorktreeStateKey(result.worktree.uri), name: result.name, branch: result.branch, uri: result.worktree.uri.toString() };
				launched = result.agent;
				if (run.finished) {
					// 作っている間に止めた。止めた回の報告にはスペースが無いので、作り終えたスペースを後から
					// 記録して片付け候補に載せる（利用者が気付かないまま残さない）
					this.recordSpace(run.runId, space);
					this.killTerminal(launched ? this.findInstance(launched.instanceId) : undefined);
					return;
				}
				if (!launched) {
					this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: result.warning, space });
					return;
				}
			} else {
				launched = await this.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
					rootUri: repository.uri,
					stateKey: repository.id,
					agentId: definition.agentId,
					prompt: definition.prompt,
					...options,
					// 利用者の作業中に時刻で起動するので、入力を新しいターミナルへ横取りしない
					preserveFocus: true,
				});
			}
		} catch (error) {
			this.logService.error('[ParadisScheduledRuns] launching the agent failed', error);
			this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: toErrorMessage(error), space });
			return;
		}
		this.watchLaunched(run, launched.instanceId, launched.paneToken, space);
	}

	/** 起動したターミナルを見張り始める（起動している間に止められていたら閉じる）。 */
	private watchLaunched(run: IActiveRun, instanceId: number, paneToken: string | undefined, space?: IParadisScheduledRunSpace): void {
		if (run.finished) {
			// 起動している間に打ち切り・停止が決まった
			this.killTerminal(this.findInstance(instanceId));
			return;
		}
		run.instance = this.findInstance(instanceId);
		if (run.instance) {
			const instance = run.instance;
			run.store.add(instance.onDisposed(() => {
				if (!run.finished) {
					this.finish(run, { runId: run.runId, status: 'cancelled', reason: 'terminalClosed' });
				}
			}));
		}
		this.report({ runId: run.runId, status: 'running', ...(paneToken ? { paneToken } : {}), ...(space ? { space } : {}) });
		this.observe(run);
	}

	/**
	 * Bot の見回りを起動する。エージェント・モデル・読むだけの引数は、定義ではなく今の Bot の台帳から取る
	 * （`requestLaunch(botId, 'patrol')`。機能がオフ・一時停止ならここで断られる）。今のスペースの裏のタブで開く。
	 */
	private async executeBotPatrol(run: IActiveRun, botId: string, options: { readonly task?: ParadisBotTaskTools; readonly prompt: string }): Promise<void> {
		let launched: IParadisBotLaunchedTerminal;
		try {
			const launch = options.task !== undefined ? await this.botsService.requestLaunch(botId, 'chat', { task: options.task }) : await this.botsService.requestLaunch(botId, 'patrol');
			if (!launch.ok) {
				this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: launch.message });
				return;
			}
			if (run.finished) {
				await this.botsService.cancelLaunch(launch.value.launchId);
				return;
			}
			const outcome = await this.instantiationService.invokeFunction(paradisLaunchBotTerminal, launch.value, {
				stateKey: this.switchService.activeStateKey,
				// 時刻で起動するので、利用者の入力を新しいターミナルへ横取りしない
				background: true,
				prompt: options.prompt,
			});
			if (!outcome.ok) {
				this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: outcome.reason });
				return;
			}
			launched = outcome.terminal;
		} catch (error) {
			this.logService.error('[ParadisScheduledRuns] launching the bot look-around or task failed', error);
			this.finish(run, { runId: run.runId, status: 'failed', reason: 'launchFailed', detail: toErrorMessage(error) });
			return;
		}
		this.watchLaunched(run, launched.instanceId, launched.paneToken);
	}

	private findInstance(instanceId: number): ITerminalInstance | undefined {
		return paradisCollectAllTerminalInstances(this.terminalService, this.terminalGroupService).find(instance => instance.instanceId === instanceId);
	}

	private onStatusesChanged(): void {
		for (const run of this.active.values()) {
			this.observe(run);
		}
	}

	private observe(run: IActiveRun): void {
		if (run.finished || !run.instance) {
			return;
		}
		const instance = run.instance;
		const instanceId = instance.instanceId;
		const step = paradisAdvanceRunWatch(run.watch, this.statusStore.getInstanceStatus(instanceId), this.statusStore.wasReviewAcknowledged?.(instanceId) === true);
		const sawFirstStatus = !run.watch.sawStatus && step.state.sawStatus;
		run.watch = step.state;
		if (step.report === 'completed') {
			// 完了してもターミナルは閉じない（結果を確かめられるよう残す）
			this.finish(run, { runId: run.runId, status: 'completed', sawAgentStatus: true });
			// Bot の定期実行を制限した段で起こした会話は、ベルに記録が残った後で閉じる（制限したまま利用者が話し続けないように。
			// 結果は会話の記録に残り、次に開いたときに続きから読める）
			const tools = run.definition.target.botTask?.tools;
			if (tools === 'read' || tools === 'web') {
				this.closeLimitedTaskPane(instance);
			}
		} else if (step.report !== undefined) {
			this.report({ runId: run.runId, status: step.report, sawAgentStatus: true });
		} else if (sawFirstStatus) {
			this.report({ runId: run.runId, status: 'running', sawAgentStatus: true });
		}
	}

	private onTimeout(run: IActiveRun): void {
		if (run.finished) {
			return;
		}
		const reason = paradisRunWatchTimeoutReason(run.watch);
		this.killTerminal(run.instance);
		this.finish(run, { runId: run.runId, status: 'timedOut', reason, sawAgentStatus: run.watch.sawStatus });
		this.notificationService.notify({
			severity: Severity.Warning,
			// allow-any-unicode-next-line
			message: localize('paradis.scheduledRuns.timedOut', "定期実行「{0}」を打ち切りました: {1}", run.definition.name, paradisScheduledRunReasonLabel(reason)),
		});
	}

	private stop(runId: string, reason: ParadisScheduledRunReason): void {
		const run = this.active.get(runId);
		if (!run || run.finished) {
			return;
		}
		if (!run.instance) {
			// まだ起動の途中。起動し終えたところで閉じる（execute が finished を見て閉じる）
			this.finish(run, { runId, status: 'cancelled', reason });
			return;
		}
		// 先に「終わった」ことにしてから閉じる（閉じた通知で terminalClosed と記録しないため）
		const instance = run.instance;
		this.finish(run, { runId, status: 'cancelled', reason });
		this.killTerminal(instance);
	}

	/** 制限した段の定期実行の会話のペインを、ベルの記録が済む頃に閉じる。利用者が前で使っていれば閉じない。 */
	private closeLimitedTaskPane(instance: ITerminalInstance): void {
		const handle = setTimeout(() => {
			this.limitedTaskCloseTimers.delete(handle);
			if (!instance.isDisposed && !(this.terminalService.activeInstance === instance && instance.hasFocus)) {
				this.killTerminal(instance);
			}
		}, PARADIS_BOT_TASK_CLOSE_DELAY_MS);
		this.limitedTaskCloseTimers.add(handle);
	}

	private killTerminal(instance: ITerminalInstance | undefined): void {
		if (instance && !instance.isDisposed) {
			// 確認ダイアログを出す safeDisposeTerminal は使わない（誰も PC の前にいないと止まる）
			instance.dispose(TerminalExitReason.User);
		}
	}

	private finish(run: IActiveRun, report: IParadisScheduledRunReport): void {
		if (run.finished) {
			return;
		}
		run.finished = true;
		this.report(report);
		if (report.status === 'failed') {
			this.notificationService.notify({
				severity: Severity.Warning,
				// allow-any-unicode-next-line
				message: localize('paradis.scheduledRuns.failed', "定期実行「{0}」を開始できませんでした: {1}", run.definition.name, report.detail ?? (report.reason ? paradisScheduledRunReasonLabel(report.reason) : '')),
			});
		}
		this.cleanup(run);
	}

	private cleanup(run: IActiveRun): void {
		run.store.dispose();
		this.active.delete(run.runId);
	}

	private recordSpace(runId: string, space: IParadisScheduledRunSpace): void {
		this.client.recordSpace(runId, space).catch(error => this.logService.warn('[ParadisScheduledRuns] recording the space failed', error));
	}

	private report(report: IParadisScheduledRunReport): void {
		this.client.report(report).catch(error => this.logService.warn('[ParadisScheduledRuns] report failed', error));
	}

	private sendHeartbeat(): void {
		// 制限時間は壁時計でも確かめる。setTimeout はスリープ中に進まないので、復帰後に
		// 実時間で 30 分を超えて動き続けないようにする
		const now = Date.now();
		for (const run of [...this.active.values()]) {
			if (now - run.startedAt >= PARADIS_SCHEDULED_RUN_TIMEOUT_MS) {
				this.onTimeout(run);
			}
		}
		const ids = [...this.active.keys()];
		if (ids.length === 0) {
			return;
		}
		this.client.heartbeat(ids).then(rejected => {
			// shared process がもう動いていないとみなした実行は、こちらでも止める（報告は受け付けられないので送らない）
			for (const runId of rejected ?? []) {
				const run = this.active.get(runId);
				if (run && !run.finished) {
					this.logService.warn('[ParadisScheduledRuns] the shared process no longer tracks this run; stopping it');
					run.finished = true;
					this.killTerminal(run.instance);
					this.cleanup(run);
				}
			}
		}, error => this.logService.warn('[ParadisScheduledRuns] heartbeat failed', error));
	}

	override dispose(): void {
		for (const handle of this.limitedTaskCloseTimers) {
			clearTimeout(handle);
		}
		this.limitedTaskCloseTimers.clear();
		for (const run of this.active.values()) {
			run.store.dispose();
		}
		this.active.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(ParadisScheduledRunsRunner.ID, ParadisScheduledRunsRunner, WorkbenchPhase.AfterRestored);

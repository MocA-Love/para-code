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
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
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
} from '../common/paradisScheduledRuns.js';
import { IParadisRunWatchState, PARADIS_RUN_WATCH_INITIAL, paradisAdvanceRunWatch, paradisRunWatchTimeoutReason } from '../common/paradisScheduledRunWatch.js';
import { IParadisScheduledRunsClient } from './paradisScheduledRunsClient.js';

/** このウィンドウで動かしている1回分。 */
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
		// 対象のリポジトリを開いていないウィンドウは手を挙げない（開いている別のウィンドウに任せる）
		if (!this.findRepository(request.definition)) {
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

		const repository = this.findRepository(definition);
		if (!repository) {
			this.finish(run, { runId: run.runId, status: 'failed', reason: 'repositoryMissing' });
			return;
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
				}, { switchToCreated: false });
				space = { stateKey: paradisWorktreeStateKey(result.worktree.uri), name: result.name, branch: result.branch, uri: result.worktree.uri.toString() };
				launched = result.agent;
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
		if (run.finished) {
			// 起動している間に打ち切り・停止が決まった
			this.killTerminal(this.findInstance(launched.instanceId));
			return;
		}
		run.instance = this.findInstance(launched.instanceId);
		if (run.instance) {
			const instance = run.instance;
			run.store.add(instance.onDisposed(() => {
				if (!run.finished) {
					this.finish(run, { runId: run.runId, status: 'cancelled', reason: 'terminalClosed' });
				}
			}));
		}
		this.report({ runId: run.runId, status: 'running', ...(launched.paneToken ? { paneToken: launched.paneToken } : {}), ...(space ? { space } : {}) });
		this.observe(run);
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
		const step = paradisAdvanceRunWatch(run.watch, this.statusStore.getInstanceStatus(run.instance.instanceId));
		const sawFirstStatus = !run.watch.sawStatus && step.state.sawStatus;
		run.watch = step.state;
		if (step.report === 'completed') {
			// 完了してもターミナルは閉じない（結果を確かめられるよう残す）
			this.finish(run, { runId: run.runId, status: 'completed', sawAgentStatus: true });
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
		for (const run of this.active.values()) {
			run.store.dispose();
		}
		this.active.clear();
		super.dispose();
	}
}

registerWorkbenchContribution2(ParadisScheduledRunsRunner.ID, ParadisScheduledRunsRunner, WorkbenchPhase.AfterRestored);

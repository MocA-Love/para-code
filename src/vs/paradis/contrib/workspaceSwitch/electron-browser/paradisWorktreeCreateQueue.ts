/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいスペース（worktree）を作成」のバックグラウンド実行キュー。
// ダイアログは作成要求をここへ投入して即座に閉じ、以降の進行状況は
//   1. 通知トースト（1件なら単独表示、複数同時なら1つに集約して各ジョブの工程を列挙）
//   2. ステータスバー項目（「スペース作成 n/m」。クリックで Workspaces ビューへ）
//   3. Workspaces ビューの「作成中」行（IParadisWorktreeCreateProgressStore 経由）
// の3箇所に表示する。完了時は自動で新スペースへ切り替えず、完了通知の
// 「このスペースに切り替える」で明示的に切り替える。
// 同一リポジトリへの並行 `git worktree add` はロック競合しうるため、
// 同一リポジトリ内は直列・リポジトリ間は並列で実行する。

import { Action } from '../../../../base/common/actions.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../workbench/services/statusbar/browser/statusbar.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree } from '../common/paradisWorkspaceSwitch.js';
import { IParadisWorktreeCreateJobSnapshot, IParadisWorktreeCreateProgressStore, paradisSanitizeBranchName } from '../common/paradisWorktreeCreate.js';
import { IParadisHeadlessWorktreeRequest, ParadisWorktreeCreateStage, paradisRunWorktreeCreateFlow } from './paradisWorktreeHeadlessCreate.js';

export const IParadisWorktreeCreateQueueService = createDecorator<IParadisWorktreeCreateQueueService>('paradisWorktreeCreateQueueService');

/** バックグラウンド作成キュー。enqueue は即座に戻り、進行状況は通知/ステータスバー/ビューに出る。 */
export interface IParadisWorktreeCreateQueueService {
	readonly _serviceBrand: undefined;
	enqueue(request: IParadisHeadlessWorktreeRequest): void;
}

/** browser 層のビューと同じく、コマンド実体（electron-browser 層）の ID を直書きで参照する。 */
const CREATE_WORKTREE_COMMAND_ID = 'paradis.workspaceSwitch.createWorktree';
const STATUSBAR_ENTRY_ID = 'paradis.worktreeCreateQueue';

// allow-any-unicode-next-line
const STR_STAGE_QUEUED = localize('paradis.createQueue.stage.queued', "待機中…");
// allow-any-unicode-next-line
const STR_STAGE_PREPARING = localize('paradis.createQueue.stage.preparing', "準備中…");
// allow-any-unicode-next-line
const STR_STAGE_NAMING = localize('paradis.createQueue.stage.naming', "ブランチ名を生成中…");
// allow-any-unicode-next-line
const STR_STAGE_CREATING = localize('paradis.createQueue.stage.creating', "worktree を作成中…");
// allow-any-unicode-next-line
const STR_STAGE_SETUP = localize('paradis.createQueue.stage.setup', "setup スクリプトを実行中…");
// allow-any-unicode-next-line
const STR_STAGE_STARTING = localize('paradis.createQueue.stage.starting', "エージェント/ターミナルを起動中…");
// allow-any-unicode-next-line
const STR_UNNAMED = localize('paradis.createQueue.unnamed', "(名前を生成中…)");
// allow-any-unicode-next-line
const STR_SWITCH_ACTION = localize('paradis.createQueue.switchAction', "このスペースに切り替える");
// allow-any-unicode-next-line
const STR_REOPEN_DIALOG_ACTION = localize('paradis.createQueue.reopenDialogAction', "ダイアログを再表示");

/** キュー側だけで使う疑似段階（queued: 同一リポジトリの先行ジョブ待ち / preparing: フロー開始直後）。 */
type QueueJobStage = 'queued' | 'preparing' | ParadisWorktreeCreateStage;

function stageLabel(stage: QueueJobStage): string {
	switch (stage) {
		case 'queued': return STR_STAGE_QUEUED;
		case 'preparing': return STR_STAGE_PREPARING;
		case 'naming': return STR_STAGE_NAMING;
		case 'creating': return STR_STAGE_CREATING;
		case 'setup': return STR_STAGE_SETUP;
		case 'starting': return STR_STAGE_STARTING;
	}
}

interface IQueueJob {
	readonly id: number;
	readonly request: IParadisHeadlessWorktreeRequest;
	/** 確定した表示名（naming 完了まで undefined）。 */
	name?: string;
	stage: QueueJobStage;
	finished: boolean;
}

/** 手入力のスペース名/ブランチ名があればそれを仮名として使う。無ければ undefined（名前生成中の表示）。 */
function provisionalJobName(job: IQueueJob): string | undefined {
	if (job.name) {
		return job.name;
	}
	const typedName = (job.request.name ?? '').trim();
	if (typedName.length > 0) {
		return typedName;
	}
	return paradisSanitizeBranchName(job.request.branch ?? '');
}

export class ParadisWorktreeCreateQueueService extends Disposable implements IParadisWorktreeCreateQueueService {

	declare readonly _serviceBrand: undefined;

	private readonly _jobs: IQueueJob[] = [];
	private readonly _repositoryChains = new Map<string, Promise<void>>();
	private _nextJobId = 1;
	/** 現在のバッチ（アクティブジョブが0になるまで）の総数と完了数。ステータスバー表示用。 */
	private _batchTotal = 0;
	private _batchFinished = 0;

	private _progressHandle: INotificationHandle | undefined;
	/** ユーザーが進行中トーストを閉じた場合、バッチが終わるまで再表示しない。 */
	private _progressDismissed = false;
	private _statusbarEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IParadisWorktreeCreateProgressStore private readonly progressStore: IParadisWorktreeCreateProgressStore,
		@INotificationService private readonly notificationService: INotificationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register({
			dispose: () => {
				this._progressHandle?.close();
				this._statusbarEntry?.dispose();
			}
		});
	}

	enqueue(request: IParadisHeadlessWorktreeRequest): void {
		// 新しいバッチの開始時のみ、進行トーストの「閉じた」状態をリセットする
		// （同一バッチ中の追加投入では、ユーザーが閉じたトーストを復活させない）
		if (this._jobs.length === 0) {
			this._progressDismissed = false;
		}
		const job: IQueueJob = { id: this._nextJobId++, request, stage: 'queued', finished: false };
		this._jobs.push(job);
		this._batchTotal++;
		this._publish();

		// 同一リポジトリ内は直列（git のロック競合とブランチ名衝突を避ける）、リポジトリ間は並列
		const previous = this._repositoryChains.get(request.repositoryId) ?? Promise.resolve();
		const chained = previous.then(() => this._runJob(job));
		this._repositoryChains.set(request.repositoryId, chained);
	}

	private async _runJob(job: IQueueJob): Promise<void> {
		job.stage = 'preparing';
		this._publish();
		try {
			const result = await this.instantiationService.invokeFunction(paradisRunWorktreeCreateFlow, job.request, {
				switchToCreated: false,
				callbacks: {
					onStage: stage => {
						job.stage = stage;
						this._publish();
					},
					onNameResolved: name => {
						job.name = name;
						this._publish();
					},
				},
			});
			this._notifyFinished(result.name, result.worktree, result.warning);
		} catch (error) {
			this.logService.error('[ParadisWorktreeCreateQueue] create failed', error);
			this._notifyFailed(job, error);
		} finally {
			job.finished = true;
			this._batchFinished++;
			this._publish();
		}
	}

	private _notifyFinished(name: string, worktree: IParadisWorktree, warning: string | undefined): void {
		const switchAction = new Action('paradis.createQueue.switch', STR_SWITCH_ACTION, undefined, true, async () => {
			await this.switchService.switchToWorktree(worktree);
		});
		this.notificationService.notify({
			severity: warning ? Severity.Warning : Severity.Info,
			message: warning
				// allow-any-unicode-next-line
				? localize('paradis.createQueue.doneWithWarning', "スペース「{0}」は作成されましたが、その後のセットアップに失敗しました: {1}", name, warning)
				// allow-any-unicode-next-line
				: localize('paradis.createQueue.done', "スペース「{0}」の準備ができました", name),
			actions: { primary: [switchAction] },
		});
	}

	private _notifyFailed(job: IQueueJob, error: unknown): void {
		const reopenAction = new Action('paradis.createQueue.reopenDialog', STR_REOPEN_DIALOG_ACTION, undefined, true, async () => {
			// ダイアログを入力値付きで開き直す（コマンド実体は paradisCreateWorktree.contribution.ts）
			await this.commandService.executeCommand(CREATE_WORKTREE_COMMAND_ID, job.request.repositoryId, job.request);
		});
		const name = provisionalJobName(job);
		this.notificationService.notify({
			severity: Severity.Error,
			message: name
				// allow-any-unicode-next-line
				? localize('paradis.createQueue.failed', "スペース「{0}」の作成に失敗しました: {1}", name, toErrorMessage(error))
				// allow-any-unicode-next-line
				: localize('paradis.createQueue.failedUnnamed', "スペースの作成に失敗しました: {0}", toErrorMessage(error)),
			actions: { primary: [reopenAction] },
		});
	}

	/** ジョブ状態の変化をストア・進行中トースト・ステータスバーへ反映する。 */
	private _publish(): void {
		const active = this._jobs.filter(job => !job.finished);

		const snapshots: IParadisWorktreeCreateJobSnapshot[] = active.map(job => {
			const name = provisionalJobName(job);
			return {
				id: job.id,
				repositoryId: job.request.repositoryId,
				...(name !== undefined ? { name } : {}),
				stageLabel: stageLabel(job.stage),
			};
		});
		this.progressStore.setJobs(snapshots);

		this._updateProgressNotification(active);
		this._updateStatusbar(active.length);

		if (active.length === 0) {
			// バッチ終了。完了済みジョブの記録とカウンタをリセットする
			this._jobs.length = 0;
			this._batchTotal = 0;
			this._batchFinished = 0;
		}
	}

	private _updateProgressNotification(active: readonly IQueueJob[]): void {
		if (active.length === 0) {
			// onDidClose リスナーが「ユーザーによるクローズ」と誤認しないよう、参照を外してから閉じる
			const handle = this._progressHandle;
			this._progressHandle = undefined;
			handle?.close();
			return;
		}
		const message = active.length === 1
			? this._singleJobMessage(active[0])
			: this._multiJobMessage(active);
		if (this._progressDismissed) {
			return;
		}
		if (!this._progressHandle) {
			const handle = this.notificationService.notify({
				severity: Severity.Info,
				message,
				sticky: true,
				progress: { infinite: true },
			});
			this._progressHandle = handle;
			const closeListener = handle.onDidClose(() => {
				closeListener.dispose();
				if (this._progressHandle === handle) {
					// バッチ完了前にユーザーが閉じた場合は、このバッチ中は再表示しない
					// （ステータスバーと Workspaces ビューの表示は残る）
					this._progressHandle = undefined;
					this._progressDismissed = true;
				}
			});
		} else {
			this._progressHandle.updateMessage(message);
		}
	}

	private _singleJobMessage(job: IQueueJob): string {
		const name = provisionalJobName(job);
		return name
			// allow-any-unicode-next-line
			? localize('paradis.createQueue.progressSingle', "スペース「{0}」を作成中 — {1}", name, stageLabel(job.stage))
			// allow-any-unicode-next-line
			: localize('paradis.createQueue.progressSingleUnnamed', "新しいスペースを作成中 — {0}", stageLabel(job.stage));
	}

	private _multiJobMessage(active: readonly IQueueJob[]): string {
		const parts = active.map(job => `${provisionalJobName(job) ?? STR_UNNAMED}: ${stageLabel(job.stage)}`);
		// allow-any-unicode-next-line
		return localize('paradis.createQueue.progressMulti', "{0}件のスペースを作成中 — {1}", active.length, parts.join(' / '));
	}

	private _updateStatusbar(activeCount: number): void {
		if (activeCount === 0) {
			this._statusbarEntry?.dispose();
			this._statusbarEntry = undefined;
			return;
		}
		// allow-any-unicode-next-line
		const name = localize('paradis.createQueue.statusbarName', "スペース作成");
		// allow-any-unicode-next-line
		const text = `$(loading~spin) ${localize('paradis.createQueue.statusbarText', "スペース作成 {0}/{1}", this._batchFinished, this._batchTotal)}`;
		const entry = {
			name,
			text,
			ariaLabel: text,
			// allow-any-unicode-next-line
			tooltip: localize('paradis.createQueue.statusbarTooltip', "バックグラウンドでスペースを作成しています。クリックで Workspaces ビューを表示します。"),
			// 登録済みビューには <viewId>.focus コマンドが自動登録される（browser 層のビュー ID を直書き）
			command: 'workbench.view.paradisWorkspaces.repositories.focus',
		};
		if (!this._statusbarEntry) {
			this._statusbarEntry = this.statusbarService.addEntry(entry, STATUSBAR_ENTRY_ID, StatusbarAlignment.LEFT, 10);
		} else {
			this._statusbarEntry.update(entry);
		}
	}
}

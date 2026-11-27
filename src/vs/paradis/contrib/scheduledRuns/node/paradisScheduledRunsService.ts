/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の時刻の管理と記録（shared process で動く。アプリ全体で1つ）。
//
// 30 秒ごとに有効な定義の時刻を判定し、時刻が来たら「開始待ち」の記録を作ってウィンドウへ
// 実行を依頼する。どのウィンドウが実行するかは早い者勝ちの `claim` で1つに決める。
// エージェントの起動と見張りはウィンドウの仕事で、ここは結果の報告を受けて記録するだけ。
//
// 安全装置（作成直後は無効・同時に1つ・1日の回数上限・最短15分・30分で打ち切り・12時間の
// 追いかけ実行）の判定は、`common/paradisScheduledRuns.ts` の純粋な関数に置いてある。
//
// Orca（stablyai/orca、MIT）の `src/main/automations/service.ts` の「一番新しい時刻だけを
// 実行し、猶予を過ぎていれば skipped として残す」考え方を参考にした（コードは移していない）。

import { IntervalTimer } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { paradisNextCronOccurrence, paradisParseCron } from '../common/paradisScheduleCron.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunPrecheckResult,
	IParadisScheduledRunRecord,
	IParadisScheduledRunReport,
	IParadisScheduledRunRequest,
	IParadisScheduledRunsResult,
	IParadisScheduledRunsState,
	ParadisScheduledRunReason,
	ParadisScheduledRunTrigger,
	paradisCheckRunGuards,
	paradisDecideDue,
	paradisIsActiveRunStatus,
	PARADIS_BOT_PATROL_PENDING_MS,
	PARADIS_SCHEDULED_RUN_CATCH_UP_MS,
	PARADIS_SCHEDULED_RUN_HISTORY_LIMIT,
	PARADIS_SCHEDULED_RUN_LEASE_MS,
	paradisScheduledRunPool,
	paradisCountRunningRuns,
	PARADIS_SCHEDULED_RUN_MIN_PENDING_MS,
	PARADIS_BOT_TASK_MAX_PER_BOT,
	PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT,
	PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS,
	PARADIS_SCHEDULED_RUN_TIMEOUT_MS,
	paradisRevalidateStoredDefinition,
	paradisSanitizeScheduledRunPrompt,
	paradisScheduledRunLastMessage,
	paradisValidateScheduledRunDraft,
	paradisSanitizeScheduledRunPrecheck,
	paradisScheduledRunPrecheckPassed,
	paradisScheduledRunPrecheckSupported,
	paradisScheduledRunReasonLabel,
	paradisValidateScheduledRunPrecheck,
} from '../common/paradisScheduledRuns.js';
import {
	IParadisBotPatrolGate,
	IParadisBotPatrolView,
	ParadisBotPatrolGateState,
	paradisBotPatrolDue,
	paradisBotPatrolGateReason,
	paradisBotPatrolName,
	paradisBotPatrolScheduleInput,
	paradisBotPatrolView,
	paradisIsBotPatrolDefinition,
	paradisOtherBotPatrolsRunsPerDay,
	paradisSanitizeBotPatrolLookFor,
} from '../common/paradisScheduledRunBotPatrol.js';
import { IParadisBotTaskView, paradisBotTaskDailyProblem, paradisBotTaskName, paradisBotTaskNeedsConfirmation, paradisBotTaskViews, paradisIsBotDefinition, paradisIsBotTaskDefinition, paradisSanitizeBotTaskInput } from '../common/paradisScheduledRunBotTask.js';
import { paradisSanitizeScheduledRunDraft, paradisSanitizeScheduledRunPrecheckShape, paradisSanitizeScheduledRunReport, paradisSanitizeScheduledRunSpace } from '../common/paradisScheduledRunsSanitize.js';
import { ParadisScheduledRunPrecheckRunner } from './paradisScheduledRunPrecheck.js';

const STR_BOTS_OFF = localize('paradis.scheduledRuns.error.botsOff', "Bot の機能がオフの間は、見回りを設定・有効にできません。");
const STR_SAVE_FAILED = localize('paradis.scheduledRuns.error.saveFailed', "変更を保存できませんでした。ディスクの空きと権限を確かめてから、もう一度やり直してください。");

/** transcript の置き場所からエージェントを見分ける（Claude は `projects/`、Codex は `sessions/` の rollout）。 */
export function paradisAgentFromTranscriptPath(path: string | undefined): 'claude' | 'codex' | undefined {
	if (path === undefined) {
		return undefined;
	}
	if (/[\\/]rollout-[^\\/]*\.jsonl$/.test(path)) {
		return 'codex';
	}
	return /\.jsonl$/.test(path) ? 'claude' : undefined;
}

/** 判定の間隔。 */
export const PARADIS_SCHEDULED_RUNS_TICK_MS = 30_000;
/**
 * 判定の間隔がこれより空いたら、スリープからの復帰とみなす。生存報告は 60 秒おきなので、
 * 空きがこれ以下なら最後の報告からの経過は 150 秒以下で、リース（180 秒）に 30 秒の余裕が残る。
 */
export const PARADIS_SCHEDULED_RUNS_RESUME_GAP_MS = 90_000;
/** 制限時間を過ぎてもウィンドウから終了の報告が来ないときに、こちらで打ち切りと記録するまでの余裕。 */
const TIMEOUT_GRACE_MS = 5 * 60_000;

/** ディスクに置く形。 */
export interface IParadisScheduledRunsStoredState {
	readonly version: 1;
	readonly definitions: readonly IParadisScheduledRunDefinition[];
	readonly runs: readonly IParadisScheduledRunRecord[];
	/** 定義ごとに、時刻を最後に判定した時刻。これより後の時刻だけを見る。 */
	readonly lastEvaluatedAt: Readonly<Record<string, number>>;
}

/** 保存先（テストではメモリに置き換える）。 */
export interface IParadisScheduledRunsStore {
	read(): Promise<IParadisScheduledRunsStoredState | undefined>;
	write(state: IParadisScheduledRunsStoredState): Promise<void>;
}

/** 時計（テストで進める）。 */
export interface IParadisScheduledRunsClock {
	now(): number;
}

/** hook の1回分のうち、ここで使うもの（`IParadisAgentHookEvent` の部分集合。テストで作りやすくするため）。 */
export interface IParadisScheduledRunHookEvent {
	readonly token: string;
	readonly event: string;
	readonly sessionId: string | undefined;
	readonly transcriptPath: string | undefined;
	readonly payload?: Readonly<Record<string, unknown>>;
}

/** ウィンドウへ送る停止の依頼。 */
export interface IParadisScheduledRunStopRequest {
	readonly runId: string;
	/** 実行を受け持っているウィンドウ（それ以外のウィンドウは無視する）。 */
	readonly claimedBy: string;
}

export class ParadisScheduledRunsService extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 定義・記録が変わった（画面の更新用）。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidRequestRun = this._register(new Emitter<IParadisScheduledRunRequest>());
	/** 開始待ちの実行をウィンドウへ知らせる。拾われるまで判定のたびに送り直す。 */
	readonly onDidRequestRun: Event<IParadisScheduledRunRequest> = this._onDidRequestRun.event;

	private readonly _onDidRequestStop = this._register(new Emitter<IParadisScheduledRunStopRequest>());
	readonly onDidRequestStop: Event<IParadisScheduledRunStopRequest> = this._onDidRequestStop.event;

	private definitions: IParadisScheduledRunDefinition[] = [];
	private runs: IParadisScheduledRunRecord[] = [];
	private lastEvaluatedAt: Record<string, number> = {};

	/** 実行中の記録 → そのエージェントのペイントークン（メモリだけに持つ）。 */
	private readonly paneTokens = new Map<string, string>();

	/** 前回の判定の時刻（スリープからの復帰を見分ける）。 */
	private lastTickAt: number | undefined;

	private readonly ready: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();
	private readonly timer = this._register(new IntervalTimer());
	/** 走っている事前確認（実行の id → 止める口）。実行が終わったら止める。 */
	private readonly prechecks = new Map<string, AbortController>();
	private readonly precheckRunner: ParadisScheduledRunPrecheckRunner | undefined;
	/** Bot の見回りの門（shared process の Bot のサービスが差し込む）。無い間は見回りの判定を見送る。 */
	private botGate: IParadisBotPatrolGate | undefined;

	constructor(
		private readonly store: IParadisScheduledRunsStore,
		private readonly clock: IParadisScheduledRunsClock,
		private readonly logService: ILogService,
		options: { readonly startTimer?: boolean; readonly hookEvents?: Event<IParadisScheduledRunHookEvent>; readonly precheckRunner?: ParadisScheduledRunPrecheckRunner } = {},
	) {
		super();
		this.precheckRunner = options.precheckRunner;
		this.ready = this.load();
		if (options.hookEvents) {
			this._register(options.hookEvents(event => this.onHookEvent(event)));
		}
		if (options.startTimer !== false) {
			this.ready.then(() => {
				if (!this._store.isDisposed) {
					this.timer.cancelAndSet(() => { this.tick(); }, PARADIS_SCHEDULED_RUNS_TICK_MS);
				}
			});
		}
	}

	private async load(): Promise<void> {
		let stored: IParadisScheduledRunsStoredState | undefined;
		try {
			stored = await this.store.read();
		} catch (error) {
			this.logService.error('[ParadisScheduledRuns] could not read the saved schedules; starting empty', error);
		}
		if (stored) {
			// ファイルは形しか確かめていない。中身も保存のときと同じ規則で確かめ直し、通らない定義は
			// 無効にする（手で書き換えて「作成直後は無効」や回数の上限を外されないように）
			this.definitions = stored.definitions.map(definition => {
				const { definition: checked, problem } = paradisRevalidateStoredDefinition(definition);
				if (problem !== undefined) {
					this.logService.warn(`[ParadisScheduledRuns] disabled a saved schedule that no longer passes validation: ${problem}`);
				} else if (checked.disabledReason === 'modifiedOutside') {
					this.logService.warn('[ParadisScheduledRuns] disabled a saved schedule whose content changed outside Para Code');
				}
				return checked;
			});
			this.runs = [...stored.runs];
			this.lastEvaluatedAt = { ...stored.lastEvaluatedAt };
		}
		// 前回の shared process が抱えていた実行は、アプリを閉じたときに一緒に止まっている
		// （ウィンドウを閉じるときにターミナルを閉じる）。開始待ちも持ち越さずに取りやめる。
		// ファイルに開始待ちを書き足せば、安全装置を通らずに（無効の定義でも）起動できてしまうため
		const now = this.clock.now();
		let changed = false;
		this.runs = this.runs.map(run => {
			if (run.status === 'starting' || run.status === 'running' || run.status === 'needsAttention') {
				changed = true;
				return { ...run, status: 'lost', reason: 'heartbeatLost', finishedAt: now };
			}
			if (run.status === 'pending') {
				changed = true;
				return { ...run, status: 'cancelled', reason: 'appRestarted', finishedAt: now };
			}
			return run;
		});
		if (changed) {
			this.persist();
		}
		this.tick();
	}

	/** 読み込みが済むのを待つ（テスト・チャネル用）。 */
	whenReady(): Promise<void> {
		return this.ready;
	}

	/** 利用者の定期実行の一覧（定期実行の画面用）。Bot の見回りは Bot のページが {@link getBotPatrol} で読むので含めない。 */
	getState(): IParadisScheduledRunsState {
		const now = this.clock.now();
		const nextRuns: Record<string, number | undefined> = {};
		const definitions = this.definitions.filter(definition => !paradisIsBotDefinition(definition));
		for (const definition of definitions) {
			if (!definition.enabled) {
				continue;
			}
			const parsed = paradisParseCron(definition.schedule);
			nextRuns[definition.id] = parsed.schedule ? paradisNextCronOccurrence(parsed.schedule, now) : undefined;
		}
		// 定義を消した後に終わりを待っている回は残す（Bot の見回りの回だけを除く）
		const patrolIds = new Set(this.definitions.filter(definition => paradisIsBotDefinition(definition)).map(definition => definition.id));
		return { definitions, runs: this.runs.filter(run => !patrolIds.has(run.definitionId)), nextRuns };
	}

	// ---------- Bot の見回り ----------

	/** Bot の見回りの門を差し込む（Bot のサービスが登録のときに呼ぶ）。 */
	setBotPatrolGate(gate: IParadisBotPatrolGate): IDisposable {
		this.botGate = gate;
		return toDisposable(() => {
			if (this.botGate === gate) {
				this.botGate = undefined;
			}
		});
	}

	private botPatrolOf(botId: string): IParadisScheduledRunDefinition | undefined {
		return this.definitions.find(definition => paradisIsBotPatrolDefinition(definition, botId));
	}

	/** Bot のページの「定期実行」の節が読むもの（次の時刻・最後の結果）。 */
	async getBotPatrol(botId: string): Promise<IParadisBotPatrolView> {
		await this.ready;
		const view = paradisBotPatrolView(this.botPatrolOf(botId), this.runs, this.botGate?.check(botId), this.clock.now());
		return { ...view, otherPatrolsRunsPerDay: paradisOtherBotPatrolsRunsPerDay(this.definitions, botId) };
	}

	/**
	 * Bot の見回りを作る・変える（Bot のページから。1 つの Bot に 1 つ）。`value` は `{ schedule, lookFor, enabled }`
	 * （`schedule` は cron 式か、前の時間帯の形）。式の正しさと間隔の下限は定義の検証で見る。
	 * 時刻を変えたとき・有効にしたときは、それより前の時刻を拾わない。
	 */
	async setBotPatrol(botId: string, value: unknown): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const input = isRecord(value) ? value : undefined;
		// 時刻は cron 式（汎用の定期実行と同じ型の欄から作る）。前の形（時間帯）も読み替えて受ける
		const schedule = paradisBotPatrolScheduleInput(input?.schedule);
		const lookFor = paradisSanitizeBotPatrolLookFor(input?.lookFor);
		const enabled = input?.enabled;
		if (!schedule || lookFor === undefined || typeof enabled !== 'boolean') {
			return { ok: false, error: localize('paradis.scheduledRuns.error.badPatrol', "見回りの設定を読めませんでした。") };
		}
		const botName = this.botGate?.botName(botId);
		if (this.botGate?.check(botId) === 'off') {
			return { ok: false, error: STR_BOTS_OFF };
		}
		if (botName === undefined) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.noBot', "この Bot は見つかりません。") };
		}
		const existing = this.botPatrolOf(botId);
		if (!existing && this.definitions.length >= PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.tooMany', "定期実行は {0} 件までです。", PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) };
		}
		const now = this.clock.now();
		const id = existing?.id ?? generateUuid();
		const fields = {
			name: paradisBotPatrolName(botName),
			schedule,
			target: { kind: 'bot' as const, repositoryUri: '', repositoryName: botName.slice(0, 200), botId },
			agentId: '',
			prompt: lookFor,
			// 時刻の回の数は式が決める（後から走らせる回も無い）。手動の「今すぐ見回る」も 1 日の回数に数えるので、
			// 式の回数ちょうどにすると、朝に手動で 1 回見回っただけで 20 時の回が落ちる。上限いっぱいにしておく
			dailyLimit: PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT,
		};
		const problem = paradisValidateScheduledRunDraft(fields);
		if (problem !== undefined) {
			return { ok: false, error: problem };
		}
		const definition: IParadisScheduledRunDefinition = { id, ...fields, enabled, createdAt: existing?.createdAt ?? now, updatedAt: now };
		const lastBefore = this.lastEvaluatedAtOf(id);
		const restart = !existing || existing.schedule !== definition.schedule || (enabled && !existing.enabled);
		this.definitions = existing ? this.definitions.map(candidate => candidate === existing ? definition : candidate) : [...this.definitions, definition];
		if (restart) {
			this.lastEvaluatedAt[id] = now;
		}
		const cancelled = enabled ? [] : this.cancelPending(id, 'disabled');
		if (!await this.commitForUser(() => {
			this.undoDefinition(id, definition, existing);
			this.undoLastEvaluatedAt(id, restart ? now : undefined, lastBefore);
			this.undoCancelled(cancelled);
		})) {
			return { ok: false, error: STR_SAVE_FAILED };
		}
		return { ok: true, definition };
	}

	/** 「今すぐ見回る」。見回りを作っていなければ断る。 */
	async runBotPatrolNow(botId: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const definition = this.botPatrolOf(botId);
		if (!definition) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.noPatrol', "この Bot の見回りはまだありません。") };
		}
		return this.runNow(definition.id);
	}

	/** Bot を消したときに、その見回りの定義と記録を消す（動いている回は止める）。 */
	async deleteBotPatrols(botId: string): Promise<void> {
		await this.ready;
		for (const definition of this.definitions.filter(candidate => paradisIsBotDefinition(candidate, botId))) {
			await this.delete(definition.id);
		}
	}

	// ---------- Bot の定期実行（報告書の D6 (a)） ----------

	/** Bot のページの「定期実行」の欄が読む一覧。 */
	async getBotTasks(botId: string): Promise<IParadisBotTaskView[]> {
		await this.ready;
		return paradisBotTaskViews(this.definitions, this.runs, botId, this.botGate?.check(botId) === 'ok', this.clock.now());
	}

	/**
	 * Bot の定期実行を作る・変える（Bot のページ・para-browser の道具から）。「Bot の権限」の段は、利用者の確認
	 * （`confirmedBotTools`）が無ければ断る。エージェントの道具から作ったもの（`byAgent`）は無効で始め、利用者が中身を
	 * 確かめて有効にするまで走らせない（汎用の定期実行の `agentReviewPending` と同じ）。
	 */
	async setBotTask(botId: string, value: unknown, byAgent = false): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const input = paradisSanitizeBotTaskInput(value);
		if (input === undefined) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.badBotTask', "定期実行の設定を読めませんでした。") };
		}
		if (this.botGate?.check(botId) === 'off') {
			return { ok: false, error: STR_BOTS_OFF };
		}
		const botName = this.botGate?.botName(botId);
		if (botName === undefined) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.noBot', "この Bot は見つかりません。") };
		}
		const existing = input.id !== undefined ? this.definitions.find(definition => definition.id === input.id) : undefined;
		if (input.id !== undefined && (existing === undefined || !paradisIsBotTaskDefinition(existing, botId))) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		// エージェントが作る・変えるものは無効で始めるので、ここでは確かめない（利用者が有効にするときに画面が確かめる）
		if (!byAgent && paradisBotTaskNeedsConfirmation(input, existing)) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.botTaskConfirm', "「読む＋Web」と「Bot の権限」の段は、確認してから選んでください。") };
		}
		if (!existing) {
			if (this.definitions.filter(definition => paradisIsBotTaskDefinition(definition, botId)).length >= PARADIS_BOT_TASK_MAX_PER_BOT) {
				return { ok: false, error: localize('paradis.scheduledRuns.error.tooManyBotTasks', "1 つの Bot の定期実行は {0} 件までです。", PARADIS_BOT_TASK_MAX_PER_BOT) };
			}
			if (this.definitions.length >= PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) {
				return { ok: false, error: localize('paradis.scheduledRuns.error.tooMany', "定期実行は {0} 件までです。", PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) };
			}
		}
		// エージェントが作ったものは、利用者が初めて有効にするまで無効のまま
		const reviewPending = byAgent ? (existing === undefined || existing.agentReviewPending === true || existing.target.botTask?.tools !== input.tools) : existing?.agentReviewPending === true && !input.enabled;
		const enabled = input.enabled && !reviewPending;
		const fields = {
			name: paradisBotTaskName(input.name, input.prompt),
			schedule: input.schedule,
			target: { kind: 'bot' as const, repositoryUri: '', repositoryName: botName.slice(0, 200), botId, botTask: { tools: input.tools } },
			agentId: '',
			prompt: input.prompt,
			dailyLimit: PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT,
		};
		const problem = paradisValidateScheduledRunDraft(fields) ?? (enabled ? paradisBotTaskDailyProblem(this.definitions, botId, input.schedule, existing?.id) : undefined);
		if (problem !== undefined) {
			return { ok: false, error: problem };
		}
		const now = this.clock.now();
		const id = existing?.id ?? generateUuid();
		const definition: IParadisScheduledRunDefinition = {
			id, ...fields, enabled,
			...(byAgent || existing?.createdByAgent ? { createdByAgent: true } : {}),
			...(reviewPending ? { agentReviewPending: true } : {}),
			createdAt: existing?.createdAt ?? now, updatedAt: now,
		};
		const lastBefore = this.lastEvaluatedAtOf(id);
		const restart = !existing || existing.schedule !== definition.schedule || (enabled && !existing.enabled);
		this.definitions = existing ? this.definitions.map(candidate => candidate === existing ? definition : candidate) : [...this.definitions, definition];
		if (restart) {
			this.lastEvaluatedAt[id] = now;
		}
		const cancelled = enabled ? [] : this.cancelPending(id, 'disabled');
		if (!await this.commitForUser(() => {
			this.undoDefinition(id, definition, existing);
			this.undoLastEvaluatedAt(id, restart ? now : undefined, lastBefore);
			this.undoCancelled(cancelled);
		})) {
			return { ok: false, error: STR_SAVE_FAILED };
		}
		return { ok: true, definition };
	}

	/** Bot の定期実行を消す（その Bot のものだけ）。 */
	async deleteBotTask(botId: string, id: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const existing = this.definitions.find(definition => definition.id === id);
		if (existing === undefined || !paradisIsBotTaskDefinition(existing, botId)) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		return this.delete(id);
	}

	/** その定義が Bot の見回りか（上限を数える枠を分けるのに使う）。 */
	private readonly isBotPatrolDefinitionId = (definitionId: string): boolean => this.definitions.some(definition => definition.id === definitionId && paradisIsBotDefinition(definition));

	/**
	 * 同時実行の枠が空かずに受け持てなかった見回りの開始待ち。期限が来たとき、今も見回りの枠が埋まっていれば、その理由で
	 * 見送ったと記録する（枠が空いた後にウィンドウが無かったせいで流れたなら、ウィンドウが無かったと記録する）。
	 */
	private readonly patrolConcurrencyBlocked = new Set<string>();

	/** 見回りの門の答え。門がまだ無い・Bot の台帳を読み終えていなければ undefined。 */
	private botGateState(definition: IParadisScheduledRunDefinition): ParadisBotPatrolGateState | undefined {
		const botId = definition.target.botId;
		if (botId === undefined) {
			return undefined;
		}
		// 定期実行は会話の 1 ターンとして走るので、会話のペインが開いている間は走らせない（門が別に答える）
		return definition.target.botTask !== undefined ? this.botGate?.checkTask(botId, definition.target.botTask.tools) : this.botGate?.check(botId);
	}

	// ---------- 定義の操作（画面から） ----------

	async save(value: unknown): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const draft = paradisSanitizeScheduledRunDraft(value);
		if (!draft) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.badDraft', "定期実行の内容を読めませんでした。") };
		}
		const error = paradisValidateScheduledRunDraft(draft);
		if (error !== undefined) {
			return { ok: false, error };
		}
		const now = this.clock.now();
		const existing = draft.id !== undefined ? this.definitions.find(definition => definition.id === draft.id) : undefined;
		if (draft.id !== undefined && !existing) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		if (existing && paradisIsBotDefinition(existing)) {
			// Bot の見回りは Bot のページ（setBotPatrol）でだけ変える
			return { ok: false, error: localize('paradis.scheduledRuns.error.botPatrol', "Bot の見回りは Bot のページで変えてください。") };
		}
		if (!existing && this.definitions.length >= PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.tooMany', "定期実行は {0} 件までです。", PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS) };
		}
		const fields = {
			name: draft.name.trim(),
			schedule: paradisParseCron(draft.schedule).schedule!.source,
			target: draft.target,
			agentId: draft.agentId,
			modelId: draft.modelId,
			effortId: draft.effortId,
			permissionId: draft.permissionId,
			prompt: paradisSanitizeScheduledRunPrompt(draft.prompt),
			dailyLimit: draft.dailyLimit,
			precheck: draft.precheck ? paradisSanitizeScheduledRunPrecheck(draft.precheck) : undefined,
		};
		let definition: IParadisScheduledRunDefinition;
		const id = existing?.id ?? generateUuid();
		const lastBefore = this.lastEvaluatedAtOf(id);
		let lastWritten: number | undefined;
		if (existing) {
			const { disabledReason: _cleared, precheck: _previous, ...rest } = existing;
			definition = withoutUndefinedPrecheck({ ...rest, ...fields, updatedAt: now });
			this.definitions = this.definitions.map(candidate => candidate.id === existing.id ? definition : candidate);
			if (existing.schedule !== definition.schedule) {
				// 時刻を変えたら、変える前の式で過ぎた時刻を新しい式で拾い直さない
				this.lastEvaluatedAt[definition.id] = now;
				lastWritten = now;
			}
		} else {
			// 作成直後は必ず無効。利用者が中身を確かめてから自分で有効にする
			definition = withoutUndefinedPrecheck({ id, ...fields, enabled: false, ...(draft.createdByAgent ? { createdByAgent: true, agentReviewPending: true } : {}), createdAt: now, updatedAt: now });
			this.definitions.push(definition);
			this.lastEvaluatedAt[definition.id] = now;
			lastWritten = now;
		}
		const written = definition;
		if (!await this.commitForUser(() => {
			this.undoDefinition(id, written, existing);
			this.undoLastEvaluatedAt(id, lastWritten, lastBefore);
		})) {
			return { ok: false, error: STR_SAVE_FAILED };
		}
		return { ok: true, definition };
	}

	async setEnabled(id: string, enabled: boolean): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const existing = this.definitions.find(definition => definition.id === id);
		if (!existing) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		const now = this.clock.now();
		if (enabled && paradisIsBotDefinition(existing) && this.botGateState(existing) === 'off') {
			return { ok: false, error: STR_BOTS_OFF };
		}
		if (enabled && !existing.enabled && paradisIsBotTaskDefinition(existing) && existing.target.botId !== undefined) {
			const problem = paradisBotTaskDailyProblem(this.definitions, existing.target.botId, existing.schedule, existing.id);
			if (problem !== undefined) {
				return { ok: false, error: problem };
			}
		}
		if (existing.enabled === enabled) {
			// 押し直しでは判定の起点を動かさない（直前の時刻を黙って逃さないように）
			return { ok: true, definition: existing };
		}
		const lastBefore = this.lastEvaluatedAtOf(id);
		const { disabledReason: _cleared, agentReviewPending: _reviewed, ...rest } = existing;
		// エージェントが作ったものは、利用者が初めて有効にした時点で確かめ済みにする
		const definition = { ...rest, enabled, updatedAt: now, ...(!enabled && existing.agentReviewPending ? { agentReviewPending: true } : {}) };
		this.definitions = this.definitions.map(candidate => candidate.id === id ? definition : candidate);
		// 有効にした時点より前の時刻は拾わない（無効だった間の時刻を「逃した」と扱わない）
		this.lastEvaluatedAt[id] = now;
		const cancelled = enabled ? [] : this.cancelPending(id, 'disabled');
		if (!await this.commitForUser(() => {
			this.undoDefinition(id, definition, existing);
			this.undoLastEvaluatedAt(id, now, lastBefore);
			this.undoCancelled(cancelled);
		})) {
			return { ok: false, error: STR_SAVE_FAILED };
		}
		return { ok: true, definition };
	}

	async delete(id: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		if (!this.definitions.some(definition => definition.id === id)) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		const index = this.definitions.findIndex(definition => definition.id === id);
		const removedDefinition = this.definitions[index];
		const lastBefore = this.lastEvaluatedAtOf(id);
		const cancelled = this.cancelPending(id, 'deleted');
		this.definitions = this.definitions.filter(definition => definition.id !== id);
		// 終わった記録は消す。動いている記録は終わりの報告を受けるまで残し、次の整理で消す
		const removedRuns = this.runs.filter(run => run.definitionId === id && !paradisIsActiveRunStatus(run.status));
		this.runs = this.runs.filter(run => !removedRuns.includes(run));
		delete this.lastEvaluatedAt[id];
		if (!await this.commitForUser(() => {
			// 消したものを足し戻すだけ（待つ間に入った別の変更は置き換えない）
			if (!this.definitions.some(definition => definition.id === id)) {
				const definitions = [...this.definitions];
				definitions.splice(Math.min(index, definitions.length), 0, removedDefinition);
				this.definitions = definitions;
			}
			const present = new Set(this.runs.map(run => run.id));
			this.runs = [...this.runs, ...removedRuns.filter(run => !present.has(run.id))];
			this.undoCancelled(cancelled);
			if (lastBefore !== undefined && !Object.prototype.hasOwnProperty.call(this.lastEvaluatedAt, id)) {
				this.lastEvaluatedAt[id] = lastBefore.value;
			}
		})) {
			return { ok: false, error: STR_SAVE_FAILED };
		}
		// 動いている回を止めるのは、削除を書けた後（書けずに戻したのに止めてしまわないように）
		for (const run of this.runs) {
			if (run.definitionId === id && paradisIsActiveRunStatus(run.status) && run.claimedBy !== undefined) {
				this._onDidRequestStop.fire({ runId: run.id, claimedBy: run.claimedBy });
			}
		}
		return { ok: true };
	}

	async runNow(id: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const definition = this.definitions.find(candidate => candidate.id === id);
		if (!definition) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		const now = this.clock.now();
		if (paradisIsBotDefinition(definition)) {
			const gate = this.botGateState(definition);
			if (gate !== 'ok') {
				const reason = gate !== undefined ? paradisBotPatrolGateReason(gate) : undefined;
				return { ok: false, error: reason !== undefined ? paradisScheduledRunReasonLabel(reason) : localize('paradis.scheduledRuns.error.noBot', "この Bot は見つかりません。") };
			}
		}
		const guard = paradisCheckRunGuards(definition, this.runs, 'manual', now, undefined, this.isBotPatrolDefinitionId);
		if (guard !== undefined) {
			// 同じものが動いているとき以外（同時実行の枠など）は、その理由を出す
			return { ok: false, error: guard === 'overlap' ? localize('paradis.scheduledRuns.error.alreadyRunning', "前の回がまだ動いています。終わってから実行してください。") : paradisScheduledRunReasonLabel(guard) };
		}
		const run = this.createPending(definition, 'manual', undefined, now, 0);
		this.commit();
		this.requestRun(run);
		return { ok: true, run };
	}

	/** 実行を止める。開始待ちならその場で取りやめ、動いていれば受け持ちのウィンドウへ頼む。 */
	async stop(runId: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const run = this.runs.find(candidate => candidate.id === runId);
		if (!run || !paradisIsActiveRunStatus(run.status)) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notActive', "この実行はもう終わっています。") };
		}
		if (run.status === 'pending' || run.claimedBy === undefined) {
			this.updateRun(runId, { status: 'cancelled', reason: 'userStopped', finishedAt: this.clock.now() });
			this.commit();
			return { ok: true };
		}
		this._onDidRequestStop.fire({ runId, claimedBy: run.claimedBy });
		return { ok: true };
	}

	/** 片付け候補の一覧から外す（利用者がスペースを消した・残すと決めたとき）。 */
	async forgetSpace(runId: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const run = this.runs.find(candidate => candidate.id === runId);
		if (!run?.space) {
			return { ok: false };
		}
		this.updateRun(runId, { space: undefined });
		this.commit();
		return { ok: true };
	}

	// ---------- ウィンドウからの操作 ----------

	/**
	 * 受け持った実行の事前確認を走らせ、エージェントを起動してよいかを返す。
	 *
	 * 時刻で起動する回（手動以外）で、定義に事前確認があるときだけ走らせる。通らなければ、ここでその回を
	 * 「事前確認で見送り」にして false を返す（ウィンドウは報告せずに手を引く）。`trusted` はウィンドウが
	 * 確かめたリポジトリの信頼。信頼していなければコマンドを走らせずに見送る。
	 * 走っている間に実行が止められた・別の状態になったときは、結果を書かずに false を返す。
	 */
	async runPrecheck(ctx: string, runId: string, trusted: boolean): Promise<boolean> {
		await this.ready;
		const run = this.runs.find(candidate => candidate.id === runId);
		const definition = run && this.definitions.find(candidate => candidate.id === run.definitionId);
		if (!run || !definition || run.claimedBy !== ctx || run.status !== 'starting') {
			return false;
		}
		const precheck = definition.precheck;
		if (!precheck || run.trigger === 'manual') {
			return true;
		}
		const skip = (reason: ParadisScheduledRunReason, result?: IParadisScheduledRunPrecheckResult) => {
			this.updateRun(runId, { status: 'skipped', reason, finishedAt: this.clock.now(), ...(result ? { precheck: result } : {}) });
			this.commit();
			return false;
		};
		if (!trusted) {
			return skip('precheckUntrusted');
		}
		if (!this.precheckRunner || !paradisScheduledRunPrecheckSupported(definition.target.repositoryUri)) {
			return skip('precheckFailed', { error: 'not supported for this repository', durationMs: 0 });
		}
		const controller = new AbortController();
		this.prechecks.set(runId, controller);
		let result: IParadisScheduledRunPrecheckResult;
		try {
			result = await this.precheckRunner({ command: precheck.command, cwd: URI.parse(definition.target.repositoryUri).fsPath, timeoutMs: precheck.timeoutSeconds * 1000, signal: controller.signal });
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error), durationMs: 0 };
		} finally {
			if (this.prechecks.get(runId) === controller) {
				this.prechecks.delete(runId);
			}
		}
		// 待っている間に止められた・不明にされた・受け持ちが変わった回には書かない
		const current = this.runs.find(candidate => candidate.id === runId);
		if (controller.signal.aborted || !current || current.claimedBy !== ctx || current.status !== 'starting') {
			return false;
		}
		if (!paradisScheduledRunPrecheckPassed(result)) {
			return skip('precheckFailed', result);
		}
		this.updateRun(runId, { precheck: result });
		this.commit();
		return true;
	}

	/**
	 * 保存する前に、事前確認を 1 回だけ試す（画面の「試す」）。記録には残さない。
	 * 形・中身が保存の規則を満たさなければ、`error` に理由を入れて返す。
	 * `token` が取り消されたら（画面を閉じたら）、走っているコマンドを止める。
	 */
	async testPrecheck(value: unknown, repositoryUri: unknown, token?: CancellationToken): Promise<{ readonly result?: IParadisScheduledRunPrecheckResult; readonly error?: string }> {
		const precheck = paradisSanitizeScheduledRunPrecheckShape(value);
		if (!precheck || typeof repositoryUri !== 'string' || repositoryUri.length === 0 || repositoryUri.length > 2000) {
			return { error: localize('paradis.scheduledRuns.error.badPrecheck', "事前確認の内容を読めませんでした。") };
		}
		const cleaned = paradisSanitizeScheduledRunPrecheck(precheck);
		const problem = paradisValidateScheduledRunPrecheck(cleaned, repositoryUri);
		if (problem !== undefined) {
			return { error: problem };
		}
		if (!this.precheckRunner) {
			return { error: localize('paradis.scheduledRuns.error.precheckUnavailable', "事前確認をこの環境では実行できません。") };
		}
		const controller = new AbortController();
		// 取り消し済みのトークンでもすぐに呼ばれる
		const cancellation = token?.onCancellationRequested(() => controller.abort());
		try {
			return { result: await this.precheckRunner({ command: cleaned.command, cwd: URI.parse(repositoryUri).fsPath, timeoutMs: cleaned.timeoutSeconds * 1000, signal: controller.signal }) };
		} catch (error) {
			return { result: { error: error instanceof Error ? error.message : String(error), durationMs: 0 } };
		} finally {
			cancellation?.dispose();
		}
	}

	/** 開始待ちの実行を受け持つ。先に来たウィンドウだけが受け取れる。 */
	async claim(ctx: string, runId: string): Promise<IParadisScheduledRunRequest | undefined> {
		await this.ready;
		const run = this.runs.find(candidate => candidate.id === runId);
		const definition = run && this.definitions.find(candidate => candidate.id === run.definitionId);
		if (!run || !definition || run.status !== 'pending') {
			return undefined;
		}
		// 同時数は、Bot の見回りと利用者の定期実行で別の枠に数える
		const pool = paradisScheduledRunPool(definition.id, this.runs, this.isBotPatrolDefinitionId);
		if (paradisCountRunningRuns(pool.runs) >= pool.maxConcurrent) {
			// 同時数に空きが無い。開始待ちのまま、次の判定で配り直す。見回りは期限が来たらこの理由で見送る
			if (pool.botPatrol) {
				this.patrolConcurrencyBlocked.add(runId);
			}
			return undefined;
		}
		this.patrolConcurrencyBlocked.delete(runId);
		const now = this.clock.now();
		if (paradisIsBotDefinition(definition)) {
			// 開始待ちの間に Bot の機能をオフにした・一時停止した・消したなら、起動しない
			const gate = this.botGateState(definition);
			if (gate === undefined) {
				return undefined;
			}
			if (gate !== 'ok') {
				const reason = paradisBotPatrolGateReason(gate);
				this.updateRun(runId, reason !== undefined ? { status: 'skipped', reason, finishedAt: now } : { status: 'cancelled', reason: 'deleted', finishedAt: now });
				this.commit();
				return undefined;
			}
			// 前の回の見回りのペイン（もう動いていないもの）を閉じてから起動する（4 時間ごとにペインが溜まらないように）。
			// 定期実行は会話のペインで走るので閉じない
			if (definition.target.botTask === undefined) {
				this.botGate?.closeIdlePatrolPanes(definition.target.botId!);
			}
		}
		const claimed = this.updateRun(runId, { status: 'starting', claimedBy: ctx, startedAt: now, heartbeatAt: now });
		this.commit();
		return claimed ? { run: claimed, definition } : undefined;
	}

	/** 受け持っている実行の状態を記録する。受け持っていないウィンドウからの報告は捨てる。 */
	async report(ctx: string, value: unknown): Promise<boolean> {
		await this.ready;
		const report: IParadisScheduledRunReport | undefined = paradisSanitizeScheduledRunReport(value);
		if (!report) {
			return false;
		}
		const run = this.runs.find(candidate => candidate.id === report.runId);
		if (!run || run.claimedBy !== ctx || !paradisIsActiveRunStatus(run.status)) {
			return false;
		}
		const now = this.clock.now();
		const finished = !paradisIsActiveRunStatus(report.status);
		if (report.paneToken !== undefined && !finished) {
			this.paneTokens.set(run.id, report.paneToken);
		}
		if (finished) {
			this.paneTokens.delete(run.id);
		}
		this.updateRun(run.id, {
			status: report.status,
			reason: report.reason,
			detail: report.detail,
			heartbeatAt: now,
			...(report.space ? { space: report.space } : {}),
			...(report.sawAgentStatus ? { sawAgentStatus: true } : {}),
			...(finished ? { finishedAt: now } : {}),
		});
		if (finished && !this.definitions.some(definition => definition.id === run.definitionId)) {
			// 定義を消した後に終わった回。残す先が無いのでその場で消す
			this.runs = this.runs.filter(candidate => candidate.id !== run.id);
		}
		this.commit();
		return true;
	}

	/**
	 * 起動の途中で止めた回に、後から作り終えたスペースを記録する（片付け候補に載せるため）。
	 *
	 * 止めた時点で回は終わっているので `report` は受け付けない。受け持っていたウィンドウからの、
	 * 終わった回で、まだスペースを記録していないものだけ受け付ける。
	 */
	async recordSpace(ctx: string, runId: string, value: unknown): Promise<boolean> {
		await this.ready;
		const space = paradisSanitizeScheduledRunSpace(value);
		const run = this.runs.find(candidate => candidate.id === runId);
		if (!space || !run || run.claimedBy !== ctx || paradisIsActiveRunStatus(run.status) || run.space !== undefined) {
			return false;
		}
		this.updateRun(run.id, { space });
		this.commit();
		return true;
	}

	/**
	 * 受け持っている実行が生きていることを知らせる。
	 *
	 * 受け付けなかった実行（もう終わった・不明にした・別のウィンドウのもの）の id を返す。
	 * ウィンドウはそれを受けて自分の見張りを止め、ターミナルを閉じる（記録の上で終わった実行が
	 * 動き続け、重複の安全装置が外れるのを防ぐ）。
	 */
	async heartbeat(ctx: string, runIds: readonly string[]): Promise<string[]> {
		await this.ready;
		const now = this.clock.now();
		const ids = new Set(runIds);
		const accepted = new Set<string>();
		this.runs = this.runs.map(run => {
			if (ids.has(run.id) && run.claimedBy === ctx && paradisIsActiveRunStatus(run.status)) {
				accepted.add(run.id);
				return { ...run, heartbeatAt: now };
			}
			return run;
		});
		// 生存報告だけでは画面を作り直さず、ファイルにも書かない（毎分の再描画と書き込みを避ける）。
		// 保存した heartbeatAt を読むのは起動時だけで、起動時は実行中の回をすべて不明にするため、
		// ディスクの値が古くても結果は変わらない。次に状態が変わって書くときに、最新の値も一緒に残る
		return runIds.filter(id => !accepted.has(id));
	}

	/** まだ誰も拾っていない実行（開いたばかりのウィンドウが最初に聞く）。 */
	async getPendingRequests(): Promise<IParadisScheduledRunRequest[]> {
		await this.ready;
		const requests: IParadisScheduledRunRequest[] = [];
		for (const run of this.runs) {
			const definition = this.definitions.find(candidate => candidate.id === run.definitionId);
			if (run.status === 'pending' && definition) {
				requests.push({ run, definition });
			}
		}
		return requests;
	}

	/**
	 * 実行中のエージェントの hook から、会話 ID と最後の発言を拾う。
	 *
	 * 最後の発言は Stop hook の `last_assistant_message` の先頭だけを、秘密らしい値を伏せて残す（履歴の「最後の出力」欄）。
	 * 会話 ID はトークン数と金額を引くのに使う。
	 */
	private onHookEvent(event: IParadisScheduledRunHookEvent): void {
		let runId: string | undefined;
		for (const [candidate, token] of this.paneTokens) {
			if (token === event.token) {
				runId = candidate;
				break;
			}
		}
		const run = runId !== undefined ? this.runs.find(candidate => candidate.id === runId) : undefined;
		if (!run || !paradisIsActiveRunStatus(run.status)) {
			return;
		}
		const patch: { -readonly [K in keyof IParadisScheduledRunRecord]?: IParadisScheduledRunRecord[K] } = {};
		if (event.sessionId !== undefined && event.sessionId.length <= 200 && event.sessionId !== run.sessionId) {
			patch.sessionId = event.sessionId;
			const agent = paradisAgentFromTranscriptPath(event.transcriptPath);
			if (agent !== undefined) {
				patch.agent = agent;
			}
		}
		const lastMessage = event.event === 'Stop' ? event.payload?.last_assistant_message : undefined;
		if (typeof lastMessage === 'string' && lastMessage.trim().length > 0) {
			patch.lastMessage = paradisScheduledRunLastMessage(lastMessage);
		}
		if (Object.keys(patch).length > 0) {
			this.updateRun(run.id, patch);
			this.commit();
		}
	}

	// ---------- 時刻の判定 ----------

	/** 1 回分の判定。テストからも呼ぶ。 */
	tick(): void {
		const now = this.clock.now();
		// 前回の判定から大きく時間が飛んでいたら、スリープからの復帰とみなす。ウィンドウの生存報告も
		// 同じだけ止まっていたので、この回はリース切れを数えず、生存報告の時刻を今へ寄せる
		const resumed = this.lastTickAt !== undefined && now - this.lastTickAt > PARADIS_SCHEDULED_RUNS_RESUME_GAP_MS;
		this.lastTickAt = now;
		let changed = false;
		const toRequest: IParadisScheduledRunRecord[] = [];

		for (const definition of this.definitions) {
			if (!definition.enabled) {
				continue;
			}
			const parsed = paradisParseCron(definition.schedule);
			if (!parsed.schedule) {
				continue;
			}
			let gate: ParadisBotPatrolGateState | undefined;
			if (paradisIsBotDefinition(definition)) {
				gate = this.botGateState(definition);
				if (gate === undefined) {
					// Bot の台帳をまだ読み終えていない。判定の起点は動かさず、次の判定で見る
					continue;
				}
				if (gate === 'off' || gate === 'missing') {
					// 一切動かさず、記録も残さない。判定の起点だけ進める（オンにしたときに逃した回を拾わない）
					this.lastEvaluatedAt[definition.id] = now;
					continue;
				}
			}
			const since = this.lastEvaluatedAt[definition.id] ?? definition.updatedAt;
			const decision = paradisDecideDue(parsed.schedule, since, now);
			this.lastEvaluatedAt[definition.id] = now;
			if (gate !== undefined) {
				if (this.tickBotPatrol(definition, decision, gate, now, toRequest)) {
					changed = true;
				}
				continue;
			}
			if (decision.skipped) {
				changed = true;
				this.addRun({
					id: generateUuid(),
					definitionId: definition.id,
					trigger: 'catchUp',
					status: 'skipped',
					reason: 'missedTooOld',
					scheduledFor: decision.skipped.last,
					createdAt: now,
					finishedAt: now,
					skippedCount: decision.skipped.count,
				});
			}
			if (decision.run) {
				changed = true;
				const guard = paradisCheckRunGuards(definition, this.runs, decision.run.trigger, now, decision.run.scheduledFor, this.isBotPatrolDefinitionId);
				if (guard !== undefined) {
					this.addRun(this.skippedRecord(definition, decision.run.trigger, decision.run.scheduledFor, now, guard));
				} else {
					toRequest.push(this.createPending(definition, decision.run.trigger, decision.run.scheduledFor, now, decision.run.coalesced));
				}
			}
		}

		// 開始待ち・実行中の見直し
		for (const run of [...this.runs]) {
			if (run.status === 'pending') {
				// 予定から 12 時間、ただし遅れて作った開始待ちにも作成から最低 1 時間は残す。Bot の見回りは短く残す
				const patrolDefinition = this.definitions.find(definition => definition.id === run.definitionId && paradisIsBotDefinition(definition));
				const botPatrol = patrolDefinition !== undefined;
				if (patrolDefinition !== undefined && this.botGateState(patrolDefinition) === 'off') {
					// 開始待ちの間に Bot の機能をオフにした: 受け持つウィンドウを待たずに、設定オフで見送る
					changed = true;
					this.patrolConcurrencyBlocked.delete(run.id);
					this.updateRun(run.id, { status: 'skipped', reason: 'botsOff', finishedAt: now });
					continue;
				}
				const expiresAt = botPatrol
					? run.createdAt + PARADIS_BOT_PATROL_PENDING_MS
					: Math.max((run.scheduledFor ?? run.createdAt) + PARADIS_SCHEDULED_RUN_CATCH_UP_MS, run.createdAt + PARADIS_SCHEDULED_RUN_MIN_PENDING_MS);
				if (now > expiresAt) {
					changed = true;
					// 見回りは、同時実行の枠が空かずに受け持てなかったなら、ウィンドウが無かったのではなくその理由で記録する
					const pool = paradisScheduledRunPool(run.definitionId, this.runs, this.isBotPatrolDefinitionId);
					const stillFull = this.patrolConcurrencyBlocked.has(run.id) && paradisCountRunningRuns(pool.runs) >= pool.maxConcurrent;
					const reason = !botPatrol ? 'noWindowTooOld' : stillFull ? 'botConcurrency' : 'botNoWindow';
					this.patrolConcurrencyBlocked.delete(run.id);
					this.updateRun(run.id, { status: 'skipped', reason, finishedAt: now });
				} else if (!toRequest.includes(run)) {
					// まだ誰も拾っていない。開いたばかりのウィンドウにも届くよう送り直す
					toRequest.push(run);
				}
			} else if (paradisIsActiveRunStatus(run.status)) {
				const definition = this.definitions.find(candidate => candidate.id === run.definitionId);
				if (definition !== undefined && paradisIsBotDefinition(definition) && this.botGateState(definition) === 'off') {
					// 動いている間に Bot の機能をオフにした。見回りを止め（受け持ちのウィンドウがペインを閉じる）、その理由で記録する
					changed = true;
					this.updateRun(run.id, { status: 'cancelled', reason: 'botsTurnedOff', finishedAt: now });
					if (run.claimedBy !== undefined) {
						this._onDidRequestStop.fire({ runId: run.id, claimedBy: run.claimedBy });
					}
					continue;
				}
				if (resumed) {
					this.updateRun(run.id, { heartbeatAt: now });
				} else if (run.heartbeatAt !== undefined && now - run.heartbeatAt > PARADIS_SCHEDULED_RUN_LEASE_MS) {
					changed = true;
					this.updateRun(run.id, { status: 'lost', reason: 'heartbeatLost', finishedAt: now });
					// 受け持ちのウィンドウがまだ生きていれば止めてもらう（記録の上で終わった回を動かし続けない）
					if (run.claimedBy !== undefined) {
						this._onDidRequestStop.fire({ runId: run.id, claimedBy: run.claimedBy });
					}
				} else if (run.startedAt !== undefined && now - run.startedAt > PARADIS_SCHEDULED_RUN_TIMEOUT_MS + TIMEOUT_GRACE_MS) {
					changed = true;
					this.updateRun(run.id, { status: 'timedOut', reason: 'timeout', finishedAt: now });
					if (run.claimedBy !== undefined) {
						this._onDidRequestStop.fire({ runId: run.id, claimedBy: run.claimedBy });
					}
				}
			}
		}

		// 定義を消した後に終わった記録（不明・時間切れにしたもの）は残す先が無いので消す
		const orphans = this.runs.filter(run => !paradisIsActiveRunStatus(run.status) && !this.definitions.some(definition => definition.id === run.definitionId));
		if (orphans.length > 0) {
			changed = true;
			this.runs = this.runs.filter(run => !orphans.includes(run));
		}

		// 判定した時刻は毎回変わるが、それだけで書き込むと 30 秒ごとにディスクへ書くことになる。
		// 記録が変わったときだけ書く（書かずに落ちても、次の起動で同じ時刻を「逃した」と判定し直すだけ）
		if (changed) {
			this.commit();
		}
		for (const run of toRequest) {
			this.requestRun(run);
		}
	}

	// ---------- 内部 ----------

	/**
	 * Bot の見回りの 1 回分の判定。時刻どおりの回だけを走らせ、逃した回は「見送り」とまとめて 1 件で記録する。
	 * 一時停止・制限できないエージェント・前の見回りが動いている間に来た回は、その理由で見送る。記録を変えたら true。
	 */
	private tickBotPatrol(definition: IParadisScheduledRunDefinition, decision: ReturnType<typeof paradisDecideDue>, gate: ParadisBotPatrolGateState, now: number, toRequest: IParadisScheduledRunRecord[]): boolean {
		const due = paradisBotPatrolDue(decision);
		let changed = false;
		if (due.missed) {
			changed = true;
			this.addRun({ id: generateUuid(), definitionId: definition.id, trigger: 'catchUp', status: 'skipped', reason: 'botMissed', scheduledFor: due.missed.last, createdAt: now, finishedAt: now, skippedCount: due.missed.count });
		}
		if (due.run) {
			changed = true;
			const reason = gate !== 'ok' ? paradisBotPatrolGateReason(gate) : paradisCheckRunGuards(definition, this.runs, 'schedule', now, due.run.scheduledFor, this.isBotPatrolDefinitionId);
			if (reason !== undefined) {
				this.addRun(this.skippedRecord(definition, 'schedule', due.run.scheduledFor, now, reason));
			} else {
				toRequest.push(this.createPending(definition, 'schedule', due.run.scheduledFor, now, due.run.coalesced));
			}
		}
		return changed;
	}

	private requestRun(run: IParadisScheduledRunRecord): void {
		const current = this.runs.find(candidate => candidate.id === run.id);
		const definition = current && this.definitions.find(candidate => candidate.id === current.definitionId);
		if (current?.status === 'pending' && definition) {
			this._onDidRequestRun.fire({ run: current, definition });
		}
	}

	private createPending(definition: IParadisScheduledRunDefinition, trigger: ParadisScheduledRunTrigger, scheduledFor: number | undefined, now: number, coalesced: number): IParadisScheduledRunRecord {
		const run: IParadisScheduledRunRecord = {
			id: generateUuid(),
			definitionId: definition.id,
			trigger,
			status: 'pending',
			createdAt: now,
			...(scheduledFor !== undefined ? { scheduledFor } : {}),
			...(coalesced > 0 ? { coalesced } : {}),
		};
		this.addRun(run);
		return run;
	}

	private skippedRecord(definition: IParadisScheduledRunDefinition, trigger: ParadisScheduledRunTrigger, scheduledFor: number, now: number, reason: ParadisScheduledRunReason): IParadisScheduledRunRecord {
		return { id: generateUuid(), definitionId: definition.id, trigger, status: 'skipped', reason, scheduledFor, createdAt: now, finishedAt: now };
	}

	/** 開始待ちを取りやめにする。取りやめにした回の、前と後の記録を返す（書けなかったときに戻すため）。 */
	private cancelPending(definitionId: string, reason: ParadisScheduledRunReason): { readonly before: IParadisScheduledRunRecord; readonly after: IParadisScheduledRunRecord }[] {
		const now = this.clock.now();
		const cancelled: { readonly before: IParadisScheduledRunRecord; readonly after: IParadisScheduledRunRecord }[] = [];
		this.runs = this.runs.map(run => {
			if (run.definitionId !== definitionId || run.status !== 'pending') {
				return run;
			}
			const after: IParadisScheduledRunRecord = { ...run, status: 'cancelled', reason, finishedAt: now };
			cancelled.push({ before: run, after });
			return after;
		});
		return cancelled;
	}

	private addRun(run: IParadisScheduledRunRecord): void {
		this.runs.push(run);
		this.prune(run.definitionId);
	}

	private updateRun(runId: string, patch: Partial<IParadisScheduledRunRecord>): IParadisScheduledRunRecord | undefined {
		let updated: IParadisScheduledRunRecord | undefined;
		this.runs = this.runs.map(run => {
			if (run.id !== runId) {
				return run;
			}
			updated = { ...run, ...patch };
			// undefined を明示して消した項目は、保存の形からも落とす
			for (const key of Object.keys(patch) as (keyof IParadisScheduledRunRecord)[]) {
				if (patch[key] === undefined) {
					delete (updated as { -readonly [K in keyof IParadisScheduledRunRecord]?: unknown })[key];
				}
			}
			return updated;
		});
		// 終わった実行（報告・生存報告切れ・時間切れ・取りやめのどれでも）のペインの対応は要らない
		if (updated && !paradisIsActiveRunStatus(updated.status)) {
			this.paneTokens.delete(runId);
			// 事前確認の途中で終わった（止めた・ウィンドウを閉じた・不明にした）回は、コマンドも止める
			this.prechecks.get(runId)?.abort();
			this.prechecks.delete(runId);
		}
		return updated;
	}

	/** 1 つの定義の記録を上限まで減らす（古い終わった記録から。片付け候補のスペースを持つ記録は残す）。 */
	private prune(definitionId: string): void {
		const own = this.runs.filter(run => run.definitionId === definitionId);
		let excess = own.length - PARADIS_SCHEDULED_RUN_HISTORY_LIMIT;
		const removable = own
			.filter(run => !paradisIsActiveRunStatus(run.status) && run.space === undefined)
			.sort((a, b) => a.createdAt - b.createdAt);
		const drop = new Set<string>();
		for (const run of removable) {
			if (excess <= 0) {
				break;
			}
			drop.add(run.id);
			excess--;
		}
		// スペースを持つ記録は片付け候補のために残すが、外で消されたスペースの分が際限なく溜まらないよう、
		// 上限の 2 倍を超えたら古いものから消す
		const remaining = own.filter(run => !drop.has(run.id));
		let spaceExcess = remaining.length - PARADIS_SCHEDULED_RUN_HISTORY_LIMIT * 2;
		for (const run of remaining.filter(candidate => !paradisIsActiveRunStatus(candidate.status)).sort((a, b) => a.createdAt - b.createdAt)) {
			if (spaceExcess <= 0) {
				break;
			}
			drop.add(run.id);
			spaceExcess--;
		}
		this.runs = this.runs.filter(run => !drop.has(run.id));
	}

	private commit(): void {
		void this.persist();
		this._onDidChange.fire();
	}

	/**
	 * 利用者の操作（保存・有効/無効・削除）の書き込み。書き終わるまで待ち、書けたかを返す。
	 * 書けなかったのに成功と返すと、ダイアログは下書きを捨て、再起動で無効にしたはずの定期実行が戻る。
	 * メモリの中身は変えたまま（次に書けたときに残る）。
	 */
	private async commitForUser(undo: () => void): Promise<boolean> {
		const saved = await this.persist();
		if (saved) {
			this._onDidChange.fire();
		} else {
			undo();
		}
		return saved;
	}

	private lastEvaluatedAtOf(id: string): { readonly value: number } | undefined {
		return Object.prototype.hasOwnProperty.call(this.lastEvaluatedAt, id) ? { value: this.lastEvaluatedAt[id] } : undefined;
	}

	/** 書けなかった定義の変更を戻す。今の定義がこの操作で入れたもののまま（参照で同じ）のときだけ。 */
	private undoDefinition(id: string, written: IParadisScheduledRunDefinition, previous: IParadisScheduledRunDefinition | undefined): void {
		if (this.definitions.find(definition => definition.id === id) !== written) {
			return;
		}
		this.definitions = previous
			? this.definitions.map(definition => definition === written ? previous : definition)
			: this.definitions.filter(definition => definition !== written);
	}

	/** 書けなかった判定の時刻を戻す。この操作で入れた値のままのときだけ（変えていなければ何もしない）。 */
	private undoLastEvaluatedAt(id: string, written: number | undefined, previous: { readonly value: number } | undefined): void {
		if (written === undefined || this.lastEvaluatedAt[id] !== written) {
			return;
		}
		if (previous) {
			this.lastEvaluatedAt[id] = previous.value;
		} else {
			delete this.lastEvaluatedAt[id];
		}
	}

	/** 取りやめにした開始待ちを戻す。同じ回の今の記録が、取りやめにしたときのまま（参照で同じ）のときだけ。 */
	private undoCancelled(cancelled: readonly { readonly before: IParadisScheduledRunRecord; readonly after: IParadisScheduledRunRecord }[]): void {
		if (cancelled.length === 0) {
			return;
		}
		this.runs = this.runs.map(run => cancelled.find(entry => entry.after === run)?.before ?? run);
	}

	/** 書き込みを列に足す。列は失敗しても止めない。返り値は、この書き込みが済んだか。 */
	private persist(): Promise<boolean> {
		const snapshot: IParadisScheduledRunsStoredState = {
			version: 1,
			definitions: this.definitions,
			runs: this.runs,
			lastEvaluatedAt: { ...this.lastEvaluatedAt },
		};
		const write = this.writeChain.then(() => this.store.write(snapshot));
		this.writeChain = write.catch(error => {
			this.logService.error('[ParadisScheduledRuns] could not save the schedules', error);
		});
		return write.then(() => true, () => false);
	}

	/** 書き込みが済むのを待つ（テスト・終了時用）。 */
	override dispose(): void {
		for (const controller of this.prechecks.values()) {
			controller.abort();
		}
		this.prechecks.clear();
		super.dispose();
	}

	flush(): Promise<void> {
		return this.writeChain;
	}
}

/** 事前確認を外した保存で、`precheck: undefined` の項目を残さない（保存の形と指紋を前と同じにする）。 */
function withoutUndefinedPrecheck(definition: IParadisScheduledRunDefinition): IParadisScheduledRunDefinition {
	if (definition.precheck !== undefined) {
		return definition;
	}
	const { precheck: _none, ...rest } = definition;
	return rest;
}

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
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { paradisRedactSecrets } from '../../notificationInbox/common/paradisNotificationInbox.js';
import { paradisNextCronOccurrence, paradisParseCron } from '../common/paradisScheduleCron.js';
import {
	IParadisScheduledRunDefinition,
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
	PARADIS_SCHEDULED_RUN_CATCH_UP_MS,
	PARADIS_SCHEDULED_RUN_HISTORY_LIMIT,
	PARADIS_SCHEDULED_RUN_LAST_MESSAGE_LENGTH,
	PARADIS_SCHEDULED_RUN_LEASE_MS,
	PARADIS_SCHEDULED_RUN_MAX_CONCURRENT,
	paradisCountRunningRuns,
	PARADIS_SCHEDULED_RUN_MIN_PENDING_MS,
	PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS,
	PARADIS_SCHEDULED_RUN_TIMEOUT_MS,
	paradisRevalidateStoredDefinition,
	paradisSanitizeScheduledRunPrompt,
	paradisValidateScheduledRunDraft,
} from '../common/paradisScheduledRuns.js';
import { paradisSanitizeScheduledRunDraft, paradisSanitizeScheduledRunReport } from '../common/paradisScheduledRunsSanitize.js';

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

	constructor(
		private readonly store: IParadisScheduledRunsStore,
		private readonly clock: IParadisScheduledRunsClock,
		private readonly logService: ILogService,
		options: { readonly startTimer?: boolean; readonly hookEvents?: Event<IParadisScheduledRunHookEvent> } = {},
	) {
		super();
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

	getState(): IParadisScheduledRunsState {
		const now = this.clock.now();
		const nextRuns: Record<string, number | undefined> = {};
		for (const definition of this.definitions) {
			if (!definition.enabled) {
				continue;
			}
			const parsed = paradisParseCron(definition.schedule);
			nextRuns[definition.id] = parsed.schedule ? paradisNextCronOccurrence(parsed.schedule, now) : undefined;
		}
		return { definitions: this.definitions, runs: this.runs, nextRuns };
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
		};
		let definition: IParadisScheduledRunDefinition;
		if (existing) {
			const { disabledReason: _cleared, ...rest } = existing;
			definition = { ...rest, ...fields, updatedAt: now };
			this.definitions = this.definitions.map(candidate => candidate.id === existing.id ? definition : candidate);
			if (existing.schedule !== definition.schedule) {
				// 時刻を変えたら、変える前の式で過ぎた時刻を新しい式で拾い直さない
				this.lastEvaluatedAt[definition.id] = now;
			}
		} else {
			// 作成直後は必ず無効。利用者が中身を確かめてから自分で有効にする
			definition = { id: generateUuid(), ...fields, enabled: false, createdAt: now, updatedAt: now };
			this.definitions.push(definition);
			this.lastEvaluatedAt[definition.id] = now;
		}
		this.commit();
		return { ok: true, definition };
	}

	async setEnabled(id: string, enabled: boolean): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const existing = this.definitions.find(definition => definition.id === id);
		if (!existing) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		const now = this.clock.now();
		if (existing.enabled === enabled) {
			// 押し直しでは判定の起点を動かさない（直前の時刻を黙って逃さないように）
			return { ok: true, definition: existing };
		}
		const { disabledReason: _cleared, ...rest } = existing;
		const definition = { ...rest, enabled, updatedAt: now };
		this.definitions = this.definitions.map(candidate => candidate.id === id ? definition : candidate);
		// 有効にした時点より前の時刻は拾わない（無効だった間の時刻を「逃した」と扱わない）
		this.lastEvaluatedAt[id] = now;
		if (!enabled) {
			this.cancelPending(id, 'disabled');
		}
		this.commit();
		return { ok: true, definition };
	}

	async delete(id: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		if (!this.definitions.some(definition => definition.id === id)) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		this.cancelPending(id, 'deleted');
		for (const run of this.runs) {
			if (run.definitionId === id && paradisIsActiveRunStatus(run.status) && run.claimedBy !== undefined) {
				this._onDidRequestStop.fire({ runId: run.id, claimedBy: run.claimedBy });
			}
		}
		this.definitions = this.definitions.filter(definition => definition.id !== id);
		// 終わった記録は消す。動いている記録は終わりの報告を受けるまで残し、次の整理で消す
		this.runs = this.runs.filter(run => run.definitionId !== id || paradisIsActiveRunStatus(run.status));
		delete this.lastEvaluatedAt[id];
		this.commit();
		return { ok: true };
	}

	async runNow(id: string): Promise<IParadisScheduledRunsResult> {
		await this.ready;
		const definition = this.definitions.find(candidate => candidate.id === id);
		if (!definition) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.notFound', "この定期実行は削除されています。") };
		}
		const now = this.clock.now();
		const guard = paradisCheckRunGuards(definition, this.runs, 'manual', now);
		if (guard !== undefined) {
			return { ok: false, error: localize('paradis.scheduledRuns.error.alreadyRunning', "前の回がまだ動いています。終わってから実行してください。") };
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

	/** 開始待ちの実行を受け持つ。先に来たウィンドウだけが受け取れる。 */
	async claim(ctx: string, runId: string): Promise<IParadisScheduledRunRequest | undefined> {
		await this.ready;
		const run = this.runs.find(candidate => candidate.id === runId);
		const definition = run && this.definitions.find(candidate => candidate.id === run.definitionId);
		if (!run || !definition || run.status !== 'pending') {
			return undefined;
		}
		if (paradisCountRunningRuns(this.runs) >= PARADIS_SCHEDULED_RUN_MAX_CONCURRENT) {
			// 全体の同時数に空きが無い。開始待ちのまま、次の判定で配り直す
			return undefined;
		}
		const now = this.clock.now();
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
		if (accepted.size > 0) {
			// 生存報告だけでは画面を作り直さない（毎分の再描画を避ける）
			this.persist();
		}
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
			// 履歴はファイルに残り画面にも出るので、秘密らしい値を伏せてから切り詰める（切り詰めた後だと、境目で
			// 切れたトークンの断片が伏せ字の形に当たらず残る）
			patch.lastMessage = paradisRedactSecrets(lastMessage.trim()).slice(0, PARADIS_SCHEDULED_RUN_LAST_MESSAGE_LENGTH);
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
			const since = this.lastEvaluatedAt[definition.id] ?? definition.updatedAt;
			const decision = paradisDecideDue(parsed.schedule, since, now);
			this.lastEvaluatedAt[definition.id] = now;
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
				const guard = paradisCheckRunGuards(definition, this.runs, decision.run.trigger, now, decision.run.scheduledFor);
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
				// 予定から 12 時間、ただし遅れて作った開始待ちにも作成から最低 1 時間は残す
				const expiresAt = Math.max((run.scheduledFor ?? run.createdAt) + PARADIS_SCHEDULED_RUN_CATCH_UP_MS, run.createdAt + PARADIS_SCHEDULED_RUN_MIN_PENDING_MS);
				if (now > expiresAt) {
					changed = true;
					this.updateRun(run.id, { status: 'skipped', reason: 'noWindowTooOld', finishedAt: now });
				} else if (!toRequest.includes(run)) {
					// まだ誰も拾っていない。開いたばかりのウィンドウにも届くよう送り直す
					toRequest.push(run);
				}
			} else if (paradisIsActiveRunStatus(run.status)) {
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

	private cancelPending(definitionId: string, reason: ParadisScheduledRunReason): void {
		const now = this.clock.now();
		this.runs = this.runs.map(run => run.definitionId === definitionId && run.status === 'pending'
			? { ...run, status: 'cancelled', reason, finishedAt: now }
			: run);
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
		this.persist();
		this._onDidChange.fire();
	}

	private persist(): void {
		const snapshot: IParadisScheduledRunsStoredState = {
			version: 1,
			definitions: this.definitions,
			runs: this.runs,
			lastEvaluatedAt: { ...this.lastEvaluatedAt },
		};
		this.writeChain = this.writeChain.then(() => this.store.write(snapshot)).catch(error => {
			this.logService.error('[ParadisScheduledRuns] could not save the schedules', error);
		});
	}

	/** 書き込みが済むのを待つ（テスト・終了時用）。 */
	flush(): Promise<void> {
		return this.writeChain;
	}
}

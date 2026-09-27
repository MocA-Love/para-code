/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行（決まった時刻にエージェントを自動で動かす）の型と、時刻の判定・安全装置の規則。
//
// 役割の分け方:
// - 時刻の判定・記録・安全装置は shared process（`node/paradisScheduledRunsService.ts`）が持つ。
//   アプリ全体で1つなので、ウィンドウを全部閉じても時刻の判定と記録は続く
// - エージェントの起動と見張りはウィンドウ（`electron-browser/paradisScheduledRunsRunner.ts`）が行う。
//   ターミナルを作れるのはウィンドウだけなので、ウィンドウが 0 枚のときは起動できず、次に
//   開いたウィンドウが拾う
//
// ここには両方が使う型と、副作用の無い判定だけを置く（テストしやすくするため）。

import { localize } from '../../../../nls.js';
import { IParadisCronSchedule, paradisCronMinimumGapMinutes, paradisCronOccurrencesBetween, paradisParseCron, PARADIS_MINUTE_MS } from './paradisScheduleCron.js';

export const PARADIS_SCHEDULED_RUNS_CHANNEL = 'paradisScheduledRuns';

// ---------- 安全装置の定数 ----------

/** 時刻の間隔の下限（分）。これより短い式は保存させない。 */
export const PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES = 15;
/** 1 回の実行の制限時間。過ぎたらターミナルを閉じて打ち切る。 */
export const PARADIS_SCHEDULED_RUN_TIMEOUT_MS = 30 * PARADIS_MINUTE_MS;
/** 逃した時刻を後から1回だけ実行してよい猶予。これより古い時刻は「スキップ」と記録する。 */
export const PARADIS_SCHEDULED_RUN_CATCH_UP_MS = 12 * 60 * PARADIS_MINUTE_MS;
/** 時刻どおりとみなす遅れ。判定の間隔（30 秒）より十分長く取る。 */
export const PARADIS_SCHEDULED_RUN_ON_TIME_MS = 3 * PARADIS_MINUTE_MS;
/** 1 日の回数上限の既定値と範囲。 */
export const PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT = 3;
export const PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT = 24;
/** 毎回新しいスペースを作るとき、片付け候補にせず残す件数。 */
export const PARADIS_SCHEDULED_RUN_KEEP_SPACES = 5;
/** 1 つの定期実行について残す履歴の件数。 */
export const PARADIS_SCHEDULED_RUN_HISTORY_LIMIT = 100;
/** 定期実行の数の上限（誤操作で大量に作られたときに判定が重くならないように）。 */
export const PARADIS_SCHEDULED_RUN_MAX_DEFINITIONS = 50;
/** プロンプトの長さの上限（コマンドラインに載せるため）。 */
export const PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH = 8000;
/** 名前の長さの上限。 */
export const PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH = 80;
/** 実行中のウィンドウからの生存報告の間隔と、途絶えたとみなす時間。 */
export const PARADIS_SCHEDULED_RUN_HEARTBEAT_MS = PARADIS_MINUTE_MS;
export const PARADIS_SCHEDULED_RUN_LEASE_MS = 3 * PARADIS_MINUTE_MS;

// ---------- 定義 ----------

/** 実行先。 */
export type ParadisScheduledRunTargetKind =
	/** リポジトリ本体（メインのチェックアウト）のスペースで起動する。 */
	| 'repository'
	/** 毎回新しいスペース（worktree）を作って起動する。 */
	| 'newSpace';

export interface IParadisScheduledRunTarget {
	readonly kind: ParadisScheduledRunTargetKind;
	/** リポジトリのルート（`URI.toString()`）。このリポジトリを開いているウィンドウだけが実行できる。 */
	readonly repositoryUri: string;
	/** 表示用のリポジトリ名。 */
	readonly repositoryName: string;
	/** 新しいスペースを作るときの元のブランチ。空ならメインのチェックアウトの今のブランチ。 */
	readonly baseRef?: string;
}

/** 1 つの定期実行の定義（利用者が作るもの）。 */
export interface IParadisScheduledRunDefinition {
	readonly id: string;
	readonly name: string;
	/** 作成直後は必ず false（shared process が保存のときに強制する）。 */
	readonly enabled: boolean;
	/** 5 項目の cron 式（ローカル時刻）。 */
	readonly schedule: string;
	readonly target: IParadisScheduledRunTarget;
	/** `paradis.workspaceSwitch.agents` のエージェント id。 */
	readonly agentId: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
	readonly prompt: string;
	/** 1 日（ローカル時刻の 0 時区切り）に自動で始めてよい回数。 */
	readonly dailyLimit: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** 画面から保存するときに送る値（id と日時は shared process が決める）。 */
export interface IParadisScheduledRunDraft {
	readonly id?: string;
	readonly name: string;
	readonly schedule: string;
	readonly target: IParadisScheduledRunTarget;
	readonly agentId: string;
	readonly modelId?: string;
	readonly effortId?: string;
	readonly permissionId?: string;
	readonly prompt: string;
	readonly dailyLimit: number;
}

// ---------- 実行の記録 ----------

export type ParadisScheduledRunStatus =
	/** 時刻が来て、ウィンドウが拾うのを待っている。 */
	| 'pending'
	/** ウィンドウが拾い、スペースの作成・エージェントの起動をしている。 */
	| 'starting'
	/** エージェントが動いている（起動した後、まだ終わっていない）。 */
	| 'running'
	/** 許可・質問の回答を待って止まっている。 */
	| 'needsAttention'
	| 'completed'
	/** 制限時間で打ち切った。 */
	| 'timedOut'
	| 'failed'
	/** 実行しなかった（上限・重複・逃した時刻が古い・ウィンドウが無いまま古くなった等）。 */
	| 'skipped'
	/** 利用者が止めた・ウィンドウを閉じた。 */
	| 'cancelled'
	/** 実行中のウィンドウから報告が途絶え、結果が分からない。 */
	| 'lost';

export type ParadisScheduledRunTrigger = 'schedule' | 'catchUp' | 'manual';

/** 記録に残す理由。表示の文は画面側で作る（言語を後から変えられるように）。 */
export type ParadisScheduledRunReason =
	| 'dailyLimit'
	| 'overlap'
	| 'tooSoon'
	| 'missedTooOld'
	| 'noWindowTooOld'
	| 'disabled'
	| 'deleted'
	| 'timeoutWhileWaiting'
	| 'timeoutNoStatus'
	| 'timeout'
	| 'terminalClosed'
	| 'windowClosed'
	| 'userStopped'
	| 'repositoryMissing'
	| 'launchFailed'
	| 'heartbeatLost';

/** 毎回新しいスペースを作ったときの、そのスペース。 */
export interface IParadisScheduledRunSpace {
	/** `paradisWorktreeStateKey` の値。 */
	readonly stateKey: string;
	readonly name: string;
	readonly branch: string;
	/** worktree のルート（`URI.toString()`）。 */
	readonly uri: string;
}

export interface IParadisScheduledRunRecord {
	readonly id: string;
	readonly definitionId: string;
	readonly trigger: ParadisScheduledRunTrigger;
	readonly status: ParadisScheduledRunStatus;
	readonly reason?: ParadisScheduledRunReason;
	/** 失敗したときの詳細（エラーの文。表示用）。 */
	readonly detail?: string;
	/** 予定の時刻（手動実行では無し）。 */
	readonly scheduledFor?: number;
	/** 記録を作った時刻。回数上限の数え方もこれで行う。 */
	readonly createdAt: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	/** まとめて1回にした、逃した時刻の数（実行した1回を除く）。 */
	readonly coalesced?: number;
	/** スキップした、逃した時刻の数。 */
	readonly skippedCount?: number;
	readonly space?: IParadisScheduledRunSpace;
	/** 実行を受け持ったウィンドウ（shared process のチャネルの接続名）。 */
	readonly claimedBy?: string;
	/** 最後に生存報告を受けた時刻。 */
	readonly heartbeatAt?: number;
	/** 状態が1度でも届いたか（hook が届かない環境の見分けに使う）。 */
	readonly sawAgentStatus?: boolean;
	/** エージェントの会話（hook が報告した session_id）。トークン数と金額を引くのに使う。 */
	readonly sessionId?: string;
	/** hook を送ってきたエージェント。 */
	readonly agent?: 'claude' | 'codex';
	/** エージェントの最後の発言（Stop hook の `last_assistant_message`、先頭だけ）。 */
	readonly lastMessage?: string;
}

/** 最後の発言として残す長さ。 */
export const PARADIS_SCHEDULED_RUN_LAST_MESSAGE_LENGTH = 400;

/** ウィンドウへ送る実行依頼。 */
export interface IParadisScheduledRunRequest {
	readonly run: IParadisScheduledRunRecord;
	readonly definition: IParadisScheduledRunDefinition;
}

/** ウィンドウからの状態の報告。 */
export interface IParadisScheduledRunReport {
	readonly runId: string;
	readonly status: Extract<ParadisScheduledRunStatus, 'running' | 'needsAttention' | 'completed' | 'timedOut' | 'failed' | 'cancelled'>;
	readonly reason?: ParadisScheduledRunReason;
	readonly detail?: string;
	readonly space?: IParadisScheduledRunSpace;
	readonly sawAgentStatus?: boolean;
	/**
	 * 起動したエージェントのペイントークン。shared process が hook（最後の発言・会話 ID）を
	 * この実行へ結び付けるためだけに使い、記録（ディスク）には残さない。秘密に準じて扱う。
	 */
	readonly paneToken?: string;
}

/** 画面に渡す全体の状態。 */
export interface IParadisScheduledRunsState {
	readonly definitions: readonly IParadisScheduledRunDefinition[];
	readonly runs: readonly IParadisScheduledRunRecord[];
	/** 定義ごとの次の時刻（有効なものだけ）。 */
	readonly nextRuns: Readonly<Record<string, number | undefined>>;
}

/** 手動実行・保存などの結果。失敗は例外ではなく文で返す（画面にそのまま出す）。 */
export interface IParadisScheduledRunsResult {
	readonly ok: boolean;
	readonly error?: string;
	readonly definition?: IParadisScheduledRunDefinition;
	readonly run?: IParadisScheduledRunRecord;
}

export function paradisIsActiveRunStatus(status: ParadisScheduledRunStatus): boolean {
	return status === 'pending' || status === 'starting' || status === 'running' || status === 'needsAttention';
}

export function paradisIsFinishedRunStatus(status: ParadisScheduledRunStatus): boolean {
	return !paradisIsActiveRunStatus(status);
}

// ---------- 検証 ----------

/**
 * 定義の下書きを検証し、問題があれば表示用の文を返す。
 *
 * 画面と shared process の両方で呼ぶ（shared process の検証が正本。画面は先に知らせるだけ）。
 */
export function paradisValidateScheduledRunDraft(draft: IParadisScheduledRunDraft): string | undefined {
	const name = draft.name.trim();
	if (name.length === 0) {
		return localize('paradis.scheduledRuns.validate.name', "名前を入れてください。");
	}
	if (name.length > PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH) {
		return localize('paradis.scheduledRuns.validate.nameLong', "名前は {0} 文字以内にしてください。", PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH);
	}
	const parsed = paradisParseCron(draft.schedule);
	if (parsed.error !== undefined) {
		return parsed.error;
	}
	if (paradisCronMinimumGapMinutes(parsed.schedule) < PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES) {
		return localize('paradis.scheduledRuns.validate.interval', "実行の間隔は {0} 分以上あけてください。", PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES);
	}
	if (draft.prompt.trim().length === 0) {
		return localize('paradis.scheduledRuns.validate.prompt', "エージェントへの指示を入れてください。");
	}
	if (draft.prompt.length > PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH) {
		return localize('paradis.scheduledRuns.validate.promptLong', "指示は {0} 文字以内にしてください。", PARADIS_SCHEDULED_RUN_MAX_PROMPT_LENGTH);
	}
	if (draft.agentId.trim().length === 0 || draft.agentId === 'none') {
		return localize('paradis.scheduledRuns.validate.agent', "エージェントを選んでください。");
	}
	if (draft.target.kind !== 'repository' && draft.target.kind !== 'newSpace') {
		return localize('paradis.scheduledRuns.validate.target', "実行先を選んでください。");
	}
	if (draft.target.repositoryUri.trim().length === 0) {
		return localize('paradis.scheduledRuns.validate.repository', "リポジトリを選んでください。");
	}
	if (!Number.isInteger(draft.dailyLimit) || draft.dailyLimit < 1 || draft.dailyLimit > PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT) {
		return localize('paradis.scheduledRuns.validate.limit', "1 日の回数は 1〜{0} 回で指定してください。", PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT);
	}
	return undefined;
}

// ---------- 時刻の判定 ----------

/** その日（ローカル時刻）の 0 時。 */
export function paradisStartOfLocalDay(time: number): number {
	const date = new Date(time);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 1 回の判定で決まったこと。 */
export interface IParadisDueDecision {
	/** 実行する時刻（1 回だけ）。 */
	readonly run?: {
		readonly scheduledFor: number;
		readonly trigger: Extract<ParadisScheduledRunTrigger, 'schedule' | 'catchUp'>;
		/** 実行する1回にまとめた、それ以前の逃した時刻の数。 */
		readonly coalesced: number;
	};
	/** 古すぎて実行しない逃した時刻。 */
	readonly skipped?: {
		readonly count: number;
		readonly first: number;
		readonly last: number;
		readonly truncated: boolean;
	};
}

/**
 * 前回の判定（`lastEvaluatedAt`）から今（`now`）までに来た時刻をどうするか決める。
 *
 * - 一番新しい時刻だけを実行の候補にする（溜まった分が一気に走らない）
 * - それが今から `PARADIS_SCHEDULED_RUN_CATCH_UP_MS`（12 時間）以内なら実行する。遅れが
 *   `PARADIS_SCHEDULED_RUN_ON_TIME_MS` 以内なら時刻どおり、それを超えたら「後から実行」と記録する
 * - 12 時間以内でそれより前の時刻は、実行する1回にまとめる（`coalesced`）
 * - 12 時間より古い時刻は実行せず「スキップ」とまとめて1件で記録する
 */
export function paradisDecideDue(schedule: IParadisCronSchedule, lastEvaluatedAt: number, now: number): IParadisDueDecision {
	if (now <= lastEvaluatedAt) {
		return {};
	}
	const occurrences = paradisCronOccurrencesBetween(schedule, lastEvaluatedAt, now);
	if (occurrences.count === 0 || occurrences.last === undefined || occurrences.first === undefined) {
		return {};
	}
	const catchUpFrom = now - PARADIS_SCHEDULED_RUN_CATCH_UP_MS;
	const latest = occurrences.last;
	if (latest < catchUpFrom) {
		return { skipped: { count: occurrences.count, first: occurrences.first, last: latest, truncated: occurrences.truncated } };
	}
	// 12 時間の窓の中の時刻（実行する1回を含む）と、それより古い時刻に分ける
	const tooOld = occurrences.first < catchUpFrom
		? paradisCronOccurrencesBetween(schedule, lastEvaluatedAt, catchUpFrom - 1)
		: undefined;
	const oldCount = tooOld?.count ?? 0;
	const withinWindow = Math.max(1, occurrences.count - oldCount);
	const trigger = now - latest <= PARADIS_SCHEDULED_RUN_ON_TIME_MS ? 'schedule' : 'catchUp';
	return {
		run: { scheduledFor: latest, trigger, coalesced: occurrences.truncated ? Math.max(0, withinWindow - 1) : withinWindow - 1 },
		...(tooOld && tooOld.count > 0 && tooOld.first !== undefined && tooOld.last !== undefined
			? { skipped: { count: tooOld.count, first: tooOld.first, last: tooOld.last, truncated: tooOld.truncated } }
			: {}),
	};
}

/** 回数上限に数える記録か（スキップは数えない）。 */
function countsTowardLimit(run: IParadisScheduledRunRecord): boolean {
	return run.status !== 'skipped';
}

/** 安全装置で止める理由。止めないなら undefined。 */
export function paradisCheckRunGuards(
	definition: IParadisScheduledRunDefinition,
	runs: readonly IParadisScheduledRunRecord[],
	trigger: ParadisScheduledRunTrigger,
	now: number,
): ParadisScheduledRunReason | undefined {
	const own = runs.filter(run => run.definitionId === definition.id);
	// 同じものは同時に1つ（手動でも同じ）
	if (own.some(run => paradisIsActiveRunStatus(run.status))) {
		return 'overlap';
	}
	if (trigger === 'manual') {
		// 手動の実行は利用者が今ボタンを押したものなので、回数と間隔では止めない（回数には数える）
		return undefined;
	}
	const dayStart = paradisStartOfLocalDay(now);
	const today = own.filter(run => countsTowardLimit(run) && run.createdAt >= dayStart).length;
	if (today >= definition.dailyLimit) {
		return 'dailyLimit';
	}
	const minGap = PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES * PARADIS_MINUTE_MS;
	if (own.some(run => countsTowardLimit(run) && now - run.createdAt < minGap)) {
		return 'tooSoon';
	}
	return undefined;
}

/**
 * 片付け候補のスペース（毎回新しいスペースを作る定期実行で、新しい方から数えて
 * `PARADIS_SCHEDULED_RUN_KEEP_SPACES` 件より古いもの）。自動では消さない。
 *
 * 同じスペースが2回載ることはない（スペースは実行ごとに作るため）が、念のため state key で
 * 重複を除く。実行中のものは候補にしない。
 */
export function paradisCleanupCandidateSpaces(definitionId: string, runs: readonly IParadisScheduledRunRecord[]): IParadisScheduledRunRecord[] {
	const withSpace = runs
		.filter(run => run.definitionId === definitionId && run.space !== undefined)
		.sort((a, b) => b.createdAt - a.createdAt);
	const seen = new Set<string>();
	const unique = withSpace.filter(run => {
		const key = run.space!.stateKey;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
	return unique.slice(PARADIS_SCHEDULED_RUN_KEEP_SPACES).filter(run => paradisIsFinishedRunStatus(run.status));
}

/** 状態の表示名。 */
export function paradisScheduledRunStatusLabel(status: ParadisScheduledRunStatus): string {
	switch (status) {
		case 'pending': return localize('paradis.scheduledRuns.status.pending', "開始待ち");
		case 'starting': return localize('paradis.scheduledRuns.status.starting', "起動中");
		case 'running': return localize('paradis.scheduledRuns.status.running', "実行中");
		case 'needsAttention': return localize('paradis.scheduledRuns.status.needsAttention', "要対応");
		case 'completed': return localize('paradis.scheduledRuns.status.completed', "完了");
		case 'timedOut': return localize('paradis.scheduledRuns.status.timedOut', "時間切れ");
		case 'failed': return localize('paradis.scheduledRuns.status.failed', "失敗");
		case 'skipped': return localize('paradis.scheduledRuns.status.skipped', "スキップ");
		case 'cancelled': return localize('paradis.scheduledRuns.status.cancelled', "停止");
		case 'lost': return localize('paradis.scheduledRuns.status.lost', "不明");
	}
}

/** 理由の表示文。 */
export function paradisScheduledRunReasonLabel(reason: ParadisScheduledRunReason, run?: Pick<IParadisScheduledRunRecord, 'skippedCount' | 'coalesced'>): string {
	switch (reason) {
		case 'dailyLimit': return localize('paradis.scheduledRuns.reason.dailyLimit', "1 日の回数上限に達したため実行しませんでした");
		case 'overlap': return localize('paradis.scheduledRuns.reason.overlap', "前の回がまだ動いていたため実行しませんでした");
		case 'tooSoon': return localize('paradis.scheduledRuns.reason.tooSoon', "前の回から {0} 分たっていないため実行しませんでした", PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES);
		case 'missedTooOld': return localize('paradis.scheduledRuns.reason.missedTooOld', "スリープ中・終了中に過ぎた {0} 回分は 12 時間より前なので実行しませんでした", run?.skippedCount ?? 1);
		case 'noWindowTooOld': return localize('paradis.scheduledRuns.reason.noWindowTooOld', "実行できるウィンドウが開かないまま 12 時間たちました");
		case 'disabled': return localize('paradis.scheduledRuns.reason.disabled', "無効にしたため取りやめました");
		case 'deleted': return localize('paradis.scheduledRuns.reason.deleted', "削除したため取りやめました");
		case 'timeoutWhileWaiting': return localize('paradis.scheduledRuns.reason.timeoutWhileWaiting', "許可・質問の回答を待ったまま 30 分たったため停止しました");
		case 'timeoutNoStatus': return localize('paradis.scheduledRuns.reason.timeoutNoStatus', "30 分で停止しました（エージェントの状態が届きませんでした。hook が設置されていない可能性があります）");
		case 'timeout': return localize('paradis.scheduledRuns.reason.timeout', "30 分で停止しました");
		case 'terminalClosed': return localize('paradis.scheduledRuns.reason.terminalClosed', "ターミナルが閉じられました");
		case 'windowClosed': return localize('paradis.scheduledRuns.reason.windowClosed', "ウィンドウを閉じたため停止しました");
		case 'userStopped': return localize('paradis.scheduledRuns.reason.userStopped', "手動で停止しました");
		case 'repositoryMissing': return localize('paradis.scheduledRuns.reason.repositoryMissing', "リポジトリがこのウィンドウに見つかりませんでした");
		case 'launchFailed': return localize('paradis.scheduledRuns.reason.launchFailed', "エージェントを起動できませんでした");
		case 'heartbeatLost': return localize('paradis.scheduledRuns.reason.heartbeatLost', "実行していたウィンドウから報告が途絶えました");
	}
}

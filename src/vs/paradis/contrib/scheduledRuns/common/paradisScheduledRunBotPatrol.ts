/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の見回りを定期実行に載せるときの、副作用の無い規則（時刻の形・回数の上限・起動の指示・画面が読む形）。
//
// 見回りの定義は定期実行の台帳に `target.kind === 'bot'` で置く。時刻の判定・記録・安全装置（同時に 1 つ・全体の
// 上限・30 分で打ち切り）は利用者の定期実行と同じ仕組みを使い、違うのは次の 3 つだけ:
// - 後から走らせない（時刻どおりの回だけ。逃した回は「見送り」と記録する）。時間帯を決めて見回るので、朝 7 時の
//   復帰で前の晩の 20 時の回を走らせない
// - 開始待ちを長く残さない（`PARADIS_BOT_PATROL_PENDING_MS`）
// - 起動の前に Bot の機能・Bot の状態を確かめる（門。shared process の Bot のサービスが答える）

import { localize } from '../../../../nls.js';
import { isRecord } from '../../../common/paradisGuards.js';
import { paradisNextCronOccurrence, paradisParseCron } from './paradisScheduleCron.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunRecord,
	ParadisScheduledRunReason,
	ParadisScheduledRunStatus,
	ParadisScheduledRunTrigger,
	PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH,
	paradisIsActiveRunStatus,
	paradisSanitizeScheduledRunPrompt,
	paradisScheduledRunLaunchPrompt,
} from './paradisScheduledRuns.js';

/**
 * 見回りを走らせてよいか（shared process の Bot のサービスが答える）。
 * - `ok`: 走らせてよい
 * - `off`: Bot の機能（`paradis.bots.enabled`）がオフ。記録も残さない
 * - `missing`: Bot が台帳に無い。記録も残さない（定義は Bot を消したときに消す。ここでは消さない）
 * - `paused`・`unsupported`・`busy`: その回を「見送り」と記録する
 */
export type ParadisBotPatrolGateState = 'ok' | 'off' | 'missing' | 'paused' | 'unsupported' | 'busy';

/** 定期実行のサービスから Bot のサービスへの問い合わせ口（Bot のサービスが後から差し込む）。 */
export interface IParadisBotPatrolGate {
	/** 見回りを走らせてよいか。Bot の台帳をまだ読み終えていなければ undefined（その回は判定を見送る）。 */
	check(botId: string): ParadisBotPatrolGateState | undefined;
	/** Bot の名前（定義の表示用）。無ければ undefined。 */
	botName(botId: string): string | undefined;
	/** 起動の前に、前の回の見回りのペイン（もう動いていないもの）を閉じてもらう。 */
	closeIdlePatrolPanes(botId: string): void;
}

/** 門の答えを、記録に残す理由にする（残さないものは undefined）。 */
export function paradisBotPatrolGateReason(state: ParadisBotPatrolGateState): ParadisScheduledRunReason | undefined {
	switch (state) {
		case 'paused': return 'botPaused';
		case 'unsupported': return 'botUnsupported';
		case 'busy': return 'botBusy';
		case 'off': return 'botsOff';
		case 'ok':
		case 'missing':
			return undefined;
	}
}

// ---------- 時刻の形 ----------

/** 見回りの間隔（時間）として選べる値。 */
export const PARADIS_BOT_PATROL_INTERVAL_HOURS: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

/** 画面で決める見回りの時刻（「4 時間ごと（8〜20 時）・平日だけ」の形）。 */
export interface IParadisBotPatrolSchedule {
	/** 何時間ごとか（{@link PARADIS_BOT_PATROL_INTERVAL_HOURS} のどれか）。 */
	readonly everyHours: number;
	/** 時間帯の始め（0〜23 時。この時刻ちょうどに 1 回目）。 */
	readonly fromHour: number;
	/** 時間帯の終わり（`fromHour`〜23 時。この時刻ちょうども含む）。 */
	readonly toHour: number;
	readonly weekdaysOnly: boolean;
}

/** Bot のページから見回りを作る・変えるときに送る値。 */
export interface IParadisBotPatrolInput {
	readonly schedule: IParadisBotPatrolSchedule;
	/** 探すもの（無ければ空）。 */
	readonly lookFor: string;
	readonly enabled: boolean;
}

/** 新しい見回りの既定（設計のモックの「4 時間ごと（8〜20 時）・平日だけ」）。 */
export const PARADIS_BOT_PATROL_DEFAULT_SCHEDULE: IParadisBotPatrolSchedule = { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true };

function isHour(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

/** チャネル越しに届いた時刻の形を確かめる。違えば undefined。 */
export function paradisSanitizeBotPatrolSchedule(value: unknown): IParadisBotPatrolSchedule | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { everyHours, fromHour, toHour, weekdaysOnly } = value;
	if (typeof everyHours !== 'number' || !PARADIS_BOT_PATROL_INTERVAL_HOURS.includes(everyHours)
		|| !isHour(fromHour) || !isHour(toHour) || toHour < fromHour
		|| typeof weekdaysOnly !== 'boolean') {
		return undefined;
	}
	return { everyHours, fromHour, toHour, weekdaysOnly };
}

/** 時刻の形を cron 式にする（`0 8-20/4 * * 1-5`）。 */
export function paradisBotPatrolCron(schedule: IParadisBotPatrolSchedule): string {
	const hours = schedule.fromHour === schedule.toHour ? `${schedule.fromHour}` : `${schedule.fromHour}-${schedule.toHour}/${schedule.everyHours}`;
	return `0 ${hours} * * ${schedule.weekdaysOnly ? '1-5' : '*'}`;
}

/** cron 式を時刻の形へ戻す（{@link paradisBotPatrolCron} が作った形だけ。ほかは undefined）。 */
export function paradisBotPatrolScheduleFromCron(expression: string): IParadisBotPatrolSchedule | undefined {
	const match = /^0 (?<from>\d{1,2})(?:-(?<to>\d{1,2})\/(?<every>\d{1,2}))? \* \* (?<days>\*|1-5)$/.exec(expression);
	if (!match?.groups) {
		return undefined;
	}
	const fromHour = Number(match.groups.from);
	const toHour = match.groups.to !== undefined ? Number(match.groups.to) : fromHour;
	const everyHours = match.groups.every !== undefined ? Number(match.groups.every) : PARADIS_BOT_PATROL_DEFAULT_SCHEDULE.everyHours;
	return paradisSanitizeBotPatrolSchedule({ everyHours, fromHour, toHour, weekdaysOnly: match.groups.days === '1-5' });
}

/** 「探すもの」を保存する形にする（制御文字を落とし、前後の空白を除く）。長すぎれば undefined。 */
export function paradisSanitizeBotPatrolLookFor(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value !== 'string' || value.length > PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH) {
		return undefined;
	}
	return paradisSanitizeScheduledRunPrompt(value).trim();
}

/** 見回りの定義の名前（定期実行の通知・記録に出る）。 */
export function paradisBotPatrolName(botName: string): string {
	return localize('paradis.scheduledRuns.botPatrolName', "{0} の見回り", botName).slice(0, 80);
}

// ---------- 起動の指示 ----------

/**
 * 見回りのエージェントへ渡す指示（1 行）。決まりの本文は専用フォルダの `AGENTS.md` にあるので、ここは
 * 見回りであることと、持ち主が決めた「探すもの」だけを渡す。英語なのは道具の説明と合わせるため。
 */
export function paradisBotPatrolPrompt(lookFor: string): string {
	const base = 'This is a look-around that Para Code started on your schedule. Follow the look-around rules in AGENTS.md: only read, check your "waiting" items, and offer what is worth doing with bot_suggest. Then end your turn.';
	const extra = paradisScheduledRunLaunchPrompt(lookFor);
	return extra.length > 0 ? `${base} Your owner asked you to look for: ${extra}` : base;
}

// ---------- 時刻の判定（後から走らせない） ----------

/** 見回りの 1 回分の判定。 */
export interface IParadisBotPatrolDue {
	/** 時刻どおりに来た回（これだけを走らせる）。 */
	readonly run?: { readonly scheduledFor: number; readonly coalesced: number };
	/** 走らせずに見送る、逃した時刻。 */
	readonly missed?: { readonly count: number; readonly last: number };
}

/**
 * 定期実行の判定（`paradisDecideDue` の結果）を見回りの規則に直す。時刻どおり（`schedule`）の回だけを走らせ、
 * 後から実行（`catchUp`）になる回と、12 時間より古い時刻は、まとめて「逃した」にする。
 */
export function paradisBotPatrolDue(decision: { readonly run?: { readonly scheduledFor: number; readonly trigger: Extract<ParadisScheduledRunTrigger, 'schedule' | 'catchUp'>; readonly coalesced: number }; readonly skipped?: { readonly count: number; readonly last: number } }): IParadisBotPatrolDue {
	let missedCount = decision.skipped?.count ?? 0;
	let missedLast = decision.skipped?.last;
	if (decision.run?.trigger === 'schedule') {
		return {
			run: { scheduledFor: decision.run.scheduledFor, coalesced: decision.run.coalesced },
			...(missedCount > 0 && missedLast !== undefined ? { missed: { count: missedCount, last: missedLast } } : {}),
		};
	}
	if (decision.run) {
		missedCount += 1 + decision.run.coalesced;
		missedLast = decision.run.scheduledFor;
	}
	return missedCount > 0 && missedLast !== undefined ? { missed: { count: missedCount, last: missedLast } } : {};
}

// ---------- 画面が読む形 ----------

/** Bot のページの「定期実行」の節が読むもの。 */
export interface IParadisBotPatrolView {
	/** 見回りの定義（まだ作っていなければ無し）。 */
	readonly definitionId?: string;
	readonly enabled: boolean;
	/** 時刻（画面で作った形でなければ無し。そのときは `schedule` の式を見せる）。 */
	readonly schedule?: IParadisBotPatrolSchedule;
	readonly cron?: string;
	readonly lookFor: string;
	/** 次に見回る時刻。無効・Bot の機能がオフ・一時停止・制限できないエージェントのときは無し。 */
	readonly nextRunAt?: number;
	/** 門の答え（画面が「一時停止中のため見回りません」などを出す）。台帳を読み終える前は無し。 */
	readonly gate?: ParadisBotPatrolGateState;
	/** 動いている回（開始待ち・起動中・実行中・要対応）。止めるときは定期実行の `stop` にこの id を渡す。 */
	readonly activeRunId?: string;
	/** 最後に終わった回。 */
	readonly lastRun?: {
		readonly id: string;
		readonly status: ParadisScheduledRunStatus;
		readonly reason?: ParadisScheduledRunReason;
		readonly trigger: ParadisScheduledRunTrigger;
		readonly scheduledFor?: number;
		readonly finishedAt?: number;
		readonly skippedCount?: number;
		/** エージェントの最後の発言（秘密らしい値は伏せてある）。 */
		readonly lastMessage?: string;
	};
}

/** Bot の見回りの定義か。 */
export function paradisIsBotPatrolDefinition(definition: IParadisScheduledRunDefinition, botId?: string): boolean {
	return definition.target.kind === 'bot' && (botId === undefined || definition.target.botId === botId);
}

/** 画面が読む形を作る。`gate` は今の門の答え（読み終える前は undefined）。 */
export function paradisBotPatrolView(definition: IParadisScheduledRunDefinition | undefined, runs: readonly IParadisScheduledRunRecord[], gate: ParadisBotPatrolGateState | undefined, now: number): IParadisBotPatrolView {
	if (definition === undefined) {
		return { enabled: false, lookFor: '', ...(gate !== undefined ? { gate } : {}) };
	}
	const own = runs.filter(run => run.definitionId === definition.id);
	const active = own.find(run => paradisIsActiveRunStatus(run.status));
	const last = own.filter(run => !paradisIsActiveRunStatus(run.status)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))[0];
	const parsed = paradisParseCron(definition.schedule);
	const nextRunAt = definition.enabled && gate === 'ok' && parsed.schedule ? paradisNextCronOccurrence(parsed.schedule, now) : undefined;
	const schedule = paradisBotPatrolScheduleFromCron(definition.schedule);
	return {
		definitionId: definition.id,
		enabled: definition.enabled,
		...(schedule !== undefined ? { schedule } : {}),
		cron: definition.schedule,
		lookFor: definition.prompt,
		...(nextRunAt !== undefined ? { nextRunAt } : {}),
		...(gate !== undefined ? { gate } : {}),
		...(active !== undefined ? { activeRunId: active.id } : {}),
		...(last !== undefined ? {
			lastRun: {
				id: last.id,
				status: last.status,
				trigger: last.trigger,
				...(last.reason !== undefined ? { reason: last.reason } : {}),
				...(last.scheduledFor !== undefined ? { scheduledFor: last.scheduledFor } : {}),
				...(last.finishedAt !== undefined ? { finishedAt: last.finishedAt } : {}),
				...(last.skippedCount !== undefined ? { skippedCount: last.skippedCount } : {}),
				...(last.lastMessage !== undefined ? { lastMessage: last.lastMessage } : {}),
			},
		} : {}),
	};
}

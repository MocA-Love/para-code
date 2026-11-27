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
import { IParadisScheduleFields, paradisCronRunsPerDay, paradisCronToSchedulePreset, paradisNextCronOccurrence, paradisParseCron, paradisScheduleFieldsFromCron, paradisScheduleFieldsToCron, paradisSchedulePresetToCron, PARADIS_SCHEDULE_EVERY_HOURS } from './paradisScheduleCron.js';
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

/** 見回りの間隔（時間）として選べる値（汎用の定期実行の「数時間ごと」と同じ）。 */
export const PARADIS_BOT_PATROL_INTERVAL_HOURS: readonly number[] = PARADIS_SCHEDULE_EVERY_HOURS;

/**
 * 「時間帯の中で n 時間ごと」の形（「4 時間ごと（8〜20 時）・平日だけ」）。分の指定ができる前の見回りの画面が
 * 作っていた形で、台帳に残っている式（`0 8-20/4 * * 1-5`）を読み替えて画面に戻すのに使う。
 */
export interface IParadisBotPatrolSchedule {
	/** 何時間ごとか（{@link PARADIS_BOT_PATROL_INTERVAL_HOURS} のどれか）。 */
	readonly everyHours: number;
	/** 時間帯の始め（0〜23 時。この時刻の `minute` 分に 1 回目）。 */
	readonly fromHour: number;
	/** 時間帯の終わり（`fromHour`〜23 時。この時刻も含む）。 */
	readonly toHour: number;
	readonly weekdaysOnly: boolean;
	/** 各回の分（0〜59）。無ければ 0（分を持たない前の形）。 */
	readonly minute?: number;
}

/**
 * Bot のページから見回りを作る・変えるときに送る値。`schedule` は cron 式（汎用の定期実行と同じ型の欄から作る）。
 * 前の形（{@link IParadisBotPatrolSchedule}）も受け、cron 式に直して扱う。
 */
export interface IParadisBotPatrolInput {
	readonly schedule: string | IParadisBotPatrolSchedule;
	/** 探すもの（無ければ空）。 */
	readonly lookFor: string;
	readonly enabled: boolean;
}

/** 新しい見回りの既定（設計のモックの「4 時間ごと（8〜20 時）・平日だけ」）。 */
export const PARADIS_BOT_PATROL_DEFAULT_SCHEDULE: IParadisBotPatrolSchedule = { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true };

/** cron 式の長さの上限（チャネル越しに届いた式を確かめる）。 */
const MAX_CRON_LENGTH = 200;

function isHour(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

function isMinute(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 59;
}

/** チャネル越しに届いた時間帯の形を確かめる。違えば undefined。 */
export function paradisSanitizeBotPatrolSchedule(value: unknown): IParadisBotPatrolSchedule | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const { everyHours, fromHour, toHour, weekdaysOnly, minute } = value;
	if (typeof everyHours !== 'number' || !PARADIS_BOT_PATROL_INTERVAL_HOURS.includes(everyHours)
		|| !isHour(fromHour) || !isHour(toHour) || toHour < fromHour
		|| typeof weekdaysOnly !== 'boolean'
		|| (minute !== undefined && !isMinute(minute))) {
		return undefined;
	}
	return { everyHours, fromHour, toHour, weekdaysOnly, ...(minute !== undefined && minute !== 0 ? { minute } : {}) };
}

/**
 * チャネル越しに届いた見回りの時刻を cron 式にする（式はそのまま、前の形は {@link paradisBotPatrolCron} で直す）。
 * 読めなければ undefined。式が正しいか・間隔が短すぎないかは定義の検証（`paradisValidateScheduledRunDraft`）が見る。
 */
export function paradisBotPatrolScheduleInput(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const expression = paradisSchedulePresetToCron({ kind: 'cron', expression: value });
		return expression.length > 0 && expression.length <= MAX_CRON_LENGTH ? expression : undefined;
	}
	const schedule = paradisSanitizeBotPatrolSchedule(value);
	return schedule !== undefined ? paradisBotPatrolCron(schedule) : undefined;
}

/** 時間帯の形を cron 式にする（`0 8-20/4 * * 1-5`）。 */
export function paradisBotPatrolCron(schedule: IParadisBotPatrolSchedule): string {
	const hours = schedule.fromHour === schedule.toHour ? `${schedule.fromHour}` : `${schedule.fromHour}-${schedule.toHour}/${schedule.everyHours}`;
	return `${schedule.minute ?? 0} ${hours} * * ${schedule.weekdaysOnly ? '1-5' : '*'}`;
}

/** cron 式を時間帯の形へ戻す（{@link paradisBotPatrolCron} が作った形だけ。ほかは undefined）。 */
export function paradisBotPatrolScheduleFromCron(expression: string): IParadisBotPatrolSchedule | undefined {
	const match = /^(?<minute>\d{1,2}) (?<from>\d{1,2})(?:-(?<to>\d{1,2})\/(?<every>\d{1,2}))? \* \* (?<days>\*|1-5)$/.exec(expression.trim().replace(/\s+/g, ' '));
	if (!match?.groups) {
		return undefined;
	}
	const fromHour = Number(match.groups.from);
	const toHour = match.groups.to !== undefined ? Number(match.groups.to) : fromHour;
	const everyHours = match.groups.every !== undefined ? Number(match.groups.every) : PARADIS_BOT_PATROL_DEFAULT_SCHEDULE.everyHours;
	return paradisSanitizeBotPatrolSchedule({ everyHours, fromHour, toHour, weekdaysOnly: match.groups.days === '1-5', minute: Number(match.groups.minute) });
}

/** 見回りの時刻の欄の種類（汎用の定期実行の種類に、前の画面の「時間帯の中で n 時間ごと」と「n 分ごと」を足したもの）。 */
export type ParadisBotPatrolScheduleKind = IParadisScheduleFields['scheduleKind'] | 'window' | 'minutes';

/**
 * 「n 分ごと」で選べる間隔（分）。時刻は cron 式で持つので、1 日（1440 分）を割り切る 60 分の倍数だけ（90 分ごとは
 * cron 式で書けない）。下限は見回りの間隔の下限（60 分）。
 */
export const PARADIS_BOT_PATROL_EVERY_MINUTES: readonly number[] = PARADIS_SCHEDULE_EVERY_HOURS.map(hours => hours * 60);

/** 見回りの時刻の欄の値（Bot のページの設定のタブが持つ）。 */
export interface IParadisBotPatrolScheduleFields extends Omit<IParadisScheduleFields, 'scheduleKind'> {
	readonly scheduleKind: ParadisBotPatrolScheduleKind;
	/** n 分ごとの n（{@link PARADIS_BOT_PATROL_EVERY_MINUTES} のどれかのときだけ式にできる）。 */
	readonly everyMinutes: number;
	readonly fromHour: number;
	readonly toHour: number;
	readonly weekdaysOnly: boolean;
}

/**
 * cron 式を見回りの欄の値へ戻す。読む順は「汎用の型 → 時間帯の形 → cron 式」（`0 8 * * 1-5` は「平日 8:00」と
 * 「平日 8 時だけの時間帯」の両方に当たるので、汎用を先にする）。
 */
export function paradisBotPatrolFieldsFromCron(expression: string | undefined): IParadisBotPatrolScheduleFields {
	const window = PARADIS_BOT_PATROL_DEFAULT_SCHEDULE;
	const defaults: IParadisBotPatrolScheduleFields = {
		scheduleKind: 'window', time: '09:00', dayOfWeek: 1, everyHours: window.everyHours, everyMinutes: 60, minute: 0, cron: paradisBotPatrolCron(window),
		fromHour: window.fromHour, toHour: window.toHour, weekdaysOnly: window.weekdaysOnly,
	};
	if (expression === undefined) {
		return defaults;
	}
	const generic = paradisScheduleFieldsFromCron(expression, { ...defaults, scheduleKind: 'cron' });
	if (generic.scheduleKind !== 'cron') {
		return { ...defaults, ...generic };
	}
	const range = paradisBotPatrolScheduleFromCron(expression);
	if (range !== undefined) {
		return { ...defaults, scheduleKind: 'window', everyHours: range.everyHours, minute: range.minute ?? 0, fromHour: range.fromHour, toHour: range.toHour, weekdaysOnly: range.weekdaysOnly, cron: generic.cron };
	}
	return { ...defaults, scheduleKind: 'cron', cron: generic.cron };
}

/** 見回りの欄の値を cron 式にする。時間帯の始めと終わりが逆・式にできない「n 分ごと」なら undefined。 */
export function paradisBotPatrolFieldsToCron(fields: IParadisBotPatrolScheduleFields): string | undefined {
	if (fields.scheduleKind === 'minutes') {
		if (!PARADIS_BOT_PATROL_EVERY_MINUTES.includes(fields.everyMinutes)) {
			return undefined;
		}
		return paradisScheduleFieldsToCron({ ...fields, scheduleKind: 'hourly', everyHours: fields.everyMinutes / 60 });
	}
	if (fields.scheduleKind === 'window') {
		if (fields.toHour < fields.fromHour) {
			return undefined;
		}
		return paradisBotPatrolCron({ everyHours: fields.everyHours, fromHour: fields.fromHour, toHour: fields.toHour, weekdaysOnly: fields.weekdaysOnly, minute: Math.min(59, Math.max(0, Math.trunc(fields.minute) || 0)) });
	}
	return paradisScheduleFieldsToCron({ ...fields, scheduleKind: fields.scheduleKind });
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
	/** 時間帯の形（{@link paradisBotPatrolScheduleFromCron} に当たる式のときだけ）。画面の欄は `cron` から作る。 */
	readonly schedule?: IParadisBotPatrolSchedule;
	readonly cron?: string;
	readonly lookFor: string;
	/** 次に見回る時刻。無効・Bot の機能がオフ・一時停止・制限できないエージェントのときは無し。 */
	readonly nextRunAt?: number;
	/** 門の答え（画面が「一時停止中のため見回りません」などを出す）。台帳を読み終える前は無し。 */
	readonly gate?: ParadisBotPatrolGateState;
	/** ほかの Bot の有効な見回りの、1 日あたりの回数の合計（見回り全体の 1 日の枠と比べて画面に出す）。 */
	readonly otherPatrolsRunsPerDay?: number;
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

/** ほかの Bot の有効な見回りの、1 日あたりの回数の合計（走る日の回数。曜日は見ず多めに数える）。 */
export function paradisOtherBotPatrolsRunsPerDay(definitions: readonly IParadisScheduledRunDefinition[], botId: string): number {
	let total = 0;
	for (const definition of definitions) {
		if (definition.enabled && paradisIsBotPatrolDefinition(definition) && definition.target.botId !== botId) {
			const parsed = paradisParseCron(definition.schedule);
			total += parsed.schedule ? paradisCronRunsPerDay(parsed.schedule) : 0;
		}
	}
	return total;
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
	// 汎用の型に当たる式（`30 9 * * 1-5` など）は時間帯の形にしない（読む順は paradisBotPatrolFieldsFromCron と同じ）
	const schedule = paradisCronToSchedulePreset(definition.schedule).kind === 'cron' ? paradisBotPatrolScheduleFromCron(definition.schedule) : undefined;
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

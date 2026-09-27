/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期実行の時刻（5 項目の cron 式）の解釈と、次の時刻・逃した時刻の計算。
//
// 時刻はこのマシンのローカル時刻で解釈する（タイムゾーンは持たない）。定期実行の時刻を決める
// shared process も、画面も同じマシンで動くため。
//
// Orca（stablyai/orca、MIT）の automations は RRULE とタイムゾーンを持つが、ここでは画面の
// 選択肢（毎日・平日・曜日・N 時間ごと）が cron で表せる範囲に収まるので、依存を増やさずに
// 小さな cron の解釈器を持つ。

import { localize } from '../../../../nls.js';

/** 1 分。 */
export const PARADIS_MINUTE_MS = 60_000;
/** 1 日の分数。 */
const MINUTES_PER_DAY = 24 * 60;

/** 解釈済みの cron 式。各集合は許された値だけを持つ。 */
export interface IParadisCronSchedule {
	/** 元の式（前後の空白と連続空白を詰めたもの）。 */
	readonly source: string;
	readonly minutes: readonly number[];
	readonly hours: readonly number[];
	readonly daysOfMonth: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	/** 0 = 日曜 … 6 = 土曜（7 は 0 に寄せる）。 */
	readonly daysOfWeek: ReadonlySet<number>;
	/** 日と曜日のどちらも `*` 以外なら、cron の慣例どおり「どちらかに合えば」実行する。 */
	readonly dayOfMonthRestricted: boolean;
	readonly dayOfWeekRestricted: boolean;
}

export type ParadisCronParseResult =
	| { readonly schedule: IParadisCronSchedule; readonly error?: undefined }
	| { readonly schedule?: undefined; readonly error: string };

interface IFieldSpec {
	readonly min: number;
	readonly max: number;
	readonly label: string;
}

const FIELD_SPECS: readonly IFieldSpec[] = [
	{ min: 0, max: 59, label: localize('paradis.scheduledRuns.cron.minute', "分") },
	{ min: 0, max: 23, label: localize('paradis.scheduledRuns.cron.hour', "時") },
	{ min: 1, max: 31, label: localize('paradis.scheduledRuns.cron.dayOfMonth', "日") },
	{ min: 1, max: 12, label: localize('paradis.scheduledRuns.cron.month', "月") },
	{ min: 0, max: 7, label: localize('paradis.scheduledRuns.cron.dayOfWeek', "曜日") },
];

/** `*`、`5`、`1-5`、`*\/15`、`0-30/10` をカンマでつないだ1項目を解釈する。 */
function parseField(text: string, spec: IFieldSpec): { values: Set<number>; restricted: boolean } | string {
	const values = new Set<number>();
	let restricted = true;
	for (const part of text.split(',')) {
		const match = /^(?<range>\*|\d+(?:-\d+)?)(?:\/(?<step>\d+))?$/.exec(part);
		if (!match?.groups) {
			return localize('paradis.scheduledRuns.cron.badField', "{0}の指定「{1}」を読めません。", spec.label, part);
		}
		const { range, step: stepText } = match.groups;
		let from = spec.min;
		let to = spec.max;
		if (range === '*') {
			if (stepText === undefined) {
				restricted = false;
			}
		} else {
			const [a, b] = range.split('-').map(value => Number(value));
			from = a;
			to = b ?? (stepText !== undefined ? spec.max : a);
		}
		const step = stepText === undefined ? 1 : Number(stepText);
		if (from < spec.min || to > spec.max || from > to || step < 1) {
			return localize('paradis.scheduledRuns.cron.outOfRange', "{0}の指定「{1}」が範囲（{2}〜{3}）を外れています。", spec.label, part, spec.min, spec.max);
		}
		for (let value = from; value <= to; value += step) {
			values.add(value);
		}
	}
	return { values, restricted };
}

/** 5 項目の cron 式（分 時 日 月 曜日）を解釈する。 */
export function paradisParseCron(expression: string): ParadisCronParseResult {
	const source = expression.trim().replace(/\s+/g, ' ');
	const fields = source.length > 0 ? source.split(' ') : [];
	if (fields.length !== 5) {
		return { error: localize('paradis.scheduledRuns.cron.fieldCount', "時刻の式は「分 時 日 月 曜日」の 5 項目で書いてください。") };
	}
	const parsed: { values: Set<number>; restricted: boolean }[] = [];
	for (let index = 0; index < fields.length; index++) {
		const result = parseField(fields[index], FIELD_SPECS[index]);
		if (typeof result === 'string') {
			return { error: result };
		}
		parsed.push(result);
	}
	const daysOfWeek = new Set<number>();
	for (const value of parsed[4].values) {
		daysOfWeek.add(value === 7 ? 0 : value);
	}
	return {
		schedule: {
			source,
			minutes: [...parsed[0].values].sort((a, b) => a - b),
			hours: [...parsed[1].values].sort((a, b) => a - b),
			daysOfMonth: parsed[2].values,
			months: parsed[3].values,
			daysOfWeek,
			dayOfMonthRestricted: parsed[2].restricted,
			dayOfWeekRestricted: parsed[4].restricted,
		},
	};
}

function dayMatches(schedule: IParadisCronSchedule, date: Date): boolean {
	if (!schedule.months.has(date.getMonth() + 1)) {
		return false;
	}
	const domMatch = schedule.daysOfMonth.has(date.getDate());
	const dowMatch = schedule.daysOfWeek.has(date.getDay());
	if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}

/** 探す日数の上限。2/29 だけの式でも見つかるよう 4 年＋余裕を見る。 */
const MAX_SEARCH_DAYS = 366 * 4 + 7;

/**
 * `after` より後（等しい時刻は含まない）で最初の時刻（epoch ms）。無ければ undefined。
 *
 * 夏時間の切り替えで存在しない時刻（2:30 など）は、Date が進めた時刻（3:30）で返す。同じ日に
 * 同じ時刻が2回来る（戻る日）ときは1回目だけを返す。
 */
export function paradisNextCronOccurrence(schedule: IParadisCronSchedule, after: number): number | undefined {
	const start = new Date(after);
	start.setSeconds(0, 0);
	const firstDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	for (let offset = 0; offset < MAX_SEARCH_DAYS; offset++) {
		const day = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + offset);
		if (!dayMatches(schedule, day)) {
			continue;
		}
		for (const hour of schedule.hours) {
			for (const minute of schedule.minutes) {
				const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime();
				if (candidate > after) {
					return candidate;
				}
			}
		}
	}
	return undefined;
}

/**
 * 連続する2回の時刻の間隔として、あり得る最短（分）。
 *
 * 1 日の中の時刻の並びと、日をまたぐ間隔（その日の最後 → 翌日の最初）から求める。翌日が実行日で
 * あるかは見ない（安全側に短く見積もる）。
 */
export function paradisCronMinimumGapMinutes(schedule: IParadisCronSchedule): number {
	const times: number[] = [];
	for (const hour of schedule.hours) {
		for (const minute of schedule.minutes) {
			times.push(hour * 60 + minute);
		}
	}
	times.sort((a, b) => a - b);
	let gap = MINUTES_PER_DAY - times[times.length - 1] + times[0];
	for (let index = 1; index < times.length; index++) {
		gap = Math.min(gap, times[index] - times[index - 1]);
	}
	return gap;
}

/** 逃した時刻の数え方の結果。 */
export interface IParadisMissedOccurrences {
	/** 範囲内の時刻の数（上限 `limit` で打ち切り）。 */
	readonly count: number;
	/** 最初と最後の時刻。count が 0 なら undefined。 */
	readonly first?: number;
	readonly last?: number;
	/** 上限で打ち切ったか。 */
	readonly truncated: boolean;
}

/**
 * `from` より後、`to` 以下で一番新しい時刻。無ければ undefined。
 *
 * 先頭から数えると間隔の短い式で長い空白（数か月の電源断など）を歩き切れないので、`to` の手前の
 * 狭い窓から探し、見つからなければ窓を倍々に広げる。
 */
export function paradisLastCronOccurrence(schedule: IParadisCronSchedule, from: number, to: number): number | undefined {
	for (let window = MINUTES_PER_DAY * PARADIS_MINUTE_MS; ; window *= 2) {
		const windowStart = Math.max(from, to - window);
		let last: number | undefined;
		for (let next = paradisNextCronOccurrence(schedule, windowStart); next !== undefined && next <= to; next = paradisNextCronOccurrence(schedule, next)) {
			last = next;
		}
		if (last !== undefined || windowStart === from) {
			return last;
		}
	}
}

/** `from` より後、`to` 以下の時刻を数える（`limit` 件で打ち切る）。 */
export function paradisCronOccurrencesBetween(schedule: IParadisCronSchedule, from: number, to: number, limit = 2000): IParadisMissedOccurrences {
	let count = 0;
	let first: number | undefined;
	let last: number | undefined;
	let cursor = from;
	while (count < limit) {
		const next = paradisNextCronOccurrence(schedule, cursor);
		if (next === undefined || next > to) {
			return { count, first, last, truncated: false };
		}
		first ??= next;
		last = next;
		count++;
		cursor = next;
	}
	// 打ち切ったときも「最後」は範囲の最後の時刻を返す（実行するのは一番新しい1回だけのため）
	const tail = paradisNextCronOccurrence(schedule, cursor);
	if (tail === undefined || tail > to) {
		return { count, first, last, truncated: false };
	}
	return { count, first, last: paradisLastCronOccurrence(schedule, cursor, to) ?? last, truncated: true };
}

// ---------- 画面向けの選択肢 ----------

/** 画面で選べる時刻の型。どれも cron 式へ落とす。 */
export type ParadisSchedulePreset =
	| { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
	| { readonly kind: 'weekdays'; readonly hour: number; readonly minute: number }
	| { readonly kind: 'weekly'; readonly dayOfWeek: number; readonly hour: number; readonly minute: number }
	| { readonly kind: 'hourly'; readonly everyHours: number; readonly minute: number }
	| { readonly kind: 'cron'; readonly expression: string };

/** 画面の選択肢を cron 式にする。 */
export function paradisSchedulePresetToCron(preset: ParadisSchedulePreset): string {
	switch (preset.kind) {
		case 'daily': return `${preset.minute} ${preset.hour} * * *`;
		case 'weekdays': return `${preset.minute} ${preset.hour} * * 1-5`;
		case 'weekly': return `${preset.minute} ${preset.hour} * * ${preset.dayOfWeek}`;
		case 'hourly': return preset.everyHours <= 1 ? `${preset.minute} * * * *` : `${preset.minute} */${preset.everyHours} * * *`;
		case 'cron': return preset.expression.trim().replace(/\s+/g, ' ');
	}
}

/** cron 式を画面の選択肢へ戻す。どの型にも当たらなければ `cron`。 */
export function paradisCronToSchedulePreset(expression: string): ParadisSchedulePreset {
	const source = expression.trim().replace(/\s+/g, ' ');
	const fixed = /^(?<minute>\d{1,2}) (?<hour>\d{1,2}) \* \* (?<dow>\*|1-5|[0-7])$/.exec(source);
	if (fixed?.groups) {
		const minute = Number(fixed.groups.minute);
		const hour = Number(fixed.groups.hour);
		if (minute <= 59 && hour <= 23) {
			const dow = fixed.groups.dow;
			if (dow === '*') {
				return { kind: 'daily', hour, minute };
			}
			if (dow === '1-5') {
				return { kind: 'weekdays', hour, minute };
			}
			return { kind: 'weekly', dayOfWeek: Number(dow) % 7, hour, minute };
		}
	}
	const hourly = /^(?<minute>\d{1,2}) (?:\*|\*\/(?<every>\d{1,2})) \* \* \*$/.exec(source);
	if (hourly?.groups && Number(hourly.groups.minute) <= 59) {
		const every = hourly.groups.every === undefined ? 1 : Number(hourly.groups.every);
		if (every >= 1 && every <= 23) {
			return { kind: 'hourly', everyHours: every, minute: Number(hourly.groups.minute) };
		}
	}
	return { kind: 'cron', expression: source };
}

function dayOfWeekName(day: number): string {
	switch (day % 7) {
		case 0: return localize('paradis.scheduledRuns.dow.sun', "日曜");
		case 1: return localize('paradis.scheduledRuns.dow.mon', "月曜");
		case 2: return localize('paradis.scheduledRuns.dow.tue', "火曜");
		case 3: return localize('paradis.scheduledRuns.dow.wed', "水曜");
		case 4: return localize('paradis.scheduledRuns.dow.thu', "木曜");
		case 5: return localize('paradis.scheduledRuns.dow.fri', "金曜");
		default: return localize('paradis.scheduledRuns.dow.sat', "土曜");
	}
}

/** 曜日の表示名（0 = 日曜）。 */
export function paradisDayOfWeekLabel(day: number): string {
	return dayOfWeekName(day);
}

function clock(hour: number, minute: number): string {
	return `${hour}:${String(minute).padStart(2, '0')}`;
}

/** cron 式を読める文にする（「平日 9:00」など）。型に当たらなければ式をそのまま返す。 */
export function paradisDescribeCron(expression: string): string {
	const preset = paradisCronToSchedulePreset(expression);
	switch (preset.kind) {
		case 'daily': return localize('paradis.scheduledRuns.describe.daily', "毎日 {0}", clock(preset.hour, preset.minute));
		case 'weekdays': return localize('paradis.scheduledRuns.describe.weekdays', "平日 {0}", clock(preset.hour, preset.minute));
		case 'weekly': return localize('paradis.scheduledRuns.describe.weekly', "毎週{0} {1}", dayOfWeekName(preset.dayOfWeek), clock(preset.hour, preset.minute));
		case 'hourly': return preset.everyHours <= 1
			? localize('paradis.scheduledRuns.describe.hourly', "毎時 {0} 分", preset.minute)
			: localize('paradis.scheduledRuns.describe.everyHours', "{0} 時間ごと（{1} 分）", preset.everyHours, preset.minute);
		case 'cron': return preset.expression;
	}
}

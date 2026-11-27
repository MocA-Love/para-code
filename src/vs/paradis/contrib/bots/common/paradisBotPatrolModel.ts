/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの「定期実行」の節と、設定のタブの見回りの欄（paradisBotPatrol.ts）の、DOM を持たない決まり。
// 見回りの台帳と時刻の判定は定期実行の側（scheduledRuns/common/paradisScheduledRunBotPatrol.ts）にあり、ここは
// 画面に出す文だけを作る。

import { localize } from '../../../../nls.js';
import { IParadisBotPatrolSchedule, IParadisBotPatrolScheduleFields, IParadisBotPatrolView, paradisBotPatrolFieldsToCron, paradisBotPatrolScheduleFromCron } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { paradisCronToSchedulePreset, paradisDescribeCron, paradisNextCronOccurrence, paradisParseCron } from '../../scheduledRuns/common/paradisScheduleCron.js';
import { paradisScheduledRunRecordStatusLabel, paradisValidateBotPatrolScheduleGap } from '../../scheduledRuns/common/paradisScheduledRuns.js';

/** 時間帯の形の 1 行（「平日 8〜20 時・4 時間ごと」「毎日 9 時」。分があれば「平日 8:30〜20:30・4 時間ごと」）。 */
export function paradisBotPatrolScheduleLabel(schedule: IParadisBotPatrolSchedule): string {
	const days = schedule.weekdaysOnly ? localize('paradis.botPatrol.weekdays', "平日") : localize('paradis.botPatrol.everyDay', "毎日");
	const minute = schedule.minute ?? 0;
	if (minute !== 0) {
		const clock = (hour: number) => `${hour}:${String(minute).padStart(2, '0')}`;
		return schedule.fromHour === schedule.toHour
			? localize('paradis.botPatrol.onceAt', "{0} {1}", days, clock(schedule.fromHour))
			: localize('paradis.botPatrol.rangeAt', "{0} {1}〜{2}・{3} 時間ごと", days, clock(schedule.fromHour), clock(schedule.toHour), schedule.everyHours);
	}
	return schedule.fromHour === schedule.toHour
		? localize('paradis.botPatrol.once', "{0} {1} 時", days, schedule.fromHour)
		: localize('paradis.botPatrol.range', "{0} {1}〜{2} 時・{3} 時間ごと", days, schedule.fromHour, schedule.toHour, schedule.everyHours);
}

/**
 * 見回りの時刻の 1 行。汎用の定期実行の型（「平日 9:30」「3 時間ごと（15 分）」）に当たればその書き方、当たらず
 * 時間帯の形ならその書き方、どちらでもなければ式をそのまま出す。
 */
export function paradisBotPatrolCronLabel(expression: string): string {
	if (paradisCronToSchedulePreset(expression).kind !== 'cron') {
		return paradisDescribeCron(expression);
	}
	const window = paradisBotPatrolScheduleFromCron(expression);
	return window !== undefined ? paradisBotPatrolScheduleLabel(window) : expression;
}

/** 時刻（今日なら時刻だけ、ほかは月日つき）。 */
export function paradisBotPatrolTime(time: number, now: number): string {
	const date = new Date(time);
	const today = new Date(now);
	const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
	return date.toDateString() === today.toDateString()
		? clock
		: localize('paradis.botPatrol.dateTime', "{0}/{1} {2}", date.getMonth() + 1, date.getDate(), clock);
}

/** 設定のタブの時刻の欄を確かめた結果。 */
export interface IParadisBotPatrolScheduleCheck {
	/** 保存する cron 式（欄から式を作れなければ無し）。 */
	readonly cron?: string;
	/** 保存できない理由（式の誤り・間隔が短すぎる・時間帯が逆）。 */
	readonly problem?: string;
	/** 保存できるときの 1 行（「平日 9:30（30 9 * * 1-5）· 有効なら次は 12/1 9:30」）。 */
	readonly summary: string;
}

/**
 * 時刻の欄を cron 式にして確かめる。式の正しさと間隔の下限は、保存のときに shared process が見るものと同じ
 * （`paradisParseCron` と見回りの下限）。画面は先に知らせるだけ。
 */
export function paradisBotPatrolScheduleCheck(fields: IParadisBotPatrolScheduleFields, now: number): IParadisBotPatrolScheduleCheck {
	const cron = paradisBotPatrolFieldsToCron(fields);
	if (cron === undefined) {
		return { problem: localize('paradis.botPatrol.badRange', "時間帯の終わりは始め以降にしてください"), summary: '' };
	}
	const parsed = paradisParseCron(cron);
	if (parsed.error !== undefined) {
		return { cron, problem: parsed.error, summary: '' };
	}
	const gap = paradisValidateBotPatrolScheduleGap(parsed.schedule);
	if (gap !== undefined) {
		return { cron, problem: gap, summary: '' };
	}
	const next = paradisNextCronOccurrence(parsed.schedule, now);
	const label = paradisBotPatrolCronLabel(cron);
	const described = label === cron ? cron : localize('paradis.botPatrol.described', "{0}（{1}）", label, cron);
	return {
		cron,
		summary: next !== undefined ? localize('paradis.botPatrol.preview', "{0} · 有効なら次は {1}", described, paradisBotPatrolTime(next, now)) : described,
	};
}

/**
 * 節の 1 行目（見回るか・いつか）。作っていない・オフ・止めている理由がある・次の時刻、の順に決める。
 */
export function paradisBotPatrolHeadline(view: IParadisBotPatrolView, now: number): string {
	if (view.definitionId === undefined) {
		return localize('paradis.botPatrol.none', "見回りはまだ決めていません");
	}
	const when = view.cron !== undefined ? paradisBotPatrolCronLabel(view.cron) : '';
	if (!view.enabled) {
		return localize('paradis.botPatrol.off', "見回りはオフです（{0}）", when);
	}
	switch (view.gate) {
		case 'off': return localize('paradis.botPatrol.gateOff', "Bot の機能がオフのため見回りません");
		case 'paused': return localize('paradis.botPatrol.gatePaused', "一時停止中のため見回りません");
		case 'unsupported': return localize('paradis.botPatrol.gateUnsupported', "このエージェントは読むだけに制限できないため見回りません");
	}
	if (view.activeRunId !== undefined) {
		return localize('paradis.botPatrol.running', "見回り中（{0}）", when);
	}
	return view.nextRunAt !== undefined
		? localize('paradis.botPatrol.next', "{0}。次は {1}", when, paradisBotPatrolTime(view.nextRunAt, now))
		: when;
}

/** 最後の回の 1 行（無ければ undefined）。 */
export function paradisBotPatrolLastRun(view: IParadisBotPatrolView, now: number): string | undefined {
	const last = view.lastRun;
	if (last === undefined) {
		return undefined;
	}
	const at = last.finishedAt ?? last.scheduledFor;
	const status = paradisScheduledRunRecordStatusLabel(last);
	return at !== undefined
		? localize('paradis.botPatrol.lastAt', "前回 {0}: {1}", paradisBotPatrolTime(at, now), status)
		: localize('paradis.botPatrol.last', "前回: {0}", status);
}

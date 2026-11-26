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
import { IParadisBotPatrolSchedule, IParadisBotPatrolView } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { paradisScheduledRunRecordStatusLabel } from '../../scheduledRuns/common/paradisScheduledRuns.js';

/** 時刻の形の 1 行（「平日 8〜20 時・4 時間ごと」「毎日 9 時」）。 */
export function paradisBotPatrolScheduleLabel(schedule: IParadisBotPatrolSchedule): string {
	const days = schedule.weekdaysOnly ? localize('paradis.botPatrol.weekdays', "平日") : localize('paradis.botPatrol.everyDay', "毎日");
	return schedule.fromHour === schedule.toHour
		? localize('paradis.botPatrol.once', "{0} {1} 時", days, schedule.fromHour)
		: localize('paradis.botPatrol.range', "{0} {1}〜{2} 時・{3} 時間ごと", days, schedule.fromHour, schedule.toHour, schedule.everyHours);
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

/**
 * 節の 1 行目（見回るか・いつか）。作っていない・オフ・止めている理由がある・次の時刻、の順に決める。
 */
export function paradisBotPatrolHeadline(view: IParadisBotPatrolView, now: number): string {
	if (view.definitionId === undefined) {
		return localize('paradis.botPatrol.none', "見回りはまだ決めていません");
	}
	const when = view.schedule !== undefined ? paradisBotPatrolScheduleLabel(view.schedule) : (view.cron ?? '');
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

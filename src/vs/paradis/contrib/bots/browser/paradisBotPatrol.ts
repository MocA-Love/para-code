/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの見回り。ホーム（項目のタブ）の「定期実行」の節と、設定のタブの「見回り」の欄。
// 読み書きは定期実行の口（IParadisScheduledRunsClient の getBotPatrol・setBotPatrol・runBotPatrolNow）を通す。
// その口は electron-browser にあるので、ここでは形だけを受け取る（{@link IParadisBotPatrolPort}。Bot のページの登録の側が渡す）。

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { IParadisBotPatrolInput, IParadisBotPatrolScheduleFields, IParadisBotPatrolView, ParadisBotPatrolScheduleKind, paradisBotPatrolFieldsFromCron, PARADIS_BOT_PATROL_EVERY_MINUTES, PARADIS_BOT_PATROL_INTERVAL_HOURS } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { paradisDayOfWeekLabel } from '../../scheduledRuns/common/paradisScheduleCron.js';
import { PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import { paradisBotPatrolHeadline, paradisBotPatrolLastRun, paradisBotPatrolScheduleCheck } from '../common/paradisBotPatrolModel.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';

const $ = DOM.$;

/** 見回りの口（定期実行の側）。 */
export interface IParadisBotPatrolPort {
	/** 定期実行か Bot の台帳が変わった（見回りの次の時刻・門の答えが変わりうる）。 */
	readonly onDidChange: Event<void>;
	get(botId: string): Promise<IParadisBotPatrolView>;
	set(botId: string, input: IParadisBotPatrolInput): Promise<{ readonly ok: boolean; readonly error?: string }>;
	runNow(botId: string): Promise<{ readonly ok: boolean; readonly error?: string }>;
}

export interface IParadisBotPatrolServices {
	readonly notificationService: INotificationService;
	readonly contextViewService: IContextViewService;
	readonly configurationService: IConfigurationService;
}

/** 設定のタブで書きかけの値（描き直しの間も持つ）。 */
interface IPatrolDraft {
	enabled: boolean;
	fields: IParadisBotPatrolScheduleFields;
	lookFor: string;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Bot 1 つ分の見回りの表示。読み込みが終わったら `rerender` を呼ぶ。 */
/** 前回の最後の発言をツールチップに出すときの長さの上限。 */
const LAST_MESSAGE_TITLE_LIMIT = 300;

export class ParadisBotPatrolSection {

	private view: IParadisBotPatrolView | undefined;
	private loading = false;
	/** 読み込み中に知らせが来た（読み終えたらもう一度読む）。 */
	private stale = false;
	private draft: IPatrolDraft | undefined;
	private busy = false;

	constructor(
		private readonly botId: string,
		private readonly port: IParadisBotPatrolPort,
		private readonly services: IParadisBotPatrolServices,
		private readonly rerender: () => void,
		private readonly openSettings: () => void,
	) { }

	/** 口の知らせを受けて読み直す（読み込み中なら、読み終えた後にもう一度読む）。 */
	invalidate(): void {
		void this.load();
	}

	/** 表示していない Bot の分: 持っている状態を捨て、次に描くときに読む（読み込み中なら、読み終えた後にもう一度読む）。 */
	forget(): void {
		if (this.loading) {
			this.stale = true;
		} else {
			this.view = undefined;
		}
	}

	private async load(): Promise<void> {
		if (this.loading) {
			this.stale = true;
			return;
		}
		this.loading = true;
		try {
			do {
				this.stale = false;
				try {
					this.view = await this.port.get(this.botId);
				} catch {
					this.view = undefined;
				}
			} while (this.stale);
		} finally {
			this.loading = false;
		}
		this.rerender();
	}

	private ensureLoaded(): IParadisBotPatrolView | undefined {
		if (this.view === undefined && !this.loading) {
			void this.load();
		}
		return this.view;
	}

	/** ホームの「定期実行」の節。見回りの 1 行、前回の結果、「今すぐ見回る」「変える」。 */
	renderHome(body: HTMLElement, store: DisposableStore): void {
		const view = this.ensureLoaded();
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botPatrol.section', "定期実行");
		const card = DOM.append(body, $('.paradis-bot-patrol'));
		const now = Date.now();
		DOM.append(card, $('.paradis-bot-patrol-line')).textContent = view === undefined ? localize('paradis.botPatrol.loading', "読み込んでいます…") : paradisBotPatrolHeadline(view, now);
		const last = view !== undefined ? paradisBotPatrolLastRun(view, now) : undefined;
		if (last !== undefined) {
			const lastLine = DOM.append(card, $('.paradis-bot-patrol-last'));
			lastLine.textContent = last;
			// Bot の言葉そのままなので、制御文字・書字方向の制御を落として短くしてから出す
			const message = paradisSanitizeDisplayText(view?.lastRun?.lastMessage, LAST_MESSAGE_TITLE_LIMIT);
			if (message) {
				lastLine.title = message;
			}
		}
		const actions = DOM.append(card, $('.paradis-bot-page-ask-actions'));
		if (view?.definitionId !== undefined) {
			const runButton = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPatrol.runNow', "今すぐ見回る") }));
			runButton.enabled = !this.busy && view.activeRunId === undefined && (view.gate === undefined || view.gate === 'ok');
			store.add(runButton.onDidClick(() => void this.runNow()));
		}
		const change = store.add(new ParadisButton(actions, { kind: 'secondary', label: view?.definitionId === undefined ? localize('paradis.botPatrol.setUp', "見回りを決める...") : localize('paradis.botPatrol.change', "変える...") }));
		store.add(change.onDidClick(() => this.openSettings()));
	}

	/** 設定のタブの「見回り」の欄（見回る・時刻の種類と欄・探すもの、保存、今すぐ見回る）。 */
	renderSettings(body: HTMLElement, store: DisposableStore): void {
		const view = this.ensureLoaded();
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botPatrol.settingsSection', "見回り");
		if (view === undefined) {
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botPatrol.loading', "読み込んでいます…");
			return;
		}
		const draft = this.draft ??= { enabled: view.definitionId !== undefined ? view.enabled : false, fields: paradisBotPatrolFieldsFromCron(view.cron), lookFor: view.lookFor };
		const grid = DOM.append(body, $('.paradis-bot-settings.paradis-bot-patrol-settings'));
		const rowPair = (label: string): { readonly key: HTMLElement; readonly value: HTMLElement } => {
			const key = DOM.append(grid, $('span.paradis-bot-settings-key'));
			key.textContent = label;
			return { key, value: DOM.append(grid, $('.paradis-bot-settings-value')) };
		};
		const row = (label: string): HTMLElement => rowPair(label).value;
		const select = (parent: HTMLElement, options: readonly (readonly [string, string])[], value: string, ariaLabel: string): ParadisSelect =>
			store.add(new ParadisSelect(parent, this.services.contextViewService, this.services.configurationService, options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel })), value, { ariaLabel }));
		const setFields = (change: Partial<IParadisBotPatrolScheduleFields>) => {
			draft.fields = { ...draft.fields, ...change };
			update();
		};

		const enabledLabel = localize('paradis.botPatrol.enabled', "見回る");
		const enabled = store.add(new ParadisSwitch(row(enabledLabel), { checked: draft.enabled, ariaLabel: enabledLabel }));
		store.add(enabled.onDidChange(checked => draft.enabled = checked));

		// 時刻（汎用の定期実行と同じ種類と欄。前の画面の「時間帯の中で n 時間ごと」も選べる）
		const whenLabel = localize('paradis.botPatrol.when', "時刻");
		const when = rowPair(whenLabel);
		// 見出しは欄の 1 行目に合わせる（下に説明の行が付くので、真ん中に揃えると欄とずれる）
		when.key.classList.add('top');
		const whenCell = when.value;
		const whenLine = DOM.append(whenCell, $('.paradis-bot-patrol-range'));
		const kind = select(whenLine, [
			['window', localize('paradis.botPatrol.kind.window', "時間帯の中で数時間ごと")],
			['daily', localize('paradis.scheduledRuns.kind.daily', "毎日")],
			['weekdays', localize('paradis.scheduledRuns.kind.weekdays', "平日（月〜金）")],
			['weekly', localize('paradis.scheduledRuns.kind.weekly', "毎週")],
			['hourly', localize('paradis.scheduledRuns.kind.hourly', "数時間ごと")],
			['minutes', localize('paradis.botPatrol.kind.minutes', "n 分ごと")],
			['cron', localize('paradis.scheduledRuns.kind.cron', "cron 式")],
		], draft.fields.scheduleKind, localize('paradis.botPatrol.aria.kind', "見回りの時刻の種類"));
		store.add(kind.onDidChange(value => setFields({ scheduleKind: value as ParadisBotPatrolScheduleKind })));
		const dayOfWeek = select(whenLine, [1, 2, 3, 4, 5, 6, 0].map(day => [String(day), paradisDayOfWeekLabel(day)] as const), String(draft.fields.dayOfWeek), localize('paradis.scheduledRuns.aria.dayOfWeek', "曜日"));
		store.add(dayOfWeek.onDidChange(value => setFields({ dayOfWeek: Number(value) })));
		const time = store.add(new ParadisInputField(whenLine, { ariaLabel: localize('paradis.botPatrol.aria.time', "時刻"), value: draft.fields.time }));
		time.element.classList.add('paradis-bot-patrol-time');
		time.inputElement.type = 'time';
		store.add(time.onDidChange(value => setFields({ time: value })));
		const everyHours = select(whenLine, PARADIS_BOT_PATROL_INTERVAL_HOURS.map(hours => [String(hours), localize('paradis.botPatrol.everyHours', "{0} 時間ごと", hours)] as const), String(draft.fields.everyHours), localize('paradis.botPatrol.every', "間隔"));
		store.add(everyHours.onDidChange(value => setFields({ everyHours: Number(value) })));
		const everyMinutes = select(whenLine, PARADIS_BOT_PATROL_EVERY_MINUTES.map(minutes => [String(minutes), localize('paradis.botPatrol.everyMinutes', "{0} 分ごと", minutes)] as const), String(draft.fields.everyMinutes), localize('paradis.botPatrol.aria.everyMinutes', "何分ごと"));
		store.add(everyMinutes.onDidChange(value => setFields({ everyMinutes: Number(value) })));
		const minuteLabel = DOM.append(whenLine, $('span'));
		minuteLabel.textContent = localize('paradis.scheduledRuns.atMinute', "の");
		const minute = store.add(new ParadisInputField(whenLine, { ariaLabel: localize('paradis.botPatrol.aria.minute', "分"), value: String(draft.fields.minute) }));
		minute.element.classList.add('paradis-bot-patrol-minute');
		minute.inputElement.type = 'number';
		minute.inputElement.min = '0';
		minute.inputElement.max = '59';
		store.add(minute.onDidChange(value => setFields({ minute: Number(value) || 0 })));
		const minuteSuffix = DOM.append(whenLine, $('span'));
		minuteSuffix.textContent = localize('paradis.scheduledRuns.minuteSuffix', "分");
		const cron = store.add(new ParadisInputField(whenLine, { ariaLabel: localize('paradis.scheduledRuns.kind.cron', "cron 式"), value: draft.fields.cron, placeholder: '30 9 * * 1-5' }));
		cron.element.classList.add('paradis-bot-patrol-cron');
		store.add(cron.onDidChange(value => setFields({ cron: value })));
		const cronHint = DOM.append(whenCell, $('span.paradis-bot-patrol-preview'));
		cronHint.textContent = localize('paradis.botPatrol.cronHint', "時刻の式（分 時 日 月 曜日）の間隔は、分や時の中でだけ繰り返します。90 分ごとのように 1 時間で割り切れない間隔は書けません。");
		const preview = DOM.append(whenCell, $('span.paradis-bot-patrol-preview'));
		preview.setAttribute('aria-live', 'polite');
		const overall = DOM.append(whenCell, $('span.paradis-bot-patrol-preview.paradis-bot-patrol-problem'));

		const range = rowPair(localize('paradis.botPatrol.rangeLabel', "時間帯"));
		const rangeLine = DOM.append(range.value, $('.paradis-bot-patrol-range'));
		const from = select(rangeLine, HOURS.map(hour => [String(hour), localize('paradis.botPatrol.hour', "{0} 時", hour)] as const), String(draft.fields.fromHour), localize('paradis.botPatrol.from', "始め"));
		DOM.append(rangeLine, $('span')).textContent = '〜';
		const to = select(rangeLine, HOURS.map(hour => [String(hour), localize('paradis.botPatrol.hour', "{0} 時", hour)] as const), String(draft.fields.toHour), localize('paradis.botPatrol.to', "終わり"));
		store.add(from.onDidChange(value => setFields({ fromHour: Number(value) })));
		store.add(to.onDidChange(value => setFields({ toHour: Number(value) })));

		const weekdaysLabel = localize('paradis.botPatrol.weekdaysOnly', "平日だけ");
		const weekdaysRow = rowPair(weekdaysLabel);
		const weekdays = store.add(new ParadisSwitch(weekdaysRow.value, { checked: draft.fields.weekdaysOnly, ariaLabel: weekdaysLabel }));
		store.add(weekdays.onDidChange(checked => setFields({ weekdaysOnly: checked })));

		// 種類に合う欄だけを見せ、式と次の時刻（または断る理由）を出す。描き直さないので、入力中の欄のフォーカスは動かない
		const update = () => {
			const fields = draft.fields;
			const showTime = fields.scheduleKind === 'daily' || fields.scheduleKind === 'weekdays' || fields.scheduleKind === 'weekly';
			const showEvery = fields.scheduleKind === 'hourly' || fields.scheduleKind === 'window';
			const showMinute = showEvery || fields.scheduleKind === 'minutes';
			DOM.setVisibility(fields.scheduleKind === 'weekly', dayOfWeek.element);
			DOM.setVisibility(showTime, time.element);
			DOM.setVisibility(showEvery, everyHours.element);
			DOM.setVisibility(fields.scheduleKind === 'minutes', everyMinutes.element);
			DOM.setVisibility(showMinute, minuteLabel, minute.element, minuteSuffix);
			DOM.setVisibility(fields.scheduleKind === 'cron', cron.element, cronHint);
			DOM.setVisibility(fields.scheduleKind === 'window', range.key, range.value, weekdaysRow.key, weekdaysRow.value);
			const result = paradisBotPatrolScheduleCheck(fields, Date.now(), view.otherPatrolsRunsPerDay);
			preview.textContent = result.problem ?? result.summary;
			preview.classList.toggle('paradis-bot-patrol-problem', result.problem !== undefined);
			overall.textContent = result.overall ?? '';
			DOM.setVisibility(result.overall !== undefined, overall);
		};
		update();

		const lookForLabel = localize('paradis.botPatrol.lookFor', "探すもの");
		const lookFor = store.add(new ParadisInputField(row(lookForLabel), { ariaLabel: lookForLabel, value: draft.lookFor, placeholder: localize('paradis.botPatrol.lookForPlaceholder', "例: 返事の無いレビューの指摘") }));
		lookFor.inputElement.maxLength = PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH;
		store.add(lookFor.onDidChange(value => draft.lookFor = value));

		// 設定の欄の下の帯と同じ形（説明の文と、右にボタン）
		const actions = DOM.append(body, $('.paradis-bot-settings-foot'));
		DOM.append(actions, $('span.paradis-bot-settings-help')).textContent = localize('paradis.botPatrol.help', "見回りは読むだけです。見つけたことは提案としてホームに出します。時刻を過ぎた回（スリープ中など）は後から走らせません。「今すぐ見回る」は 1 日の回数に数えません。");
		const save = store.add(new ParadisButton(actions, { kind: 'primary', label: localize('paradis.botPatrol.save', "見回りを保存") }));
		save.enabled = !this.busy;
		store.add(save.onDidClick(() => void this.save()));
		if (view.definitionId !== undefined) {
			const runButton = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPatrol.runNow', "今すぐ見回る") }));
			runButton.enabled = !this.busy && view.activeRunId === undefined && (view.gate === undefined || view.gate === 'ok');
			store.add(runButton.onDidClick(() => void this.runNow()));
		}
	}

	private async save(): Promise<void> {
		const draft = this.draft;
		if (draft === undefined || this.busy) {
			return;
		}
		const result = paradisBotPatrolScheduleCheck(draft.fields, Date.now(), this.view?.otherPatrolsRunsPerDay);
		if (result.problem !== undefined || result.cron === undefined) {
			this.services.notificationService.warn(result.problem ?? '');
			return;
		}
		const schedule = result.cron;
		// 断られたら書きかけを残す（選んだ時間帯や探すものを保存済みの値に戻さない）。保存できたら、読み直して描く前に捨てる
		await this.act(() => this.port.set(this.botId, { schedule, lookFor: draft.lookFor, enabled: draft.enabled }), error => localize('paradis.botPatrol.saveFailed', "見回りを保存できませんでした: {0}", error), () => {
			if (this.draft === draft) {
				this.draft = undefined;
			}
			// 全体の枠は超えた回をその日に見送るだけ（記録に理由が残る）なので保存は断らず、保存した後に知らせる
			if (draft.enabled && result.overall !== undefined) {
				this.services.notificationService.warn(result.overall);
			}
		});
	}

	private async runNow(): Promise<void> {
		if (this.busy) {
			return;
		}
		await this.act(() => this.port.runNow(this.botId), error => localize('paradis.botPatrol.runFailed', "見回りを始められませんでした: {0}", error));
	}

	/** 口を呼び、断られたら理由を出す。うまくいったら `succeeded` を呼んでから読み直す。 */
	private async act(work: () => Promise<{ readonly ok: boolean; readonly error?: string }>, failure: (error: string) => string, succeeded?: () => void): Promise<void> {
		this.busy = true;
		this.rerender();
		try {
			const result = await work();
			if (result.ok) {
				succeeded?.();
			} else {
				this.services.notificationService.warn(failure(result.error ?? ''));
			}
		} catch (error) {
			this.services.notificationService.warn(failure(String(error)));
		} finally {
			this.busy = false;
		}
		await this.load();
	}
}

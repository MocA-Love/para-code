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
import { IParadisBotPatrolInput, IParadisBotPatrolSchedule, IParadisBotPatrolView, PARADIS_BOT_PATROL_DEFAULT_SCHEDULE, PARADIS_BOT_PATROL_INTERVAL_HOURS } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import { paradisBotPatrolHeadline, paradisBotPatrolLastRun } from '../common/paradisBotPatrolModel.js';
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
	schedule: IParadisBotPatrolSchedule;
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

	/** 設定のタブの「見回り」の欄（見回る・間隔・時間帯・平日だけ・探すもの、保存、今すぐ見回る）。 */
	renderSettings(body: HTMLElement, store: DisposableStore): void {
		const view = this.ensureLoaded();
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botPatrol.settingsSection', "見回り");
		if (view === undefined) {
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botPatrol.loading', "読み込んでいます…");
			return;
		}
		const draft = this.draft ??= { enabled: view.definitionId !== undefined ? view.enabled : false, schedule: view.schedule ?? PARADIS_BOT_PATROL_DEFAULT_SCHEDULE, lookFor: view.lookFor };
		const grid = DOM.append(body, $('.paradis-bot-settings.paradis-bot-patrol-settings'));
		const row = (label: string): HTMLElement => {
			DOM.append(grid, $('span.paradis-bot-settings-key')).textContent = label;
			return DOM.append(grid, $('.paradis-bot-settings-value'));
		};
		const enabledLabel = localize('paradis.botPatrol.enabled', "見回る");
		const enabled = store.add(new ParadisSwitch(row(enabledLabel), { checked: draft.enabled, ariaLabel: enabledLabel }));
		store.add(enabled.onDidChange(checked => draft.enabled = checked));

		const everyLabel = localize('paradis.botPatrol.every', "間隔");
		const every = store.add(new ParadisSelect(row(everyLabel), this.services.contextViewService, this.services.configurationService,
			PARADIS_BOT_PATROL_INTERVAL_HOURS.map(hours => ({ value: String(hours), label: localize('paradis.botPatrol.everyHours', "{0} 時間ごと", hours) })), String(draft.schedule.everyHours), { ariaLabel: everyLabel }));
		store.add(every.onDidChange(value => draft.schedule = { ...draft.schedule, everyHours: Number(value) }));

		const rangeLabel = localize('paradis.botPatrol.rangeLabel', "時間帯");
		const range = DOM.append(row(rangeLabel), $('.paradis-bot-patrol-range'));
		const from = store.add(new ParadisSelect(range, this.services.contextViewService, this.services.configurationService,
			HOURS.map(hour => ({ value: String(hour), label: localize('paradis.botPatrol.hour', "{0} 時", hour) })), String(draft.schedule.fromHour), { ariaLabel: localize('paradis.botPatrol.from', "始め") }));
		DOM.append(range, $('span')).textContent = '〜';
		const to = store.add(new ParadisSelect(range, this.services.contextViewService, this.services.configurationService,
			HOURS.map(hour => ({ value: String(hour), label: localize('paradis.botPatrol.hour', "{0} 時", hour) })), String(draft.schedule.toHour), { ariaLabel: localize('paradis.botPatrol.to', "終わり") }));
		store.add(from.onDidChange(value => draft.schedule = { ...draft.schedule, fromHour: Number(value) }));
		store.add(to.onDidChange(value => draft.schedule = { ...draft.schedule, toHour: Number(value) }));

		const weekdaysLabel = localize('paradis.botPatrol.weekdaysOnly', "平日だけ");
		const weekdays = store.add(new ParadisSwitch(row(weekdaysLabel), { checked: draft.schedule.weekdaysOnly, ariaLabel: weekdaysLabel }));
		store.add(weekdays.onDidChange(checked => draft.schedule = { ...draft.schedule, weekdaysOnly: checked }));

		const lookForLabel = localize('paradis.botPatrol.lookFor', "探すもの");
		const lookFor = store.add(new ParadisInputField(row(lookForLabel), { ariaLabel: lookForLabel, value: draft.lookFor, placeholder: localize('paradis.botPatrol.lookForPlaceholder', "例: 返事の無いレビューの指摘") }));
		lookFor.inputElement.maxLength = PARADIS_BOT_PATROL_MAX_LOOK_FOR_LENGTH;
		store.add(lookFor.onDidChange(value => draft.lookFor = value));

		// 設定の欄の下の帯と同じ形（説明の文と、右にボタン）
		const actions = DOM.append(body, $('.paradis-bot-settings-foot'));
		DOM.append(actions, $('span.paradis-bot-settings-help')).textContent = localize('paradis.botPatrol.help', "見回りは読むだけです。見つけたことは提案としてホームに出します。時刻を過ぎた回（スリープ中など）は後から走らせません。");
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
		if (draft.schedule.toHour < draft.schedule.fromHour) {
			this.services.notificationService.warn(localize('paradis.botPatrol.badRange', "時間帯の終わりは始め以降にしてください"));
			return;
		}
		// 断られたら書きかけを残す（選んだ時間帯や探すものを保存済みの値に戻さない）。保存できたら、読み直して描く前に捨てる
		await this.act(() => this.port.set(this.botId, { schedule: draft.schedule, lookFor: draft.lookFor, enabled: draft.enabled }), error => localize('paradis.botPatrol.saveFailed', "見回りを保存できませんでした: {0}", error), () => {
			if (this.draft === draft) {
				this.draft = undefined;
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

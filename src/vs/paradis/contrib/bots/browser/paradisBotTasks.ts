/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの設定のタブの「定期実行」の欄（報告書の D6 (a)）。一覧（止める・今すぐ実行・変える・消す）と、足す・変える欄。
// 見回りの欄（paradisBotPatrol.ts）が持ち、見回りの欄の上に描く（Bot のページ本体は触らない）。読み書きは見回りの口に
// 足した `tasks`（{@link IParadisBotTasksPort}）を通す。

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import { paradisSanitizeDisplayText } from '../../agentBrowser/common/paradisAgentBrowserTabs.js';
import { IParadisBotPatrolScheduleFields, paradisBotPatrolFieldsFromCron } from '../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';
import { IParadisBotTaskInput, IParadisBotTaskView } from '../../scheduledRuns/common/paradisScheduledRunBotTask.js';
import { paradisDayOfWeekLabel } from '../../scheduledRuns/common/paradisScheduleCron.js';
import { ParadisBotTaskTools, PARADIS_BOT_TASK_MAX_PROMPT_LENGTH, PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH, paradisScheduledRunReasonLabel } from '../../scheduledRuns/common/paradisScheduledRuns.js';
import { paradisBotPatrolCronLabel, paradisBotPatrolScheduleCheck, paradisBotPatrolTime } from '../common/paradisBotPatrolModel.js';
import type { IParadisBotPatrolServices } from './paradisBotPatrol.js';

const $ = DOM.$;

type Result = Promise<{ readonly ok: boolean; readonly error?: string }>;

/** 定期実行の口（定期実行の側。Bot のページの登録の側が渡す）。 */
export interface IParadisBotTasksPort {
	get(botId: string): Promise<IParadisBotTaskView[]>;
	set(botId: string, input: IParadisBotTaskInput): Result;
	remove(botId: string, id: string): Result;
	setEnabled(id: string, enabled: boolean): Result;
	runNow(id: string): Result;
	stop(runId: string): Result;
	/** 「Bot の権限」の段を使ってよいかを利用者に確かめる。 */
	confirmBotTools(taskName: string): Promise<boolean>;
	/** 消してよいかを利用者に確かめる。 */
	confirmRemove(taskName: string): Promise<boolean>;
}

/** 道具の段の表示名。 */
export function paradisBotTaskToolsLabel(tools: ParadisBotTaskTools): string {
	switch (tools) {
		case 'read': return localize('paradis.botTasks.tools.read', "読むだけ");
		case 'web': return localize('paradis.botTasks.tools.web', "読む＋Web");
		case 'bot': return localize('paradis.botTasks.tools.bot', "Bot の権限");
	}
}

/** 道具の段の説明（欄の下に出す 1 行）。 */
export function paradisBotTaskToolsHelp(tools: ParadisBotTaskTools): string {
	switch (tools) {
		case 'read': return localize('paradis.botTasks.toolsHelp.read', "手元のファイルを読むだけです。Web も書き換えもしません。");
		case 'web': return localize('paradis.botTasks.toolsHelp.web', "「読む＋Web」は Web のページを読めますが、ファイルの書き換えやコマンドは使いません。読んだページの文は指示として扱いません。");
		case 'bot': return localize('paradis.botTasks.toolsHelp.bot', "会話と同じ権限で動きます。Web から読んだ文に誘導されて、ファイルの書き換えやコマンドを使うおそれがあります。");
	}
}

/** 書きかけの欄。 */
interface ITaskDraft {
	/** 変える定義（足すときは無し）。 */
	readonly id?: string;
	name: string;
	fields: IParadisBotPatrolScheduleFields;
	prompt: string;
	tools: ParadisBotTaskTools;
	enabled: boolean;
	/** 変える前の段（「Bot の権限」のままなら確かめ直さない）。 */
	readonly previousTools?: ParadisBotTaskTools;
}

/** 一覧の最後の結果を title に出すときの長さ。 */
const LAST_MESSAGE_TITLE_LIMIT = 300;
/** 一覧に出す最後の結果の長さ。 */
const LAST_MESSAGE_LINE_LIMIT = 120;

/** Bot 1 つ分の「定期実行」の欄。 */
export class ParadisBotTasksSection {

	private views: IParadisBotTaskView[] | undefined;
	private loading = false;
	private stale = false;
	private draft: ITaskDraft | undefined;
	private busy = false;

	constructor(
		private readonly botId: string,
		private readonly port: IParadisBotTasksPort,
		private readonly services: IParadisBotPatrolServices,
		private readonly rerender: () => void,
	) { }

	invalidate(): void {
		void this.load();
	}

	forget(): void {
		if (this.loading) {
			this.stale = true;
		} else {
			this.views = undefined;
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
					this.views = await this.port.get(this.botId);
				} catch {
					this.views = undefined;
				}
			} while (this.stale);
		} finally {
			this.loading = false;
		}
		this.rerender();
	}

	renderSettings(body: HTMLElement, store: DisposableStore): void {
		if (this.views === undefined && !this.loading) {
			void this.load();
		}
		const views = this.views;
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botTasks.section', "定期実行");
		if (views === undefined) {
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botTasks.loading', "読み込んでいます…");
			return;
		}
		const now = Date.now();
		if (views.length === 0 && this.draft === undefined) {
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botTasks.empty', "決まった時刻に Bot へ頼むことを足せます。結果は Bot の会話に残り、ベルで知らせます。");
		}
		const list = DOM.append(body, $('.paradis-bot-tasks'));
		for (const view of views) {
			if (this.draft?.id === view.id) {
				this.renderForm(list, store);
				continue;
			}
			this.renderRow(list, view, store, now);
		}
		if (this.draft !== undefined && this.draft.id === undefined) {
			this.renderForm(list, store);
		} else if (this.draft === undefined) {
			const foot = DOM.append(body, $('.paradis-bot-settings-foot'));
			DOM.append(foot, $('span.paradis-bot-settings-help')).textContent = localize('paradis.botTasks.help', "会話を開いている間は走らせません。時刻を過ぎた回（スリープ中など）は後から走らせません。");
			const add = store.add(new ParadisButton(foot, { kind: 'secondary', label: localize('paradis.botTasks.add', "定期実行を足す") }));
			add.enabled = !this.busy;
			store.add(add.onDidClick(() => {
				this.draft = { name: '', fields: { ...paradisBotPatrolFieldsFromCron(undefined), scheduleKind: 'daily', time: '09:00' }, prompt: '', tools: 'web', enabled: true };
				this.rerender();
			}));
		}
	}

	private renderRow(list: HTMLElement, view: IParadisBotTaskView, store: DisposableStore, now: number): void {
		const row = DOM.append(list, $('.paradis-bot-task'));
		const head = DOM.append(row, $('.paradis-bot-task-head'));
		const toggleLabel = localize('paradis.botTasks.enabledAria', "{0} を走らせる", view.name);
		const toggle = store.add(new ParadisSwitch(head, { checked: view.enabled, ariaLabel: toggleLabel }));
		store.add(toggle.onDidChange(checked => void this.setEnabled(view, checked)));
		DOM.append(head, $('span.paradis-bot-task-name')).textContent = view.name;
		createParadisChip(head, paradisBotTaskToolsLabel(view.tools), view.tools === 'bot' ? 'warning' : 'neutral');
		if (view.agentReviewPending) {
			createParadisChip(head, localize('paradis.botTasks.byAgent', "エージェントが作成"), 'info');
		}
		const when = paradisBotPatrolCronLabel(view.cron);
		const next = view.nextRunAt !== undefined ? localize('paradis.botTasks.next', "{0} · 次は {1}", when, paradisBotPatrolTime(view.nextRunAt, now)) : when;
		DOM.append(row, $('.paradis-bot-task-when')).textContent = view.activeRunId !== undefined ? localize('paradis.botTasks.running', "{0} · 実行中", when) : next;
		// 頼むことと最後の結果は利用者・エージェントの言葉なので、制御文字を落として文字として出す（HTML として描かない）
		DOM.append(row, $('.paradis-bot-task-prompt')).textContent = paradisSanitizeDisplayText(view.prompt, LAST_MESSAGE_LINE_LIMIT) ?? '';
		if (view.lastRun !== undefined) {
			const last = DOM.append(row, $('.paradis-bot-task-last'));
			const message = paradisSanitizeDisplayText(view.lastRun.lastMessage, LAST_MESSAGE_LINE_LIMIT);
			const status = view.lastRun.status === 'completed'
				? localize('paradis.botTasks.lastDone', "前回 {0}", view.lastRun.finishedAt !== undefined ? paradisBotPatrolTime(view.lastRun.finishedAt, now) : '')
				: localize('paradis.botTasks.lastOther', "前回は終わりませんでした: {0}", view.lastRun.reason !== undefined ? paradisScheduledRunReasonLabel(view.lastRun.reason) : view.lastRun.status);
			last.textContent = message ? localize('paradis.botTasks.lastWithMessage', "{0} · {1}", status, message) : status;
			const title = paradisSanitizeDisplayText(view.lastRun.lastMessage, LAST_MESSAGE_TITLE_LIMIT);
			if (title) {
				last.title = title;
			}
		}
		const actions = DOM.append(row, $('.paradis-bot-page-ask-actions'));
		if (view.activeRunId !== undefined) {
			const stop = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botTasks.stop', "止める") }));
			stop.enabled = !this.busy;
			const runId = view.activeRunId;
			store.add(stop.onDidClick(() => void this.act(() => this.port.stop(runId), error => localize('paradis.botTasks.stopFailed', "定期実行を止められませんでした: {0}", error))));
		} else {
			const run = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botTasks.runNow', "今すぐ実行") }));
			run.enabled = !this.busy && !view.agentReviewPending;
			store.add(run.onDidClick(() => void this.act(() => this.port.runNow(view.id), error => localize('paradis.botTasks.runFailed', "定期実行を始められませんでした: {0}", error))));
		}
		const edit = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botTasks.edit', "変える...") }));
		edit.enabled = !this.busy && this.draft === undefined;
		store.add(edit.onDidClick(() => {
			this.draft = { id: view.id, name: view.name, fields: paradisBotPatrolFieldsFromCron(view.cron), prompt: view.prompt, tools: view.tools, enabled: view.enabled, previousTools: view.tools };
			this.rerender();
		}));
		const remove = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botTasks.remove', "消す") }));
		remove.enabled = !this.busy;
		store.add(remove.onDidClick(() => void this.remove(view)));
	}

	private renderForm(list: HTMLElement, store: DisposableStore): void {
		const draft = this.draft!;
		const form = DOM.append(list, $('.paradis-bot-task.paradis-bot-task-form'));
		const grid = DOM.append(form, $('.paradis-bot-settings.paradis-bot-patrol-settings'));
		const rowPair = (label: string): { readonly key: HTMLElement; readonly value: HTMLElement } => {
			const key = DOM.append(grid, $('span.paradis-bot-settings-key'));
			key.textContent = label;
			return { key, value: DOM.append(grid, $('.paradis-bot-settings-value')) };
		};
		const select = (parent: HTMLElement, options: readonly (readonly [string, string])[], value: string, ariaLabel: string): ParadisSelect =>
			store.add(new ParadisSelect(parent, this.services.contextViewService, this.services.configurationService, options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel })), value, { ariaLabel }));

		const nameLabel = localize('paradis.botTasks.name', "名前");
		const name = store.add(new ParadisInputField(rowPair(nameLabel).value, { ariaLabel: nameLabel, value: draft.name, placeholder: localize('paradis.botTasks.namePlaceholder', "例: 下北沢の天気") }));
		name.inputElement.maxLength = PARADIS_SCHEDULED_RUN_MAX_NAME_LENGTH;
		store.add(name.onDidChange(value => draft.name = value));

		const when = rowPair(localize('paradis.botTasks.when', "いつ"));
		when.key.classList.add('top');
		const whenLine = DOM.append(when.value, $('.paradis-bot-patrol-range'));
		const kind = select(whenLine, [
			['daily', localize('paradis.scheduledRuns.kind.daily', "毎日")],
			['weekdays', localize('paradis.scheduledRuns.kind.weekdays', "平日（月〜金）")],
			['weekly', localize('paradis.scheduledRuns.kind.weekly', "毎週")],
			['hourly', localize('paradis.scheduledRuns.kind.hourly', "数時間ごと")],
			['cron', localize('paradis.scheduledRuns.kind.cron', "cron 式")],
		], draft.fields.scheduleKind === 'window' || draft.fields.scheduleKind === 'minutes' ? 'cron' : draft.fields.scheduleKind, localize('paradis.botTasks.aria.kind', "定期実行の時刻の種類"));
		const setFields = (change: Partial<IParadisBotPatrolScheduleFields>) => {
			draft.fields = { ...draft.fields, ...change };
			update();
		};
		store.add(kind.onDidChange(value => setFields({ scheduleKind: value as IParadisBotPatrolScheduleFields['scheduleKind'] })));
		const dayOfWeek = select(whenLine, [1, 2, 3, 4, 5, 6, 0].map(day => [String(day), paradisDayOfWeekLabel(day)] as const), String(draft.fields.dayOfWeek), localize('paradis.scheduledRuns.aria.dayOfWeek', "曜日"));
		store.add(dayOfWeek.onDidChange(value => setFields({ dayOfWeek: Number(value) })));
		const time = store.add(new ParadisInputField(whenLine, { ariaLabel: localize('paradis.botTasks.aria.time', "時刻"), value: draft.fields.time }));
		time.element.classList.add('paradis-bot-patrol-time');
		time.inputElement.type = 'time';
		store.add(time.onDidChange(value => setFields({ time: value })));
		const everyHours = select(whenLine, [1, 2, 3, 4, 6, 8, 12].map(hours => [String(hours), localize('paradis.botPatrol.everyHours', "{0} 時間ごと", hours)] as const), String(draft.fields.everyHours), localize('paradis.botPatrol.every', "間隔"));
		store.add(everyHours.onDidChange(value => setFields({ everyHours: Number(value) })));
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
		const cron = store.add(new ParadisInputField(whenLine, { ariaLabel: localize('paradis.scheduledRuns.kind.cron', "cron 式"), value: draft.fields.cron, placeholder: '30 0 * * *' }));
		cron.element.classList.add('paradis-bot-patrol-cron');
		store.add(cron.onDidChange(value => setFields({ cron: value })));
		const preview = DOM.append(when.value, $('span.paradis-bot-patrol-preview'));
		preview.setAttribute('aria-live', 'polite');
		const update = () => {
			const fields = draft.fields;
			const showTime = fields.scheduleKind === 'daily' || fields.scheduleKind === 'weekdays' || fields.scheduleKind === 'weekly';
			DOM.setVisibility(fields.scheduleKind === 'weekly', dayOfWeek.element);
			DOM.setVisibility(showTime, time.element);
			DOM.setVisibility(fields.scheduleKind === 'hourly', everyHours.element, minuteLabel, minute.element, minuteSuffix);
			DOM.setVisibility(fields.scheduleKind === 'cron', cron.element);
			const result = paradisBotPatrolScheduleCheck(fields, Date.now());
			preview.textContent = result.problem ?? result.summary;
			preview.classList.toggle('paradis-bot-patrol-problem', result.problem !== undefined);
		};
		update();

		const promptLabel = localize('paradis.botTasks.prompt', "頼むこと");
		const prompt = store.add(new ParadisInputField(rowPair(promptLabel).value, { ariaLabel: promptLabel, value: draft.prompt, placeholder: localize('paradis.botTasks.promptPlaceholder', "例: 翌日の下北沢の天気を調べて知らせて") }));
		prompt.inputElement.maxLength = PARADIS_BOT_TASK_MAX_PROMPT_LENGTH;
		store.add(prompt.onDidChange(value => draft.prompt = value));

		const toolsRow = rowPair(localize('paradis.botTasks.tools', "道具"));
		toolsRow.key.classList.add('top');
		const tools = select(toolsRow.value, (['read', 'web', 'bot'] as const).map(tier => [tier, paradisBotTaskToolsLabel(tier)] as const), draft.tools, localize('paradis.botTasks.aria.tools', "道具の段"));
		const toolsHelp = DOM.append(toolsRow.value, $('span.paradis-bot-patrol-preview'));
		toolsHelp.textContent = paradisBotTaskToolsHelp(draft.tools);
		toolsHelp.classList.toggle('paradis-bot-patrol-problem', draft.tools === 'bot');
		store.add(tools.onDidChange(value => {
			draft.tools = value as ParadisBotTaskTools;
			toolsHelp.textContent = paradisBotTaskToolsHelp(draft.tools);
			toolsHelp.classList.toggle('paradis-bot-patrol-problem', draft.tools === 'bot');
		}));

		const resultRow = rowPair(localize('paradis.botTasks.result', "結果"));
		DOM.append(resultRow.value, $('span.paradis-bot-task-result')).textContent = localize('paradis.botTasks.resultValue', "この Bot の会話に書いてベルで知らせる");

		const enabledLabel = localize('paradis.botTasks.enabled', "走らせる");
		const enabled = store.add(new ParadisSwitch(rowPair(enabledLabel).value, { checked: draft.enabled, ariaLabel: enabledLabel }));
		store.add(enabled.onDidChange(checked => draft.enabled = checked));

		const actions = DOM.append(form, $('.paradis-bot-settings-foot'));
		DOM.append(actions, $('span.paradis-bot-settings-help')).textContent = localize('paradis.botTasks.formHelp', "眠っている会話を続けて起こし、頼むことを 1 ターンとして渡します。会話を開いている間の回は見送ります。");
		const cancel = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botTasks.cancel', "やめる") }));
		store.add(cancel.onDidClick(() => {
			this.draft = undefined;
			this.rerender();
		}));
		const save = store.add(new ParadisButton(actions, { kind: 'primary', label: localize('paradis.botTasks.save', "保存") }));
		save.enabled = !this.busy;
		store.add(save.onDidClick(() => void this.save()));
	}

	private async save(): Promise<void> {
		const draft = this.draft;
		if (draft === undefined || this.busy) {
			return;
		}
		const check = paradisBotPatrolScheduleCheck(draft.fields, Date.now());
		if (check.problem !== undefined || check.cron === undefined) {
			this.services.notificationService.warn(check.problem ?? '');
			return;
		}
		if (draft.prompt.trim().length === 0) {
			this.services.notificationService.warn(localize('paradis.scheduledRuns.validate.botTaskPrompt', "Bot に頼むことを入れてください。"));
			return;
		}
		// 「Bot の権限」に変えるときだけ確かめる（shared process の側でも、確かめた印が無ければ断る）
		let confirmedBotTools = false;
		if (draft.tools === 'bot' && draft.previousTools !== 'bot') {
			confirmedBotTools = await this.port.confirmBotTools(draft.name.trim() || draft.prompt.trim().slice(0, 30));
			if (!confirmedBotTools) {
				return;
			}
		}
		const schedule = check.cron;
		await this.act(() => this.port.set(this.botId, {
			...(draft.id !== undefined ? { id: draft.id } : {}),
			name: draft.name, schedule, prompt: draft.prompt, tools: draft.tools, enabled: draft.enabled,
			...(confirmedBotTools ? { confirmedBotTools: true } : {}),
		}), error => localize('paradis.botTasks.saveFailed', "定期実行を保存できませんでした: {0}", error), () => {
			if (this.draft === draft) {
				this.draft = undefined;
			}
		});
	}

	private async setEnabled(view: IParadisBotTaskView, enabled: boolean): Promise<void> {
		// エージェントが作った「Bot の権限」の定期実行は、初めて有効にするときに確かめる
		if (enabled && view.agentReviewPending && view.tools === 'bot' && !await this.port.confirmBotTools(view.name)) {
			this.rerender();
			return;
		}
		await this.act(() => this.port.setEnabled(view.id, enabled), error => localize('paradis.botTasks.toggleFailed', "定期実行を切り替えられませんでした: {0}", error));
	}

	private async remove(view: IParadisBotTaskView): Promise<void> {
		if (!await this.port.confirmRemove(view.name)) {
			return;
		}
		await this.act(() => this.port.remove(this.botId, view.id), error => localize('paradis.botTasks.removeFailed', "定期実行を消せませんでした: {0}", error));
	}

	private async act(work: () => Result, failure: (error: string) => string, succeeded?: () => void): Promise<void> {
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

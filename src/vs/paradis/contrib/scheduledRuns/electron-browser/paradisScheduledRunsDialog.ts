/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 歯車メニュー →「定期実行」で開くモーダル（Q78 案A）。左に定期実行の一覧、右に中身と実行履歴。
// 形は使用量ダイアログ（左ナビ＋本文）に揃えている。
//
// 内蔵ブラウザの裏に隠れないよう、backdrop に共通の印 `paradis-modal-backdrop`（overlayManager.ts に登録済み）を付ける。
// 重ね順はワークベンチのモーダル（2575）より下に置く。削除の確認に IDialogService を使うため
// （dialogStyle が custom のときの確認ダイアログは 2575 に出る）。

import './media/paradisScheduledRuns.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisAgentModelCatalogService } from '../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { IParadisCcusageSessionRow, PARADIS_CCUSAGE_CHANNEL } from '../../ccusage/common/paradisCcusage.js';
import { FETCH_WINDOW_DAYS, PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH, paradisCcusageDateArg } from '../../ccusage/electron-browser/paradisCcusageClient.js';
import { IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService, paradisWorktreeStateKey } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisAgentCommandTemplate } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { PARADIS_REMOVE_WORKTREE_COMMAND_ID } from '../../workspaceSwitch/electron-browser/paradisCreateWorktree.contribution.js';
import {
	paradisCronToSchedulePreset,
	paradisDayOfWeekLabel,
	paradisDescribeCron,
	paradisNextCronOccurrence,
	paradisParseCron,
	ParadisSchedulePreset,
	paradisSchedulePresetToCron,
} from '../common/paradisScheduleCron.js';
import {
	IParadisScheduledRunDefinition,
	IParadisScheduledRunDraft,
	IParadisScheduledRunRecord,
	IParadisScheduledRunsState,
	ParadisScheduledRunTargetKind,
	paradisCleanupCandidateSpaces,
	paradisIsActiveRunStatus,
	PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT,
	PARADIS_SCHEDULED_RUN_KEEP_SPACES,
	PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT,
	PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES,
	paradisScheduledRunReasonLabel,
	paradisScheduledRunStatusLabel,
	paradisValidateScheduledRunDraft,
} from '../common/paradisScheduledRuns.js';
import { IParadisScheduledRunsClient } from './paradisScheduledRunsClient.js';

const $ = dom.$;

/** 履歴に出す件数。 */
const HISTORY_ROWS = 30;

type ScheduleKind = ParadisSchedulePreset['kind'];

/** 編集中のフォームの値。 */
interface IFormValues {
	id?: string;
	name: string;
	scheduleKind: ScheduleKind;
	time: string;
	dayOfWeek: number;
	everyHours: number;
	minute: number;
	cron: string;
	targetKind: ParadisScheduledRunTargetKind;
	repositoryUri: string;
	repositoryName: string;
	baseRef: string;
	agentId: string;
	modelId: string;
	effortId: string;
	permissionId: string;
	prompt: string;
	dailyLimit: number;
}

interface IRunUsage {
	readonly tokens?: number;
	readonly cost?: number;
}

function formatClock(date: Date): string {
	return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 近い日付は「今日」「明日」「昨日」で書く。 */
export function paradisFormatScheduledTime(time: number, now: number = Date.now()): string {
	const date = new Date(time);
	const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
	const dayDiff = Math.round((startOfDay(date) - startOfDay(new Date(now))) / 86_400_000);
	const clock = formatClock(date);
	switch (dayDiff) {
		case 0: return localize('paradis.scheduledRuns.time.today', "今日 {0}", clock);
		case 1: return localize('paradis.scheduledRuns.time.tomorrow', "明日 {0}", clock);
		case -1: return localize('paradis.scheduledRuns.time.yesterday', "昨日 {0}", clock);
		default: return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
	}
}

function statusTone(run: IParadisScheduledRunRecord): 'ok' | 'warn' | 'error' | 'busy' | 'muted' {
	switch (run.status) {
		case 'completed': return 'ok';
		case 'needsAttention':
		case 'timedOut': return 'warn';
		case 'failed':
		case 'lost': return 'error';
		case 'pending':
		case 'starting':
		case 'running': return 'busy';
		default: return 'muted';
	}
}

function formValuesFromDefinition(definition: IParadisScheduledRunDefinition): IFormValues {
	const preset = paradisCronToSchedulePreset(definition.schedule);
	const values = emptyFormValues();
	values.id = definition.id;
	values.name = definition.name;
	values.scheduleKind = preset.kind;
	values.cron = definition.schedule;
	if (preset.kind === 'daily' || preset.kind === 'weekdays' || preset.kind === 'weekly') {
		values.time = `${String(preset.hour).padStart(2, '0')}:${String(preset.minute).padStart(2, '0')}`;
	}
	if (preset.kind === 'weekly') {
		values.dayOfWeek = preset.dayOfWeek;
	}
	if (preset.kind === 'hourly') {
		values.everyHours = preset.everyHours;
		values.minute = preset.minute;
	}
	values.targetKind = definition.target.kind;
	values.repositoryUri = definition.target.repositoryUri;
	values.repositoryName = definition.target.repositoryName;
	values.baseRef = definition.target.baseRef ?? '';
	values.agentId = definition.agentId;
	values.modelId = definition.modelId ?? '';
	values.effortId = definition.effortId ?? '';
	values.permissionId = definition.permissionId ?? '';
	values.prompt = definition.prompt;
	values.dailyLimit = definition.dailyLimit;
	return values;
}

function emptyFormValues(): IFormValues {
	return {
		name: '', scheduleKind: 'weekdays', time: '09:00', dayOfWeek: 1, everyHours: 3, minute: 0, cron: '0 9 * * 1-5',
		targetKind: 'repository', repositoryUri: '', repositoryName: '', baseRef: '',
		agentId: '', modelId: '', effortId: '', permissionId: '', prompt: '',
		dailyLimit: PARADIS_SCHEDULED_RUN_DEFAULT_DAILY_LIMIT,
	};
}

/** フォームの時刻の欄から cron 式を作る。 */
export function paradisFormScheduleToCron(values: Pick<IFormValues, 'scheduleKind' | 'time' | 'dayOfWeek' | 'everyHours' | 'minute' | 'cron'>): string {
	const match = /^(?<hour>\d{1,2}):(?<minute>\d{2})$/.exec(values.time.trim());
	const hour = Math.min(23, Number(match?.groups?.hour ?? 9));
	const minute = Math.min(59, Number(match?.groups?.minute ?? 0));
	switch (values.scheduleKind) {
		case 'daily': return paradisSchedulePresetToCron({ kind: 'daily', hour, minute });
		case 'weekdays': return paradisSchedulePresetToCron({ kind: 'weekdays', hour, minute });
		case 'weekly': return paradisSchedulePresetToCron({ kind: 'weekly', dayOfWeek: values.dayOfWeek, hour, minute });
		case 'hourly': return paradisSchedulePresetToCron({ kind: 'hourly', everyHours: values.everyHours, minute: Math.min(59, Math.max(0, values.minute)) });
		case 'cron': return paradisSchedulePresetToCron({ kind: 'cron', expression: values.cron });
	}
}

function draftFromForm(values: IFormValues): IParadisScheduledRunDraft {
	return {
		...(values.id ? { id: values.id } : {}),
		name: values.name,
		schedule: paradisFormScheduleToCron(values),
		target: {
			kind: values.targetKind,
			repositoryUri: values.repositoryUri,
			repositoryName: values.repositoryName,
			...(values.targetKind === 'newSpace' && values.baseRef.trim() ? { baseRef: values.baseRef.trim() } : {}),
		},
		agentId: values.agentId,
		...(values.modelId ? { modelId: values.modelId } : {}),
		...(values.effortId ? { effortId: values.effortId } : {}),
		...(values.permissionId ? { permissionId: values.permissionId } : {}),
		prompt: values.prompt,
		dailyLimit: values.dailyLimit,
	};
}

export class ParadisScheduledRunsDialog extends Disposable {

	private readonly backdrop: HTMLElement;
	private readonly modal: HTMLElement;
	private readonly navList: HTMLElement;
	private readonly content: HTMLElement;
	private readonly message: HTMLElement;
	private readonly contentDisposables = this._register(new DisposableStore());
	private readonly navDisposables = this._register(new DisposableStore());

	private state: IParadisScheduledRunsState | undefined;
	private selectedId: string | undefined;
	/** 編集中（新規は id なし）。編集中は記録が変わっても本文を作り直さない。 */
	private editing: IFormValues | undefined;
	private usage: Map<string, IRunUsage> | undefined;
	private usageRequested = false;

	constructor(
		@ILayoutService layoutService: ILayoutService,
		@IParadisScheduledRunsClient private readonly client: IParadisScheduledRunsClient,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly worktreeService: IParadisWorktreeService,
		@IParadisAgentModelCatalogService private readonly modelCatalogService: IParadisAgentModelCatalogService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.backdrop = $('.paradis-scheduled-runs-backdrop.paradis-modal-backdrop');
		this.modal = dom.append(this.backdrop, $('.paradis-scheduled-runs'));
		this.modal.setAttribute('role', 'dialog');
		this.modal.setAttribute('aria-modal', 'true');

		const header = dom.append(this.modal, $('.psr-header'));
		const title = dom.append(header, $('h2'));
		title.id = 'paradis-scheduled-runs-title';
		title.textContent = localize('paradis.scheduledRuns.title', "定期実行");
		this.modal.setAttribute('aria-labelledby', title.id);
		dom.append(header, $('.psr-spacer'));
		const createButton = this.button(header, localize('paradis.scheduledRuns.create', "新規作成"), 'primary', Codicon.add);
		this._register(dom.addDisposableListener(createButton, 'click', () => this.startEdit(undefined)));
		const close = dom.append(header, $('button.psr-close')) as HTMLButtonElement;
		close.type = 'button';
		close.setAttribute('aria-label', localize('paradis.scheduledRuns.close', "閉じる"));
		close.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._register(dom.addDisposableListener(close, 'click', () => this.dispose()));

		const body = dom.append(this.modal, $('.psr-body'));
		const nav = dom.append(body, $('nav.psr-nav'));
		dom.append(nav, $('.psr-nav-caption')).textContent = localize('paradis.scheduledRuns.navCaption', "定期実行");
		this.navList = dom.append(nav, $('.psr-nav-list'));
		const main = dom.append(body, $('.psr-main'));
		this.message = dom.append(main, $('.psr-message'));
		this.message.setAttribute('role', 'status');
		this.content = dom.append(main, $('.psr-content'));

		this.modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this.backdrop, 'mousedown', e => {
			if (e.target === this.backdrop) {
				this.dispose();
			}
		}));
		this._register(dom.addDisposableListener(this.backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				event.stopPropagation();
				if (this.editing) {
					this.cancelEdit();
				} else {
					this.dispose();
				}
			}
		}));

		this._register(this.client.onDidChange(() => this.reload()));
		this._register(this.modelCatalogService.onDidChange(() => {
			if (this.editing) {
				this.renderContent();
			}
		}));
		this.modelCatalogService.refresh();
		layoutService.activeContainer.appendChild(this.backdrop);
		this.modal.focus();
		this.reload();
	}

	override dispose(): void {
		this.backdrop.remove();
		super.dispose();
	}

	// ---------- 読み込み ----------

	private async reload(): Promise<void> {
		try {
			const state = await this.client.getState();
			if (this._store.isDisposed) {
				return;
			}
			this.state = state;
		} catch (error) {
			this.logService.warn('[ParadisScheduledRuns] could not read the state', error);
			this.showMessage(localize('paradis.scheduledRuns.loadFailed', "定期実行の一覧を読めませんでした。"), 'error');
			return;
		}
		if (this.selectedId === undefined || !this.state.definitions.some(definition => definition.id === this.selectedId)) {
			this.selectedId = this.state.definitions[0]?.id;
		}
		this.renderNav();
		if (!this.editing) {
			this.renderContent();
		}
	}

	private definition(id: string | undefined): IParadisScheduledRunDefinition | undefined {
		return id === undefined ? undefined : this.state?.definitions.find(definition => definition.id === id);
	}

	private runsOf(id: string): IParadisScheduledRunRecord[] {
		return (this.state?.runs ?? []).filter(run => run.definitionId === id).sort((a, b) => b.createdAt - a.createdAt);
	}

	// ---------- 左の一覧 ----------

	private renderNav(): void {
		this.navDisposables.clear();
		dom.clearNode(this.navList);
		const definitions = this.state?.definitions ?? [];
		if (definitions.length === 0) {
			dom.append(this.navList, $('.psr-nav-empty')).textContent = localize('paradis.scheduledRuns.navEmpty', "まだありません。「新規作成」から作ります。");
			return;
		}
		for (const definition of definitions) {
			const item = dom.append(this.navList, $('button.psr-nav-item')) as HTMLButtonElement;
			item.type = 'button';
			item.classList.toggle('active', this.editing ? this.editing.id === definition.id : definition.id === this.selectedId);
			const latest = this.runsOf(definition.id)[0];
			const dot = dom.append(item, $('span.psr-dot'));
			dot.classList.add(definition.enabled ? (latest ? `tone-${statusTone(latest)}` : 'tone-idle') : 'tone-off');
			const main = dom.append(item, $('span.psr-nav-main'));
			dom.append(main, $('span.psr-nav-name')).textContent = definition.name;
			const sub = dom.append(main, $('span.psr-nav-sub'));
			const next = this.state?.nextRuns[definition.id];
			sub.textContent = !definition.enabled
				? localize('paradis.scheduledRuns.navDisabled', "無効")
				: next !== undefined
					? localize('paradis.scheduledRuns.navNext', "次回 {0}", paradisFormatScheduledTime(next))
					: paradisDescribeCron(definition.schedule);
			this.navDisposables.add(dom.addDisposableListener(item, 'click', () => {
				if (this.editing) {
					this.editing = undefined;
				}
				this.selectedId = definition.id;
				this.clearMessage();
				this.renderNav();
				this.renderContent();
			}));
		}
	}

	// ---------- 右の本文 ----------

	private renderContent(): void {
		this.contentDisposables.clear();
		dom.clearNode(this.content);
		if (this.editing) {
			this.renderForm(this.editing);
			return;
		}
		const definition = this.definition(this.selectedId);
		if (!definition) {
			this.renderEmpty();
			return;
		}
		this.renderDetail(definition);
	}

	private renderEmpty(): void {
		const empty = dom.append(this.content, $('.psr-empty'));
		dom.append(empty, $('.psr-empty-title')).textContent = localize('paradis.scheduledRuns.emptyTitle', "決まった時刻にエージェントを動かせます");
		dom.append(empty, $('p')).textContent = localize('paradis.scheduledRuns.emptyBody', "作った定期実行は無効の状態で始まります。中身を確かめてから有効にしてください。同じものは同時に 1 つだけ動き、1 回 30 分で打ち切ります。PC がスリープ中やアプリを終了している間は実行できません。");
		const button = this.button(empty, localize('paradis.scheduledRuns.create', "新規作成"), 'primary', Codicon.add);
		this.contentDisposables.add(dom.addDisposableListener(button, 'click', () => this.startEdit(undefined)));
	}

	private renderDetail(definition: IParadisScheduledRunDefinition): void {
		const head = dom.append(this.content, $('.psr-detail-head'));
		dom.append(head, $('h3')).textContent = definition.name;
		const toggleLabel = dom.append(head, $('label.psr-toggle-label'));
		const toggle = dom.append(toggleLabel, $('input.psr-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = definition.enabled;
		dom.append(toggleLabel, $('span')).textContent = definition.enabled ? localize('paradis.scheduledRuns.enabled', "有効") : localize('paradis.scheduledRuns.disabled', "無効");
		this.contentDisposables.add(dom.addDisposableListener(toggle, 'change', async () => {
			toggle.disabled = true;
			const result = await this.client.setEnabled(definition.id, toggle.checked);
			if (!result.ok) {
				this.showMessage(result.error ?? '', 'error');
			} else {
				this.clearMessage();
			}
		}));
		dom.append(head, $('.psr-spacer'));
		const runNow = this.button(head, localize('paradis.scheduledRuns.runNow', "今すぐ実行"), 'secondary', Codicon.play);
		this.contentDisposables.add(dom.addDisposableListener(runNow, 'click', () => this.runNow(definition)));
		const edit = this.button(head, localize('paradis.scheduledRuns.edit', "編集"), 'secondary', Codicon.edit);
		this.contentDisposables.add(dom.addDisposableListener(edit, 'click', () => this.startEdit(definition)));
		const remove = this.button(head, localize('paradis.scheduledRuns.delete', "削除"), 'secondary', Codicon.trash);
		this.contentDisposables.add(dom.addDisposableListener(remove, 'click', () => this.deleteDefinition(definition)));

		const summary = dom.append(this.content, $('.psr-summary'));
		const next = this.state?.nextRuns[definition.id];
		this.summaryRow(summary, localize('paradis.scheduledRuns.field.schedule', "スケジュール"), (value => {
			dom.append(value, $('span')).textContent = paradisDescribeCron(definition.schedule);
			dom.append(value, $('code.psr-cron')).textContent = definition.schedule;
			if (definition.enabled && next !== undefined) {
				dom.append(value, $('span.psr-muted')).textContent = localize('paradis.scheduledRuns.nextAt', "次回 {0}", paradisFormatScheduledTime(next));
			}
		}));
		this.summaryRow(summary, localize('paradis.scheduledRuns.field.target', "実行先"), value => {
			value.textContent = definition.target.kind === 'newSpace'
				? localize('paradis.scheduledRuns.target.newSpaceIn', "毎回新しいスペースを作成（{0}）", definition.target.repositoryName)
				: localize('paradis.scheduledRuns.target.repositoryIn', "リポジトリ本体（{0}）", definition.target.repositoryName);
			if (!this.switchService.repositories.some(repository => repository.uri.toString() === definition.target.repositoryUri)) {
				dom.append(value, $('span.psr-warn')).textContent = localize('paradis.scheduledRuns.repositoryElsewhere', "このウィンドウでは開いていません。開いているウィンドウで実行されます。");
			}
		});
		this.summaryRow(summary, localize('paradis.scheduledRuns.field.agent', "エージェント"), value => {
			const agent = this.agents().find(candidate => candidate.id === definition.agentId);
			const parts = [agent?.label ?? definition.agentId];
			const model = agent?.models?.find(option => option.id === definition.modelId);
			if (definition.modelId) {
				parts.push(model?.label ?? definition.modelId);
			}
			if (definition.effortId) {
				parts.push(definition.effortId);
			}
			const permission = agent?.permissions?.find(option => option.id === definition.permissionId);
			if (definition.permissionId) {
				parts.push(permission?.label ?? definition.permissionId);
			}
			value.textContent = parts.join(' / ');
			if (permission?.danger) {
				value.classList.add('psr-danger-text');
			}
		});
		this.summaryRow(summary, localize('paradis.scheduledRuns.field.prompt', "指示"), value => {
			dom.append(value, $('pre.psr-prompt')).textContent = definition.prompt;
		});
		this.summaryRow(summary, localize('paradis.scheduledRuns.field.guards', "安全装置"), value => {
			value.textContent = localize('paradis.scheduledRuns.guards', "同時実行 1 / 1 日 {0} 回まで / 最短 {1} 分間隔 / 1 回 30 分で停止", definition.dailyLimit, PARADIS_SCHEDULED_RUN_MIN_INTERVAL_MINUTES);
		});

		const runs = this.runsOf(definition.id);
		this.renderHistory(runs);
		if (definition.target.kind === 'newSpace' || runs.some(run => run.space)) {
			this.renderCleanup(definition);
		}
	}

	private renderHistory(runs: readonly IParadisScheduledRunRecord[]): void {
		const section = dom.append(this.content, $('.psr-section'));
		dom.append(section, $('h4')).textContent = localize('paradis.scheduledRuns.history', "実行履歴");
		if (runs.length === 0) {
			dom.append(section, $('.psr-muted')).textContent = localize('paradis.scheduledRuns.historyEmpty', "まだ実行していません。");
			return;
		}
		this.requestUsage(runs);
		const table = dom.append(section, $('table.psr-table'));
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const label of [
			localize('paradis.scheduledRuns.col.start', "開始"),
			localize('paradis.scheduledRuns.col.status', "状態"),
			localize('paradis.scheduledRuns.col.output', "最後の出力"),
			localize('paradis.scheduledRuns.col.tokens', "トークン"),
			localize('paradis.scheduledRuns.col.cost', "推定コスト"),
			'',
		]) {
			dom.append(headRow, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));
		for (const run of runs.slice(0, HISTORY_ROWS)) {
			const row = dom.append(tbody, $('tr'));
			const time = run.startedAt ?? run.scheduledFor ?? run.createdAt;
			const startCell = dom.append(row, $('td.psr-nowrap'));
			startCell.textContent = paradisFormatScheduledTime(time);
			if (run.trigger === 'manual') {
				dom.append(startCell, $('span.psr-chip')).textContent = localize('paradis.scheduledRuns.trigger.manual', "手動");
			} else if (run.trigger === 'catchUp' && run.status !== 'skipped') {
				dom.append(startCell, $('span.psr-chip')).textContent = localize('paradis.scheduledRuns.trigger.catchUp', "後から");
			}
			const statusCell = dom.append(row, $('td.psr-nowrap'));
			dom.append(statusCell, $(`span.psr-dot.tone-${statusTone(run)}`));
			dom.append(statusCell, $('span')).textContent = paradisScheduledRunStatusLabel(run.status);
			const outputCell = dom.append(row, $('td.psr-output'));
			const output = run.lastMessage
				?? run.detail
				?? (run.reason ? paradisScheduledRunReasonLabel(run.reason, run) : undefined)
				?? '';
			outputCell.textContent = output;
			outputCell.title = output;
			if (run.coalesced) {
				dom.append(outputCell, $('span.psr-muted')).textContent = localize('paradis.scheduledRuns.coalesced', "（逃した {0} 回分をまとめて実行）", run.coalesced);
			}
			const usage = run.sessionId ? this.usage?.get(run.sessionId) : undefined;
			dom.append(row, $('td.psr-num')).textContent = usage?.tokens !== undefined ? usage.tokens.toLocaleString() : '—';
			dom.append(row, $('td.psr-num')).textContent = usage?.cost !== undefined ? `$${usage.cost.toFixed(2)}` : '—';
			const actions = dom.append(row, $('td.psr-actions'));
			if (paradisIsActiveRunStatus(run.status)) {
				const stop = this.button(actions, localize('paradis.scheduledRuns.stop', "停止"), 'secondary', Codicon.debugStop);
				this.contentDisposables.add(dom.addDisposableListener(stop, 'click', async () => {
					stop.disabled = true;
					const result = await this.client.stop(run.id);
					if (!result.ok) {
						this.showMessage(result.error ?? '', 'error');
					}
				}));
			}
			if (run.space && this.findWorktree(run.space.stateKey)) {
				const open = this.button(actions, localize('paradis.scheduledRuns.openSpace', "スペースを開く"), 'secondary', Codicon.goToFile);
				this.contentDisposables.add(dom.addDisposableListener(open, 'click', () => this.openSpace(run)));
			}
		}
		if (runs.length > HISTORY_ROWS) {
			dom.append(section, $('.psr-muted')).textContent = localize('paradis.scheduledRuns.historyMore', "ほか {0} 件（古い順に 100 件まで残します）", runs.length - HISTORY_ROWS);
		}
		dom.append(section, $('.psr-note')).textContent = localize('paradis.scheduledRuns.usageNote', "トークンと推定コストは Claude Code の会話だけを ccusage から引いています。Codex の回は表示しません。");
	}

	private renderCleanup(definition: IParadisScheduledRunDefinition): void {
		const section = dom.append(this.content, $('.psr-section'));
		dom.append(section, $('h4')).textContent = localize('paradis.scheduledRuns.cleanup', "片付け候補のスペース");
		dom.append(section, $('.psr-muted')).textContent = localize('paradis.scheduledRuns.cleanupDesc', "この定期実行が作ったスペースのうち、新しい {0} 件より古いものです。自動では消しません。", PARADIS_SCHEDULED_RUN_KEEP_SPACES);
		const alive = paradisCleanupCandidateSpaces(definition.id, this.state?.runs ?? [], space => this.findWorktree(space.stateKey) !== undefined);
		if (alive.length === 0) {
			dom.append(section, $('.psr-muted')).textContent = localize('paradis.scheduledRuns.cleanupEmpty', "今はありません。");
			return;
		}
		const list = dom.append(section, $('.psr-cleanup-list'));
		for (const run of alive) {
			const space = run.space!;
			const row = dom.append(list, $('.psr-cleanup-row'));
			const main = dom.append(row, $('.psr-cleanup-main'));
			dom.append(main, $('.psr-cleanup-name')).textContent = space.name;
			dom.append(main, $('.psr-muted')).textContent = `${space.branch} · ${paradisFormatScheduledTime(run.createdAt)}`;
			const open = this.button(row, localize('paradis.scheduledRuns.openSpace', "スペースを開く"), 'secondary');
			this.contentDisposables.add(dom.addDisposableListener(open, 'click', () => this.openSpace(run)));
			const remove = this.button(row, localize('paradis.scheduledRuns.removeSpace', "削除…"), 'secondary');
			this.contentDisposables.add(dom.addDisposableListener(remove, 'click', () => this.removeSpace(run)));
			const forget = this.button(row, localize('paradis.scheduledRuns.forgetSpace', "一覧から外す"), 'secondary');
			this.contentDisposables.add(dom.addDisposableListener(forget, 'click', () => this.client.forgetSpace(run.id)));
		}
	}

	private summaryRow(container: HTMLElement, label: string, fill: (value: HTMLElement) => void): void {
		const row = dom.append(container, $('.psr-summary-row'));
		dom.append(row, $('.psr-summary-label')).textContent = label;
		fill(dom.append(row, $('.psr-summary-value')));
	}

	// ---------- 操作 ----------

	private async runNow(definition: IParadisScheduledRunDefinition): Promise<void> {
		const result = await this.client.runNow(definition.id);
		if (!result.ok) {
			this.showMessage(result.error ?? '', 'error');
			return;
		}
		const here = this.switchService.repositories.some(repository => repository.uri.toString() === definition.target.repositoryUri);
		this.showMessage(here
			? localize('paradis.scheduledRuns.runNowStarted', "実行を始めました。30 分で打ち切ります。")
			: localize('paradis.scheduledRuns.runNowElsewhere', "開始待ちにしました。リポジトリ「{0}」を開いているウィンドウで実行されます。", definition.target.repositoryName), 'info');
	}

	private async deleteDefinition(definition: IParadisScheduledRunDefinition): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			type: 'warning',
			message: localize('paradis.scheduledRuns.deleteConfirm', "定期実行「{0}」を削除しますか？", definition.name),
			detail: localize('paradis.scheduledRuns.deleteDetail', "実行履歴も消えます。作成したスペースはそのまま残ります。動いている回は止めます。"),
			primaryButton: localize('paradis.scheduledRuns.deleteButton', "削除"),
		});
		if (!confirmed || this._store.isDisposed) {
			return;
		}
		const result = await this.client.delete(definition.id);
		if (!result.ok) {
			this.showMessage(result.error ?? '', 'error');
		}
	}

	private findWorktree(stateKey: string): IParadisWorktree | undefined {
		for (const repository of this.switchService.repositories) {
			const found = this.worktreeService.getDetectedWorktrees(repository.id).find(worktree => paradisWorktreeStateKey(worktree.uri) === stateKey && !worktree.missing);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	private async openSpace(run: IParadisScheduledRunRecord): Promise<void> {
		const worktree = run.space && this.findWorktree(run.space.stateKey);
		if (!worktree) {
			return;
		}
		this.dispose();
		await this.switchService.switchToWorktree(worktree);
	}

	private async removeSpace(run: IParadisScheduledRunRecord): Promise<void> {
		const worktree = run.space && this.findWorktree(run.space.stateKey);
		if (!worktree) {
			return;
		}
		// 削除の確認・後始末（teardown スクリプト、開いていれば親へ戻る）は既存の削除コマンドに任せる
		await this.commandService.executeCommand(PARADIS_REMOVE_WORKTREE_COMMAND_ID, worktree);
		if (!this._store.isDisposed && run.space && !this.findWorktree(run.space.stateKey)) {
			await this.client.forgetSpace(run.id);
		}
	}

	// ---------- トークンと金額 ----------

	/** Claude Code の会話だけ、ccusage のセッション一覧から引く（ダイアログを開いている間に1回）。 */
	private requestUsage(runs: readonly IParadisScheduledRunRecord[]): void {
		if (this.usageRequested || !runs.some(run => run.sessionId && run.agent !== 'codex')) {
			return;
		}
		this.usageRequested = true;
		const executablePath = this.configurationService.getValue<string>(PARADIS_CCUSAGE_SETTING_EXECUTABLE_PATH);
		const since = new Date();
		since.setDate(since.getDate() - (FETCH_WINDOW_DAYS - 1));
		const options = {
			...(typeof executablePath === 'string' && executablePath.trim() ? { executablePath: executablePath.trim() } : {}),
			since: paradisCcusageDateArg(since),
		};
		this.sharedProcessService.getChannel(PARADIS_CCUSAGE_CHANNEL).call<IParadisCcusageSessionRow[]>('fetchRecentSessions', [options]).then(rows => {
			if (this._store.isDisposed) {
				return;
			}
			const usage = new Map<string, IRunUsage>();
			for (const row of rows) {
				if (row.sessionId) {
					usage.set(row.sessionId, { tokens: row.totalTokens, cost: row.totalCost });
				}
			}
			this.usage = usage;
			if (!this.editing) {
				this.renderContent();
			}
		}, error => this.logService.info('[ParadisScheduledRuns] ccusage sessions unavailable', error));
	}

	// ---------- 編集 ----------

	private agents(): readonly IParadisAgentCommandTemplate[] {
		return this.modelCatalogService.getAgentTemplates().filter(agent => agent.id !== 'none');
	}

	private startEdit(definition: IParadisScheduledRunDefinition | undefined): void {
		const values = definition ? formValuesFromDefinition(definition) : emptyFormValues();
		if (!definition) {
			const repository = this.switchService.repositories[0];
			if (repository) {
				values.repositoryUri = repository.uri.toString();
				values.repositoryName = repository.name;
			}
			values.agentId = this.agents()[0]?.id ?? '';
		}
		this.editing = values;
		this.clearMessage();
		this.renderNav();
		this.renderContent();
	}

	private cancelEdit(): void {
		this.editing = undefined;
		this.clearMessage();
		this.renderNav();
		this.renderContent();
	}

	private renderForm(values: IFormValues): void {
		const form = dom.append(this.content, $('form.psr-form'));
		dom.append(form, $('h3')).textContent = values.id
			? localize('paradis.scheduledRuns.editTitle', "定期実行を編集")
			: localize('paradis.scheduledRuns.createTitle', "定期実行を作成");
		if (!values.id) {
			dom.append(form, $('.psr-note')).textContent = localize('paradis.scheduledRuns.createNote', "作成直後は無効です。中身を確かめてから一覧の右上で有効にしてください。");
		}
		const error = dom.append(form, $('.psr-form-error'));
		error.setAttribute('role', 'alert');

		// 名前
		const name = this.input(this.formRow(form, localize('paradis.scheduledRuns.field.name', "名前")), values.name);
		name.maxLength = 80;
		this.contentDisposables.add(dom.addDisposableListener(name, 'input', () => { values.name = name.value; update(); }));

		// スケジュール
		const scheduleCell = this.formRow(form, localize('paradis.scheduledRuns.field.schedule', "スケジュール"));
		const scheduleLine = dom.append(scheduleCell, $('.psr-inline'));
		const kind = this.select(scheduleLine, [
			['daily', localize('paradis.scheduledRuns.kind.daily', "毎日")],
			['weekdays', localize('paradis.scheduledRuns.kind.weekdays', "平日（月〜金）")],
			['weekly', localize('paradis.scheduledRuns.kind.weekly', "毎週")],
			['hourly', localize('paradis.scheduledRuns.kind.hourly', "数時間ごと")],
			['cron', localize('paradis.scheduledRuns.kind.cron', "cron 式")],
		], values.scheduleKind);
		const dayOfWeek = this.select(scheduleLine, [1, 2, 3, 4, 5, 6, 0].map(day => [String(day), paradisDayOfWeekLabel(day)] as [string, string]), String(values.dayOfWeek));
		const time = this.input(scheduleLine, values.time);
		time.type = 'time';
		const everyHours = this.select(scheduleLine, [1, 2, 3, 4, 6, 8, 12].map(hours => [String(hours), hours === 1
			? localize('paradis.scheduledRuns.everyHour', "1 時間ごと")
			: localize('paradis.scheduledRuns.everyHours', "{0} 時間ごと", hours)] as [string, string]), String(values.everyHours));
		const minuteLabel = dom.append(scheduleLine, $('span.psr-muted'));
		minuteLabel.textContent = localize('paradis.scheduledRuns.atMinute', "の");
		const minute = this.input(scheduleLine, String(values.minute));
		minute.type = 'number';
		minute.min = '0';
		minute.max = '59';
		minute.classList.add('psr-narrow');
		const minuteSuffix = dom.append(scheduleLine, $('span.psr-muted'));
		minuteSuffix.textContent = localize('paradis.scheduledRuns.minuteSuffix', "分");
		const cron = this.input(scheduleLine, values.cron);
		cron.classList.add('psr-mono');
		cron.placeholder = '0 9 * * 1-5';
		const schedulePreview = dom.append(scheduleCell, $('.psr-muted'));

		// 実行先
		const targetCell = this.formRow(form, localize('paradis.scheduledRuns.field.target', "実行先"));
		const targetLine = dom.append(targetCell, $('.psr-inline'));
		const repositories = this.switchService.repositories.map(repository => [repository.uri.toString(), repository.name] as [string, string]);
		if (values.repositoryUri && !repositories.some(([uri]) => uri === values.repositoryUri)) {
			repositories.unshift([values.repositoryUri, localize('paradis.scheduledRuns.repositoryNotHere', "{0}（このウィンドウに無し）", values.repositoryName)]);
		}
		const repository = this.select(targetLine, repositories, values.repositoryUri);
		const targetKind = this.select(targetLine, [
			['repository', localize('paradis.scheduledRuns.target.repository', "リポジトリ本体で実行")],
			['newSpace', localize('paradis.scheduledRuns.target.newSpace', "毎回新しいスペースを作る")],
		], values.targetKind);
		const baseRefLine = dom.append(targetCell, $('.psr-inline'));
		dom.append(baseRefLine, $('span.psr-muted')).textContent = localize('paradis.scheduledRuns.baseRef', "元のブランチ");
		const baseRef = this.input(baseRefLine, values.baseRef);
		baseRef.placeholder = localize('paradis.scheduledRuns.baseRefPlaceholder', "空なら今のブランチ");
		const targetNote = dom.append(targetCell, $('.psr-muted'));

		// エージェント
		const agentCell = this.formRow(form, localize('paradis.scheduledRuns.field.agent', "エージェント"));
		const agentLine = dom.append(agentCell, $('.psr-inline'));
		const agents = this.agents();
		const agent = this.select(agentLine, agents.map(candidate => [candidate.id, candidate.label] as [string, string]), values.agentId);
		const model = this.select(agentLine, [], values.modelId);
		const effort = this.select(agentLine, [], values.effortId);
		const permission = this.select(agentLine, [], values.permissionId);
		const permissionHint = dom.append(agentCell, $('.psr-muted'));

		// 指示
		const prompt = dom.append(this.formRow(form, localize('paradis.scheduledRuns.field.prompt', "指示")), $('textarea.psr-textarea')) as HTMLTextAreaElement;
		prompt.value = values.prompt;
		prompt.rows = 6;
		prompt.placeholder = localize('paradis.scheduledRuns.promptPlaceholder', "例: 依存パッケージの更新を確認して、必要なら PR を作って");
		this.contentDisposables.add(dom.addDisposableListener(prompt, 'input', () => { values.prompt = prompt.value; update(); }));

		// 回数
		const limitCell = this.formRow(form, localize('paradis.scheduledRuns.field.limit', "1 日の回数"));
		const limitLine = dom.append(limitCell, $('.psr-inline'));
		const limit = this.input(limitLine, String(values.dailyLimit));
		limit.type = 'number';
		limit.min = '1';
		limit.max = String(PARADIS_SCHEDULED_RUN_MAX_DAILY_LIMIT);
		limit.classList.add('psr-narrow');
		dom.append(limitLine, $('span.psr-muted')).textContent = localize('paradis.scheduledRuns.limitSuffix', "回まで（手動の実行は止めませんが回数に数えます）");

		const footer = dom.append(form, $('.psr-form-footer'));
		const cancel = this.button(footer, localize('paradis.scheduledRuns.cancel', "キャンセル"), 'secondary');
		const save = this.button(footer, values.id ? localize('paradis.scheduledRuns.save', "保存") : localize('paradis.scheduledRuns.createButton', "作成"), 'primary');
		save.type = 'submit';

		const fillAgentOptions = () => {
			const template = agents.find(candidate => candidate.id === values.agentId);
			this.fillSelect(model, [['', localize('paradis.scheduledRuns.defaultModel', "既定のモデル")], ...(template?.models ?? []).map(option => [option.id, option.label ?? option.id] as [string, string])], values.modelId);
			model.style.display = template?.models?.length ? '' : 'none';
			const modelOption = template?.models?.find(option => option.id === values.modelId);
			const effortIds = (modelOption?.efforts ?? template?.efforts?.map(option => option.id) ?? []);
			this.fillSelect(effort, [['', localize('paradis.scheduledRuns.defaultEffort', "既定のエフォート")], ...effortIds.map(id => [id, id] as [string, string])], values.effortId);
			effort.style.display = effortIds.length ? '' : 'none';
			this.fillSelect(permission, (template?.permissions ?? []).map(option => [option.id, option.label] as [string, string]), values.permissionId || template?.permissions?.[0]?.id || '');
			permission.style.display = template?.permissions?.length ? '' : 'none';
			values.modelId = model.value;
			values.effortId = effort.value;
			values.permissionId = permission.value === template?.permissions?.[0]?.id ? '' : permission.value;
		};

		const update = () => {
			const showTime = values.scheduleKind === 'daily' || values.scheduleKind === 'weekdays' || values.scheduleKind === 'weekly';
			time.style.display = showTime ? '' : 'none';
			dayOfWeek.style.display = values.scheduleKind === 'weekly' ? '' : 'none';
			for (const element of [everyHours, minuteLabel, minute, minuteSuffix]) {
				element.style.display = values.scheduleKind === 'hourly' ? '' : 'none';
			}
			cron.style.display = values.scheduleKind === 'cron' ? '' : 'none';
			baseRefLine.style.display = values.targetKind === 'newSpace' ? '' : 'none';
			targetNote.textContent = values.targetKind === 'newSpace'
				? localize('paradis.scheduledRuns.newSpaceNote', "実行のたびにスペース（worktree）を作ります。新しい {0} 件より古いものは片付け候補として一覧に出します（自動では消しません）。", PARADIS_SCHEDULED_RUN_KEEP_SPACES)
				: localize('paradis.scheduledRuns.repositoryNote', "リポジトリのメインのチェックアウトで、新しいターミナルを開いて起動します。");
			const template = agents.find(candidate => candidate.id === values.agentId);
			const permissionOption = template?.permissions?.find(option => option.id === (values.permissionId || template.permissions?.[0]?.id));
			permissionHint.textContent = permissionOption?.danger
				? localize('paradis.scheduledRuns.dangerPermission', "この権限では、エージェントが確認なしでコマンドを実行します。誰も見ていない時刻に動くことに注意してください。")
				: localize('paradis.scheduledRuns.permissionNote', "許可待ちで止まったときは「要対応」として通知し、30 分で打ち切ります。");
			permissionHint.classList.toggle('psr-danger-text', !!permissionOption?.danger);

			const draft = draftFromForm(values);
			const problem = paradisValidateScheduledRunDraft(draft);
			const parsed = paradisParseCron(draft.schedule);
			if (parsed.schedule) {
				const next = paradisNextCronOccurrence(parsed.schedule, Date.now());
				schedulePreview.textContent = next !== undefined
					? localize('paradis.scheduledRuns.preview', "{0}（{1}）· 有効にすると次回 {2}", paradisDescribeCron(draft.schedule), draft.schedule, paradisFormatScheduledTime(next))
					: draft.schedule;
			} else {
				schedulePreview.textContent = '';
			}
			error.textContent = problem ?? '';
			save.disabled = problem !== undefined;
		};

		this.contentDisposables.add(dom.addDisposableListener(kind, 'change', () => { values.scheduleKind = kind.value as ScheduleKind; update(); }));
		this.contentDisposables.add(dom.addDisposableListener(dayOfWeek, 'change', () => { values.dayOfWeek = Number(dayOfWeek.value); update(); }));
		this.contentDisposables.add(dom.addDisposableListener(time, 'input', () => { values.time = time.value; update(); }));
		this.contentDisposables.add(dom.addDisposableListener(everyHours, 'change', () => { values.everyHours = Number(everyHours.value); update(); }));
		this.contentDisposables.add(dom.addDisposableListener(minute, 'input', () => { values.minute = Number(minute.value) || 0; update(); }));
		this.contentDisposables.add(dom.addDisposableListener(cron, 'input', () => { values.cron = cron.value; update(); }));
		this.contentDisposables.add(dom.addDisposableListener(repository, 'change', () => {
			values.repositoryUri = repository.value;
			values.repositoryName = this.switchService.repositories.find(candidate => candidate.uri.toString() === repository.value)?.name ?? values.repositoryName;
			update();
		}));
		this.contentDisposables.add(dom.addDisposableListener(targetKind, 'change', () => { values.targetKind = targetKind.value as ParadisScheduledRunTargetKind; update(); }));
		this.contentDisposables.add(dom.addDisposableListener(baseRef, 'input', () => { values.baseRef = baseRef.value; }));
		this.contentDisposables.add(dom.addDisposableListener(agent, 'change', () => {
			values.agentId = agent.value;
			values.modelId = '';
			values.effortId = '';
			values.permissionId = '';
			fillAgentOptions();
			update();
		}));
		this.contentDisposables.add(dom.addDisposableListener(model, 'change', () => { values.modelId = model.value; values.effortId = ''; fillAgentOptions(); update(); }));
		this.contentDisposables.add(dom.addDisposableListener(effort, 'change', () => { values.effortId = effort.value; }));
		this.contentDisposables.add(dom.addDisposableListener(permission, 'change', () => {
			const template = agents.find(candidate => candidate.id === values.agentId);
			values.permissionId = permission.value === template?.permissions?.[0]?.id ? '' : permission.value;
			update();
		}));
		this.contentDisposables.add(dom.addDisposableListener(limit, 'input', () => { values.dailyLimit = Number(limit.value); update(); }));
		this.contentDisposables.add(dom.addDisposableListener(cancel, 'click', e => { e.preventDefault(); this.cancelEdit(); }));
		this.contentDisposables.add(dom.addDisposableListener(form, 'submit', async e => {
			e.preventDefault();
			save.disabled = true;
			const result = await this.client.save(draftFromForm(values));
			if (this._store.isDisposed) {
				return;
			}
			if (!result.ok) {
				error.textContent = result.error ?? '';
				save.disabled = false;
				return;
			}
			this.editing = undefined;
			this.selectedId = result.definition?.id ?? this.selectedId;
			this.showMessage(values.id
				? localize('paradis.scheduledRuns.saved', "保存しました。")
				: localize('paradis.scheduledRuns.created', "作成しました。無効のままです。中身を確かめてから有効にしてください。"), 'info');
			await this.reload();
		}));

		fillAgentOptions();
		update();
		name.focus();
	}

	private formRow(form: HTMLElement, label: string): HTMLElement {
		const row = dom.append(form, $('.psr-form-row'));
		dom.append(row, $('label.psr-form-label')).textContent = label;
		return dom.append(row, $('.psr-form-field'));
	}

	private input(container: HTMLElement, value: string): HTMLInputElement {
		const input = dom.append(container, $('input.psr-input')) as HTMLInputElement;
		input.type = 'text';
		input.value = value;
		return input;
	}

	private select(container: HTMLElement, options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
		const select = dom.append(container, $('select.psr-select')) as HTMLSelectElement;
		this.fillSelect(select, options, value);
		return select;
	}

	private fillSelect(select: HTMLSelectElement, options: readonly (readonly [string, string])[], value: string): void {
		dom.clearNode(select);
		for (const [id, label] of options) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = id;
			option.textContent = label;
		}
		if (options.some(([id]) => id === value)) {
			select.value = value;
		}
	}

	private button(container: HTMLElement, label: string, kind: 'primary' | 'secondary', icon?: ThemeIcon): HTMLButtonElement {
		const button = dom.append(container, $(`button.psr-button.${kind}`)) as HTMLButtonElement;
		button.type = 'button';
		if (icon) {
			button.appendChild($(`span${ThemeIcon.asCSSSelector(icon)}`));
		}
		dom.append(button, $('span')).textContent = label;
		return button;
	}

	private showMessage(text: string, severity: 'info' | 'error'): void {
		this.message.textContent = text;
		this.message.classList.toggle('error', severity === 'error');
		this.message.classList.toggle('visible', text.length > 0);
	}

	private clearMessage(): void {
		this.showMessage('', 'info');
	}
}

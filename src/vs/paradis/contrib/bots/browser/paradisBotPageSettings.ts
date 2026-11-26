/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot のページの「設定」と「ファイル」のタブ（設計の PR 10b、モック bots-paradot-mock.html の pageSettings・pageFiles）。
//
// - 設定: 動かす・ピン留め・顔の色と形はすぐ当てる。名前・エージェント・権限・役割（SOUL.md）は「保存」で当て、
//   エージェント・権限・役割を変えるときは管理の道具 update_bot と同じ規則で確かめる（同じ paradisBotChangeRequest と
//   paradisBotChangeDetail で本文を作る）。
// - ファイル: 専用フォルダの SOUL.md（人格メモ。読むだけ、書き換えは設定のタブから）と MEMORY.md（記憶。書ける）。
//   保存の前に読み直し、開いた後にほかの場所（Bot 自身）が書き換えていたら上書きしない。

import * as DOM from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { paradisApplyBotChange, paradisBotChangeRequest } from '../common/paradisBotManageTools.js';
import { IParadisBotPatch, PARADIS_BOT_FACE_COLORS, PARADIS_BOT_FACE_SHAPES } from '../common/paradisBots.js';
import { IParadisBotSummary, IParadisBotsService } from '../common/paradisBotsApi.js';
import { paradisBotNameProblemMessage, paradisValidateBotName } from '../common/paradisBotsBandModel.js';
import { IParadisBotSettingsDraft, PARADIS_BOT_HOME_FILES, paradisBotHomeFileConflict, paradisBotPermissionOptions, paradisBotSettingsAgents, paradisBotSettingsChange } from '../common/paradisBotSettingsModel.js';
import { paradisBotChangeDetail } from './paradisBotChangeDetail.js';
import { renderParadisBotFace } from './paradisBotFace.js';

const $ = DOM.$;

const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' };

/** 設定・ファイルのタブが使うもの（ページから渡す）。 */
export interface IParadisBotPageSettingsServices {
	readonly botsService: IParadisBotsService;
	readonly paradisDialogService: IParadisDialogService;
	readonly notificationService: INotificationService;
	readonly contextViewService: IContextViewService;
	readonly configurationService: IConfigurationService;
}

/**
 * 1 つの Bot の設定とファイルのタブ。描き直し（台帳の知らせ）をまたいで、入力中の値と読み込んだファイルを持つ。
 */
export class ParadisBotSettingsPanel {

	private draft: IParadisBotSettingsDraft | undefined;
	/** 読み込んだ SOUL.md（役割の元）。読めるまで undefined。 */
	private role: string | undefined;
	private roleLoaded = false;
	private readonly files = new Map<string, string | undefined>();
	private readonly fileEdits = new Map<string, string>();
	private openFile = PARADIS_BOT_HOME_FILES[0].path;
	private saving = false;

	constructor(
		private readonly botId: string,
		private readonly services: IParadisBotPageSettingsServices,
		private readonly rerender: () => void,
	) { }

	// ---- 設定 ---------------------------------------------------------------------------------

	renderSettings(body: HTMLElement, bot: IParadisBotSummary, store: DisposableStore): void {
		if (!this.roleLoaded) {
			this.roleLoaded = true;
			void this.loadRole();
		}
		const draft = this.draft ??= { name: bot.name, agent: bot.agent, permissionId: bot.permissionId, role: this.role };
		const grid = DOM.append(body, $('.paradis-bot-settings'));
		const row = (label: string): HTMLElement => {
			DOM.append(grid, $('span.paradis-bot-settings-key')).textContent = label;
			return DOM.append(grid, $('.paradis-bot-settings-value'));
		};

		// すぐ当てるもの
		const run = store.add(new ParadisSwitch(row(localize('paradis.botPage.settings.run', "動かす")), { checked: !bot.paused, ariaLabel: localize('paradis.botPage.settings.run', "動かす") }));
		store.add(run.onDidChange(checked => void this.quick({ paused: !checked }, !checked)));
		const pin = store.add(new ParadisSwitch(row(localize('paradis.botPage.settings.pin', "ピン留め")), { checked: bot.pinned, ariaLabel: localize('paradis.botPage.settings.pin', "ピン留め") }));
		store.add(pin.onDidChange(checked => void this.quick({ pinned: checked }, false)));

		const colors = DOM.append(row(localize('paradis.botPage.settings.color', "色")), $('.paradis-bot-settings-swatches'));
		colors.setAttribute('role', 'radiogroup');
		colors.setAttribute('aria-label', localize('paradis.botPage.settings.color', "色"));
		for (const color of PARADIS_BOT_FACE_COLORS) {
			const button = DOM.append(colors, $('button.paradis-bot-settings-swatch.paradis-focus-ring')) as HTMLButtonElement;
			button.type = 'button';
			renderParadisBotFace(button, { shape: 'circle', color });
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(bot.faceColor === color));
			button.setAttribute('aria-label', color);
			store.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => void this.quick({ faceColor: color }, false)));
		}
		const shapes = DOM.append(row(localize('paradis.botPage.settings.shape', "形")), $('.paradis-bot-settings-swatches'));
		shapes.setAttribute('role', 'radiogroup');
		shapes.setAttribute('aria-label', localize('paradis.botPage.settings.shape', "形"));
		for (const shape of PARADIS_BOT_FACE_SHAPES) {
			const button = DOM.append(shapes, $('button.paradis-bot-settings-shape.paradis-focus-ring')) as HTMLButtonElement;
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(bot.faceShape === shape));
			button.setAttribute('aria-label', shape);
			renderParadisBotFace(button, { shape, color: bot.faceColor });
			store.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => void this.quick({ faceShape: shape }, false)));
		}

		// 保存で当てるもの
		const nameValue = row(localize('paradis.botPage.settings.name', "名前"));
		const name = store.add(new ParadisInputField(nameValue, { ariaLabel: localize('paradis.botPage.settings.name', "名前"), value: draft.name }));
		const nameError = DOM.append(nameValue, $('.paradis-bot-settings-error'));
		const agents = store.add(new ParadisSegmented<ParadisAgentKind>(row(localize('paradis.botPage.settings.agent', "エージェント")), {
			items: paradisBotSettingsAgents(bot.agent).map(kind => ({ value: kind, label: AGENT_LABELS[kind] ?? kind })),
			value: draft.agent,
			ariaLabel: localize('paradis.botPage.settings.agent', "エージェント"),
		}));
		const permissionValue = row(localize('paradis.botPage.settings.permission', "権限"));
		const options = paradisBotPermissionOptions(draft.agent);
		const permission = store.add(new ParadisSelect(permissionValue, this.services.contextViewService, this.services.configurationService,
			options.map(option => ({ value: option.id, label: option.label })), draft.permissionId ?? 'default', { ariaLabel: localize('paradis.botPage.settings.permission', "権限") }));
		const hint = options.find(option => option.id === (draft.permissionId ?? 'default'))?.hint;
		if (hint) {
			DOM.append(permissionValue, $('.paradis-bot-settings-help')).textContent = hint;
		}
		const roleValue = row(localize('paradis.botPage.settings.role', "役割（SOUL.md）"));
		const roleFrame = DOM.append(roleValue, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-settings-role'));
		const role = DOM.append(roleFrame, $('textarea')) as HTMLTextAreaElement;
		role.rows = 6;
		role.spellcheck = false;
		role.setAttribute('aria-label', localize('paradis.botPage.settings.role', "役割（SOUL.md）"));
		role.value = draft.role ?? '';
		role.disabled = draft.role === undefined;
		role.placeholder = draft.role === undefined ? localize('paradis.botPage.settings.roleLoading', "読み込んでいます…") : '';

		const foot = DOM.append(body, $('.paradis-bot-settings-foot'));
		const note = DOM.append(foot, $('span.paradis-bot-settings-help'));
		note.textContent = localize('paradis.botPage.settings.confirmNote', "エージェント・権限・役割を変えるときは、保存の前に確かめます。");
		const save = store.add(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.botPage.settings.save', "保存") }));

		const update = () => {
			this.draft = { name: name.value, agent: agents.value ?? draft.agent, permissionId: permission.value, role: this.draft?.role === undefined && this.role === undefined ? undefined : role.value };
			const checked = paradisValidateBotName(name.value, this.services.botsService.snapshot.bots, bot.id);
			nameError.textContent = checked.ok ? '' : paradisBotNameProblemMessage(checked.problem);
			save.enabled = checked.ok && !this.saving && paradisBotSettingsChange(bot, this.role, this.draft) !== undefined;
		};
		store.add(name.onDidChange(update));
		store.add(agents.onDidChange(() => {
			update();
			// 権限の選択肢はエージェントごとに違う
			this.rerender();
		}));
		store.add(permission.onDidChange(() => {
			update();
			this.rerender();
		}));
		store.add(DOM.addDisposableListener(role, DOM.EventType.INPUT, update));
		store.add(save.onDidClick(() => void this.save(bot)));
		update();
	}

	private async loadRole(): Promise<void> {
		const result = await this.services.botsService.readHomeFile(this.botId, 'SOUL.md');
		this.role = result.ok ? result.value ?? '' : undefined;
		if (this.draft !== undefined && this.draft.role === undefined && this.role !== undefined) {
			this.draft = { ...this.draft, role: this.role };
		}
		this.rerender();
	}

	/** 動かす・ピン留め・顔。確かめずに当てる（update_bot でも確かめないもの）。 */
	private async quick(patch: IParadisBotPatch, stop: boolean): Promise<void> {
		const result = await this.services.botsService.updateBot(this.botId, patch);
		if (!result.ok) {
			this.services.notificationService.warn(localize('paradis.botPage.settings.failed', "Bot を変えられませんでした: {0}", result.message));
		} else if (stop) {
			await this.services.botsService.requestStop(this.botId);
		}
	}

	private async save(bot: IParadisBotSummary): Promise<void> {
		const draft = this.draft;
		const change = draft !== undefined ? paradisBotSettingsChange(bot, this.role, draft) : undefined;
		if (change === undefined || this.saving) {
			return;
		}
		if (change.needsConfirmation) {
			const request = paradisBotChangeRequest(bot, change);
			// 確かめる本文は管理の道具と同じ。持ち主が自分で変えるので、依頼元（caller）は渡さない
			const detail = paradisBotChangeDetail(request);
			const { confirmed } = await this.services.paradisDialogService.confirm({
				message: localize('paradis.botPage.settings.confirm', "Bot「{0}」の設定を変えますか?", bot.name),
				detail,
				primaryButton: localize('paradis.botPage.settings.confirmAction', "変える"),
				...(request.permission === 'wider' || request.permission === 'unknown' ? { focusCancel: true } : {}),
			});
			if (!confirmed) {
				return;
			}
		}
		this.saving = true;
		this.rerender();
		try {
			// 当て方も管理の道具と同じ（台帳の変更が通ってから SOUL.md を書く）
			const applied = await paradisApplyBotChange(this.services.botsService, { botId: bot.id, patch: change.patch, ...(change.role !== undefined ? { role: change.role } : {}) });
			if (!applied.ok) {
				this.services.notificationService.warn(localize('paradis.botPage.settings.failed', "Bot を変えられませんでした: {0}", applied.message));
				return;
			}
			if (change.role !== undefined) {
				this.role = change.role;
				this.files.set('SOUL.md', change.role);
			}
			this.draft = undefined;
		} finally {
			this.saving = false;
			this.rerender();
		}
	}

	// ---- ファイル -------------------------------------------------------------------------------

	renderFiles(body: HTMLElement, bot: IParadisBotSummary, store: DisposableStore): void {
		DOM.append(body, $('.paradis-bot-page-section')).textContent = localize('paradis.botPage.files.folder', "専用フォルダ ~/.para-code/bots/{0}/", bot.folder);
		const list = DOM.append(body, $('.paradis-bot-page-list'));
		for (const entry of PARADIS_BOT_HOME_FILES) {
			const row = DOM.append(list, $('button.paradis-bot-page-row.paradis-focus-ring-inset')) as HTMLButtonElement;
			row.type = 'button';
			row.classList.toggle('selected', entry.path === this.openFile);
			row.setAttribute('aria-pressed', String(entry.path === this.openFile));
			DOM.append(row, $('span.paradis-bot-page-row-title')).textContent = entry.path === 'SOUL.md'
				? localize('paradis.botPage.files.soul', "SOUL.md（人格メモ）")
				: localize('paradis.botPage.files.memory', "MEMORY.md（記憶）");
			store.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, () => {
				this.openFile = entry.path;
				this.rerender();
			}));
		}
		const entry = PARADIS_BOT_HOME_FILES.find(candidate => candidate.path === this.openFile)!;
		if (!this.files.has(entry.path)) {
			void this.loadFile(entry.path);
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botPage.files.loading', "読み込んでいます…");
			return;
		}
		const text = this.files.get(entry.path);
		if (!entry.editable) {
			DOM.append(body, $('.paradis-bot-page-text.paradis-bot-files-view')).textContent = text ?? '';
			DOM.append(body, $('.paradis-bot-page-hint')).textContent = localize('paradis.botPage.files.soulHint', "人格メモ（役割）は設定のタブで書き換えます。");
			return;
		}
		const frame = DOM.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-files-editor'));
		const editor = DOM.append(frame, $('textarea')) as HTMLTextAreaElement;
		editor.rows = 16;
		editor.spellcheck = false;
		editor.setAttribute('aria-label', entry.path);
		editor.value = this.fileEdits.get(entry.path) ?? text ?? '';
		const foot = DOM.append(body, $('.paradis-bot-settings-foot'));
		const note = DOM.append(foot, $('span.paradis-bot-settings-help'));
		note.textContent = localize('paradis.botPage.files.memoryHint', "Bot も書き足します。保存の前に読み直し、開いた後に書き換わっていたら上書きしません。");
		const save = store.add(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.botPage.files.save', "保存") }));
		save.enabled = this.fileEdits.has(entry.path) && !this.saving;
		store.add(DOM.addDisposableListener(editor, DOM.EventType.INPUT, () => {
			this.fileEdits.set(entry.path, editor.value);
			save.enabled = !this.saving;
		}));
		store.add(save.onDidClick(() => void this.saveFile(entry.path)));
	}

	private async loadFile(path: string): Promise<void> {
		const result = await this.services.botsService.readHomeFile(this.botId, path);
		this.files.set(path, result.ok ? result.value : undefined);
		this.rerender();
	}

	private async saveFile(path: string): Promise<void> {
		const edited = this.fileEdits.get(path);
		if (edited === undefined || this.saving) {
			return;
		}
		this.saving = true;
		try {
			const latest = await this.services.botsService.readHomeFile(this.botId, path);
			if (latest.ok && paradisBotHomeFileConflict(this.files.get(path), latest.value)) {
				this.services.notificationService.warn(localize('paradis.botPage.files.conflict', "{0} は開いた後に書き換わっていたので、保存しませんでした。自分の編集を写してから開き直してください。", path));
				return;
			}
			const written = await this.services.botsService.writeHomeFile(this.botId, path, edited);
			if (!written.ok) {
				this.services.notificationService.warn(localize('paradis.botPage.files.failed', "{0} を書けませんでした: {1}", path, written.message));
				return;
			}
			this.files.set(path, edited);
			this.fileEdits.delete(path);
		} finally {
			this.saving = false;
			this.rerender();
		}
	}
}

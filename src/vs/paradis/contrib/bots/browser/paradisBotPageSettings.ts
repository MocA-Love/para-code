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
import { createParadisChip } from '../../../browser/paradisBadges.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { ParadisSegmented } from '../../../browser/paradisSegmented.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisSwitch } from '../../../browser/paradisSwitch.js';
import type { ParadisAgentKind } from '../../agentChat/common/paradisAgentDescriptor.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';
import { paradisApplyBotChange, paradisBotChangeRequest, PARADIS_BOT_ROLE_LIMIT } from '../common/paradisBotManageTools.js';
import { IParadisBotPatch, PARADIS_BOT_FACE_COLORS, PARADIS_BOT_FACE_SHAPES } from '../common/paradisBots.js';
import { IParadisBotSummary, IParadisBotsService } from '../common/paradisBotsApi.js';
import { paradisBotNameProblemMessage, paradisValidateBotName } from '../common/paradisBotsBandModel.js';
import { IParadisBotMemorySnapshotInfo, IParadisBotSettingsDraft, IParadisBotUndoTidyResult, paradisBotMemorySnapshotCount, paradisBotUndoTidyLines, PARADIS_BOT_HOME_FILES, paradisBotHomeFileConflict, paradisBotHomeFileDiff, paradisBotRoleOverflow, paradisBotPermissionOptions, ParadisBotSettingsBase, paradisBotSettingsAgents, paradisBotSettingsChange, ParadisBotSettingsField, paradisBotSettingsRebase } from '../common/paradisBotSettingsModel.js';
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

/** 作り直したときにフォーカスと選択範囲を戻す入力欄を、ページへ知らせる。 */
export type ParadisBotSettingsFocusTracker = (element: HTMLInputElement | HTMLTextAreaElement, key: string) => void;

/**
 * 1 つの Bot の設定とファイルのタブ。描き直し（台帳の知らせ）をまたいで、入力中の値と読み込んだファイルを持つ。
 * 保存前の書きかけは台帳の値で上書きしない（手を付けていない欄だけ台帳に合わせ、書き換えた欄はほかで変わったと知らせる）。
 */
export class ParadisBotSettingsPanel {

	private draft: IParadisBotSettingsDraft | undefined;
	/** 書きかけを始めたときの台帳の値。 */
	private base: ParadisBotSettingsBase | undefined;
	/** 書きかけの間に、ほかの場所で変わった欄（保存するまで知らせ続ける）。 */
	private readonly changedElsewhere = new Set<ParadisBotSettingsField>();
	/** 読み込んだ SOUL.md（役割の元）。読めるまで undefined。 */
	private role: string | undefined;
	private roleLoaded = false;
	private readonly files = new Map<string, string | undefined>();
	private readonly fileEdits = new Map<string, string>();
	/** 書きかけの間に、開いた後でほかの場所（Bot 自身など）が書き換えたファイルの今の中身（上書きするか読み直すかを選ばせる）。 */
	private readonly fileConflicts = new Map<string, string | undefined>();
	/** 記憶の写しの一覧（新しい順）。読めるまで undefined、読めなければ 'failed'。 */
	private snapshots: readonly IParadisBotMemorySnapshotInfo[] | 'failed' | undefined;
	private snapshotsLoading = false;
	/** 直前の取り消しの結果（写しの一覧の下に出す。書き戻せなかったファイルもここで知らせる）。 */
	private lastUndo: IParadisBotUndoTidyResult | undefined;
	private undoing = false;
	private openFile = PARADIS_BOT_HOME_FILES[0].path;
	private saving = false;

	constructor(
		private readonly botId: string,
		private readonly services: IParadisBotPageSettingsServices,
		private readonly rerender: () => void,
	) { }

	/**
	 * タブに出す台帳の値の印。ページはこれが変わったときだけ描き直す（ほかの Bot の変化では描き直さない）。パネル自身の
	 * 状態が変わったときは、作るときに渡された `rerender` で描き直させる。
	 */
	signature(tab: 'settings' | 'files', bot: IParadisBotSummary): string {
		return JSON.stringify(tab === 'settings'
			? [tab, bot.name, bot.agent, bot.permissionId, bot.paused, bot.pinned, bot.faceColor, bot.faceShape]
			: [tab, bot.folder]);
	}

	// ---- 設定 ---------------------------------------------------------------------------------

	renderSettings(body: HTMLElement, bot: IParadisBotSummary, store: DisposableStore, track: ParadisBotSettingsFocusTracker): void {
		if (!this.roleLoaded) {
			this.roleLoaded = true;
			void this.loadRole();
		}
		const current: ParadisBotSettingsBase = { name: bot.name, agent: bot.agent, permissionId: bot.permissionId };
		if (this.draft === undefined || this.base === undefined) {
			this.draft = { ...current, role: this.draft?.role ?? this.role };
		} else {
			const rebased = paradisBotSettingsRebase(this.base, this.draft, current);
			this.draft = rebased.draft;
			for (const field of rebased.changedElsewhere) {
				this.changedElsewhere.add(field);
			}
		}
		this.base = current;
		const draft = this.draft;
		const grid = DOM.append(body, $('.paradis-bot-settings'));
		const row = (label: string, top?: boolean): HTMLElement => {
			const key = DOM.append(grid, $('span.paradis-bot-settings-key'));
			key.textContent = label;
			key.classList.toggle('top', top === true);
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
		track(name.inputElement, 'settings-name');
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
		const roleValue = row(localize('paradis.botPage.settings.role', "役割（SOUL.md）"), true);
		const roleFrame = DOM.append(roleValue, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-settings-role'));
		const role = DOM.append(roleFrame, $('textarea')) as HTMLTextAreaElement;
		role.rows = 6;
		role.spellcheck = false;
		role.setAttribute('aria-label', localize('paradis.botPage.settings.role', "役割（SOUL.md）"));
		role.value = draft.role ?? '';
		track(role, 'settings-role');
		role.disabled = draft.role === undefined;
		role.placeholder = draft.role === undefined ? localize('paradis.botPage.settings.roleLoading', "読み込んでいます…") : '';
		const roleError = DOM.append(roleValue, $('.paradis-bot-settings-error'));

		if (this.changedElsewhere.size > 0) {
			const labels = [...this.changedElsewhere].map(field => field === 'name' ? localize('paradis.botPage.settings.name', "名前") : field === 'agent' ? localize('paradis.botPage.settings.agent', "エージェント") : localize('paradis.botPage.settings.permission', "権限"));
			const elsewhere = DOM.append(body, $('.paradis-bot-settings-elsewhere'));
			elsewhere.setAttribute('role', 'status');
			elsewhere.textContent = localize('paradis.botPage.settings.changedElsewhere', "書きかけの間に、ほかの場所で{0}が変わりました。保存すると、この画面の値で上書きします。", labels.join('・'));
		}
		const foot = DOM.append(body, $('.paradis-bot-settings-foot'));
		const note = DOM.append(foot, $('span.paradis-bot-settings-help'));
		note.textContent = localize('paradis.botPage.settings.confirmNote', "エージェント・権限・役割を変えるときは、保存の前に確かめます。");
		const save = store.add(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.botPage.settings.save', "保存") }));

		const update = () => {
			this.draft = { name: name.value, agent: agents.value ?? draft.agent, permissionId: permission.value, role: this.draft?.role === undefined && this.role === undefined ? undefined : role.value };
			const checked = paradisValidateBotName(name.value, this.services.botsService.snapshot.bots, bot.id);
			nameError.textContent = checked.ok ? '' : paradisBotNameProblemMessage(checked.problem);
			// 上限を超えた役割は黙って切り詰めず、保存を断る
			const overflow = paradisBotRoleOverflow(this.draft.role);
			roleError.textContent = overflow > 0 ? localize('paradis.botPage.settings.roleTooLong', "役割が {0} 文字多すぎます（{1} 文字まで）。", overflow, PARADIS_BOT_ROLE_LIMIT) : '';
			save.enabled = checked.ok && overflow === 0 && !this.saving && paradisBotSettingsChange(bot, this.role, this.draft) !== undefined;
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
		if (change === undefined || this.saving || paradisBotRoleOverflow(change.role) > 0) {
			return;
		}
		// 確かめるのはエージェント・権限・役割だけ。名前の変更と止めた Bot の再開に確認を付けたのは、エージェント（管理の道具）
		// からの変更を利用者に見せるため（paradisBotUpdateNeedsConfirmation）。利用者が画面で自分で行うときは確かめない
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
			this.base = undefined;
			this.changedElsewhere.clear();
		} finally {
			this.saving = false;
			this.rerender();
		}
	}

	// ---- ファイル -------------------------------------------------------------------------------

	renderFiles(body: HTMLElement, bot: IParadisBotSummary, store: DisposableStore, track: ParadisBotSettingsFocusTracker): void {
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
				this.reloadFiles();
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
		if (this.fileConflicts.has(entry.path)) {
			this.renderFileConflict(body, entry.path, store);
		}
		const frame = DOM.append(body, $('.paradis-field.paradis-field-area.paradis-focus-subtle-within.paradis-bot-files-editor'));
		const editor = DOM.append(frame, $('textarea')) as HTMLTextAreaElement;
		editor.rows = 16;
		editor.spellcheck = false;
		editor.setAttribute('aria-label', entry.path);
		editor.value = this.fileEdits.get(entry.path) ?? text ?? '';
		track(editor, `files-${entry.path}`);
		const foot = DOM.append(body, $('.paradis-bot-settings-foot'));
		const note = DOM.append(foot, $('span.paradis-bot-settings-help'));
		note.textContent = localize('paradis.botPage.files.memoryHint', "Bot も書き足します。保存の前に読み直し、開いた後に書き換わっていたら上書きするか読み直すかを選びます。");
		const save = store.add(new ParadisButton(foot, { kind: 'primary', label: localize('paradis.botPage.files.save', "保存") }));
		save.enabled = this.fileEdits.has(entry.path) && !this.saving && !this.fileConflicts.has(entry.path);
		store.add(DOM.addDisposableListener(editor, DOM.EventType.INPUT, () => {
			this.fileEdits.set(entry.path, editor.value);
			save.enabled = !this.saving && !this.fileConflicts.has(entry.path);
		}));
		store.add(save.onDidClick(() => void this.saveFile(entry.path)));
		if (entry.path === 'MEMORY.md') {
			this.renderSnapshots(body, bot, store);
		}
	}

	/**
	 * 整理の前の写し（本体が会話の Bot を起動するたびに取る。新しい順に 5 件まで）。時刻・件数・一部だけかを並べ、
	 * 一番新しい写しにだけ取り消しのボタンを置く（取り消しが戻すのは一番新しい写し）。
	 */
	private renderSnapshots(body: HTMLElement, bot: IParadisBotSummary, store: DisposableStore): void {
		if (this.snapshots === undefined && !this.snapshotsLoading) {
			void this.loadSnapshots();
		}
		const section = DOM.append(body, $('.paradis-bot-snapshots'));
		DOM.append(section, $('.paradis-bot-page-section')).textContent = localize('paradis.botPage.snapshots.title', "整理の前の写し");
		const snapshots = this.snapshots;
		if (snapshots === undefined) {
			DOM.append(section, $('.paradis-bot-settings-help')).textContent = localize('paradis.botPage.snapshots.loading', "読み込んでいます…");
		} else if (snapshots === 'failed') {
			DOM.append(section, $('.paradis-bot-settings-help')).textContent = localize('paradis.botPage.snapshots.failed', "写しの一覧を読めませんでした。");
		} else if (snapshots.length === 0) {
			DOM.append(section, $('.paradis-bot-settings-help')).textContent = localize('paradis.botPage.snapshots.empty', "まだ写しはありません。会話の Bot を起動するたびに、記憶の写しを取ります。");
		} else {
			const list = DOM.append(section, $('.paradis-bot-snapshots-list'));
			snapshots.forEach((snapshot, index) => {
				const row = DOM.append(list, $('.paradis-bot-snapshots-row'));
				// 取り消しで戻せるのは一番新しい写しだけなので、古い写しの行は淡く出す
				row.classList.toggle('older', index > 0);
				DOM.append(row, $('span.paradis-bot-snapshots-time')).textContent = new Date(snapshot.takenAt).toLocaleString();
				DOM.append(row, $('span.paradis-bot-snapshots-count')).textContent = paradisBotMemorySnapshotCount(snapshot);
				if (snapshot.partial) {
					createParadisChip(row, localize('paradis.botPage.snapshots.partialChip', "一部だけ"), 'warning');
				}
				if (index === 0) {
					const undo = store.add(new ParadisButton(row, { kind: 'secondary', small: true, label: localize('paradis.botPage.snapshots.undo', "この写しに戻す..."), disabled: this.undoing }));
					store.add(undo.onDidClick(() => void this.undoMemoryTidy(bot)));
				}
			});
			if (snapshots.length > 1) {
				DOM.append(section, $('.paradis-bot-settings-help')).textContent = localize('paradis.botPage.snapshots.onlyNewest', "記憶の整理を取り消して戻せるのは、一番新しい写しだけです。");
			}
		}
		if (this.lastUndo !== undefined) {
			const result = DOM.append(section, $('.paradis-bot-snapshots-result'));
			result.setAttribute('role', 'status');
			for (const line of paradisBotUndoTidyLines(this.lastUndo, at => new Date(at).toLocaleString())) {
				const element = DOM.append(result, $('.paradis-bot-settings-help'));
				element.textContent = line.text;
				element.classList.toggle('attention', line.attention);
			}
		}
	}

	private async loadSnapshots(): Promise<void> {
		this.snapshotsLoading = true;
		try {
			const result = await this.services.botsService.listMemorySnapshots(this.botId);
			this.snapshots = result.ok ? result.value : 'failed';
		} catch {
			this.snapshots = 'failed';
		} finally {
			this.snapshotsLoading = false;
			this.rerender();
		}
	}

	/** 記憶の整理を取り消す（一番新しい写しを書き戻す。整理でできたファイルは消さずに知らせる）。 */
	private async undoMemoryTidy(bot: IParadisBotSummary): Promise<void> {
		const { confirmed } = await this.services.paradisDialogService.confirm({
			message: localize('paradis.botPage.files.undoTidyConfirm', "「{0}」の記憶の整理を取り消しますか?", bot.name),
			detail: Array.isArray(this.snapshots) && this.snapshots.length > 0
				? localize('paradis.botPage.files.undoTidyDetailAt', "{0} に取った写しを書き戻します。その後に書き足した記憶も、写しの時点に戻ります。", new Date(this.snapshots[0].takenAt).toLocaleString())
				: localize('paradis.botPage.files.undoTidyDetail', "整理の前に取った写しを書き戻します。整理の後に書き足した記憶も、写しの時点に戻ります。"),
			primaryButton: localize('paradis.botPage.files.undoTidyAction', "取り消す"),
			destructive: true,
		});
		if (!confirmed) {
			return;
		}
		this.undoing = true;
		this.rerender();
		try {
			const result = await this.services.botsService.undoMemoryTidy(this.botId);
			if (!result.ok) {
				this.services.notificationService.warn(localize('paradis.botPage.files.undoTidyFailed', "記憶の整理を取り消せませんでした: {0}", result.message));
				return;
			}
			// 結果（戻した件数・残したファイル・書き戻せなかったファイル）は写しの一覧の下に出す
			this.lastUndo = result.value;
			this.files.clear();
			this.fileEdits.clear();
			this.fileConflicts.clear();
		} finally {
			this.undoing = false;
			this.snapshots = undefined;
			this.rerender();
		}
	}

	/** 開いた後に書き換わったファイルの差分と、「上書きする」「読み直す（書きかけを捨てる）」の選び。 */
	private renderFileConflict(body: HTMLElement, path: string, store: DisposableStore): void {
		const latest = this.fileConflicts.get(path);
		const box = DOM.append(body, $('.paradis-bot-files-conflict'));
		box.setAttribute('role', 'status');
		DOM.append(box, $('.paradis-bot-files-conflict-title')).textContent = localize('paradis.botPage.files.conflictTitle', "{0} は開いた後にほかの場所で書き換わりました。変わったところ:", path);
		const diff = DOM.append(box, $('.paradis-bot-files-diff'));
		for (const line of paradisBotHomeFileDiff(this.files.get(path), latest)) {
			if (line.kind === 'same') {
				continue;
			}
			const row = DOM.append(diff, $(`.paradis-bot-files-diff-line.${line.kind}`));
			row.textContent = `${line.kind === 'added' ? '+' : '-'} ${line.text}`;
		}
		const actions = DOM.append(box, $('.paradis-bot-settings-foot'));
		const overwrite = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.files.overwrite', "上書きする"), disabled: this.saving }));
		store.add(overwrite.onDidClick(() => void this.saveFile(path, { expected: latest })));
		const reload = store.add(new ParadisButton(actions, { kind: 'secondary', label: localize('paradis.botPage.files.reloadDiscard', "読み直す（書きかけを捨てる）"), disabled: this.saving }));
		store.add(reload.onDidClick(() => {
			this.files.set(path, latest);
			this.fileEdits.delete(path);
			this.fileConflicts.delete(path);
			this.rerender();
		}));
	}

	/**
	 * ファイルのタブを開き直した・ファイルを選び直したときに読み直す。書きかけが無ければ新しい中身にし、書きかけがあって
	 * ほかの場所で書き換わっていれば、上書きするか読み直すかを選ばせる。
	 */
	reloadFiles(): void {
		// 写しは会話の Bot を起動するたびに増えるので、開き直したら読み直す
		if (this.snapshots !== undefined && !this.snapshotsLoading) {
			void this.loadSnapshots();
		}
		if (this.files.has(this.openFile)) {
			void this.refreshFile(this.openFile);
		}
	}

	private async refreshFile(path: string): Promise<void> {
		const result = await this.services.botsService.readHomeFile(this.botId, path);
		if (!result.ok) {
			return;
		}
		if (!this.fileEdits.has(path)) {
			if (this.files.get(path) !== result.value) {
				this.files.set(path, result.value);
				this.rerender();
			}
			return;
		}
		if (paradisBotHomeFileConflict(this.files.get(path), result.value)) {
			this.fileConflicts.set(path, result.value);
			this.rerender();
		}
	}

	private async loadFile(path: string): Promise<void> {
		const result = await this.services.botsService.readHomeFile(this.botId, path);
		this.files.set(path, result.ok ? result.value : undefined);
		this.rerender();
	}

	/**
	 * 保存の前に読み直し、開いた後に書き換わっていたら書かずに、上書きするか読み直すかを選ばせる。読み直せなければ
	 * 比べられないので書かない。`overwrite.expected` は「上書きする」を選んだときに見せた今の中身（その後にまた変わっていたら選び直させる）。
	 */
	private async saveFile(path: string, overwrite?: { readonly expected: string | undefined }): Promise<void> {
		const edited = this.fileEdits.get(path);
		if (edited === undefined || this.saving) {
			return;
		}
		this.saving = true;
		try {
			const latest = await this.services.botsService.readHomeFile(this.botId, path);
			if (!latest.ok) {
				this.services.notificationService.warn(localize('paradis.botPage.files.readFailed', "{0} を読み直せなかったので、保存しませんでした: {1}", path, latest.message));
				return;
			}
			if (paradisBotHomeFileConflict(overwrite !== undefined ? overwrite.expected : this.files.get(path), latest.value)) {
				this.fileConflicts.set(path, latest.value);
				return;
			}
			const written = await this.services.botsService.writeHomeFile(this.botId, path, edited);
			if (!written.ok) {
				this.services.notificationService.warn(localize('paradis.botPage.files.failed', "{0} を書けませんでした: {1}", path, written.message));
				return;
			}
			this.files.set(path, edited);
			this.fileEdits.delete(path);
			this.fileConflicts.delete(path);
		} finally {
			this.saving = false;
			this.rerender();
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「ユーザー辞書」の ElevenLabs 版。ElevenLabs の発音辞書（alias 規則）を
// 一覧・作成・編集・書き出し（PLS）・削除（アーカイブ）する。画面は「表記」「読み」の2列だけで、
// phoneme 規則は作らない（日本語で音が崩れるため）。他のツールで作った phoneme 規則は保存しても残す。
// 読み上げエンジンが Aivis のときは何も描かない（Aivis 版の ParadisAivisDictionarySection が描く）。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisElevenLabsDictionaryDetail,
	IParadisElevenLabsDictionaryEntry,
	IParadisElevenLabsDictionaryListItem,
	ParadisElevenLabsRule,
	paradisEntriesFromElevenLabsRules,
	paradisRulesFromElevenLabsEntries,
	paradisValidateElevenLabsEntries,
} from '../common/paradisElevenLabs.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisElevenLabsDictionaryCache } from './paradisElevenLabsApiCache.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.elevenlabsDict.title', "ユーザー辞書");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.elevenlabsDict.desc', "ElevenLabs の発音辞書で、表記を別の読みに置き換えてから読み上げます。読みはひらがな・カタカナなど、そのまま読ませたい書き方で入れます。");
// allow-any-unicode-next-line
const STR_NEW = localize('paradis.notif.elevenlabsDict.new', "新規辞書");
// allow-any-unicode-next-line
const STR_NO_KEY = localize('paradis.notif.elevenlabsDict.noKey', "ElevenLabs の API キーを設定すると辞書を管理できます。");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.elevenlabsDict.loading', "読み込み中…");
// allow-any-unicode-next-line
const STR_EMPTY = localize('paradis.notif.elevenlabsDict.empty', "まだ辞書がありません。「新規辞書」から作成してください。");
// allow-any-unicode-next-line
const STR_ACTIVE_BADGE = localize('paradis.notif.elevenlabsDict.activeBadge', "ACTIVE");
// allow-any-unicode-next-line
const STR_APPLY = localize('paradis.notif.elevenlabsDict.apply', "適用");
// allow-any-unicode-next-line
const STR_EDIT = localize('paradis.notif.elevenlabsDict.edit', "編集");
// allow-any-unicode-next-line
const STR_EXPORT = localize('paradis.notif.elevenlabsDict.export', "書き出し (PLS)");
// allow-any-unicode-next-line
const STR_DELETE = localize('paradis.notif.elevenlabsDict.delete', "削除");
// allow-any-unicode-next-line
const strRules = (n: number) => localize('paradis.notif.elevenlabsDict.rules', "{0} 件", n);
// allow-any-unicode-next-line
const strDeleteConfirm = (name: string) => localize('paradis.notif.elevenlabsDict.deleteConfirm', "辞書「{0}」を削除します。よろしいですか？", name);
// allow-any-unicode-next-line
const STR_DELETE_DETAIL = localize('paradis.notif.elevenlabsDict.deleteDetail', "ElevenLabs には辞書を消す API が無いため、アーカイブして一覧から外します。");

export class ParadisElevenLabsDictionarySection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _nestedDialog = this._register(new MutableDisposable<Disposable>());

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'aivis') {
				this._render();
			}
		}));
		this._render();
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		paradisPreserveScroll(this.container, () => this._renderBody());
	}

	private _renderBody(): void {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		const settings = this.settingsService.getAivisSettings();
		if (settings.engine !== 'elevenlabs') {
			return;
		}
		const apiKey = settings.elevenLabsApiKey;

		const header = dom.append(this.container, $('.setting-row'));
		const titles = dom.append(header, $('.sr-main'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;
		const newBtn = dom.append(header, $('button.pns-btn')) as HTMLButtonElement;
		newBtn.style.flexShrink = '0';
		newBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		newBtn.append(STR_NEW);
		newBtn.disabled = !apiKey;
		this._renderDisposables.add(dom.addDisposableListener(newBtn, 'click', () => this._openEditor(apiKey, undefined)));

		if (!apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return;
		}

		const listEl = dom.append(this.container, $('div'));
		const cached = paradisElevenLabsDictionaryCache.get(apiKey);
		if (cached) {
			this._populateList(listEl, cached, apiKey, settings.elevenLabsDictionaryId);
			return;
		}
		listEl.textContent = STR_LOADING;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsDictionaryListItem[]>('listElevenLabsDictionaries', [apiKey]).then(list => {
			paradisElevenLabsDictionaryCache.set(apiKey, list);
			if (this._store.isDisposed || !listEl.isConnected) {
				return;
			}
			this._populateList(listEl, list, apiKey, settings.elevenLabsDictionaryId);
		}, error => {
			if (this._store.isDisposed || !listEl.isConnected) {
				return;
			}
			dom.clearNode(listEl);
			dom.append(listEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _populateList(listEl: HTMLElement, list: readonly IParadisElevenLabsDictionaryListItem[], apiKey: string, activeId: string): void {
		dom.clearNode(listEl);
		if (list.length === 0) {
			dom.append(listEl, $('.pns-empty')).textContent = STR_EMPTY;
			return;
		}
		for (const dict of list) {
			this._renderCard(listEl, dict, apiKey, activeId);
		}
	}

	private _renderCard(container: HTMLElement, dict: IParadisElevenLabsDictionaryListItem, apiKey: string, activeId: string): void {
		const isActive = dict.id === activeId;
		const card = dom.append(container, $('.pns-dict-card'));
		card.classList.toggle('active', isActive);
		const top = dom.append(card, $('.pns-row'));
		top.style.marginBottom = '0';
		const infoEl = dom.append(top, $('div'));
		const nameRow = dom.append(infoEl, $('.pns-ringtone-name'));
		dom.append(nameRow, $('span')).textContent = dict.name;
		if (isActive) {
			dom.append(nameRow, $('span.pns-dict-badge-active')).textContent = STR_ACTIVE_BADGE;
		}
		const parts = [dict.description || '—'];
		if (dict.ruleCount !== null) {
			parts.push(strRules(dict.ruleCount));
		}
		if (dict.createdAt !== null) {
			parts.push(new Date(dict.createdAt).toISOString().slice(0, 10));
		}
		dom.append(infoEl, $('.pns-ringtone-desc')).textContent = parts.join(' · ');

		const actions = dom.append(top, $('div'));
		actions.style.display = 'flex';
		actions.style.gap = '5px';
		actions.style.flexShrink = '0';

		if (!isActive) {
			const applyBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
			applyBtn.textContent = STR_APPLY;
			this._renderDisposables.add(dom.addDisposableListener(applyBtn, 'click', () => {
				this.settingsService.setAivisSettings({ elevenLabsDictionaryId: dict.id });
			}));
		}
		const editBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		editBtn.textContent = STR_EDIT;
		this._renderDisposables.add(dom.addDisposableListener(editBtn, 'click', () => this._openEditor(apiKey, dict)));

		const exportBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		exportBtn.title = STR_EXPORT;
		exportBtn.setAttribute('aria-label', STR_EXPORT);
		exportBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.arrowDown)}`));
		this._renderDisposables.add(dom.addDisposableListener(exportBtn, 'click', () => this._export(apiKey, dict)));

		const deleteBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon.pns-btn-danger')) as HTMLButtonElement;
		deleteBtn.title = STR_DELETE;
		deleteBtn.setAttribute('aria-label', STR_DELETE);
		deleteBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
		this._renderDisposables.add(dom.addDisposableListener(deleteBtn, 'click', () => this._delete(apiKey, dict, isActive)));
	}

	private async _export(apiKey: string, dict: IParadisElevenLabsDictionaryListItem): Promise<void> {
		try {
			const xml = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<string>('downloadElevenLabsDictionary', [apiKey, dict.id]);
			const blob = new Blob([xml], { type: 'application/pls+xml' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${dict.name || 'dictionary'}.pls`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] ElevenLabs dictionary export failed', error);
		}
	}

	private async _delete(apiKey: string, dict: IParadisElevenLabsDictionaryListItem, wasActive: boolean): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: strDeleteConfirm(dict.name),
			detail: STR_DELETE_DETAIL,
			primaryButton: STR_DELETE,
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('archiveElevenLabsDictionary', [apiKey, dict.id]);
			paradisElevenLabsDictionaryCache.delete(apiKey);
			if (wasActive) {
				this.settingsService.setAivisSettings({ elevenLabsDictionaryId: '' });
			}
			this._render();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] ElevenLabs dictionary archive failed', error);
		}
	}

	private _openEditor(apiKey: string, dict: IParadisElevenLabsDictionaryListItem | undefined): void {
		this._nestedDialog.value = new ParadisElevenLabsDictionaryEditorDialog(this.layoutService, this.sharedProcessService, apiKey, dict, created => {
			paradisElevenLabsDictionaryCache.delete(apiKey);
			if (created && !this.settingsService.getAivisSettings().elevenLabsDictionaryId) {
				// 最初に作った辞書はそのまま使う（setAivisSettings の再描画で一覧も読み直す）。
				this.settingsService.setAivisSettings({ elevenLabsDictionaryId: created });
			} else {
				this._render();
			}
		});
	}
}

// === 辞書の作成・編集ダイアログ ==================================================================

// allow-any-unicode-next-line
const STR_CREATE_TITLE = localize('paradis.notif.elevenlabsDict.createTitle', "発音辞書を作成");
// allow-any-unicode-next-line
const STR_EDIT_TITLE = localize('paradis.notif.elevenlabsDict.editTitle', "発音辞書を編集");
// allow-any-unicode-next-line
const STR_EDIT_DESC = localize('paradis.notif.elevenlabsDict.editDesc', "読み上げる前に「表記」を「読み」に置き換えます。読みはひらがな・カタカナなど、そのまま読ませたい書き方で入れます。");
// allow-any-unicode-next-line
const STR_NAME_LABEL = localize('paradis.notif.elevenlabsDict.nameLabel', "名前");
// allow-any-unicode-next-line
const STR_DESCRIPTION_LABEL = localize('paradis.notif.elevenlabsDict.descriptionLabel', "説明");
// allow-any-unicode-next-line
const STR_COL_SURFACE = localize('paradis.notif.elevenlabsDict.colSurface', "表記");
// allow-any-unicode-next-line
const STR_COL_READING = localize('paradis.notif.elevenlabsDict.colReading', "読み");
// allow-any-unicode-next-line
const STR_ADD_ROW = localize('paradis.notif.elevenlabsDict.addRow', "行を追加");
// allow-any-unicode-next-line
const STR_NO_ROWS = localize('paradis.notif.elevenlabsDict.noRows', "まだ単語がありません。下の「行を追加」から開始してください。");
// allow-any-unicode-next-line
const strKeptPhonemes = (n: number) => localize('paradis.notif.elevenlabsDict.keptPhonemes', "ほかのツールで作った発音記号の規則が {0} 件あります。ここには出しませんが、保存しても残ります。", n);
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.notif.elevenlabsDict.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.notif.elevenlabsDict.save', "保存");
// allow-any-unicode-next-line
const STR_SAVING = localize('paradis.notif.elevenlabsDict.saving', "保存中…");
// allow-any-unicode-next-line
const STR_ERR_NAME_EMPTY = localize('paradis.notif.elevenlabsDict.errNameEmpty', "辞書名を入力してください");
// allow-any-unicode-next-line
const STR_ERR_NO_RULES = localize('paradis.notif.elevenlabsDict.errNoRules', "単語を1つ以上入れてください");
// allow-any-unicode-next-line
const strErrSurface = (row: number) => localize('paradis.notif.elevenlabsDict.errSurface', "行 {0}: 表記が空です", row);
// allow-any-unicode-next-line
const strErrReading = (row: number) => localize('paradis.notif.elevenlabsDict.errReading', "行 {0}: 読みが空です", row);

interface IEditableRow {
	surface: string;
	reading: string;
}

class ParadisElevenLabsDictionaryEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _bodyEl: HTMLElement;
	private readonly _rowDisposables = this._register(new DisposableStore());
	private _rows: IEditableRow[] = [];
	private _existingRules: readonly ParadisElevenLabsRule[] = [];
	private _name = '';
	private _description = '';

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly apiKey: string,
		private readonly dict: IParadisElevenLabsDictionaryListItem | undefined,
		/** 保存できたら呼ぶ。新しく作った場合はその ID を渡す。 */
		private readonly onSaved: (createdId: string | undefined) => void,
	) {
		super();

		this._backdrop = $('.paradis-notif-nested-backdrop');
		const dialog = $('.paradis-notif-nested-dialog.wide');
		this._backdrop.appendChild(dialog);
		dom.append(dialog, $('h3')).textContent = dict ? STR_EDIT_TITLE : STR_CREATE_TITLE;
		dom.append(dialog, $('.pns-nested-desc')).textContent = STR_EDIT_DESC;
		this._bodyEl = dom.append(dialog, $('div'));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		layoutService.activeContainer.appendChild(this._backdrop);

		if (!dict) {
			this._rows = [{ surface: '', reading: '' }];
			this._renderBody(dialog);
			return;
		}
		this._bodyEl.textContent = '…';
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsDictionaryDetail>('getElevenLabsDictionary', [apiKey, dict.id]).then(detail => {
			if (this._store.isDisposed) {
				return;
			}
			this._name = detail.name;
			this._description = detail.description;
			this._existingRules = detail.rules;
			this._rows = paradisEntriesFromElevenLabsRules(detail.rules).map(entry => ({ ...entry }));
			this._renderBody(dialog);
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(this._bodyEl);
			dom.append(this._bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _renderBody(dialog: HTMLElement): void {
		dom.clearNode(this._bodyEl);
		const isNew = !this.dict;

		const nameRow = dom.append(this._bodyEl, $('.pns-field'));
		dom.append(nameRow, $('label.pns-label')).textContent = STR_NAME_LABEL;
		if (isNew) {
			const nameInput = dom.append(nameRow, $('input')) as HTMLInputElement;
			nameInput.maxLength = 100;
			this._register(dom.addDisposableListener(nameInput, 'input', () => { this._name = nameInput.value; }));
			const descRow = dom.append(this._bodyEl, $('.pns-field'));
			dom.append(descRow, $('label.pns-label')).textContent = STR_DESCRIPTION_LABEL;
			const descInput = dom.append(descRow, $('input')) as HTMLInputElement;
			descInput.maxLength = 500;
			this._register(dom.addDisposableListener(descInput, 'input', () => { this._description = descInput.value; }));
			nameInput.focus();
		} else {
			// 名前と説明は作るときだけ決める（規則の置き換えとは別の API になるため、ここでは変えない）。
			dom.append(nameRow, $('div')).textContent = this._name;
		}

		const table = dom.append(this._bodyEl, $('table.pns-dict-table'));
		const headRow = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const label of [STR_COL_SURFACE, STR_COL_READING, '']) {
			dom.append(headRow, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));
		const renderRows = () => {
			this._rowDisposables.clear();
			dom.clearNode(tbody);
			if (this._rows.length === 0) {
				const cell = dom.append(dom.append(tbody, $('tr')), $('td')) as HTMLTableCellElement;
				cell.colSpan = 3;
				cell.textContent = STR_NO_ROWS;
				return;
			}
			for (let i = 0; i < this._rows.length; i++) {
				this._renderRow(tbody, i, renderRows);
			}
		};
		renderRows();

		const addRow = dom.append(this._bodyEl, $('.pns-row'));
		const addBtn = dom.append(addRow, $('button.pns-btn')) as HTMLButtonElement;
		addBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		addBtn.append(STR_ADD_ROW);
		this._register(dom.addDisposableListener(addBtn, 'click', () => {
			this._rows.push({ surface: '', reading: '' });
			renderRows();
		}));
		const phonemeCount = this._existingRules.filter(rule => rule.type === 'phoneme').length;
		if (phonemeCount > 0) {
			dom.append(addRow, $('.pns-row-hint')).textContent = strKeptPhonemes(phonemeCount);
		}

		const errorEl = dom.append(this._bodyEl, $('.pns-error'));

		const footer = dom.append(dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));
		const saveBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._register(dom.addDisposableListener(saveBtn, 'click', async () => {
			errorEl.textContent = '';
			if (isNew && !this._name.trim()) {
				errorEl.textContent = STR_ERR_NAME_EMPTY;
				return;
			}
			const entries: IParadisElevenLabsDictionaryEntry[] = this._rows.map(row => ({ surface: row.surface, reading: row.reading }));
			const problem = paradisValidateElevenLabsEntries(entries);
			if (problem) {
				errorEl.textContent = problem.problem === 'surface' ? strErrSurface(problem.row) : strErrReading(problem.row);
				return;
			}
			const rules = paradisRulesFromElevenLabsEntries(entries, this._existingRules);
			if (isNew && rules.length === 0) {
				errorEl.textContent = STR_ERR_NO_RULES;
				return;
			}
			saveBtn.disabled = true;
			saveBtn.textContent = STR_SAVING;
			try {
				const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
				if (this.dict) {
					await channel.call('setElevenLabsDictionaryRules', [this.apiKey, this.dict.id, rules]);
					this.onSaved(undefined);
				} else {
					const created = await channel.call<{ id: string }>('createElevenLabsDictionary', [this.apiKey, this._name.trim(), this._description.trim(), rules]);
					this.onSaved(created.id);
				}
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				saveBtn.disabled = false;
				saveBtn.textContent = STR_SAVE;
			}
		}));
	}

	private _renderRow(tbody: HTMLElement, index: number, rerender: () => void): void {
		const row = this._rows[index];
		const tr = dom.append(tbody, $('tr'));
		const surfaceInput = dom.append(dom.append(tr, $('td')), $('input')) as HTMLInputElement;
		surfaceInput.value = row.surface;
		this._rowDisposables.add(dom.addDisposableListener(surfaceInput, 'input', () => { row.surface = surfaceInput.value; }));
		const readingInput = dom.append(dom.append(tr, $('td')), $('input')) as HTMLInputElement;
		readingInput.value = row.reading;
		this._rowDisposables.add(dom.addDisposableListener(readingInput, 'input', () => { row.reading = readingInput.value; }));
		const removeBtn = dom.append(dom.append(tr, $('td')), $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		removeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._rowDisposables.add(dom.addDisposableListener(removeBtn, 'click', () => {
			this._rows.splice(index, 1);
			rerender();
		}));
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}
}

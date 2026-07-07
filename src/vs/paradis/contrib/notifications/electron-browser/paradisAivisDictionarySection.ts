/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「ユーザー辞書」セクション（Superset apps/desktop の AivisDictionary.tsx /
// DictionaryEditorDialog.tsx / CreateDictionaryDialog.tsx の移植）。辞書の一覧・新規作成・編集・
// AivisSpeech互換JSONのimport/export・削除を扱う。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisAivisDictionaryDetail,
	IParadisAivisDictionaryListItem,
	IParadisAivisDictionaryWord,
	PARADIS_AIVIS_WORD_TYPES,
	PARADIS_NOTIFICATIONS_CHANNEL,
	ParadisAivisWordType,
} from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.dict.title', "ユーザー辞書");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.dict.desc', "固有名詞・英略語・ブランチ名など特殊な読み方をする単語を登録します。AivisSpeech 互換 JSON の import / export に対応。");
// allow-any-unicode-next-line
const STR_NEW = localize('paradis.notif.dict.new', "新規辞書");
// allow-any-unicode-next-line
const STR_NO_KEY = localize('paradis.notif.dict.noKey', "Aivis API キーを設定すると辞書を管理できます。");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.dict.loading', "読み込み中…");
// allow-any-unicode-next-line
const STR_EMPTY = localize('paradis.notif.dict.empty', "まだ辞書がありません。「新規辞書」から作成してください。");
// allow-any-unicode-next-line
const STR_ACTIVE_BADGE = localize('paradis.notif.dict.activeBadge', "ACTIVE");
// allow-any-unicode-next-line
const STR_APPLY = localize('paradis.notif.dict.apply', "適用");
// allow-any-unicode-next-line
const STR_EDIT = localize('paradis.notif.dict.edit', "編集");
// allow-any-unicode-next-line
const STR_DELETE_CONFIRM_TITLE = (name: string) => localize('paradis.notif.dict.deleteConfirmTitle', "辞書「{0}」を削除します。よろしいですか？", name);
// allow-any-unicode-next-line
const STR_DELETE_CONFIRM_PRIMARY = localize('paradis.notif.dict.deleteConfirmPrimary', "削除");

export class ParadisAivisDictionarySection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _fileInput: HTMLInputElement;
	private _importTargetUuid: string | undefined;
	// 新規作成/編集ダイアログは同時に1つしか開かない前提。開くたびに差し替えて、
	// 閉じた（自己dispose済みの）ダイアログ参照をセクション本体の store に溜めない。
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

		this._fileInput = document.createElement('input');
		this._fileInput.type = 'file';
		this._fileInput.accept = 'application/json,.json';
		this._fileInput.style.display = 'none';
		this._register(dom.addDisposableListener(this._fileInput, 'change', () => this._handleImportFile()));

		this._register(this.settingsService.onDidChange(() => this._render()));
		this._render();
	}

	override dispose(): void {
		this._fileInput.remove();
		super.dispose();
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		// 再描画で直前にフォーカスされていた要素がDOMから外れることでスクロール位置が
		// 先頭に戻ってしまう問題への対策(paradisNotificationSettingsDomUtils.ts参照)。
		paradisPreserveScroll(this.container, () => this._renderBody());
	}

	private _renderBody(): void {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		const header = dom.append(this.container, $('.pns-row'));
		const titles = dom.append(header, $('div'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;

		const settings = this.settingsService.getAivisSettings();
		const newBtn = dom.append(header, $('button.pns-btn')) as HTMLButtonElement;
		newBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		newBtn.append(STR_NEW);
		newBtn.disabled = !settings.apiKey;
		this._renderDisposables.add(dom.addDisposableListener(newBtn, 'click', () => this._openCreateDialog()));

		this.container.appendChild(this._fileInput);

		if (!settings.apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return;
		}

		const listEl = dom.append(this.container, $('div'));
		listEl.textContent = STR_LOADING;

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisDictionaryListItem[]>('listAivisDictionaries', [settings.apiKey]).then(list => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(listEl);
			if (list.length === 0) {
				dom.append(listEl, $('.pns-empty')).textContent = STR_EMPTY;
				return;
			}
			for (const dict of list) {
				this._renderCard(listEl, dict, settings.apiKey, settings.userDictionaryUuid);
			}
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(listEl);
			dom.append(listEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _renderCard(container: HTMLElement, dict: IParadisAivisDictionaryListItem, apiKey: string, activeUuid: string): void {
		const isActive = dict.uuid === activeUuid;
		const card = dom.append(container, $('.pns-dict-card'));
		if (isActive) {
			card.classList.add('active');
		}
		const top = dom.append(card, $('.pns-row'));
		top.style.marginBottom = '0';
		const infoEl = dom.append(top, $('div'));
		const nameRow = dom.append(infoEl, $('.pns-ringtone-name'));
		dom.append(nameRow, $('span')).textContent = dict.name;
		if (isActive) {
			dom.append(nameRow, $('span.pns-dict-badge-active')).textContent = STR_ACTIVE_BADGE;
		}
		const descLine = dom.append(infoEl, $('.pns-ringtone-desc'));
		descLine.textContent = `${dict.description || '—'} · ${dict.word_count} words · ${dict.updated_at.slice(0, 10)}`;

		const actions = dom.append(top, $('div'));
		actions.style.display = 'flex';
		actions.style.gap = '5px';
		actions.style.flexShrink = '0';

		if (!isActive) {
			const applyBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
			applyBtn.textContent = STR_APPLY;
			this._renderDisposables.add(dom.addDisposableListener(applyBtn, 'click', () => {
				this.settingsService.setAivisSettings({ userDictionaryUuid: dict.uuid });
			}));
		}

		const editBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		editBtn.textContent = STR_EDIT;
		this._renderDisposables.add(dom.addDisposableListener(editBtn, 'click', () => this._openEditDialog(dict.uuid, apiKey)));

		const importBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		importBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.arrowUp)}`));
		this._renderDisposables.add(dom.addDisposableListener(importBtn, 'click', () => {
			this._importTargetUuid = dict.uuid;
			this._fileInput.click();
		}));

		const exportBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		exportBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.arrowDown)}`));
		this._renderDisposables.add(dom.addDisposableListener(exportBtn, 'click', () => this._exportDictionary(dict.uuid, dict.name, apiKey)));

		const deleteBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon.pns-btn-danger')) as HTMLButtonElement;
		deleteBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.trash)}`));
		this._renderDisposables.add(dom.addDisposableListener(deleteBtn, 'click', () => this._deleteDictionary(dict.uuid, dict.name, apiKey, isActive)));
	}

	private async _handleImportFile(): Promise<void> {
		const file = this._fileInput.files?.[0];
		const targetUuid = this._importTargetUuid;
		this._fileInput.value = '';
		this._importTargetUuid = undefined;
		if (!file || !targetUuid) {
			return;
		}
		const settings = this.settingsService.getAivisSettings();
		try {
			const text = await file.text();
			const data = JSON.parse(text);
			if (typeof data !== 'object' || Array.isArray(data) || data === null) {
				// allow-any-unicode-next-line
				throw new Error('AivisSpeech 互換の JSON オブジェクトを選択してください');
			}
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('importAivisDictionary', [settings.apiKey, targetUuid, data, false]);
			this._render();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary import failed', error);
		}
	}

	private async _exportDictionary(uuid: string, name: string, apiKey: string): Promise<void> {
		try {
			const data = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<Record<string, unknown>>('exportAivisDictionary', [apiKey, uuid]);
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${name || 'dictionary'}.aivisspeech.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary export failed', error);
		}
	}

	private async _deleteDictionary(uuid: string, name: string, apiKey: string, wasActive: boolean): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: STR_DELETE_CONFIRM_TITLE(name),
			primaryButton: STR_DELETE_CONFIRM_PRIMARY,
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('deleteAivisDictionary', [apiKey, uuid]);
			if (wasActive) {
				this.settingsService.setAivisSettings({ userDictionaryUuid: '' });
			}
			this._render();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary delete failed', error);
		}
	}

	private _openCreateDialog(): void {
		const settings = this.settingsService.getAivisSettings();
		const dialog = new ParadisCreateDictionaryDialog(this.layoutService, this.sharedProcessService, settings.apiKey, uuid => {
			this._render();
			this._openEditDialog(uuid, settings.apiKey);
		});
		this._nestedDialog.value = dialog;
	}

	private _openEditDialog(uuid: string, apiKey: string): void {
		const dialog = new ParadisDictionaryEditorDialog(this.layoutService, this.sharedProcessService, uuid, apiKey, () => this._render());
		this._nestedDialog.value = dialog;
	}
}

// === 新規辞書ダイアログ =========================================================================

// allow-any-unicode-next-line
const STR_CREATE_TITLE = localize('paradis.notif.dict.createTitle', "新規辞書を作成");
// allow-any-unicode-next-line
const STR_NAME_LABEL = localize('paradis.notif.dict.nameLabel', "名前");
// allow-any-unicode-next-line
const STR_DESCRIPTION_LABEL = localize('paradis.notif.dict.descriptionLabel', "説明");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.notif.dict.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_CREATE = localize('paradis.notif.dict.create', "作成");

class ParadisCreateDictionaryDialog extends Disposable {

	private readonly _backdrop: HTMLElement;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly apiKey: string,
		private readonly onCreated: (uuid: string) => void,
	) {
		super();

		this._backdrop = $('.paradis-notif-nested-backdrop');
		const dialog = $('.paradis-notif-nested-dialog');
		this._backdrop.appendChild(dialog);

		dom.append(dialog, $('h3')).textContent = STR_CREATE_TITLE;

		const nameField = dom.append(dialog, $('.pns-field'));
		dom.append(nameField, $('label.pns-label')).textContent = STR_NAME_LABEL;
		const nameInput = dom.append(nameField, $('input')) as HTMLInputElement;
		nameInput.maxLength = 100;

		const descField = dom.append(dialog, $('.pns-field'));
		dom.append(descField, $('label.pns-label')).textContent = STR_DESCRIPTION_LABEL;
		const descInput = dom.append(descField, $('input')) as HTMLInputElement;
		descInput.maxLength = 500;

		const errorEl = dom.append(dialog, $('.pns-error'));

		const footer = dom.append(dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

		const createBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		createBtn.textContent = STR_CREATE;
		this._register(dom.addDisposableListener(createBtn, 'click', async () => {
			const name = nameInput.value.trim();
			if (!name) {
				return;
			}
			createBtn.disabled = true;
			try {
				const result = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<{ uuid: string }>('createAivisDictionary', [this.apiKey, name, descInput.value.trim()]);
				this.onCreated(result.uuid);
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				createBtn.disabled = false;
			}
		}));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		nameInput.focus();
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}
}

// === 辞書編集ダイアログ ==========================================================================

// allow-any-unicode-next-line
const STR_EDIT_TITLE = localize('paradis.notif.dict.editTitle', "ユーザー辞書を編集");
// allow-any-unicode-next-line
const STR_EDIT_DESC = localize('paradis.notif.dict.editDesc', "Aivis の音声合成時に適用される読み方を登録します。読みはカタカナで入力してください。");
// allow-any-unicode-next-line
const STR_COL_SURFACE = localize('paradis.notif.dict.colSurface', "表記");
// allow-any-unicode-next-line
const STR_COL_PRONUNCIATION = localize('paradis.notif.dict.colPronunciation', "読み (カタカナ)");
// allow-any-unicode-next-line
const STR_COL_ACCENT = localize('paradis.notif.dict.colAccent', "アクセント");
// allow-any-unicode-next-line
const STR_COL_PRIORITY = localize('paradis.notif.dict.colPriority', "優先度 (0-10)");
// allow-any-unicode-next-line
const STR_COL_TYPE = localize('paradis.notif.dict.colType', "品詞");
// allow-any-unicode-next-line
const STR_ADD_ROW = localize('paradis.notif.dict.addRow', "行を追加");
// allow-any-unicode-next-line
const STR_ACCENT_HINT = localize('paradis.notif.dict.accentHint', "アクセント核は 0 始まりの整数 (0 = 平板型)。");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.notif.dict.save', "保存");
// allow-any-unicode-next-line
const STR_SAVING = localize('paradis.notif.dict.saving', "保存中…");
// allow-any-unicode-next-line
const STR_NO_WORDS = localize('paradis.notif.dict.noWords', "まだ単語がありません。下の「行を追加」から開始してください。");
// allow-any-unicode-next-line
const STR_ERR_NAME_EMPTY = localize('paradis.notif.dict.errNameEmpty', "辞書名を入力してください");
// allow-any-unicode-next-line
const strErrSurfaceEmpty = (row: number) => localize('paradis.notif.dict.errSurfaceEmpty', "行 {0}: 表記が空です", row);
// allow-any-unicode-next-line
const strErrPronunciationEmpty = (row: number) => localize('paradis.notif.dict.errPronunciationEmpty', "行 {0}: 読みが空です", row);
// allow-any-unicode-next-line
const strErrKatakana = (row: number) => localize('paradis.notif.dict.errKatakana', "行 {0}: 読みはカタカナで入力してください", row);

// allow-any-unicode-next-line
const KATAKANA_RE = /^[゠-ヿー\s]+$/;

interface IWordRow {
	uuid: string;
	surface: string;
	pronunciation: string;
	accentType: number;
	wordType: ParadisAivisWordType;
	priority: number;
}

class ParadisDictionaryEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _bodyEl: HTMLElement;
	// 行の追加/削除のたびに tbody を作り直すため、行のリスナはこの store に束ねて
	// renderRows 冒頭で clear する（ダイアログ本体の store に無制限に溜めない）。
	private readonly _rowDisposables = this._register(new DisposableStore());
	private _words: IWordRow[] = [];
	private _name = '';
	private _description = '';

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly uuid: string,
		private readonly apiKey: string,
		private readonly onSaved: () => void,
	) {
		super();

		this._backdrop = $('.paradis-notif-nested-backdrop');
		const dialog = $('.paradis-notif-nested-dialog.wide');
		this._backdrop.appendChild(dialog);

		dom.append(dialog, $('h3')).textContent = STR_EDIT_TITLE;
		dom.append(dialog, $('.pns-nested-desc')).textContent = STR_EDIT_DESC;

		this._bodyEl = dom.append(dialog, $('div'));
		this._bodyEl.textContent = '…';

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisDictionaryDetail>('getAivisDictionary', [apiKey, uuid]).then(detail => {
			if (this._store.isDisposed) {
				return;
			}
			this._name = detail.name;
			this._description = detail.description;
			this._words = detail.word_properties.map(w => ({
				uuid: w.uuid,
				surface: w.surface[0] ?? '',
				pronunciation: w.pronunciation[0] ?? '',
				accentType: w.accent_type[0] ?? 0,
				wordType: w.word_type,
				priority: w.priority,
			}));
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

		const nameRow = dom.append(this._bodyEl, $('.pns-field'));
		dom.append(nameRow, $('label.pns-label')).textContent = STR_NAME_LABEL;
		const nameInput = dom.append(nameRow, $('input')) as HTMLInputElement;
		nameInput.value = this._name;
		nameInput.maxLength = 100;
		this._register(dom.addDisposableListener(nameInput, 'input', () => { this._name = nameInput.value; }));

		const descRow = dom.append(this._bodyEl, $('.pns-field'));
		dom.append(descRow, $('label.pns-label')).textContent = STR_DESCRIPTION_LABEL;
		const descInput = dom.append(descRow, $('input')) as HTMLInputElement;
		descInput.value = this._description;
		descInput.maxLength = 500;
		this._register(dom.addDisposableListener(descInput, 'input', () => { this._description = descInput.value; }));

		const table = dom.append(this._bodyEl, $('table.pns-dict-table'));
		const thead = dom.append(table, $('thead'));
		const headRow = dom.append(thead, $('tr'));
		for (const label of [STR_COL_SURFACE, STR_COL_PRONUNCIATION, STR_COL_ACCENT, STR_COL_PRIORITY, STR_COL_TYPE, '']) {
			dom.append(headRow, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));

		const errorEl = $('.pns-error') as HTMLElement;

		const renderRows = () => {
			this._rowDisposables.clear();
			dom.clearNode(tbody);
			if (this._words.length === 0) {
				const emptyRow = dom.append(tbody, $('tr'));
				const cell = dom.append(emptyRow, $('td')) as HTMLTableCellElement;
				cell.colSpan = 6;
				cell.textContent = STR_NO_WORDS;
				return;
			}
			for (let i = 0; i < this._words.length; i++) {
				this._renderWordRow(tbody, i, renderRows);
			}
		};
		renderRows();

		const footer1 = dom.append(this._bodyEl, $('.pns-row'));
		const addBtn = dom.append(footer1, $('button.pns-btn')) as HTMLButtonElement;
		addBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		addBtn.append(STR_ADD_ROW);
		this._register(dom.addDisposableListener(addBtn, 'click', () => {
			this._words.push({ uuid: generateUuid(), surface: '', pronunciation: '', accentType: 0, wordType: 'PROPER_NOUN', priority: 5 });
			renderRows();
		}));
		dom.append(footer1, $('.pns-row-hint')).textContent = STR_ACCENT_HINT;

		this._bodyEl.appendChild(errorEl);

		const footer = dom.append(dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

		const saveBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		saveBtn.textContent = STR_SAVE;
		this._register(dom.addDisposableListener(saveBtn, 'click', async () => {
			errorEl.textContent = '';
			if (!this._name.trim()) {
				errorEl.textContent = STR_ERR_NAME_EMPTY;
				return;
			}
			for (let i = 0; i < this._words.length; i++) {
				const w = this._words[i];
				if (!w.surface.trim()) {
					errorEl.textContent = strErrSurfaceEmpty(i + 1);
					return;
				}
				if (!w.pronunciation.trim()) {
					errorEl.textContent = strErrPronunciationEmpty(i + 1);
					return;
				}
				if (!KATAKANA_RE.test(w.pronunciation.trim())) {
					errorEl.textContent = strErrKatakana(i + 1);
					return;
				}
			}
			saveBtn.disabled = true;
			saveBtn.textContent = STR_SAVING;
			const words: IParadisAivisDictionaryWord[] = this._words.map(w => ({
				uuid: w.uuid,
				surface: [w.surface.trim()],
				pronunciation: [w.pronunciation.trim()],
				accent_type: [Math.max(0, Math.floor(w.accentType))],
				word_type: w.wordType,
				priority: Math.max(0, Math.min(10, Math.floor(w.priority))),
			}));
			try {
				await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('updateAivisDictionary', [this.apiKey, this.uuid, this._name.trim(), this._description.trim(), words]);
				this.onSaved();
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				saveBtn.disabled = false;
				saveBtn.textContent = STR_SAVE;
			}
		}));
	}

	private _renderWordRow(tbody: HTMLElement, index: number, rerender: () => void): void {
		const word = this._words[index];
		const row = dom.append(tbody, $('tr'));

		const surfaceCell = dom.append(row, $('td'));
		const surfaceInput = dom.append(surfaceCell, $('input')) as HTMLInputElement;
		surfaceInput.value = word.surface;
		this._rowDisposables.add(dom.addDisposableListener(surfaceInput, 'input', () => { word.surface = surfaceInput.value; }));

		const pronunciationCell = dom.append(row, $('td'));
		const pronunciationInput = dom.append(pronunciationCell, $('input')) as HTMLInputElement;
		pronunciationInput.value = word.pronunciation;
		this._rowDisposables.add(dom.addDisposableListener(pronunciationInput, 'input', () => { word.pronunciation = pronunciationInput.value; }));

		const accentCell = dom.append(row, $('td'));
		const accentInput = dom.append(accentCell, $('input')) as HTMLInputElement;
		accentInput.type = 'number';
		accentInput.min = '0';
		accentInput.value = String(word.accentType);
		this._rowDisposables.add(dom.addDisposableListener(accentInput, 'input', () => { word.accentType = Number(accentInput.value) || 0; }));

		const priorityCell = dom.append(row, $('td'));
		const priorityInput = dom.append(priorityCell, $('input')) as HTMLInputElement;
		priorityInput.type = 'number';
		priorityInput.min = '0';
		priorityInput.max = '10';
		priorityInput.value = String(word.priority);
		this._rowDisposables.add(dom.addDisposableListener(priorityInput, 'input', () => { word.priority = Number(priorityInput.value) || 0; }));

		const typeCell = dom.append(row, $('td'));
		const typeSelect = dom.append(typeCell, $('select')) as HTMLSelectElement;
		for (const type of PARADIS_AIVIS_WORD_TYPES) {
			const option = dom.append(typeSelect, $('option')) as HTMLOptionElement;
			option.value = type.value;
			option.textContent = type.label;
		}
		typeSelect.value = word.wordType;
		this._rowDisposables.add(dom.addDisposableListener(typeSelect, 'change', () => { word.wordType = typeSelect.value as ParadisAivisWordType; }));

		const removeCell = dom.append(row, $('td'));
		const removeBtn = dom.append(removeCell, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		removeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		this._rowDisposables.add(dom.addDisposableListener(removeBtn, 'click', () => {
			this._words.splice(index, 1);
			rerender();
		}));
	}

	override dispose(): void {
		this._backdrop.remove();
		super.dispose();
	}
}

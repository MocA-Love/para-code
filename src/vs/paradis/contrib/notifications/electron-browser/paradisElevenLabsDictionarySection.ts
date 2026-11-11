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
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
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
import { paradisPreserveScroll, ParadisSectionFocusCarrier, paradisSetFocusKey } from './paradisNotificationSettingsDomUtils.js';
import { ParadisModalSize } from '../../../browser/paradisModal.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { paradisNotifNestedModal } from './paradisNotificationNestedModal.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { PARADIS_MODAL_DRAFT_RESTORED, paradisModalDraftSnapshot, ParadisModalDrafts } from '../../paradisSettings/browser/paradisModalDrafts.js';
import { paradisNotifButton } from './paradisNotificationKitParts.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';

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
	/** 描き直しで作り直されたボタンへフォーカスを引き継ぐ（入れ子の箱を閉じた後の戻し先も探す）。 */
	private readonly _focus: ParadisSectionFocusCarrier;
	private readonly _nestedDialog = this._register(new MutableDisposable<Disposable>());
	private _actionErrorEl: HTMLElement | undefined;

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILogService private readonly logService: ILogService,
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
		this._focus = new ParadisSectionFocusCarrier(this.container);
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
		this._focus.capture();
		let listPending = false;
		paradisPreserveScroll(this.container, () => { listPending = this._renderBody(); });
		this._focus.restore(!listPending);
	}

	/** 一覧を後から（取得の後に）足すときは true を返す。 */
	private _renderBody(): boolean {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		const settings = this.settingsService.getAivisSettings();
		if (settings.engine !== 'elevenlabs') {
			return false;
		}
		const apiKey = settings.elevenLabsApiKey;

		const header = dom.append(this.container, $('.setting-row'));
		const titles = dom.append(header, $('.sr-main'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;
		const newBtn = paradisNotifButton(header, 'secondary', { icon: Codicon.add, label: STR_NEW });
		paradisSetFocusKey(newBtn, 'new');
		newBtn.disabled = !apiKey;
		this._renderDisposables.add(dom.addDisposableListener(newBtn, 'click', () => this._openEditor(apiKey, undefined)));

		if (!apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return false;
		}

		// 書き出し・削除の失敗はここに出す。
		this._actionErrorEl = dom.append(this.container, $('.pns-error'));
		const listEl = dom.append(this.container, $('div'));
		const cached = paradisElevenLabsDictionaryCache.get(apiKey);
		if (cached) {
			this._populateList(listEl, cached, apiKey, settings.elevenLabsDictionaryId);
			return false;
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
			this._focus.restore(true);
		});
		return true;
	}

	private _populateList(listEl: HTMLElement, list: readonly IParadisElevenLabsDictionaryListItem[], apiKey: string, activeId: string): void {
		dom.clearNode(listEl);
		if (list.length === 0) {
			dom.append(listEl, $('.pns-empty')).textContent = STR_EMPTY;
			this._focus.restore(true);
			return;
		}
		for (const dict of list) {
			this._renderCard(listEl, dict, apiKey, activeId);
		}
		this._focus.restore(true);
	}

	private _renderCard(container: HTMLElement, dict: IParadisElevenLabsDictionaryListItem, apiKey: string, activeId: string): void {
		const isActive = dict.id === activeId;
		const card = dom.append(container, $('.pns-dict-card'));
		card.classList.toggle('active', isActive);
		const top = dom.append(card, $('.pns-row'));
		top.style.marginBottom = '0';
		const infoEl = dom.append(top, $('.pns-dict-info'));
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

		const actions = dom.append(top, $('.pns-dict-actions'));

		if (!isActive) {
			const applyBtn = paradisNotifButton(actions, 'secondary', { label: STR_APPLY });
			paradisSetFocusKey(applyBtn, `apply:${dict.id}`);
			this._renderDisposables.add(dom.addDisposableListener(applyBtn, 'click', () => {
				this.settingsService.setAivisSettings({ elevenLabsDictionaryId: dict.id });
			}));
		}
		const editBtn = paradisNotifButton(actions, 'secondary', { label: STR_EDIT });
		paradisSetFocusKey(editBtn, `edit:${dict.id}`);
		this._renderDisposables.add(dom.addDisposableListener(editBtn, 'click', () => this._openEditor(apiKey, dict)));

		const hover = { service: this.hoverService, store: this._renderDisposables };
		const exportBtn = paradisNotifButton(actions, 'icon', { icon: Codicon.arrowDown, title: STR_EXPORT, hover });
		paradisSetFocusKey(exportBtn, `export:${dict.id}`);
		this._renderDisposables.add(dom.addDisposableListener(exportBtn, 'click', () => this._export(apiKey, dict)));

		const deleteBtn = paradisNotifButton(actions, 'icon', { icon: Codicon.trash, title: STR_DELETE, className: 'pns-delete', hover });
		paradisSetFocusKey(deleteBtn, `delete:${dict.id}`);
		this._renderDisposables.add(dom.addDisposableListener(deleteBtn, 'click', () => this._delete(apiKey, dict, isActive)));
	}

	private async _export(apiKey: string, dict: IParadisElevenLabsDictionaryListItem): Promise<void> {
		if (this._actionErrorEl) {
			this._actionErrorEl.textContent = '';
		}
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
			this._showActionError(error);
		}
	}

	private async _delete(apiKey: string, dict: IParadisElevenLabsDictionaryListItem, wasActive: boolean): Promise<void> {
		const { confirmed } = await this.paradisDialogService.confirm({
			destructive: true,
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
			this._showActionError(error);
		}
	}

	private _showActionError(error: unknown): void {
		if (this._actionErrorEl?.isConnected) {
			this._actionErrorEl.textContent = error instanceof Error ? error.message : String(error);
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
		}, () => this._focus.find(dict ? `edit:${dict.id}` : 'new'));
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
const STR_REMOVE_ROW = localize('paradis.notif.elevenlabsDict.removeRow', "行を消す");
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

/** 辞書の作成・編集の中身（保存前の下書き・読み込んだときの写しに使う）。他のツールで作った規則は入れない（開くたびに読み直す）。 */
interface IElevenLabsEditorState {
	readonly name: string;
	readonly description: string;
	readonly rows: readonly IEditableRow[];
}

/**
 * 保存せずに閉じた辞書の作成・編集（`create` または `edit:<辞書の ID>` → 中身）。別のモーダルを開いたときや Hub ごと
 * 閉じたときに打ちかけの入力を覚えておき、次に同じ辞書（作成なら作成）を開いたときに戻す。「キャンセル」と保存で捨てる。
 */
const elevenLabsEditorDrafts = new ParadisModalDrafts<IElevenLabsEditorState>();

export class ParadisElevenLabsDictionaryEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _bodyEl: HTMLElement;
	private readonly _rowDisposables = this._register(new DisposableStore());
	private _rows: IEditableRow[] = [];
	private _existingRules: readonly ParadisElevenLabsRule[] = [];
	private _name = '';
	private _description = '';
	/** 読み込んだときの中身（保存前の変更があるかを比べる）。読み込む前は undefined。 */
	private _loaded: string | undefined;
	/** 「キャンセル」と保存で閉じるときは、下書きを残さない。 */
	private _discardOnClose = false;
	private _closed = false;
	private readonly _footEl: HTMLElement;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly apiKey: string,
		private readonly dict: IParadisElevenLabsDictionaryListItem | undefined,
		/** 保存できたら呼ぶ。新しく作った場合はその ID を渡す。 */
		private readonly onSaved: (createdId: string | undefined) => void,
		/** 閉じるときに、開いたボタンが描き直しで外れていたら代わりに戻す先（{@link ParadisSectionFocusCarrier.find}）。 */
		restoreFallback?: () => HTMLElement | undefined,
	) {
		super();

		// 辞書の編集は段 M の箱（Q537 の 43 A）。表は本文の中でスクロールする
		const { backdrop, modal: dialog, close, body, foot } = paradisNotifNestedModal(ParadisModalSize.Medium, dict ? STR_EDIT_TITLE : STR_CREATE_TITLE);
		this._backdrop = backdrop;
		this._footEl = foot;
		this._register(dom.addDisposableListener(close, 'click', () => this.dispose()));
		dom.append(body, $('.pns-nested-desc')).textContent = STR_EDIT_DESC;
		this._bodyEl = dom.append(body, $('div'));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));
		// フォーカスと Esc は fork のモーダルに共通の扱いに乗せる。Hub の中から開く入れ子の箱なので Hub は閉じない。
		// 別のモーダルに閉じられたとき・Esc・外側の押下では、保存前の変更を下書きとして残す（dispose）
		dialog.tabIndex = -1;
		this._register(new ParadisModalFocus({ backdrop: this._backdrop, modal: dialog, nested: true, onEscape: () => this.dispose(), close: () => this.dispose(), restoreFallback }));
		layoutService.activeContainer.appendChild(this._backdrop);
		dialog.focus();

		if (!dict) {
			this._rows = [{ surface: '', reading: '' }];
			this._restoreDraftAndRender();
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
			this._restoreDraftAndRender();
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(this._bodyEl);
			dom.append(this._bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private get _draftKey(): string {
		return this.dict ? `edit:${this.dict.id}` : 'create';
	}

	private _state(): IElevenLabsEditorState {
		return { name: this._name, description: this._description, rows: this._rows };
	}

	/** 読み込んだ中身を写しに取り、下書きがあれば中身をそれに置き換えて描く。 */
	private _restoreDraftAndRender(): void {
		this._loaded = paradisModalDraftSnapshot(this._state());
		const draft = elevenLabsEditorDrafts.take(this._draftKey);
		if (draft) {
			// 名前と説明は作るときだけ入力できる。編集では読み込んだ名前を出す
			if (!this.dict) {
				this._name = draft.name;
				this._description = draft.description;
			}
			this._rows = [...draft.rows];
		}
		this._renderBody();
		if (draft) {
			this._bodyEl.prepend($('.pns-nested-desc', undefined, PARADIS_MODAL_DRAFT_RESTORED));
		}
	}

	private _renderBody(): void {
		dom.clearNode(this._bodyEl);
		const isNew = !this.dict;

		const nameRow = dom.append(this._bodyEl, $('.pns-field'));
		dom.append(nameRow, $('label.pns-label')).textContent = STR_NAME_LABEL;
		if (isNew) {
			const nameInput = this._register(new ParadisInputField(nameRow, { ariaLabel: STR_NAME_LABEL })).inputElement;
			nameInput.value = this._name;
			nameInput.maxLength = 100;
			this._register(dom.addDisposableListener(nameInput, 'input', () => { this._name = nameInput.value; }));
			const descRow = dom.append(this._bodyEl, $('.pns-field'));
			dom.append(descRow, $('label.pns-label')).textContent = STR_DESCRIPTION_LABEL;
			const descInput = this._register(new ParadisInputField(descRow, { ariaLabel: STR_DESCRIPTION_LABEL })).inputElement;
			descInput.value = this._description;
			descInput.maxLength = 500;
			this._register(dom.addDisposableListener(descInput, 'input', () => { this._description = descInput.value; }));
			nameInput.focus();
		} else {
			// 名前と説明は作るときだけ決める（規則の置き換えとは別の API になるため、ここでは変えない）。
			dom.append(nameRow, $('div')).textContent = this._name;
		}

		const table = dom.append(dom.append(this._bodyEl, $('.pns-table-scroll')), $('table.pns-dict-table'));
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
		const addBtn = this._register(new ParadisButton(addRow, { kind: 'secondary', icon: Codicon.add, label: STR_ADD_ROW }));
		this._register(addBtn.onDidClick(() => {
			this._rows.push({ surface: '', reading: '' });
			renderRows();
		}));
		const phonemeCount = this._existingRules.filter(rule => rule.type === 'phoneme').length;
		if (phonemeCount > 0) {
			dom.append(addRow, $('.pns-row-hint')).textContent = strKeptPhonemes(phonemeCount);
		}

		const errorEl = dom.append(this._bodyEl, $('.pns-error'));

		const cancelBtn = this._register(new ParadisButton(this._footEl, { kind: 'secondary', label: STR_CANCEL }));
		this._register(cancelBtn.onDidClick(() => {
			this._discardOnClose = true;
			this.dispose();
		}));
		const saveBtn = this._register(new ParadisButton(this._footEl, { kind: 'primary', label: STR_SAVE }));
		this._register(saveBtn.onDidClick(async () => {
			if (!saveBtn.enabled) {
				return;
			}
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
			saveBtn.enabled = false;
			saveBtn.label = STR_SAVING;
			try {
				const channel = this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
				if (this.dict) {
					await channel.call('setElevenLabsDictionaryRules', [this.apiKey, this.dict.id, rules]);
					this._discardOnClose = true;
					this.onSaved(undefined);
				} else {
					const created = await channel.call<{ id: string }>('createElevenLabsDictionary', [this.apiKey, this._name.trim(), this._description.trim(), rules]);
					this._discardOnClose = true;
					this.onSaved(created.id);
				}
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				saveBtn.enabled = true;
				saveBtn.label = STR_SAVE;
			}
		}));
	}

	private _renderRow(tbody: HTMLElement, index: number, rerender: () => void): void {
		const row = this._rows[index];
		const tr = dom.append(tbody, $('tr'));
		const surfaceInput = this._rowDisposables.add(new ParadisInputField(dom.append(tr, $('td')), { ariaLabel: STR_COL_SURFACE, small: true })).inputElement;
		surfaceInput.value = row.surface;
		this._rowDisposables.add(dom.addDisposableListener(surfaceInput, 'input', () => { row.surface = surfaceInput.value; }));
		const readingInput = this._rowDisposables.add(new ParadisInputField(dom.append(tr, $('td')), { ariaLabel: STR_COL_READING, small: true })).inputElement;
		readingInput.value = row.reading;
		this._rowDisposables.add(dom.addDisposableListener(readingInput, 'input', () => { row.reading = readingInput.value; }));
		const removeBtn = this._rowDisposables.add(new ParadisButton(dom.append(tr, $('td')), { kind: 'icon', small: true, icon: Codicon.close, title: STR_REMOVE_ROW, ariaLabel: STR_REMOVE_ROW }));
		this._rowDisposables.add(removeBtn.onDidClick(() => {
			this._rows.splice(index, 1);
			rerender();
		}));
	}

	override dispose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		// 読み込んだときから変わっていれば、下書きとして残す（「キャンセル」・保存のときは捨てる）
		if (this._discardOnClose) {
			elevenLabsEditorDrafts.discard(this._draftKey);
		} else {
			elevenLabsEditorDrafts.keepIfChanged(this._draftKey, this._state(), this._loaded);
		}
		this._backdrop.remove();
		super.dispose();
	}
}

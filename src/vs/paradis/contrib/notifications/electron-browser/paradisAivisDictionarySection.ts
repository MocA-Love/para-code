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
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
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
import { getCachedAivisDictionaryList, invalidateAivisDictionaryListCache, setCachedAivisDictionaryList } from './paradisAivisApiCache.js';
import { paradisPreserveScroll, ParadisSectionFocusCarrier, paradisSetFocusKey } from './paradisNotificationSettingsDomUtils.js';
import { ParadisModalSize } from '../../../browser/paradisModal.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import { ParadisInputField } from '../../../browser/paradisInputField.js';
import { paradisNotifNestedModal } from './paradisNotificationNestedModal.js';
import { ParadisSelect } from '../../../browser/paradisSelect.js';
import { ParadisModalFocus } from '../../paradisSettings/browser/paradisModalFocus.js';
import { PARADIS_MODAL_DRAFT_RESTORED, paradisModalDraftSnapshot, ParadisModalDrafts } from '../../paradisSettings/browser/paradisModalDrafts.js';
import { paradisNotifButton, paradisNotifChip } from './paradisNotificationKitParts.js';
import { paradisNotifSafeFileName, paradisNotifSaveTextFile } from './paradisNotificationSaveFile.js';
import { IParadisDialogService } from '../../confirmDialog/browser/paradisDialogService.js';

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
const STR_IMPORT = localize('paradis.notif.dict.import', "読み込み (JSON)");
const STR_EXPORT = localize('paradis.notif.dict.export', "書き出し (JSON)");
const STR_DELETE = localize('paradis.notif.dict.delete', "削除");

export class ParadisAivisDictionarySection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	/** 描き直しで作り直されたボタンへフォーカスを引き継ぐ（入れ子の箱を閉じた後の戻し先も探す）。 */
	private readonly _focus: ParadisSectionFocusCarrier;
	private readonly _fileInput: HTMLInputElement;
	private _importTargetUuid: string | undefined;
	/** 取り込み・書き出し・削除の失敗を出す欄（描き直すたびに作り直す）。 */
	private _actionErrorEl: HTMLElement | undefined;
	// 新規作成/編集ダイアログは同時に1つしか開かない前提。開くたびに差し替えて、
	// 閉じた（自己dispose済みの）ダイアログ参照をセクション本体の store に溜めない。
	private readonly _nestedDialog = this._register(new MutableDisposable<Disposable>());

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IParadisDialogService private readonly paradisDialogService: IParadisDialogService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ILogService private readonly logService: ILogService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._focus = new ParadisSectionFocusCarrier(this.container);

		this._fileInput = document.createElement('input');
		this._fileInput.type = 'file';
		this._fileInput.accept = 'application/json,.json';
		this._fileInput.style.display = 'none';
		this._register(dom.addDisposableListener(this._fileInput, 'change', () => this._handleImportFile()));

		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'aivis') {
				this._render();
			}
		}));
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
		this._focus.capture();
		let listPending = false;
		paradisPreserveScroll(this.container, () => { listPending = this._renderBody(); });
		this._focus.restore(!listPending);
	}

	/** 一覧を後から（取得の後に）足すときは true を返す。 */
	private _renderBody(): boolean {
		dom.clearNode(this.container);
		this._renderDisposables.clear();

		// 読み上げエンジンが ElevenLabs のときは ElevenLabs 用のセクションが描く。こちらは空にして API も叩かない。
		if (this.settingsService.getAivisSettings().engine !== 'aivis') {
			return false;
		}

		const header = dom.append(this.container, $('.setting-row'));
		const titles = dom.append(header, $('.sr-main'));
		dom.append(titles, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(titles, $('.pns-section-desc')).textContent = STR_DESC;

		const settings = this.settingsService.getAivisSettings();
		const newBtn = paradisNotifButton(header, 'secondary', { icon: Codicon.add, label: STR_NEW });
		paradisSetFocusKey(newBtn, 'new');
		newBtn.disabled = !settings.apiKey;
		this._renderDisposables.add(dom.addDisposableListener(newBtn, 'click', () => this._openCreateDialog()));

		this.container.appendChild(this._fileInput);

		if (!settings.apiKey) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_NO_KEY;
			return false;
		}

		// 取り込み・書き出し・削除の失敗はここに出す。
		this._actionErrorEl = dom.append(this.container, $('.pns-error'));
		const listEl = dom.append(this.container, $('div'));

		// フォーマット文字列の編集やスライダー操作などリストと無関係な 'aivis' スコープの変更でも
		// このセクションは再描画されるため、既にキャッシュ済みならAPIを叩き直さず同期的に描画する
		// （毎回「読み込み中…」に戻って本文高さが変動し、スクロール位置がずれるのを防ぐ）。
		const cached = getCachedAivisDictionaryList(settings.apiKey);
		if (cached) {
			this._populateList(listEl, cached, settings.apiKey, settings.userDictionaryUuid);
			return false;
		}

		listEl.textContent = STR_LOADING;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisDictionaryListItem[]>('listAivisDictionaries', [settings.apiKey]).then(list => {
			if (this._store.isDisposed) {
				return;
			}
			setCachedAivisDictionaryList(settings.apiKey, list);
			this._populateList(listEl, list, settings.apiKey, settings.userDictionaryUuid);
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(listEl);
			dom.append(listEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
			this._focus.restore(true);
		});
		return true;
	}

	private _populateList(listEl: HTMLElement, list: readonly IParadisAivisDictionaryListItem[], apiKey: string, activeUuid: string): void {
		dom.clearNode(listEl);
		if (list.length === 0) {
			dom.append(listEl, $('.pns-empty')).textContent = STR_EMPTY;
			this._focus.restore(true);
			return;
		}
		for (const dict of list) {
			this._renderCard(listEl, dict, apiKey, activeUuid);
		}
		this._focus.restore(true);
	}

	private _renderCard(container: HTMLElement, dict: IParadisAivisDictionaryListItem, apiKey: string, activeUuid: string): void {
		const isActive = dict.uuid === activeUuid;
		const card = dom.append(container, $('.pns-dict-card'));
		if (isActive) {
			card.classList.add('active');
		}
		const top = dom.append(card, $('.pns-row'));
		top.style.marginBottom = '0';
		const infoEl = dom.append(top, $('.pns-dict-info'));
		const nameRow = dom.append(infoEl, $('.pns-ringtone-name'));
		dom.append(nameRow, $('span')).textContent = dict.name;
		if (isActive) {
			paradisNotifChip(nameRow, STR_ACTIVE_BADGE, 'success');
		}
		const descLine = dom.append(infoEl, $('.pns-ringtone-desc'));
		descLine.textContent = `${dict.description || '—'} · ${dict.word_count} words · ${dict.updated_at.slice(0, 10)}`;

		const actions = dom.append(top, $('.pns-dict-actions'));

		if (!isActive) {
			const applyBtn = paradisNotifButton(actions, 'secondary', { label: STR_APPLY });
			paradisSetFocusKey(applyBtn, `apply:${dict.uuid}`);
			this._renderDisposables.add(dom.addDisposableListener(applyBtn, 'click', () => {
				this.settingsService.setAivisSettings({ userDictionaryUuid: dict.uuid });
			}));
		}

		const editBtn = paradisNotifButton(actions, 'secondary', { label: STR_EDIT });
		paradisSetFocusKey(editBtn, `edit:${dict.uuid}`);
		this._renderDisposables.add(dom.addDisposableListener(editBtn, 'click', () => this._openEditDialog(dict.uuid, apiKey)));

		const hover = { service: this.hoverService, store: this._renderDisposables };
		const importBtn = paradisNotifButton(actions, 'icon', { icon: Codicon.arrowUp, title: STR_IMPORT, hover });
		paradisSetFocusKey(importBtn, `import:${dict.uuid}`);
		this._renderDisposables.add(dom.addDisposableListener(importBtn, 'click', () => {
			this._importTargetUuid = dict.uuid;
			this._fileInput.click();
		}));

		const exportBtn = paradisNotifButton(actions, 'icon', { icon: Codicon.arrowDown, title: STR_EXPORT, hover });
		paradisSetFocusKey(exportBtn, `export:${dict.uuid}`);
		this._renderDisposables.add(dom.addDisposableListener(exportBtn, 'click', () => this._exportDictionary(dict.uuid, dict.name, apiKey)));

		const deleteBtn = paradisNotifButton(actions, 'icon', { icon: Codicon.trash, title: STR_DELETE, className: 'pns-delete', hover });
		paradisSetFocusKey(deleteBtn, `delete:${dict.uuid}`);
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
		this._clearActionError();
		try {
			const text = await file.text();
			const data = JSON.parse(text);
			if (typeof data !== 'object' || Array.isArray(data) || data === null) {
				// allow-any-unicode-next-line
				throw new Error('AivisSpeech 互換の JSON オブジェクトを選択してください');
			}
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('importAivisDictionary', [settings.apiKey, targetUuid, data, false]);
			invalidateAivisDictionaryListCache(settings.apiKey);
			this._render();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary import failed', error);
			this._showActionError(error);
		}
	}

	private async _exportDictionary(uuid: string, name: string, apiKey: string): Promise<void> {
		this._clearActionError();
		try {
			const data = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<Record<string, unknown>>('exportAivisDictionary', [apiKey, uuid]);
			await paradisNotifSaveTextFile(this.fileDialogService, this.fileService, `${paradisNotifSafeFileName(name, 'dictionary')}.aivisspeech.json`, JSON.stringify(data, null, 2), [{ name: 'AivisSpeech JSON', extensions: ['json'] }]);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary export failed', error);
			this._showActionError(error);
		}
	}

	private async _deleteDictionary(uuid: string, name: string, apiKey: string, wasActive: boolean): Promise<void> {
		const { confirmed } = await this.paradisDialogService.confirm({
			destructive: true,
			message: STR_DELETE_CONFIRM_TITLE(name),
			primaryButton: STR_DELETE_CONFIRM_PRIMARY,
		});
		if (!confirmed) {
			return;
		}
		this._clearActionError();
		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('deleteAivisDictionary', [apiKey, uuid]);
			invalidateAivisDictionaryListCache(apiKey);
			if (wasActive) {
				this.settingsService.setAivisSettings({ userDictionaryUuid: '' });
			}
			this._render();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] dictionary delete failed', error);
			this._showActionError(error);
		}
	}

	private _clearActionError(): void {
		if (this._actionErrorEl) {
			this._actionErrorEl.textContent = '';
		}
	}

	private _showActionError(error: unknown): void {
		if (this._actionErrorEl?.isConnected) {
			this._actionErrorEl.textContent = error instanceof Error ? error.message : String(error);
		}
	}

	private _openCreateDialog(): void {
		const settings = this.settingsService.getAivisSettings();
		const dialog = new ParadisCreateDictionaryDialog(this.layoutService, this.sharedProcessService, settings.apiKey, uuid => {
			invalidateAivisDictionaryListCache(settings.apiKey);
			this._render();
			// 作った辞書の編集は「新規辞書」から続く流れなので、閉じたら「新規辞書」へ戻す
			this._openEditDialog(uuid, settings.apiKey, 'new');
		}, () => this._focus.find('new'));
		this._nestedDialog.value = dialog;
	}

	private _openEditDialog(uuid: string, apiKey: string, openerKey = `edit:${uuid}`): void {
		const dialog = new ParadisDictionaryEditorDialog(this.layoutService, this.sharedProcessService, uuid, apiKey, () => {
			invalidateAivisDictionaryListCache(apiKey);
			this._render();
		}, this.contextViewService, this.configurationService, () => this._focus.find(openerKey));
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

/** 新規辞書の箱の中身（保存前の下書き）。 */
interface ICreateDictionaryState {
	readonly name: string;
	readonly description: string;
}

/** 作成せずに閉じた新規辞書の箱の入力。辞書はまだ無いので、キーは 1 つ（{@link CREATE_DRAFT_KEY}）。 */
const createDictionaryDrafts = new ParadisModalDrafts<ICreateDictionaryState>();
const CREATE_DRAFT_KEY = 'create';
const CREATE_EMPTY_SNAPSHOT = paradisModalDraftSnapshot({ name: '', description: '' } satisfies ICreateDictionaryState);

export class ParadisCreateDictionaryDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _nameInput: HTMLInputElement;
	private readonly _descInput: HTMLInputElement;
	/** 「キャンセル」と作成で閉じるときは、下書きを残さない。 */
	private _discardOnClose = false;
	private _closed = false;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly apiKey: string,
		private readonly onCreated: (uuid: string) => void,
		/** 閉じるときに、開いたボタンが描き直しで外れていたら代わりに戻す先（{@link ParadisSectionFocusCarrier.find}）。 */
		restoreFallback?: () => HTMLElement | undefined,
	) {
		super();

		// 名前と説明の 2 欄だけの小さい箱（キットのダイアログの段 S）
		const { backdrop, modal: dialog, close, body, foot } = paradisNotifNestedModal(ParadisModalSize.Small, STR_CREATE_TITLE);
		this._backdrop = backdrop;
		this._register(dom.addDisposableListener(close, 'click', () => this.dispose()));

		const nameField = dom.append(body, $('.pns-field'));
		dom.append(nameField, $('label.pns-label')).textContent = STR_NAME_LABEL;
		const nameInput = this._nameInput = this._register(new ParadisInputField(nameField, { ariaLabel: STR_NAME_LABEL })).inputElement;
		nameInput.maxLength = 100;

		const descField = dom.append(body, $('.pns-field'));
		dom.append(descField, $('label.pns-label')).textContent = STR_DESCRIPTION_LABEL;
		const descInput = this._descInput = this._register(new ParadisInputField(descField, { ariaLabel: STR_DESCRIPTION_LABEL })).inputElement;
		descInput.maxLength = 500;

		const draft = createDictionaryDrafts.take(CREATE_DRAFT_KEY);
		if (draft) {
			nameInput.value = draft.name;
			descInput.value = draft.description;
			dom.append(body, $('.pns-nested-desc')).textContent = PARADIS_MODAL_DRAFT_RESTORED;
		}

		const errorEl = dom.append(body, $('.pns-error'));

		const cancelBtn = this._register(new ParadisButton(foot, { kind: 'secondary', label: STR_CANCEL }));
		this._register(cancelBtn.onDidClick(() => {
			this._discardOnClose = true;
			this.dispose();
		}));

		const createBtn = this._register(new ParadisButton(foot, { kind: 'primary', label: STR_CREATE }));
		this._register(createBtn.onDidClick(async () => {
			const name = nameInput.value.trim();
			if (!name || !createBtn.enabled) {
				return;
			}
			createBtn.enabled = false;
			try {
				const result = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<{ uuid: string }>('createAivisDictionary', [this.apiKey, name, descInput.value.trim()]);
				// 先に閉じてから編集の箱を開く（開いた箱へ移したフォーカスを、この箱の閉じる処理が Hub へ戻さないように）
				this._discardOnClose = true;
				this.dispose();
				this.onCreated(result.uuid);
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				createBtn.enabled = true;
			}
		}));

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));

		// フォーカスと Esc は fork のモーダルに共通の扱いに乗せる。Hub の中から開く入れ子の箱なので Hub は閉じない。
		// 別のモーダルに閉じられたとき・Esc・外側の押下では、作成前の入力を下書きとして残す（dispose）
		dialog.tabIndex = -1;
		this._register(new ParadisModalFocus({ backdrop: this._backdrop, modal: dialog, nested: true, onEscape: () => this.dispose(), close: () => this.dispose(), restoreFallback }));
		layoutService.activeContainer.appendChild(this._backdrop);
		nameInput.focus();
	}

	override dispose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		const state: ICreateDictionaryState = { name: this._nameInput.value, description: this._descInput.value };
		if (this._discardOnClose) {
			createDictionaryDrafts.discard(CREATE_DRAFT_KEY);
		} else {
			createDictionaryDrafts.keepIfChanged(CREATE_DRAFT_KEY, state, CREATE_EMPTY_SNAPSHOT);
		}
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
const STR_REMOVE_ROW = localize('paradis.notif.dict.removeRow', "行を消す");
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

/** 辞書の編集の中身（保存前の下書き・読み込んだときの写しに使う）。 */
interface IDictionaryEditorState {
	readonly name: string;
	readonly description: string;
	readonly words: readonly IWordRow[];
}

/**
 * 保存せずに閉じた辞書の編集（辞書の uuid → 中身）。別のモーダルを開いたとき（コマンドパレットからの紐付けのダイアログなど）や
 * Hub ごと閉じたときに、打ちかけの入力を失わないよう覚えておき、次にその辞書を開いたときに戻す。「キャンセル」と保存で捨てる。
 * このウィンドウを開いている間だけ（ディスクには書かない）。
 */
const dictionaryEditorDrafts = new ParadisModalDrafts<IDictionaryEditorState>();

export class ParadisDictionaryEditorDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _bodyEl: HTMLElement;
	private readonly _footEl: HTMLElement;
	// 行の追加/削除のたびに tbody を作り直すため、行のリスナはこの store に束ねて
	// renderRows 冒頭で clear する（ダイアログ本体の store に無制限に溜めない）。
	private readonly _rowDisposables = this._register(new DisposableStore());
	private _words: IWordRow[] = [];
	private _name = '';
	private _description = '';
	/** 読み込んだときの中身（保存前の変更があるかを比べる）。読み込む前は undefined。 */
	private _loaded: string | undefined;
	/** 「キャンセル」と保存で閉じるときは、下書きを残さない。 */
	private _discardOnClose = false;
	private _closed = false;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly uuid: string,
		private readonly apiKey: string,
		private readonly onSaved: () => void,
		private readonly contextViewService: IContextViewService,
		private readonly configurationService: IConfigurationService,
		/** 閉じるときに、開いたボタンが描き直しで外れていたら代わりに戻す先（{@link ParadisSectionFocusCarrier.find}）。 */
		restoreFallback?: () => HTMLElement | undefined,
	) {
		super();

		// 辞書の編集は段 M の箱（Q537 の 43 A）。表は本文の中でスクロールする
		const { backdrop, modal: dialog, close, body, foot } = paradisNotifNestedModal(ParadisModalSize.Medium, STR_EDIT_TITLE);
		this._backdrop = backdrop;
		this._footEl = foot;
		this._register(dom.addDisposableListener(close, 'click', () => this.dispose()));
		dom.append(body, $('.pns-nested-desc')).textContent = STR_EDIT_DESC;

		this._bodyEl = dom.append(body, $('div'));
		this._bodyEl.textContent = '…';

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
			this._loaded = paradisModalDraftSnapshot(this._state());
			const draft = dictionaryEditorDrafts.take(uuid);
			if (draft) {
				this._name = draft.name;
				this._description = draft.description;
				this._words = [...draft.words];
			}
			this._renderBody();
			if (draft) {
				this._bodyEl.prepend($('.pns-nested-desc', undefined, PARADIS_MODAL_DRAFT_RESTORED));
			}
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			dom.clearNode(this._bodyEl);
			dom.append(this._bodyEl, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
		});
	}

	private _renderBody(): void {
		dom.clearNode(this._bodyEl);

		const nameRow = dom.append(this._bodyEl, $('.pns-field'));
		dom.append(nameRow, $('label.pns-label')).textContent = STR_NAME_LABEL;
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

		const table = dom.append(dom.append(this._bodyEl, $('.pns-table-scroll')), $('table.pns-dict-table'));
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
		const addBtn = this._register(new ParadisButton(footer1, { kind: 'secondary', icon: Codicon.add, label: STR_ADD_ROW }));
		this._register(addBtn.onDidClick(() => {
			this._words.push({ uuid: generateUuid(), surface: '', pronunciation: '', accentType: 0, wordType: 'PROPER_NOUN', priority: 5 });
			renderRows();
		}));
		dom.append(footer1, $('.pns-row-hint')).textContent = STR_ACCENT_HINT;

		this._bodyEl.appendChild(errorEl);

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
			saveBtn.enabled = false;
			saveBtn.label = STR_SAVING;
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
				this._discardOnClose = true;
				this.onSaved();
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				saveBtn.enabled = true;
				saveBtn.label = STR_SAVE;
			}
		}));
	}

	private _renderWordRow(tbody: HTMLElement, index: number, rerender: () => void): void {
		const word = this._words[index];
		const row = dom.append(tbody, $('tr'));

		const surfaceCell = dom.append(row, $('td'));
		const surfaceInput = this._rowDisposables.add(new ParadisInputField(surfaceCell, { ariaLabel: STR_COL_SURFACE, small: true })).inputElement;
		surfaceInput.value = word.surface;
		this._rowDisposables.add(dom.addDisposableListener(surfaceInput, 'input', () => { word.surface = surfaceInput.value; }));

		const pronunciationCell = dom.append(row, $('td'));
		const pronunciationInput = this._rowDisposables.add(new ParadisInputField(pronunciationCell, { ariaLabel: STR_COL_PRONUNCIATION, small: true })).inputElement;
		pronunciationInput.value = word.pronunciation;
		this._rowDisposables.add(dom.addDisposableListener(pronunciationInput, 'input', () => { word.pronunciation = pronunciationInput.value; }));

		const accentCell = dom.append(row, $('td'));
		const accentInput = dom.append(accentCell, $('input')) as HTMLInputElement;
		accentInput.type = 'number';
		accentInput.setAttribute('aria-label', STR_COL_ACCENT);
		accentInput.min = '0';
		accentInput.value = String(word.accentType);
		this._rowDisposables.add(dom.addDisposableListener(accentInput, 'input', () => { word.accentType = Number(accentInput.value) || 0; }));

		const priorityCell = dom.append(row, $('td'));
		const priorityInput = dom.append(priorityCell, $('input')) as HTMLInputElement;
		priorityInput.type = 'number';
		priorityInput.setAttribute('aria-label', STR_COL_PRIORITY);
		priorityInput.min = '0';
		priorityInput.max = '10';
		priorityInput.value = String(word.priority);
		this._rowDisposables.add(dom.addDisposableListener(priorityInput, 'input', () => { word.priority = Number(priorityInput.value) || 0; }));

		const typeCell = dom.append(row, $('td'));
		const typeSelect = this._rowDisposables.add(new ParadisSelect(typeCell, this.contextViewService, this.configurationService,
			PARADIS_AIVIS_WORD_TYPES.map(type => ({ value: type.value, label: type.label })), word.wordType, { ariaLabel: STR_COL_TYPE }));
		this._rowDisposables.add(typeSelect.onDidChange(value => { word.wordType = value as ParadisAivisWordType; }));

		const removeCell = dom.append(row, $('td'));
		const removeBtn = this._rowDisposables.add(new ParadisButton(removeCell, { kind: 'icon', small: true, icon: Codicon.close, title: STR_REMOVE_ROW, ariaLabel: STR_REMOVE_ROW }));
		this._rowDisposables.add(removeBtn.onDidClick(() => {
			this._words.splice(index, 1);
			rerender();
		}));
	}

	private _state(): IDictionaryEditorState {
		return { name: this._name, description: this._description, words: this._words };
	}

	override dispose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		// 読み込んだときから変わっていれば、下書きとして残す（「キャンセル」・保存のときは捨てる）
		if (this._discardOnClose) {
			dictionaryEditorDrafts.discard(this.uuid);
		} else {
			dictionaryEditorDrafts.keepIfChanged(this.uuid, this._state(), this._loaded);
		}
		this._backdrop.remove();
		super.dispose();
	}
}

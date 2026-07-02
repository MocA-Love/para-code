/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「Aivis Voice Announcement」セクション（Superset apps/desktop の
// AivisSettings.tsx の移植）。有効化トグル、音量/speaking rateスライダー、APIキー、
// モデルプリセット、Model UUID、適用辞書、プレースホルダ挿入、完了/許可要求フォーマットを扱う。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisAivisDictionaryListItem,
	IParadisAivisModelPreset,
	IParadisAivisModelSummary,
	PARADIS_AIVIS_BUILTIN_PRESETS,
	PARADIS_AIVIS_PLACEHOLDER_KEYS,
	PARADIS_AIVIS_PLACEHOLDER_LABELS,
	PARADIS_NOTIFICATIONS_CHANNEL,
} from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.aivis.title', "Aivis Voice Announcement");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.aivis.desc', "通知音の後に Aivis API でワークスペース名やブランチ名を音声で読み上げます。");
// allow-any-unicode-next-line
const STR_ENABLE_LABEL = localize('paradis.notif.aivis.enableLabel', "音声報告を有効化");
// allow-any-unicode-next-line
const STR_ENABLE_HINT = localize('paradis.notif.aivis.enableHint', "LLM の動作完了時と許可要求時に音声で通知します。");
// allow-any-unicode-next-line
const STR_VOLUME_LABEL = localize('paradis.notif.aivis.volumeLabel', "音量");
// allow-any-unicode-next-line
const STR_RATE_LABEL = localize('paradis.notif.aivis.rateLabel', "話速");
// allow-any-unicode-next-line
const STR_API_KEY_LABEL = localize('paradis.notif.aivis.apiKeyLabel', "API Key");
// allow-any-unicode-next-line
const STR_TOGGLE_API_KEY_VISIBILITY = localize('paradis.notif.aivis.toggleApiKeyVisibility', "API キーの表示/非表示を切り替え");
// allow-any-unicode-next-line
const STR_MODEL_UUID_LABEL = localize('paradis.notif.aivis.modelUuidLabel', "Model UUID");
// allow-any-unicode-next-line
const STR_DICTIONARY_LABEL = localize('paradis.notif.aivis.dictionaryLabel', "適用するユーザー辞書");
// allow-any-unicode-next-line
const STR_DICTIONARY_NONE = localize('paradis.notif.aivis.dictionaryNone', "— 辞書なし —");
// allow-any-unicode-next-line
const STR_PLACEHOLDER_LABEL = localize('paradis.notif.aivis.placeholderLabel', "プレースホルダ");
// allow-any-unicode-next-line
const STR_FORMAT_LABEL = localize('paradis.notif.aivis.formatLabel', "完了フォーマット");
// allow-any-unicode-next-line
const STR_FORMAT_PERMISSION_LABEL = localize('paradis.notif.aivis.formatPermissionLabel', "許可要求フォーマット");
// allow-any-unicode-next-line
const STR_TEST_PLAY = localize('paradis.notif.aivis.testPlay', "テスト再生");
// allow-any-unicode-next-line
const STR_MODEL_INFO_LOADING = localize('paradis.notif.aivis.modelInfoLoading', "モデル情報を取得中…");
// allow-any-unicode-next-line
const STR_MODEL_INFO_INVALID = localize('paradis.notif.aivis.modelInfoInvalid', "UUID 形式 (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx) で入力してください。");

// allow-any-unicode-next-line
const STR_PRESET_ICON_PLACEHOLDER = '🎙️';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Aivisモデルプリセットのアイコン取得結果キャッシュ (uuid → iconUrl、無ければ null)。
 * モジュールスコープに置くことで、設定ダイアログを閉じて再度開いても再フェッチを避ける。
 */
const presetIconCache = new Map<string, string | null>();

const SAMPLE_PLACEHOLDER_VALUES: Readonly<Record<string, string>> = Object.freeze({
	// allow-any-unicode-next-line
	branch: 'サンプルブランチ',
	// allow-any-unicode-next-line
	workspace: 'サンプルワークスペース',
	// allow-any-unicode-next-line
	worktree: 'サンプルワークツリー',
	// allow-any-unicode-next-line
	project: 'サンプルプロジェクト',
	// allow-any-unicode-next-line
	tab: 'ターミナル',
	// allow-any-unicode-next-line
	pane: 'ペーン1',
});

export class ParadisAivisVoiceSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _activeField: 'format' | 'permission' = 'format';
	private _formatInput: HTMLTextAreaElement | undefined;
	private _formatPermissionInput: HTMLTextAreaElement | undefined;

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(this.settingsService.onDidChange(() => this._render()));
		this._render();
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

		dom.append(this.container, $('.pns-section-title')).textContent = STR_TITLE;
		dom.append(this.container, $('.pns-section-desc')).textContent = STR_DESC;

		const settings = this.settingsService.getAivisSettings();

		const toggleRow = dom.append(this.container, $('.pns-row'));
		const toggleLabels = dom.append(toggleRow, $('div'));
		dom.append(toggleLabels, $('.pns-row-label')).textContent = STR_ENABLE_LABEL;
		dom.append(toggleLabels, $('.pns-row-hint')).textContent = STR_ENABLE_HINT;
		const toggle = dom.append(toggleRow, $('input.pns-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = settings.enabled;
		this._renderDisposables.add(dom.addDisposableListener(toggle, 'change', () => {
			this.settingsService.setAivisSettings({ enabled: toggle.checked });
		}));

		if (!settings.enabled) {
			return;
		}

		this._renderSlider(STR_VOLUME_LABEL, settings.volume, 0, 100, 1, v => `${v}%`, v => this.settingsService.setAivisSettings({ volume: v }));
		this._renderSlider(STR_RATE_LABEL, settings.speakingRate, 0.5, 2.0, 0.1, v => `${v.toFixed(1)}x`, v => this.settingsService.setAivisSettings({ speakingRate: v }));

		const apiKeyField = this._field(STR_API_KEY_LABEL);
		const apiKeyRow = dom.append(apiKeyField, $('.pns-input-group'));
		const apiKeyInput = dom.append(apiKeyRow, $('input')) as HTMLInputElement;
		apiKeyInput.type = 'password';
		apiKeyInput.autocomplete = 'off';
		apiKeyInput.placeholder = 'aivis_...';
		apiKeyInput.value = settings.apiKey;
		this._renderDisposables.add(dom.addDisposableListener(apiKeyInput, 'blur', () => {
			this.settingsService.setAivisSettings({ apiKey: apiKeyInput.value });
		}));
		const toggleVisibilityBtn = dom.append(apiKeyRow, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		toggleVisibilityBtn.setAttribute('aria-label', STR_TOGGLE_API_KEY_VISIBILITY);
		toggleVisibilityBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.eye)}`));
		this._renderDisposables.add(dom.addDisposableListener(toggleVisibilityBtn, 'click', () => {
			const willShow = apiKeyInput.type === 'password';
			apiKeyInput.type = willShow ? 'text' : 'password';
			dom.clearNode(toggleVisibilityBtn);
			toggleVisibilityBtn.appendChild($(`span${ThemeIcon.asCSSSelector(willShow ? Codicon.eyeClosed : Codicon.eye)}`));
		}));

		this._renderPresetTiles(settings.modelUuid, settings.apiKey);

		const modelUuidField = this._field(STR_MODEL_UUID_LABEL);
		const modelUuidInput = dom.append(modelUuidField, $('input')) as HTMLInputElement;
		modelUuidInput.placeholder = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
		modelUuidInput.value = settings.modelUuid;
		this._renderDisposables.add(dom.addDisposableListener(modelUuidInput, 'blur', () => {
			this.settingsService.setAivisSettings({ modelUuid: modelUuidInput.value.trim() });
		}));
		const modelInfoEl = dom.append(modelUuidField, $('.pns-row-hint'));
		this._renderModelInfo(modelInfoEl, settings.modelUuid, settings.apiKey);

		this._renderDictionarySelect(settings);

		// --- プレースホルダ ---
		const placeholderField = this._field(STR_PLACEHOLDER_LABEL);
		const chipRow = dom.append(placeholderField, $('.pns-chip-row'));
		for (const key of PARADIS_AIVIS_PLACEHOLDER_KEYS) {
			const chip = dom.append(chipRow, $('button.pns-btn')) as HTMLButtonElement;
			chip.textContent = `{{${key}}} / ${PARADIS_AIVIS_PLACEHOLDER_LABELS[key]}`;
			this._renderDisposables.add(dom.addDisposableListener(chip, 'click', () => this._insertPlaceholder(key)));
		}

		// --- 完了フォーマット ---
		this._formatInput = this._renderFormatField(STR_FORMAT_LABEL, settings.format, 'format', next => this.settingsService.setAivisSettings({ format: next }), () => this._testPlay('complete'));
		// --- 許可要求フォーマット ---
		this._formatPermissionInput = this._renderFormatField(STR_FORMAT_PERMISSION_LABEL, settings.formatPermission, 'permission', next => this.settingsService.setAivisSettings({ formatPermission: next }), () => this._testPlay('permission'));
	}

	private _field(labelText: string): HTMLElement {
		const field = dom.append(this.container, $('.pns-field'));
		dom.append(field, $('label.pns-label')).textContent = labelText;
		return field;
	}

	private _renderSlider(labelText: string, value: number, min: number, max: number, step: number, format: (v: number) => string, onCommit: (v: number) => void): void {
		const field = dom.append(this.container, $('.pns-field'));
		const label = dom.append(field, $('label.pns-label'));
		label.textContent = `${labelText}: ${format(value)}`;
		const slider = dom.append(field, $('input')) as HTMLInputElement;
		slider.type = 'range';
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(value);
		this._renderDisposables.add(dom.addDisposableListener(slider, 'input', () => {
			label.textContent = `${labelText}: ${format(Number(slider.value))}`;
		}));
		this._renderDisposables.add(dom.addDisposableListener(slider, 'change', () => {
			onCommit(Number(slider.value));
		}));
	}

	private _renderPresetTiles(currentModelUuid: string, apiKey: string): void {
		const field = dom.append(this.container, $('.pns-field'));
		const grid = dom.append(field, $('.pns-preset-grid'));
		const presets: readonly IParadisAivisModelPreset[] = [...PARADIS_AIVIS_BUILTIN_PRESETS, ...this.settingsService.getCustomAivisModelPresets()];
		for (const preset of presets) {
			const tile = dom.append(grid, $('.pns-preset-tile'));
			if (preset.uuid === currentModelUuid) {
				tile.classList.add('selected');
			}
			const iconWrap = dom.append(tile, $('.pns-preset-icon'));
			iconWrap.textContent = STR_PRESET_ICON_PLACEHOLDER;
			this._renderPresetIcon(iconWrap, preset.uuid, apiKey);
			dom.append(tile, $('.pns-preset-name')).textContent = preset.name;
			dom.append(tile, $('.pns-preset-author')).textContent = preset.authorName;
			this._renderDisposables.add(dom.addDisposableListener(tile, 'click', () => {
				this.settingsService.setAivisSettings({ modelUuid: preset.uuid });
			}));
		}
	}

	/**
	 * プリセットタイルのアイコンをAivis API (`getAivisModel`)から取得して表示する。
	 * 取得結果（成功・失敗いずれも）はモジュールスコープの `presetIconCache` にキャッシュし、
	 * ダイアログの再オープンやセクションの再描画をまたいで再取得を避ける。
	 */
	private _renderPresetIcon(iconWrap: HTMLElement, uuid: string, apiKey: string): void {
		if (!apiKey) {
			return; // プレースホルダのまま
		}
		const cached = presetIconCache.get(uuid);
		if (cached !== undefined) {
			this._applyPresetIcon(iconWrap, cached);
			return;
		}
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisModelSummary | null>('getAivisModel', [apiKey, uuid]).then(model => {
			const iconUrl = model?.iconUrl ?? null;
			presetIconCache.set(uuid, iconUrl);
			if (!this._store.isDisposed && iconWrap.isConnected) {
				this._applyPresetIcon(iconWrap, iconUrl);
			}
		}, error => {
			presetIconCache.set(uuid, null);
			this.logService.trace('[ParadisNotifications] failed to fetch Aivis preset icon', error);
		});
	}

	private _applyPresetIcon(iconWrap: HTMLElement, iconUrl: string | null): void {
		dom.clearNode(iconWrap);
		if (iconUrl) {
			const img = dom.append(iconWrap, $('img')) as HTMLImageElement;
			img.src = iconUrl;
			img.alt = '';
		} else {
			iconWrap.textContent = STR_PRESET_ICON_PLACEHOLDER;
		}
	}

	private _renderModelInfo(container: HTMLElement, uuid: string, apiKey: string): void {
		const trimmed = uuid.trim();
		if (!trimmed) {
			return;
		}
		if (!UUID_RE.test(trimmed)) {
			container.textContent = STR_MODEL_INFO_INVALID;
			return;
		}
		container.textContent = STR_MODEL_INFO_LOADING;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisModelSummary | null>('getAivisModel', [apiKey, trimmed]).then(model => {
			if (this._store.isDisposed || container.isConnected === false) {
				return;
			}
			if (!model) {
				container.textContent = '';
				return;
			}
			// allow-any-unicode-next-line
			container.textContent = `選択中: ${model.name}${model.authorName ? ` / by ${model.authorName}` : ''}`;
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			// allow-any-unicode-next-line
			container.textContent = `モデル取得失敗: ${error instanceof Error ? error.message : String(error)}`;
		});
	}

	private _renderDictionarySelect(settings: { readonly apiKey: string; readonly userDictionaryUuid: string }): void {
		const field = this._field(STR_DICTIONARY_LABEL);
		const select = dom.append(field, $('select')) as HTMLSelectElement;
		select.disabled = !settings.apiKey;
		const noneOption = dom.append(select, $('option')) as HTMLOptionElement;
		noneOption.value = '';
		noneOption.textContent = STR_DICTIONARY_NONE;
		select.value = '';

		this._renderDisposables.add(dom.addDisposableListener(select, 'change', () => {
			this.settingsService.setAivisSettings({ userDictionaryUuid: select.value });
		}));

		if (!settings.apiKey) {
			return;
		}
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisDictionaryListItem[]>('listAivisDictionaries', [settings.apiKey]).then(list => {
			if (this._store.isDisposed) {
				return;
			}
			for (const dict of list) {
				const option = dom.append(select, $('option')) as HTMLOptionElement;
				option.value = dict.uuid;
				option.textContent = `${dict.name} (${dict.word_count})`;
			}
			select.value = settings.userDictionaryUuid || '';
		}, error => {
			this.logService.warn('[ParadisNotifications] failed to list Aivis dictionaries', error);
		});
	}

	private _insertPlaceholder(key: string): void {
		const target = this._activeField === 'permission' ? this._formatPermissionInput : this._formatInput;
		if (!target) {
			return;
		}
		const token = `{{${key}}}`;
		const start = target.selectionStart ?? target.value.length;
		const end = target.selectionEnd ?? target.value.length;
		target.value = target.value.slice(0, start) + token + target.value.slice(end);
		target.focus();
		const pos = start + token.length;
		target.setSelectionRange(pos, pos);
		if (this._activeField === 'permission') {
			this.settingsService.setAivisSettings({ formatPermission: target.value });
		} else {
			this.settingsService.setAivisSettings({ format: target.value });
		}
	}

	private _renderFormatField(labelText: string, value: string, field: 'format' | 'permission', onCommit: (next: string) => void, onTest: () => void): HTMLTextAreaElement {
		const row = dom.append(this.container, $('.pns-field'));
		const header = dom.append(row, $('.pns-row'));
		header.style.marginBottom = '5px';
		dom.append(header, $('label.pns-label')).textContent = labelText;
		const testBtn = dom.append(header, $('button.pns-btn')) as HTMLButtonElement;
		testBtn.textContent = STR_TEST_PLAY;
		this._renderDisposables.add(dom.addDisposableListener(testBtn, 'click', onTest));

		const textarea = dom.append(row, $('textarea')) as HTMLTextAreaElement;
		textarea.rows = 2;
		textarea.value = value;
		this._renderDisposables.add(dom.addDisposableListener(textarea, 'focus', () => { this._activeField = field; }));
		this._renderDisposables.add(dom.addDisposableListener(textarea, 'blur', () => onCommit(textarea.value)));
		return textarea;
	}

	private async _testPlay(kind: 'complete' | 'permission'): Promise<void> {
		const settings = this.settingsService.getAivisSettings();
		if (!settings.apiKey || !settings.modelUuid) {
			return;
		}
		const template = kind === 'permission' ? settings.formatPermission : settings.format;
		let rendered = template;
		for (const [key, value] of Object.entries(SAMPLE_PLACEHOLDER_VALUES)) {
			rendered = rendered.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value);
		}
		// allow-any-unicode-next-line
		rendered = rendered.replace(/\{\{\s*event\s*\}\}/g, kind === 'permission' ? 'PermissionRequest' : 'Stop').replace(/\{\{\s*\w+\s*\}\}/g, '');
		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('playAivis', [{
				apiKey: settings.apiKey,
				modelUuid: settings.modelUuid,
				// allow-any-unicode-next-line
				text: rendered.trim() || 'テストです',
				speakingRate: settings.speakingRate,
				userDictionaryUuid: settings.userDictionaryUuid || undefined,
				volume: settings.volume,
			}]);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] Aivis test playback failed', error);
		}
	}
}

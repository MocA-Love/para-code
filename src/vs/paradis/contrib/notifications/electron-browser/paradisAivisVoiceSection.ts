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
	IParadisAivisPlaceholders,
	PARADIS_AIVIS_BUILTIN_PRESETS,
	PARADIS_AIVIS_PLACEHOLDER_KEYS,
	PARADIS_AIVIS_PLACEHOLDER_LABELS,
	PARADIS_NOTIFICATIONS_CHANNEL,
	renderParadisAivisTemplate,
} from '../common/paradisNotifications.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { getCachedAivisDictionaryList, getCachedAivisModelInfo, setCachedAivisDictionaryList, setCachedAivisModelInfo } from './paradisAivisApiCache.js';
import { paradisPreserveScroll } from './paradisNotificationSettingsDomUtils.js';
import { base64ToBlobUrl } from './paradisNotificationSoundPlayer.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.aivis.title', "Aivis Voice Announcement");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.aivis.desc', "通知音の後に Aivis API でスペース名やブランチ名を音声で読み上げます。");
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
// allow-any-unicode-next-line
const STR_PLAY_SAMPLE_ARIA = localize('paradis.notif.aivis.playSampleAria', "サンプル音声を再生");
// allow-any-unicode-next-line
const STR_STOP_SAMPLE_ARIA = localize('paradis.notif.aivis.stopSampleAria', "サンプル音声を停止");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Aivisモデルプリセットのモデル情報(アイコン・サンプル音声URL等)取得結果キャッシュ。
 * モジュールスコープに置くことで、設定ダイアログを閉じて再度開いても再フェッチを避ける。
 */
const presetModelInfoCache = new Map<string, IParadisAivisModelSummary | null>();

/** テスト再生用のサンプル値。event は再生する種別に応じて上書きする。 */
const SAMPLE_PLACEHOLDER_VALUES: IParadisAivisPlaceholders = Object.freeze({
	// allow-any-unicode-next-line
	space: 'サンプルスペース',
	// allow-any-unicode-next-line
	branch: 'サンプルブランチ',
	// allow-any-unicode-next-line
	worktree: 'サンプルワークツリー',
	// allow-any-unicode-next-line
	tab: 'ターミナル',
});

export class ParadisAivisVoiceSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _activeField: 'format' | 'permission' = 'format';
	private _formatInput: HTMLTextAreaElement | undefined;
	private _formatPermissionInput: HTMLTextAreaElement | undefined;

	private _sampleAudio: HTMLAudioElement | undefined;
	private _sampleBlobUrl: string | undefined;
	private _playingSampleUuid: string | undefined;
	private _playingSampleButton: HTMLButtonElement | undefined;

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
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

	override dispose(): void {
		this._sampleAudio?.pause();
		this._sampleAudio = undefined;
		if (this._sampleBlobUrl) {
			URL.revokeObjectURL(this._sampleBlobUrl);
			this._sampleBlobUrl = undefined;
		}
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
			// mousedownでフォーマット欄からフォーカスを奪うと、textareaのblurが click より先に
			// 発火して setAivisSettings() を呼び、'aivis' スコープの再描画でこのチップ自身を含む
			// セクション全体が作り直されてしまう。その結果 click イベントが失われたり、挿入先の
			// textareaが再描画後の新しいDOM要素(選択範囲情報を持たない)になったりして、挿入位置が
			// カーソル位置からずれる・挿入自体が反映されないように見える不具合になっていた。
			// フォーカス移動自体を止めることで、挿入前に再描画が割り込まないようにする。
			this._renderDisposables.add(dom.addDisposableListener(chip, 'mousedown', e => e.preventDefault()));
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
			dom.append(tile, $('.pns-preset-name')).textContent = preset.name;
			dom.append(tile, $('.pns-preset-author')).textContent = preset.authorName;

			const actions = dom.append(tile, $('.pns-preset-actions'));
			const sampleBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
			sampleBtn.disabled = true; // サンプルURLが判明するまでは無効
			sampleBtn.setAttribute('aria-label', STR_PLAY_SAMPLE_ARIA);
			sampleBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.play)}`));

			this._renderDisposables.add(dom.addDisposableListener(tile, 'click', () => {
				this.settingsService.setAivisSettings({ modelUuid: preset.uuid });
			}));
			this._renderDisposables.add(dom.addDisposableListener(sampleBtn, 'click', e => {
				e.stopPropagation(); // タイル選択(モデル切り替え)を誘発しない
				this._toggleSamplePlayback(preset.uuid, sampleBtn);
			}));

			this._renderPresetModelInfo(iconWrap, sampleBtn, preset.uuid, apiKey);
		}
	}

	/**
	 * プリセットタイルのアイコン・サンプル音声URLをAivis API (`getAivisModel`)から取得して適用する。
	 * 取得結果（成功・失敗いずれも）はモジュールスコープの `presetModelInfoCache` にキャッシュし、
	 * ダイアログの再オープンやセクションの再描画をまたいで再取得を避ける。
	 */
	private _renderPresetModelInfo(iconWrap: HTMLElement, sampleBtn: HTMLButtonElement, uuid: string, apiKey: string): void {
		if (!apiKey) {
			return; // アイコンはプレースホルダのまま、サンプルボタンは無効のまま
		}
		const cached = presetModelInfoCache.get(uuid);
		if (cached !== undefined) {
			this._applyPresetModelInfo(iconWrap, sampleBtn, uuid, cached);
			return;
		}
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisModelSummary | null>('getAivisModel', [apiKey, uuid]).then(model => {
			presetModelInfoCache.set(uuid, model);
			if (!this._store.isDisposed && iconWrap.isConnected) {
				this._applyPresetModelInfo(iconWrap, sampleBtn, uuid, model);
			}
		}, error => {
			presetModelInfoCache.set(uuid, null);
			this.logService.trace('[ParadisNotifications] failed to fetch Aivis preset info', error);
		});
	}

	private _applyPresetModelInfo(iconWrap: HTMLElement, sampleBtn: HTMLButtonElement, uuid: string, model: IParadisAivisModelSummary | null): void {
		dom.clearNode(iconWrap);
		if (model?.iconUrl) {
			const img = dom.append(iconWrap, $('img')) as HTMLImageElement;
			img.src = model.iconUrl;
			img.alt = '';
		} else {
			iconWrap.textContent = STR_PRESET_ICON_PLACEHOLDER;
		}

		sampleBtn.disabled = !model?.sampleUrl;
		// 再描画をまたいでサンプル再生中だったタイルを復元する（再生自体は継続しているため
		// ボタン表示だけを追従させる。paradisNotificationSettingsDialog.ts の着信音試聴と同じ考え方）。
		if (this._playingSampleUuid === uuid) {
			this._playingSampleButton = sampleBtn;
			this._setSampleButtonPlaying(sampleBtn, true);
		}
	}

	private _setSampleButtonPlaying(btn: HTMLButtonElement, playing: boolean): void {
		dom.clearNode(btn);
		btn.appendChild($(`span${ThemeIcon.asCSSSelector(playing ? Codicon.primitiveSquare : Codicon.play)}`));
		btn.setAttribute('aria-label', playing ? STR_STOP_SAMPLE_ARIA : STR_PLAY_SAMPLE_ARIA);
	}

	private _toggleSamplePlayback(uuid: string, btn: HTMLButtonElement): void {
		if (this._playingSampleUuid === uuid) {
			this._stopSamplePlayback();
			return;
		}
		const sampleUrl = presetModelInfoCache.get(uuid)?.sampleUrl;
		if (!sampleUrl) {
			return;
		}
		this._stopSamplePlayback();
		// フェッチ中の二重クリック・他タイル選択との競合防止のため先に確保しておく。
		this._playingSampleUuid = uuid;
		void this._playSampleFromUrl(uuid, sampleUrl, btn);
	}

	/**
	 * サンプル音声はAivis側の外部httpsホストから配信されるため、workbenchのCSP (`media-src`)
	 * では直接 `<audio src="https://...">` を再生できない。shared process 経由でバイト列を
	 * 取得し、カスタム着信音の再生と同じくBlob URL化してから再生する。
	 */
	private async _playSampleFromUrl(uuid: string, sampleUrl: string, btn: HTMLButtonElement): Promise<void> {
		let result: { base64: string; mimeType: string } | null;
		try {
			result = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<{ base64: string; mimeType: string } | null>('fetchAudio', [sampleUrl]);
		} catch (error) {
			this.logService.warn('[ParadisNotifications] failed to fetch Aivis sample audio', error);
			result = null;
		}
		if (this._store.isDisposed || this._playingSampleUuid !== uuid) {
			return; // 取得中に停止された、または別のサンプルが選択された
		}
		if (!result) {
			this._playingSampleUuid = undefined;
			return;
		}

		const blobUrl = base64ToBlobUrl(result.base64, result.mimeType);
		const audio = new Audio(blobUrl);
		this._sampleAudio = audio;
		this._sampleBlobUrl = blobUrl;
		this._playingSampleButton = btn;
		this._setSampleButtonPlaying(btn, true);
		audio.addEventListener('ended', () => this._stopSamplePlayback());
		audio.addEventListener('error', () => {
			this.logService.warn('[ParadisNotifications] Aivis sample playback error', audio.error);
			this._stopSamplePlayback();
		});
		try {
			await audio.play();
		} catch (error) {
			this.logService.warn('[ParadisNotifications] failed to play Aivis sample', error);
			this._stopSamplePlayback();
		}
	}

	private _stopSamplePlayback(): void {
		if (this._sampleAudio) {
			this._sampleAudio.pause();
			this._sampleAudio.src = '';
			this._sampleAudio = undefined;
		}
		if (this._sampleBlobUrl) {
			URL.revokeObjectURL(this._sampleBlobUrl);
			this._sampleBlobUrl = undefined;
		}
		if (this._playingSampleButton) {
			this._setSampleButtonPlaying(this._playingSampleButton, false);
		}
		this._playingSampleUuid = undefined;
		this._playingSampleButton = undefined;
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

		// フォーマット文字列の編集など、UUID自体は変わっていない 'aivis' スコープの変更でも
		// このセクションは再描画される。キャッシュ済みなら再フェッチせず即座に表示する。
		const cached = getCachedAivisModelInfo(apiKey, trimmed);
		if (cached !== undefined) {
			this._applyModelInfo(container, cached);
			return;
		}

		container.textContent = STR_MODEL_INFO_LOADING;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisModelSummary | null>('getAivisModel', [apiKey, trimmed]).then(model => {
			setCachedAivisModelInfo(apiKey, trimmed, model);
			if (this._store.isDisposed || container.isConnected === false) {
				return;
			}
			this._applyModelInfo(container, model);
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			// allow-any-unicode-next-line
			container.textContent = `モデル取得失敗: ${error instanceof Error ? error.message : String(error)}`;
		});
	}

	private _applyModelInfo(container: HTMLElement, model: IParadisAivisModelSummary | null): void {
		if (!model) {
			container.textContent = '';
			return;
		}
		// allow-any-unicode-next-line
		container.textContent = `選択中: ${model.name}${model.authorName ? ` / by ${model.authorName}` : ''}`;
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

		const cached = getCachedAivisDictionaryList(settings.apiKey);
		if (cached) {
			this._populateDictionaryOptions(select, cached, settings.userDictionaryUuid);
			return;
		}

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisAivisDictionaryListItem[]>('listAivisDictionaries', [settings.apiKey]).then(list => {
			if (this._store.isDisposed) {
				return;
			}
			setCachedAivisDictionaryList(settings.apiKey, list);
			this._populateDictionaryOptions(select, list, settings.userDictionaryUuid);
		}, error => {
			this.logService.warn('[ParadisNotifications] failed to list Aivis dictionaries', error);
		});
	}

	private _populateDictionaryOptions(select: HTMLSelectElement, list: readonly IParadisAivisDictionaryListItem[], userDictionaryUuid: string): void {
		for (const dict of list) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = dict.uuid;
			option.textContent = `${dict.name} (${dict.word_count})`;
		}
		select.value = userDictionaryUuid || '';
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
		// 本番 (paradisNotificationTrigger) と同じ置換関数を使い、プレビューと実際の読み上げの挙動を一致させる
		const rendered = renderParadisAivisTemplate(template, {
			...SAMPLE_PLACEHOLDER_VALUES,
			// allow-any-unicode-next-line
			event: kind === 'permission' ? '許可要求' : '作業完了',
		});
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

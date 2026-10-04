/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「音声報告」セクションで、読み上げエンジンが ElevenLabs のときに出す項目
// （API Key、声の一覧と検索・サンプル再生、voice_id の直接入力、モデル、適用する発音辞書）。
// 共通の項目（有効化・音量・話速・文面・テスト再生）は ParadisAivisVoiceSection が描く。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisElevenLabsDictionaryListItem,
	IParadisElevenLabsModel,
	IParadisElevenLabsVoice,
	paradisFilterElevenLabsVoices,
	PARADIS_ELEVENLABS_DEFAULT_MODEL_ID,
} from '../common/paradisElevenLabs.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisAivisSettings, IParadisNotificationsSettingsService, ParadisApiKeyField } from '../browser/paradisNotificationsSettings.js';
import { paradisElevenLabsDictionaryCache, paradisElevenLabsModelCache, paradisElevenLabsVoiceCache } from './paradisElevenLabsApiCache.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_API_KEY_DESC = localize('paradis.notif.elevenlabs.apiKeyDesc', "Voices の読み取り権限があると、下にアカウントの声の一覧が出ます。");
// allow-any-unicode-next-line
const STR_VOICES_LABEL = localize('paradis.notif.elevenlabs.voicesLabel', "声");
// allow-any-unicode-next-line
const STR_VOICES_SEARCH = localize('paradis.notif.elevenlabs.voicesSearch', "声を検索");
// allow-any-unicode-next-line
const STR_VOICES_REFRESH = localize('paradis.notif.elevenlabs.voicesRefresh', "声の一覧を読み直す");
// allow-any-unicode-next-line
const STR_VOICES_NOTE = localize('paradis.notif.elevenlabs.voicesNote', "▶ は ElevenLabs が用意しているサンプルを鳴らします（文字数は減りません）。");
// allow-any-unicode-next-line
const STR_VOICES_NO_KEY = localize('paradis.notif.elevenlabs.voicesNoKey', "API キーを入れると声の一覧が出ます。");
// allow-any-unicode-next-line
const STR_VOICES_LOADING = localize('paradis.notif.elevenlabs.voicesLoading', "声の一覧を読み込み中…");
// allow-any-unicode-next-line
const STR_VOICES_EMPTY = localize('paradis.notif.elevenlabs.voicesEmpty', "一致する声はありません。");
// allow-any-unicode-next-line
const strVoicesMore = (n: number) => localize('paradis.notif.elevenlabs.voicesMore', "ほかに {0} 件あります。検索で絞り込んでください。", n);
// allow-any-unicode-next-line
const STR_JAPANESE_TAG = localize('paradis.notif.elevenlabs.japaneseTag', "日本語");
// allow-any-unicode-next-line
const STR_VOICE_ID_LABEL = localize('paradis.notif.elevenlabs.voiceIdLabel', "voice_id");
// allow-any-unicode-next-line
const STR_VOICE_ID_DESC = localize('paradis.notif.elevenlabs.voiceIdDesc', "一覧に無い声（共有ライブラリなど）は ID を直接入れます。");
// allow-any-unicode-next-line
const strVoiceSelected = (name: string) => localize('paradis.notif.elevenlabs.voiceSelected', "選択中: {0}", name);
// allow-any-unicode-next-line
const STR_MODEL_LABEL = localize('paradis.notif.elevenlabs.modelLabel', "モデル");
// allow-any-unicode-next-line
const STR_MODEL_DESC = localize('paradis.notif.elevenlabs.modelDesc', "日本語に対応したモデルだけを出します。Flash は出始めが速く、文字単価も安めです。");
// allow-any-unicode-next-line
const STR_DICTIONARY_LABEL = localize('paradis.notif.elevenlabs.dictionaryLabel', "適用する発音辞書");
// allow-any-unicode-next-line
const STR_DICTIONARY_NONE = localize('paradis.notif.elevenlabs.dictionaryNone', "— 辞書なし —");
// allow-any-unicode-next-line
const STR_PLAY_SAMPLE_ARIA = localize('paradis.notif.elevenlabs.playSampleAria', "サンプル音声を再生");

/** 一度に並べる声のタイルの上限。アカウントの声が多いとダイアログが縦に伸び続けるため。 */
const MAX_VOICE_TILES = 30;

/** サンプル再生は音声報告セクションが受け持つ（Aivis のプリセットと同じ再生器を使う）。 */
export interface IParadisElevenLabsSampleHost {
	toggleSample(id: string, url: string, button: HTMLButtonElement): void;
	/** 描き直しで作り直したボタンに、再生中の表示を引き継ぐ。 */
	attachSampleButton(id: string, button: HTMLButtonElement): void;
	/** API Key の入力欄（表示切替つき）。Aivis と同じ部品を使う。 */
	renderApiKeyField(parent: HTMLElement, field: ParadisApiKeyField, apiKey: string, placeholder: string, description: string): void;
}

export class ParadisElevenLabsVoiceFields {

	/** 検索語は描き直しをまたいで残す。 */
	private _query = '';

	constructor(
		private readonly host: IParadisElevenLabsSampleHost,
		private readonly isDisposed: () => boolean,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@ILogService private readonly logService: ILogService,
	) { }

	render(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore): void {
		this.host.renderApiKeyField(parent, 'elevenLabsApiKey', settings.elevenLabsApiKey, 'sk_...', STR_API_KEY_DESC);

		// 声の一覧は非同期に届く。届いたら voice_id 欄の「選択中」表示も合わせる。
		const onVoicesLoaded: ((voices: readonly IParadisElevenLabsVoice[]) => void)[] = [];
		this._renderVoices(parent, settings, disposables, voices => onVoicesLoaded.forEach(listener => listener(voices)));
		this._renderVoiceIdField(parent, settings, disposables, onVoicesLoaded);
		this._renderModelSelect(parent, settings, disposables);
		this._renderDictionarySelect(parent, settings, disposables);
	}

	// --- 声 --------------------------------------------------------------------------------------

	private _renderVoices(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore, onLoaded: (voices: readonly IParadisElevenLabsVoice[]) => void): void {
		const apiKey = settings.elevenLabsApiKey;
		const field = dom.append(parent, $('.setting-row.pns-field-block'));
		const header = dom.append(field, $('.pns-voice-header'));
		dom.append(header, $('.sr-label')).textContent = STR_VOICES_LABEL;
		const search = dom.append(header, $('input')) as HTMLInputElement;
		search.placeholder = STR_VOICES_SEARCH;
		search.style.width = '180px';
		search.value = this._query;
		search.disabled = !apiKey;
		const refreshBtn = dom.append(header, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		refreshBtn.setAttribute('aria-label', STR_VOICES_REFRESH);
		refreshBtn.title = STR_VOICES_REFRESH;
		refreshBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		refreshBtn.disabled = !apiKey;

		const grid = dom.append(field, $('.pns-preset-grid'));
		const footer = dom.append(field, $('.sr-desc.pns-voice-note'));
		footer.textContent = STR_VOICES_NOTE;

		if (!apiKey) {
			dom.append(grid, $('.pns-empty')).textContent = STR_VOICES_NO_KEY;
			return;
		}

		const tilesDisposables = disposables.add(new DisposableStore());
		const renderTiles = (voices: readonly IParadisElevenLabsVoice[]) => {
			tilesDisposables.clear();
			dom.clearNode(grid);
			const filtered = paradisFilterElevenLabsVoices(voices, this._query);
			if (filtered.length === 0) {
				dom.append(grid, $('.pns-empty')).textContent = STR_VOICES_EMPTY;
			}
			for (const voice of filtered.slice(0, MAX_VOICE_TILES)) {
				this._renderVoiceTile(grid, voice, settings.elevenLabsVoiceId, tilesDisposables);
			}
			footer.textContent = filtered.length > MAX_VOICE_TILES ? `${STR_VOICES_NOTE} ${strVoicesMore(filtered.length - MAX_VOICE_TILES)}` : STR_VOICES_NOTE;
		};

		const load = (force: boolean) => {
			const cached = force ? undefined : paradisElevenLabsVoiceCache.get(apiKey);
			if (cached) {
				renderTiles(cached);
				return;
			}
			dom.clearNode(grid);
			dom.append(grid, $('.pns-empty')).textContent = STR_VOICES_LOADING;
			void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsVoice[]>('listElevenLabsVoices', [apiKey]).then(voices => {
				paradisElevenLabsVoiceCache.set(apiKey, voices);
				if (this.isDisposed() || !grid.isConnected) {
					return;
				}
				renderTiles(voices);
				onLoaded(voices);
			}, error => {
				if (this.isDisposed() || !grid.isConnected) {
					return;
				}
				dom.clearNode(grid);
				dom.append(grid, $('.pns-error')).textContent = error instanceof Error ? error.message : String(error);
			});
		};

		disposables.add(dom.addDisposableListener(search, 'input', () => {
			// 検索はタイルだけを描き直す（セクション全体を描き直すと入力欄のフォーカスが外れる）。
			this._query = search.value;
			const cached = paradisElevenLabsVoiceCache.get(apiKey);
			if (cached) {
				renderTiles(cached);
			}
		}));
		disposables.add(dom.addDisposableListener(refreshBtn, 'click', () => load(true)));
		load(false);
	}

	private _renderVoiceTile(grid: HTMLElement, voice: IParadisElevenLabsVoice, selectedVoiceId: string, disposables: DisposableStore): void {
		const tile = dom.append(grid, $('.pns-preset-tile'));
		tile.classList.toggle('selected', voice.voiceId === selectedVoiceId);
		dom.append(tile, $('.pns-preset-name')).textContent = voice.name;
		const desc = dom.append(tile, $('.pns-preset-author'));
		desc.textContent = voice.description || voice.category || voice.voiceId;
		desc.title = voice.description;
		const tags = dom.append(tile, $('.pns-voice-tags'));
		if (voice.japanese) {
			dom.append(tags, $('span.pns-voice-tag')).textContent = STR_JAPANESE_TAG;
		}
		const actions = dom.append(tile, $('.pns-preset-actions'));
		const sampleBtn = dom.append(actions, $('button.pns-btn.pns-btn-icon')) as HTMLButtonElement;
		sampleBtn.setAttribute('aria-label', STR_PLAY_SAMPLE_ARIA);
		sampleBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.play)}`));
		sampleBtn.disabled = !voice.previewUrl;
		this.host.attachSampleButton(voice.voiceId, sampleBtn);

		disposables.add(dom.addDisposableListener(tile, 'click', () => {
			this.settingsService.setAivisSettings({ elevenLabsVoiceId: voice.voiceId });
		}));
		disposables.add(dom.addDisposableListener(sampleBtn, 'click', e => {
			e.stopPropagation(); // タイルの選択（声の切り替え）を起こさない
			if (voice.previewUrl) {
				this.host.toggleSample(voice.voiceId, voice.previewUrl, sampleBtn);
			}
		}));
	}

	private _renderVoiceIdField(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore, onVoicesLoaded: ((voices: readonly IParadisElevenLabsVoice[]) => void)[]): void {
		const field = dom.append(parent, $('.setting-row'));
		const main = dom.append(field, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = STR_VOICE_ID_LABEL;
		dom.append(main, $('.sr-desc')).textContent = STR_VOICE_ID_DESC;
		const hint = dom.append(main, $('.pns-uuid-hint'));
		const input = dom.append(field, $('input')) as HTMLInputElement;
		input.style.width = '290px';
		input.style.fontFamily = 'var(--monaco-monospace-font)';
		input.style.fontSize = '11px';
		input.spellcheck = false;
		input.value = settings.elevenLabsVoiceId;

		const showHint = () => {
			const voiceId = input.value.trim();
			const voices = paradisElevenLabsVoiceCache.get(settings.elevenLabsApiKey) ?? [];
			const voice = voices.find(candidate => candidate.voiceId === voiceId);
			hint.className = voice ? 'pns-uuid-hint ok' : 'pns-uuid-hint';
			hint.textContent = voice ? strVoiceSelected(voice.name) : '';
		};
		showHint();
		onVoicesLoaded.push(() => showHint());
		disposables.add(dom.addDisposableListener(input, 'input', showHint));
		disposables.add(dom.addDisposableListener(input, 'blur', () => {
			const next = input.value.trim();
			if (next !== settings.elevenLabsVoiceId) {
				this.settingsService.setAivisSettings({ elevenLabsVoiceId: next });
			}
		}));
	}

	// --- モデル ----------------------------------------------------------------------------------

	private _renderModelSelect(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore): void {
		const apiKey = settings.elevenLabsApiKey;
		const field = dom.append(parent, $('.setting-row'));
		const main = dom.append(field, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = STR_MODEL_LABEL;
		dom.append(main, $('.sr-desc')).textContent = STR_MODEL_DESC;
		const errorEl = dom.append(main, $('.pns-uuid-hint'));
		const select = dom.append(field, $('select')) as HTMLSelectElement;
		select.style.width = '230px';
		const current = settings.elevenLabsModelId || PARADIS_ELEVENLABS_DEFAULT_MODEL_ID;
		this._populateModels(select, [], current);
		select.disabled = !apiKey;
		disposables.add(dom.addDisposableListener(select, 'change', () => {
			this.settingsService.setAivisSettings({ elevenLabsModelId: select.value });
		}));
		if (!apiKey) {
			return;
		}
		const cached = paradisElevenLabsModelCache.get(apiKey);
		if (cached) {
			this._populateModels(select, cached, current);
			return;
		}
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsModel[]>('listElevenLabsModels', [apiKey]).then(models => {
			paradisElevenLabsModelCache.set(apiKey, models);
			if (!this.isDisposed() && select.isConnected) {
				this._populateModels(select, models, current);
			}
		}, error => {
			this.logService.warn('[ParadisNotifications] failed to list ElevenLabs models', error);
			if (!this.isDisposed() && errorEl.isConnected) {
				errorEl.className = 'pns-uuid-hint ng';
				errorEl.textContent = error instanceof Error ? error.message : String(error);
			}
		});
	}

	/** 一覧に無いモデル（保存済みの値）も選択肢に残し、選び直さない限り変わらないようにする。 */
	private _populateModels(select: HTMLSelectElement, models: readonly IParadisElevenLabsModel[], current: string): void {
		dom.clearNode(select);
		const options = [...models];
		if (!options.some(model => model.modelId === current)) {
			options.unshift({ modelId: current, name: current });
		}
		for (const model of options) {
			const option = dom.append(select, $('option')) as HTMLOptionElement;
			option.value = model.modelId;
			option.textContent = model.name;
		}
		select.value = current;
	}

	// --- 発音辞書 --------------------------------------------------------------------------------

	private _renderDictionarySelect(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore): void {
		const apiKey = settings.elevenLabsApiKey;
		const field = dom.append(parent, $('.setting-row'));
		const main = dom.append(field, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = STR_DICTIONARY_LABEL;
		const select = dom.append(field, $('select')) as HTMLSelectElement;
		select.style.width = '230px';
		select.disabled = !apiKey;
		const populate = (list: readonly IParadisElevenLabsDictionaryListItem[], loaded: boolean) => {
			dom.clearNode(select);
			const none = dom.append(select, $('option')) as HTMLOptionElement;
			none.value = '';
			none.textContent = STR_DICTIONARY_NONE;
			for (const dict of list) {
				const option = dom.append(select, $('option')) as HTMLOptionElement;
				option.value = dict.id;
				option.textContent = dict.ruleCount === null ? dict.name : `${dict.name} (${dict.ruleCount})`;
			}
			// 一覧が読めない間は、保存済みの辞書を選択肢に残して勝手に外れないようにする。
			// 読めた一覧に無い（アーカイブ済み等）なら「辞書なし」と出す。読み上げも辞書なしになる。
			if (!loaded && settings.elevenLabsDictionaryId && !list.some(dict => dict.id === settings.elevenLabsDictionaryId)) {
				const option = dom.append(select, $('option')) as HTMLOptionElement;
				option.value = settings.elevenLabsDictionaryId;
				option.textContent = settings.elevenLabsDictionaryId;
			}
			select.value = [...select.options].some(option => option.value === settings.elevenLabsDictionaryId) ? settings.elevenLabsDictionaryId : '';
		};
		populate([], false);
		disposables.add(dom.addDisposableListener(select, 'change', () => {
			this.settingsService.setAivisSettings({ elevenLabsDictionaryId: select.value });
		}));
		if (!apiKey) {
			return;
		}
		const cached = paradisElevenLabsDictionaryCache.get(apiKey);
		if (cached) {
			populate(cached, true);
			return;
		}
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsDictionaryListItem[]>('listElevenLabsDictionaries', [apiKey]).then(list => {
			paradisElevenLabsDictionaryCache.set(apiKey, list);
			if (!this.isDisposed() && select.isConnected) {
				populate(list, true);
			}
		}, error => {
			this.logService.warn('[ParadisNotifications] failed to list ElevenLabs dictionaries', error);
		});
	}
}

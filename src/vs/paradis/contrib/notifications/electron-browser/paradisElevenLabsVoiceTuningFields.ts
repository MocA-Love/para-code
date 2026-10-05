/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定の「音声報告」で ElevenLabs を選んでいるとき、選んだ声のすぐ下に出す「<声> の調整」。
// 安定度（stability）・声の近さ（similarity_boost）を声ごとに覚え、ElevenLabs に保存した値の読み込み・戻し、
// この声の音量の補正（aivis-mcp の表）を出す。値は通知の合成で送り、「通知と同じ辞書と声の調整を
// エージェントの読み上げにも使う」がオンなら aivis-mcp にも書く（paradisAgentDictionarySync.contribution.ts）。

import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IParadisAivisSettings, IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisElevenLabsVoice, PARADIS_ELEVENLABS_DEFAULT_MODEL_ID } from '../common/paradisElevenLabs.js';
import { PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { paradisVoiceGainProgress } from '../common/paradisVoiceGains.js';
import { paradisElevenLabsGainKey } from '../common/paradisVoiceGain.js';
import {
	IParadisElevenLabsVoiceTuning,
	paradisIsElevenLabsV3Model,
	paradisNormalizeTuningValue,
	paradisRoundV3Stability,
	paradisSameVoiceTuning,
	PARADIS_VOICE_TUNING_STEP,
} from '../common/paradisVoiceTuning.js';
import { paradisElevenLabsVoiceCache } from './paradisElevenLabsApiCache.js';
import { paradisDidSavedVoiceSettingsFail, paradisGetCachedSavedVoiceSettings, paradisLoadVoiceGains, paradisMarkSavedVoiceSettingsFailed, paradisSetCachedSavedVoiceSettings } from './paradisVoiceGainsCache.js';
import './media/paradisVoiceTuning.css';

const $ = dom.$;

// allow-any-unicode-next-line
const strTitle = (name: string) => localize('paradis.notif.tune.title', "{0} の調整", name);
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.tune.desc', "声ごとに覚えます。声を切り替えると、その声の値が出ます。触っていない声は ElevenLabs のサイトでその声に保存した値で読みます。");
// allow-any-unicode-next-line
const STR_STABILITY = localize('paradis.notif.tune.stability', "安定度（stability）");
// allow-any-unicode-next-line
const STR_STABILITY_DESC = localize('paradis.notif.tune.stabilityDesc', "低いほど抑揚が大きく、毎回の読み方も変わります。");
// allow-any-unicode-next-line
const STR_STABILITY_DESC_V3 = localize('paradis.notif.tune.stabilityDescV3', "低いほど抑揚が大きく、毎回の読み方も変わります。選んでいるモデル（v3 系）は 0・0.5・1 の 3 段だけです。");
// allow-any-unicode-next-line
const STR_STABILITY_LOW = localize('paradis.notif.tune.stabilityLow', "感情豊か・ぶれる");
// allow-any-unicode-next-line
const STR_STABILITY_HIGH = localize('paradis.notif.tune.stabilityHigh', "平坦・安定");
// allow-any-unicode-next-line
const STR_SIMILARITY = localize('paradis.notif.tune.similarity', "声の近さ（similarity_boost）");
// allow-any-unicode-next-line
const STR_SIMILARITY_DESC = localize('paradis.notif.tune.similarityDesc', "高すぎると、元の録音の雑音や癖まで真似ます。");
// allow-any-unicode-next-line
const STR_SIMILARITY_LOW = localize('paradis.notif.tune.similarityLow', "素直な声");
// allow-any-unicode-next-line
const STR_SIMILARITY_HIGH = localize('paradis.notif.tune.similarityHigh', "元の声に近い");
// allow-any-unicode-next-line
const STR_SAVED_LABEL = localize('paradis.notif.tune.savedLabel', "ElevenLabs の保存値");
// allow-any-unicode-next-line
const STR_SAVED_DESC = localize('paradis.notif.tune.savedDesc', "ElevenLabs のサイトでこの声に保存した値です。調整しないときはこの値で読みます。");
// allow-any-unicode-next-line
const STR_SAVED_LOAD = localize('paradis.notif.tune.savedLoad', "読み込む");
// allow-any-unicode-next-line
const STR_SAVED_RESET = localize('paradis.notif.tune.savedReset', "保存値に戻す");
// allow-any-unicode-next-line
const STR_SAVED_LOADING = localize('paradis.notif.tune.savedLoading', "保存値を読み込み中…");
// allow-any-unicode-next-line
const STR_SAVED_UNKNOWN = localize('paradis.notif.tune.savedUnknown', "保存値はまだ読み込んでいません。");
// allow-any-unicode-next-line
const strSaved = (stability: string, similarity: string) => localize('paradis.notif.tune.saved', "保存値: 安定度 {0} / 声の近さ {1}", stability, similarity);
// allow-any-unicode-next-line
const STR_USING_SAVED = localize('paradis.notif.tune.usingSaved', "今は保存値で読んでいます。");
// allow-any-unicode-next-line
const STR_USING_OWN = localize('paradis.notif.tune.usingOwn', "今はこの声に調整した値で読んでいます。");
// allow-any-unicode-next-line
const STR_GAIN_LABEL = localize('paradis.notif.tune.gainLabel', "この声の音量の補正");
// allow-any-unicode-next-line
const STR_GAIN_DESC = localize('paradis.notif.tune.gainDesc', "この PC の aivis-mcp が測った値です。通知の読み上げとエージェントの読み上げで共通で、-20 LUFS に揃えます。");
// allow-any-unicode-next-line
const STR_GAIN_UNMEASURED = localize('paradis.notif.tune.gainUnmeasured', "未測定");
// allow-any-unicode-next-line
const STR_GAIN_UNSUPPORTED = localize('paradis.notif.tune.gainUnsupported', "aivis-mcp 2.5.4 以上が要ります");
// allow-any-unicode-next-line
const STR_GAIN_LOADING = localize('paradis.notif.tune.gainLoading', "読み込み中…");
// allow-any-unicode-next-line
const strGainLearned = (done: number, window: number) => localize('paradis.notif.tune.gainLearned', "学習 {0}/{1} 回", done, window);

/** ElevenLabs が声を作ったときの値（保存値が読めないときにスライダーを置く位置）。 */
const ELEVENLABS_DEFAULT_TUNING: Required<IParadisElevenLabsVoiceTuning> = { stability: 0.5, similarityBoost: 0.75 };

function formatValue(value: number | undefined): string {
	// allow-any-unicode-next-line
	return value === undefined ? '—' : value.toFixed(2);
}

export function paradisFormatGainDb(value: number): string {
	return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

export class ParadisElevenLabsVoiceTuningFields {

	constructor(
		private readonly isDisposed: () => boolean,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) { }

	/** 描く。声の一覧が後から届いたときに見出しの声の名前を直す関数を返す（声を選んでいなければ何も描かない）。 */
	render(parent: HTMLElement, settings: IParadisAivisSettings, disposables: DisposableStore): ((voices: readonly IParadisElevenLabsVoice[]) => void) | undefined {
		const voiceId = settings.elevenLabsVoiceId.trim();
		if (!voiceId) {
			return undefined;
		}
		const apiKey = settings.elevenLabsApiKey;
		const modelId = settings.elevenLabsModelId || PARADIS_ELEVENLABS_DEFAULT_MODEL_ID;
		const v3 = paradisIsElevenLabsV3Model(modelId);
		const own = settings.elevenLabsVoiceSettings[voiceId];
		let saved = apiKey ? paradisGetCachedSavedVoiceSettings(apiKey, voiceId) : undefined;

		const title = dom.append(parent, $('.pns-tune-title'));
		const showTitle = (voices: readonly IParadisElevenLabsVoice[]) => {
			title.textContent = strTitle(voices.find(voice => voice.voiceId === voiceId)?.name ?? voiceId);
		};
		showTitle(paradisElevenLabsVoiceCache.get(apiKey) ?? []);
		dom.append(parent, $('.pns-section-desc')).textContent = STR_DESC;

		const initial = (field: keyof IParadisElevenLabsVoiceTuning): number => own?.[field] ?? saved?.[field] ?? ELEVENLABS_DEFAULT_TUNING[field];
		const stability = this._renderSlider(parent, STR_STABILITY, v3 ? STR_STABILITY_DESC_V3 : STR_STABILITY_DESC, STR_STABILITY_LOW, STR_STABILITY_HIGH, v3 ? 0.5 : PARADIS_VOICE_TUNING_STEP, v3 ? paradisRoundV3Stability(initial('stability')) : initial('stability'), disposables);
		const similarity = this._renderSlider(parent, STR_SIMILARITY, STR_SIMILARITY_DESC, STR_SIMILARITY_LOW, STR_SIMILARITY_HIGH, PARADIS_VOICE_TUNING_STEP, initial('similarityBoost'), disposables);

		const commit = () => {
			const next: IParadisElevenLabsVoiceTuning = {
				stability: paradisNormalizeTuningValue(Number(stability.value)),
				similarityBoost: paradisNormalizeTuningValue(Number(similarity.value)),
			};
			const map = this.settingsService.getAivisSettings().elevenLabsVoiceSettings;
			if (!paradisSameVoiceTuning(map[voiceId], next)) {
				this.settingsService.setAivisSettings({ elevenLabsVoiceSettings: { ...map, [voiceId]: next } });
			}
		};
		disposables.add(dom.addDisposableListener(stability, 'change', commit));
		disposables.add(dom.addDisposableListener(similarity, 'change', commit));

		// --- ElevenLabs の保存値 ---
		const savedRow = dom.append(parent, $('.setting-row'));
		const savedMain = dom.append(savedRow, $('.sr-main'));
		dom.append(savedMain, $('.sr-label')).textContent = STR_SAVED_LABEL;
		dom.append(savedMain, $('.sr-desc')).textContent = STR_SAVED_DESC;
		const savedHint = dom.append(savedMain, $('.pns-uuid-hint'));
		dom.append(savedMain, $('.sr-desc')).textContent = own ? STR_USING_OWN : STR_USING_SAVED;
		const actions = dom.append(savedRow, $('.pns-tune-actions'));
		const loadBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		loadBtn.textContent = STR_SAVED_LOAD;
		loadBtn.disabled = !apiKey;
		const resetBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		resetBtn.textContent = STR_SAVED_RESET;
		resetBtn.disabled = !own;

		const showSaved = () => {
			savedHint.className = saved ? 'pns-uuid-hint ok' : 'pns-uuid-hint';
			savedHint.textContent = saved ? strSaved(formatValue(saved.stability), formatValue(saved.similarityBoost)) : STR_SAVED_UNKNOWN;
		};
		showSaved();

		const loadSaved = async (adopt: boolean) => {
			savedHint.className = 'pns-uuid-hint';
			savedHint.textContent = STR_SAVED_LOADING;
			loadBtn.disabled = true;
			try {
				const value = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsVoiceTuning>('getElevenLabsVoiceSettings', [apiKey, voiceId]);
				paradisSetCachedSavedVoiceSettings(apiKey, voiceId, value);
				if (this.isDisposed() || !savedHint.isConnected) {
					return;
				}
				saved = value;
				showSaved();
				if (adopt && own) {
					// 調整した値を持つ声は、読み込んだ保存値をこの声の値にする（スライダーに入れる）
					const next: IParadisElevenLabsVoiceTuning = {
						stability: paradisNormalizeTuningValue(value.stability),
						similarityBoost: paradisNormalizeTuningValue(value.similarityBoost),
					};
					const map = this.settingsService.getAivisSettings().elevenLabsVoiceSettings;
					this.settingsService.setAivisSettings({ elevenLabsVoiceSettings: { ...map, [voiceId]: next } });
					return;
				}
				if (!own) {
					stability.value = String(v3 ? paradisRoundV3Stability(value.stability ?? ELEVENLABS_DEFAULT_TUNING.stability) : (value.stability ?? ELEVENLABS_DEFAULT_TUNING.stability));
					similarity.value = String(value.similarityBoost ?? ELEVENLABS_DEFAULT_TUNING.similarityBoost);
					stability.dispatchEvent(new Event('input'));
					similarity.dispatchEvent(new Event('input'));
				}
			} catch (error) {
				paradisMarkSavedVoiceSettingsFailed(apiKey, voiceId);
				if (!this.isDisposed() && savedHint.isConnected) {
					savedHint.className = 'pns-uuid-hint ng';
					savedHint.textContent = error instanceof Error ? error.message : String(error);
				}
			} finally {
				if (!this.isDisposed() && loadBtn.isConnected) {
					loadBtn.disabled = !apiKey;
				}
			}
		};
		disposables.add(dom.addDisposableListener(loadBtn, 'click', () => void loadSaved(true)));
		disposables.add(dom.addDisposableListener(resetBtn, 'click', () => {
			const map = { ...this.settingsService.getAivisSettings().elevenLabsVoiceSettings };
			delete map[voiceId];
			this.settingsService.setAivisSettings({ elevenLabsVoiceSettings: map });
		}));
		if (apiKey && !saved && !paradisDidSavedVoiceSettingsFail(apiKey, voiceId)) {
			// 初めて出す声は保存値を取ってきて、スライダーをその位置に置く（調整した値を持つ声は動かさない）
			void loadSaved(false);
		}

		this._renderGain(parent, paradisElevenLabsGainKey(voiceId, modelId));
		return showTitle;
	}

	private _renderSlider(parent: HTMLElement, label: string, desc: string, low: string, high: string, step: number, value: number, disposables: DisposableStore): HTMLInputElement {
		const row = dom.append(parent, $('.setting-row'));
		const main = dom.append(row, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = label;
		dom.append(main, $('.sr-desc')).textContent = desc;
		const control = dom.append(row, $('.pns-tune-slider'));
		const line = dom.append(control, $('.pns-tune-slider-row'));
		const slider = dom.append(line, $('input')) as HTMLInputElement;
		slider.type = 'range';
		slider.min = '0';
		slider.max = '1';
		slider.step = String(step);
		slider.value = String(value);
		slider.setAttribute('aria-label', label);
		const shown = dom.append(line, $('span.pns-tune-value'));
		shown.textContent = Number(slider.value).toFixed(2);
		const ends = dom.append(control, $('.pns-tune-ends'));
		dom.append(ends, $('span')).textContent = low;
		dom.append(ends, $('span')).textContent = high;
		disposables.add(dom.addDisposableListener(slider, 'input', () => {
			shown.textContent = Number(slider.value).toFixed(2);
		}));
		return slider;
	}

	private _renderGain(parent: HTMLElement, key: string): void {
		const row = dom.append(parent, $('.setting-row'));
		const main = dom.append(row, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = STR_GAIN_LABEL;
		dom.append(main, $('.sr-desc')).textContent = STR_GAIN_DESC;
		const value = dom.append(row, $('span.pns-tune-actions'));
		dom.append(value, $('span.pns-pill')).textContent = STR_GAIN_LOADING;
		void paradisLoadVoiceGains(this.sharedProcessService).then(result => {
			if (this.isDisposed() || !value.isConnected) {
				return;
			}
			dom.clearNode(value);
			if (result.status !== 'ok') {
				dom.append(value, $('span.pns-pill')).textContent = result.status === 'unsupported' ? STR_GAIN_UNSUPPORTED : result.message;
				return;
			}
			const entry = result.value.entries.find(candidate => candidate.key === key);
			if (!entry || entry.gainDb === undefined) {
				dom.append(value, $('span.pns-pill')).textContent = STR_GAIN_UNMEASURED;
				return;
			}
			const progress = paradisVoiceGainProgress(entry, result.value.learnWindow);
			dom.append(value, $(`span.pns-pill.${progress.learning ? 'warn' : 'ok'}`)).textContent = paradisFormatGainDb(entry.gainDb);
			dom.append(value, $('span.pns-pill')).textContent = strGainLearned(progress.done, result.value.learnWindow);
		});
	}
}

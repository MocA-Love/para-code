/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「音量の補正」ページ。この PC の aivis-mcp（2.5.4 以上）が声とモデルの組ごとに
// 覚えている音量の補正を表で見せ、行のやり直し・ファイルへの書き出しと読み込み・学習の窓の変更をする。
// SSH 先の表は扱わない（SSH 先の声も手元で鳴らすときは手元の表を使う）。補正値を手で決める操作は持たない。
// aivis-mcp の実行は shared process（node/paradisVoiceGainsService.ts）。

import * as dom from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { IParadisElevenLabsVoice } from '../common/paradisElevenLabs.js';
import { PARADIS_AIVIS_BUILTIN_PRESETS, PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import {
	IParadisVoiceGainEntry,
	IParadisVoiceGainImportResult,
	IParadisVoiceGainList,
	PARADIS_GAIN_LEARN_WINDOW_MAX,
	PARADIS_GAIN_LEARN_WINDOW_MIN,
	PARADIS_GAIN_MIN_SECONDS_LOWER,
	PARADIS_GAIN_MIN_SECONDS_UPPER,
	PARADIS_VOICE_GAINS_CHANNEL,
	ParadisVoiceGainsResult,
	paradisIsInitialVoiceGain,
	paradisIsVoiceGainKey,
	paradisVoiceGainProgress,
} from '../common/paradisVoiceGains.js';
import { paradisElevenLabsModelCache, paradisElevenLabsVoiceCache } from './paradisElevenLabsApiCache.js';
import { paradisFormatGainDb } from './paradisElevenLabsVoiceTuningFields.js';
import { paradisForgetVoiceGains, paradisLoadVoiceGains } from './paradisVoiceGainsCache.js';
import './media/paradisVoiceTuning.css';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.gain.title', "音量の補正");
// allow-any-unicode-next-line
const strDesc = (window: number, seconds: number) => localize('paradis.notif.gain.desc', "声とモデルの組ごとに、読み上げの大きさを -20 LUFS に揃える値です。この PC の aivis-mcp が鳴らすたびに測り、直近 {0} 回（{1} 秒以上の発話だけ）の中央値を使います。通知の読み上げとエージェントの読み上げで同じ表を使います。", window, seconds);
// allow-any-unicode-next-line
const STR_DESC_PLAIN = localize('paradis.notif.gain.descPlain', "声とモデルの組ごとに、読み上げの大きさを -20 LUFS に揃える値です。この PC の aivis-mcp が鳴らすたびに測ります。通知の読み上げとエージェントの読み上げで同じ表を使います。");
// allow-any-unicode-next-line
const STR_UNSUPPORTED = localize('paradis.notif.gain.unsupported', "aivis-mcp 2.5.4 以上が要ります");
// allow-any-unicode-next-line
const strUnsupportedVersion = (version: string) => localize('paradis.notif.gain.unsupportedVersion', "aivis-mcp 2.5.4 以上が要ります（この PC の aivis-mcp は {0} です）", version);
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.gain.loading', "音量の表を読み込み中…");
// allow-any-unicode-next-line
const STR_EMPTY = localize('paradis.notif.gain.empty', "まだ測った声はありません。aivis-mcp が読み上げると増えます。");
// allow-any-unicode-next-line
const STR_COL_VOICE = localize('paradis.notif.gain.colVoice', "声");
// allow-any-unicode-next-line
const STR_COL_MODEL = localize('paradis.notif.gain.colModel', "モデル");
// allow-any-unicode-next-line
const STR_COL_GAIN = localize('paradis.notif.gain.colGain', "補正");
// allow-any-unicode-next-line
const STR_COL_LEARN = localize('paradis.notif.gain.colLearn', "学習");
// allow-any-unicode-next-line
const STR_COL_UPDATED = localize('paradis.notif.gain.colUpdated', "最後の測定");
// allow-any-unicode-next-line
const STR_UNMEASURED = localize('paradis.notif.gain.unmeasured', "未測定");
// allow-any-unicode-next-line
const STR_LEARNING = localize('paradis.notif.gain.learning', "学習中");
// allow-any-unicode-next-line
const STR_INITIAL = localize('paradis.notif.gain.initial', "初期値");
// allow-any-unicode-next-line
const STR_INITIAL_TITLE = localize('paradis.notif.gain.initialTitle', "aivis-mcp が最初から持っている値です。この声で読み上げると測り始めます。");
// allow-any-unicode-next-line
const STR_RESET = localize('paradis.notif.gain.reset', "やり直す");
// allow-any-unicode-next-line
const STR_RESET_NOTE = localize('paradis.notif.gain.resetNote', "やり直すと、その行の測定を捨てて次の発話から測り直します（それまでは初期値、初期値の無い声は同じモデルの声の平均か 0 dB で鳴らします）。");
// allow-any-unicode-next-line
const strResetConfirm = (voice: string, model: string) => localize('paradis.notif.gain.resetConfirm', "{0}（{1}）の音量の学習をやり直しますか?", voice, model);
// allow-any-unicode-next-line
const STR_RESET_DETAIL = localize('paradis.notif.gain.resetDetail', "これまでの測定を捨てて、次の発話から測り直します。");
// allow-any-unicode-next-line
const STR_EXPORT = localize('paradis.notif.gain.export', "ファイルに書き出す…");
// allow-any-unicode-next-line
const STR_IMPORT = localize('paradis.notif.gain.import', "ファイルから読み込む…");
// allow-any-unicode-next-line
const STR_IMPORT_MODE = localize('paradis.notif.gain.importMode', "読み込み:");
// allow-any-unicode-next-line
const STR_IMPORT_KEEP = localize('paradis.notif.gain.importKeep', "自分の表にある行は残す");
// allow-any-unicode-next-line
const STR_IMPORT_OVERWRITE = localize('paradis.notif.gain.importOverwrite', "受け取った値で上書き");
// allow-any-unicode-next-line
const STR_RELOAD = localize('paradis.notif.gain.reload', "読み直す");
// allow-any-unicode-next-line
const STR_FILE_FILTER = localize('paradis.notif.gain.fileFilter', "音量の表 (JSON)");
// allow-any-unicode-next-line
const strExported = (count: number) => localize('paradis.notif.gain.exported', "音量の表を書き出しました（{0} 行）。", count);
// allow-any-unicode-next-line
const strImported = (result: IParadisVoiceGainImportResult) => localize('paradis.notif.gain.imported', "音量の表を読み込みました（追加 {0}・更新 {1}・そのまま {2}・押し出し {3}・上限で入らなかった行 {4}）。", result.added, result.updated, result.skipped, result.evicted, result.dropped);
// allow-any-unicode-next-line
const strFailed = (message: string) => localize('paradis.notif.gain.failed', "aivis-mcp で失敗しました: {0}", message);
// allow-any-unicode-next-line
const STR_LEARN_LABEL = localize('paradis.notif.gain.learnLabel', "学習の窓");
// allow-any-unicode-next-line
const STR_LEARN_DESC = localize('paradis.notif.gain.learnDesc', "中央値に使う回数と、測る発話の最短の長さです。aivis-mcp の設定（config.json）に書き込みます。環境変数 AIVIS_GAIN_LEARN_WINDOW・AIVIS_GAIN_MIN_LEARN_SECONDS を設定している場合はそちらが優先されます。");
// allow-any-unicode-next-line
const STR_LEARN_TIMES = localize('paradis.notif.gain.learnTimes', "回");
// allow-any-unicode-next-line
const STR_LEARN_SECONDS = localize('paradis.notif.gain.learnSeconds', "秒");
// allow-any-unicode-next-line
const strLearnRange = (minWindow: number, maxWindow: number, minSeconds: number, maxSeconds: number) => localize('paradis.notif.gain.learnRange', "回数は {0}〜{1} の整数、秒は {2}〜{3} で入れてください。", minWindow, maxWindow, minSeconds, maxSeconds);
// allow-any-unicode-next-line
const STR_LEARN_SAVED = localize('paradis.notif.gain.learnSaved', "学習の窓を変えました。");
// allow-any-unicode-next-line
const STR_LEARN_OVERRIDDEN = localize('paradis.notif.gain.learnOverridden', "aivis-mcp の設定には書きましたが、環境変数 AIVIS_GAIN_LEARN_WINDOW・AIVIS_GAIN_MIN_LEARN_SECONDS の値が優先されているため、使う値は変わっていません。");
// allow-any-unicode-next-line
const STR_FILE_NOTE = localize('paradis.notif.gain.fileNote', "書き出したファイルには、声の ID・モデル・補正値・直近の測定が入ります。API キーや文面は入りません。別の PC や SSH 先へ持っていって「ファイルから読み込む」で足せます。");

/** 声の ID が長いときに表で見せる長さ。 */
const SHORT_ID_LENGTH = 10;

function shortId(id: string): string {
	// allow-any-unicode-next-line
	return id.length > SHORT_ID_LENGTH ? `${id.slice(0, SHORT_ID_LENGTH)}…` : id;
}

export class ParadisVoiceGainSection extends Disposable {

	private readonly _renderDisposables = this._register(new DisposableStore());
	private _result: ParadisVoiceGainsResult<IParadisVoiceGainList> | undefined;
	private _overwrite = false;
	private _busy = false;
	private _requestedVoices = false;

	constructor(
		private readonly container: HTMLElement,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._render();
		void this._load(false);
	}

	private async _load(force: boolean): Promise<void> {
		if (force) {
			paradisForgetVoiceGains();
		}
		this._result = undefined;
		this._render();
		const result = await paradisLoadVoiceGains(this.sharedProcessService, force);
		if (this._store.isDisposed) {
			return;
		}
		this._result = result;
		this._render();
		this._loadVoiceNames(result);
	}

	/** ElevenLabs の声の名前がまだ無ければ、一度だけ取りに行く（表の「声」を名前で出すため）。 */
	private _loadVoiceNames(result: ParadisVoiceGainsResult<IParadisVoiceGainList>): void {
		const apiKey = this.settingsService.getAivisSettings().elevenLabsApiKey;
		if (this._requestedVoices || !apiKey || paradisElevenLabsVoiceCache.get(apiKey) || result.status !== 'ok' || !result.value.entries.some(entry => entry.provider === 'elevenlabs')) {
			return;
		}
		this._requestedVoices = true;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisElevenLabsVoice[]>('listElevenLabsVoices', [apiKey]).then(voices => {
			paradisElevenLabsVoiceCache.set(apiKey, voices);
			if (!this._store.isDisposed) {
				this._render();
			}
		}, () => { /* 名前が引けなければ ID のまま出す */ });
	}

	private _render(): void {
		if (this._store.isDisposed) {
			return;
		}
		dom.clearNode(this.container);
		this._renderDisposables.clear();
		dom.append(this.container, $('.pns-section-title')).textContent = STR_TITLE;
		const result = this._result;
		dom.append(this.container, $('.pns-section-desc')).textContent = result?.status === 'ok' ? strDesc(result.value.learnWindow, result.value.minLearnSeconds) : STR_DESC_PLAIN;

		if (!result) {
			dom.append(this.container, $('.pns-empty')).textContent = STR_LOADING;
			return;
		}
		if (result.status === 'unsupported') {
			dom.append(this.container, $('.pns-empty')).textContent = result.version ? strUnsupportedVersion(result.version) : STR_UNSUPPORTED;
			this._renderReload(dom.append(this.container, $('.pns-gain-toolbar')));
			return;
		}
		if (result.status === 'failed') {
			dom.append(this.container, $('.pns-error')).textContent = strFailed(result.message);
			this._renderReload(dom.append(this.container, $('.pns-gain-toolbar')));
			return;
		}

		const list = result.value;
		const block = dom.append(this.container, $('.setting-row.pns-field-block'));
		const body = dom.append(block, $('div'));
		body.style.width = '100%';
		if (list.entries.length === 0) {
			dom.append(body, $('.pns-empty')).textContent = STR_EMPTY;
		} else {
			this._renderTable(body, list);
			dom.append(body, $('.sr-desc')).textContent = STR_RESET_NOTE;
		}
		this._renderToolbar(body);
		this._renderLearning(list);
		dom.append(this.container, $('.pns-gain-note')).textContent = STR_FILE_NOTE;
	}

	private _renderTable(parent: HTMLElement, list: IParadisVoiceGainList): void {
		const table = dom.append(parent, $('table.pns-gain-table'));
		const head = dom.append(dom.append(table, $('thead')), $('tr'));
		for (const label of [STR_COL_VOICE, STR_COL_MODEL, STR_COL_GAIN, STR_COL_LEARN, STR_COL_UPDATED, '']) {
			dom.append(head, $('th')).textContent = label;
		}
		const tbody = dom.append(table, $('tbody'));
		const entries = [...list.entries].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		for (const entry of entries) {
			const row = dom.append(tbody, $('tr'));
			const voiceCell = dom.append(row, $('td'));
			voiceCell.textContent = this._voiceName(entry);
			voiceCell.title = entry.voice;
			dom.append(row, $('td')).textContent = this._modelName(entry);
			const gainCell = dom.append(row, $('td.num'));
			gainCell.textContent = entry.gainDb === undefined ? STR_UNMEASURED : paradisFormatGainDb(entry.gainDb);
			const learnCell = dom.append(row, $('td'));
			const initial = paradisIsInitialVoiceGain(entry);
			if (initial) {
				// 一度も測っていない行（aivis-mcp が最初から持つ値だけ）は、進みではなく「初期値」と出す
				const pill = dom.append(learnCell, $('span.pns-pill'));
				pill.textContent = STR_INITIAL;
				pill.title = STR_INITIAL_TITLE;
			} else {
				const progress = paradisVoiceGainProgress(entry, list.learnWindow);
				const meter = dom.append(learnCell, $('span.pns-gain-meter'));
				dom.append(meter, $('i')).style.width = `${Math.round(progress.done / Math.max(1, list.learnWindow) * 100)}%`;
				dom.append(learnCell, $('span')).textContent = `${progress.done}/${list.learnWindow}`;
				if (progress.learning) {
					learnCell.append(' ');
					dom.append(learnCell, $('span.pns-pill.warn')).textContent = STR_LEARNING;
				}
			}
			// allow-any-unicode-next-line
			dom.append(row, $('td')).textContent = entry.updatedAt === undefined ? '—' : fromNow(entry.updatedAt, true);
			const actionCell = dom.append(row, $('td'));
			const reset = dom.append(actionCell, $('button.pns-btn')) as HTMLButtonElement;
			reset.textContent = STR_RESET;
			// 測った値の無い行は、やり直しても何も変わらない
			reset.disabled = this._busy || initial || !paradisIsVoiceGainKey(entry.key);
			this._renderDisposables.add(dom.addDisposableListener(reset, 'click', () => void this._reset(entry)));
		}
	}

	private _renderToolbar(parent: HTMLElement): void {
		const toolbar = dom.append(parent, $('.pns-gain-toolbar'));
		const exportBtn = dom.append(toolbar, $('button.pns-btn')) as HTMLButtonElement;
		exportBtn.textContent = STR_EXPORT;
		exportBtn.disabled = this._busy;
		const importBtn = dom.append(toolbar, $('button.pns-btn')) as HTMLButtonElement;
		importBtn.textContent = STR_IMPORT;
		importBtn.disabled = this._busy;
		dom.append(toolbar, $('span.sr-desc')).textContent = STR_IMPORT_MODE;
		const mode = dom.append(toolbar, $('select')) as HTMLSelectElement;
		mode.setAttribute('aria-label', STR_IMPORT_MODE);
		for (const [value, label] of [['keep', STR_IMPORT_KEEP], ['overwrite', STR_IMPORT_OVERWRITE]] as const) {
			const option = dom.append(mode, $('option')) as HTMLOptionElement;
			option.value = value;
			option.textContent = label;
		}
		mode.value = this._overwrite ? 'overwrite' : 'keep';
		this._renderReload(toolbar);
		this._renderDisposables.add(dom.addDisposableListener(mode, 'change', () => { this._overwrite = mode.value === 'overwrite'; }));
		this._renderDisposables.add(dom.addDisposableListener(exportBtn, 'click', () => void this._export()));
		this._renderDisposables.add(dom.addDisposableListener(importBtn, 'click', () => void this._import()));
	}

	private _renderReload(parent: HTMLElement): void {
		const reload = dom.append(parent, $('button.pns-btn')) as HTMLButtonElement;
		reload.textContent = STR_RELOAD;
		reload.disabled = this._busy;
		this._renderDisposables.add(dom.addDisposableListener(reload, 'click', () => void this._load(true)));
	}

	private _renderLearning(list: IParadisVoiceGainList): void {
		const row = dom.append(this.container, $('.setting-row'));
		const main = dom.append(row, $('.sr-main'));
		dom.append(main, $('.sr-label')).textContent = STR_LEARN_LABEL;
		dom.append(main, $('.sr-desc')).textContent = STR_LEARN_DESC;
		const hint = dom.append(main, $('.pns-uuid-hint'));
		const group = dom.append(row, $('.pns-gain-learning'));
		const windowInput = dom.append(group, $('input')) as HTMLInputElement;
		windowInput.type = 'number';
		windowInput.min = String(PARADIS_GAIN_LEARN_WINDOW_MIN);
		windowInput.max = String(PARADIS_GAIN_LEARN_WINDOW_MAX);
		windowInput.step = '1';
		windowInput.value = String(list.learnWindow);
		windowInput.setAttribute('aria-label', STR_LEARN_TIMES);
		dom.append(group, $('span')).textContent = STR_LEARN_TIMES;
		const secondsInput = dom.append(group, $('input')) as HTMLInputElement;
		secondsInput.type = 'number';
		secondsInput.min = String(PARADIS_GAIN_MIN_SECONDS_LOWER);
		secondsInput.max = String(PARADIS_GAIN_MIN_SECONDS_UPPER);
		secondsInput.step = '0.5';
		secondsInput.value = String(list.minLearnSeconds);
		secondsInput.setAttribute('aria-label', STR_LEARN_SECONDS);
		dom.append(group, $('span')).textContent = STR_LEARN_SECONDS;

		const commit = async () => {
			const window = Number(windowInput.value);
			const seconds = Number(secondsInput.value);
			if (window === list.learnWindow && seconds === list.minLearnSeconds) {
				return;
			}
			if (!Number.isInteger(window) || window < PARADIS_GAIN_LEARN_WINDOW_MIN || window > PARADIS_GAIN_LEARN_WINDOW_MAX
				|| !Number.isFinite(seconds) || seconds < PARADIS_GAIN_MIN_SECONDS_LOWER || seconds > PARADIS_GAIN_MIN_SECONDS_UPPER) {
				hint.className = 'pns-uuid-hint ng';
				hint.textContent = strLearnRange(PARADIS_GAIN_LEARN_WINDOW_MIN, PARADIS_GAIN_LEARN_WINDOW_MAX, PARADIS_GAIN_MIN_SECONDS_LOWER, PARADIS_GAIN_MIN_SECONDS_UPPER);
				return;
			}
			const result = await this._run<true>('setLearning', [window === list.learnWindow ? undefined : window, seconds === list.minLearnSeconds ? undefined : seconds]);
			if (result) {
				await this._load(true);
				// 読み直した値が入れた値と違うなら、CLI を動かした環境の環境変数が config.json より優先されている
				const after = this._result?.status === 'ok' ? this._result.value : undefined;
				const overridden = after !== undefined && (after.learnWindow !== window || after.minLearnSeconds !== Math.round(seconds * 100) / 100);
				if (overridden) {
					this.notificationService.warn(STR_LEARN_OVERRIDDEN);
				} else {
					this.notificationService.info(STR_LEARN_SAVED);
				}
			}
		};
		this._renderDisposables.add(dom.addDisposableListener(windowInput, 'change', () => void commit()));
		this._renderDisposables.add(dom.addDisposableListener(secondsInput, 'change', () => void commit()));
	}

	private _voiceName(entry: IParadisVoiceGainEntry): string {
		if (entry.provider === 'elevenlabs') {
			const voices = paradisElevenLabsVoiceCache.get(this.settingsService.getAivisSettings().elevenLabsApiKey) ?? [];
			return voices.find(voice => voice.voiceId === entry.voice)?.name ?? shortId(entry.voice);
		}
		if (entry.provider === 'aivis') {
			const presets = [...PARADIS_AIVIS_BUILTIN_PRESETS, ...this.settingsService.getCustomAivisModelPresets()];
			const preset = presets.find(candidate => candidate.uuid === entry.voice);
			return preset ? `${preset.name} (Aivis)` : shortId(entry.voice);
		}
		return shortId(entry.voice);
	}

	private _modelName(entry: IParadisVoiceGainEntry): string {
		if (entry.provider === 'aivis' && entry.model === 'default') {
			// allow-any-unicode-next-line
			return '—';
		}
		if (entry.provider === 'elevenlabs') {
			const models = paradisElevenLabsModelCache.get(this.settingsService.getAivisSettings().elevenLabsApiKey) ?? [];
			return models.find(model => model.modelId === entry.model)?.name ?? entry.model;
		}
		return entry.model;
	}

	private async _reset(entry: IParadisVoiceGainEntry): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: strResetConfirm(this._voiceName(entry), this._modelName(entry)),
			detail: STR_RESET_DETAIL,
			primaryButton: STR_RESET,
		});
		if (!confirmed || this._store.isDisposed) {
			return;
		}
		if (await this._run<true>('reset', [entry.key])) {
			await this._load(true);
		}
	}

	private async _export(): Promise<void> {
		const defaultFolder = await this.fileDialogService.defaultFilePath(Schemas.file);
		const target = await this.fileDialogService.showSaveDialog({
			title: STR_EXPORT,
			defaultUri: joinPath(defaultFolder, 'aivis-mcp-gains.json'),
			filters: [{ name: STR_FILE_FILTER, extensions: ['json'] }],
			availableFileSystems: [Schemas.file],
		});
		if (!target || target.scheme !== Schemas.file || this._store.isDisposed) {
			return;
		}
		const written = await this._run<number>('export', [target.fsPath]);
		if (written !== undefined) {
			this.notificationService.info(strExported(written));
		}
	}

	private async _import(): Promise<void> {
		const overwrite = this._overwrite;
		const picked = await this.fileDialogService.showOpenDialog({
			title: STR_IMPORT,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: STR_FILE_FILTER, extensions: ['json'] }],
			availableFileSystems: [Schemas.file],
		});
		const source = picked?.[0];
		if (!source || source.scheme !== Schemas.file || this._store.isDisposed) {
			return;
		}
		const result = await this._run<IParadisVoiceGainImportResult>('import', [source.fsPath, overwrite]);
		if (result) {
			this.notificationService.info(strImported(result));
			await this._load(true);
		}
	}

	/** aivis-mcp を呼ぶ。失敗・古い版は通知に出して undefined を返す。 */
	private async _run<T>(command: string, args: unknown[]): Promise<T | undefined> {
		this._busy = true;
		this._render();
		try {
			const result = await this.sharedProcessService.getChannel(PARADIS_VOICE_GAINS_CHANNEL).call<ParadisVoiceGainsResult<T>>(command, args);
			if (result.status === 'ok') {
				return result.value;
			}
			this.notificationService.error(result.status === 'unsupported' ? (result.version ? strUnsupportedVersion(result.version) : STR_UNSUPPORTED) : strFailed(result.message));
			return undefined;
		} catch (error) {
			this.notificationService.error(strFailed(error instanceof Error ? error.message : String(error)));
			return undefined;
		} finally {
			this._busy = false;
			this._render();
		}
	}
}

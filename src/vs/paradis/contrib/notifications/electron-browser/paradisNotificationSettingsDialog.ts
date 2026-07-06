/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログのシェル（自前backdrop+モーダル。paradisBindingDialog.ts と同じ方式）+
// 「Notifications」セクション（着信音の選択・音量・カスタム音源の取込）。
// Aivis Voice Announcement / ユーザー辞書 / 使用量の各セクションは別ファイルのクラスに委譲する
// （Superset apps/desktop の Settings > Notifications ページの構成をそのまま踏襲）。

import './media/paradisNotificationSettings.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CUSTOM_RINGTONE_ID, IParadisCustomRingtoneInfo, IParadisRingtoneData, PARADIS_NOTIFICATIONS_CHANNEL, PARADIS_RINGTONES } from '../common/paradisNotifications.js';
import { ParadisAivisDictionarySection } from './paradisAivisDictionarySection.js';
import { ParadisAivisUsageSection } from './paradisAivisUsageSection.js';
import { ParadisAivisVoiceSection } from './paradisAivisVoiceSection.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { ParadisNotificationSoundPlayer } from './paradisNotificationSoundPlayer.js';
import { openParadisYouTubeImportDialog } from './paradisYouTubeImportDialog.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.title', "通知設定");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.notif.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_SECTION_TITLE = localize('paradis.notif.sectionTitle', "Notifications");
// allow-any-unicode-next-line
const STR_SECTION_DESC = localize('paradis.notif.sectionDesc', "タスク完了時のサウンドと着信音");
// allow-any-unicode-next-line
const STR_TOGGLE_LABEL = localize('paradis.notif.toggleLabel', "通知サウンド");
// allow-any-unicode-next-line
const STR_TOGGLE_HINT = localize('paradis.notif.toggleHint', "タスク完了時にサウンドを再生します");
// allow-any-unicode-next-line
const STR_OS_TOGGLE_LABEL = localize('paradis.notif.osToggleLabel', "デスクトップ通知");
// allow-any-unicode-next-line
const STR_OS_TOGGLE_HINT = localize('paradis.notif.osToggleHint', "エージェントの対応待ち・作業完了を OS の通知センターに表示します（通知のクリックで該当スペースへ切り替え）");
// allow-any-unicode-next-line
const STR_OS_EVENTS_LABEL = localize('paradis.notif.osEventsLabel', "通知するイベント");
// allow-any-unicode-next-line
const STR_OS_EVENT_PERMISSION = localize('paradis.notif.osEventPermission', "対応待ち");
// allow-any-unicode-next-line
const STR_OS_EVENT_REVIEW = localize('paradis.notif.osEventReview', "作業完了");
// allow-any-unicode-next-line
const STR_FOCUSED_TOGGLE_LABEL = localize('paradis.notif.focusedToggleLabel', "Para Code を見ている間も通知する");
// allow-any-unicode-next-line
const STR_FOCUSED_TOGGLE_HINT = localize('paradis.notif.focusedToggleHint', "オフの場合、いま開いているスペースのイベントはウィンドウのフォーカス中は通知されません（音・読み上げ含む）");
// allow-any-unicode-next-line
const STR_VOLUME_LABEL = localize('paradis.notif.volumeLabel', "音量");
// allow-any-unicode-next-line
const STR_RINGTONE_TITLE = localize('paradis.notif.ringtoneTitle', "通知サウンド");
// allow-any-unicode-next-line
const STR_RINGTONE_DESC = localize('paradis.notif.ringtoneDesc', "サウンドを選択するか、独自の音源を追加できます。カスタム音源は .mp3、.wav、.ogg に対応しています。");
// allow-any-unicode-next-line
const STR_ADD_CUSTOM = localize('paradis.notif.addCustom', "カスタム音源を追加");
// allow-any-unicode-next-line
const STR_REPLACE_CUSTOM = localize('paradis.notif.replaceCustom', "カスタム音源を差し替え");
// allow-any-unicode-next-line
const STR_FROM_YOUTUBE = localize('paradis.notif.fromYouTube', "YouTubeから取り込み");
// allow-any-unicode-next-line
const STR_IMPORT_TITLE = localize('paradis.notif.importDialogTitle', "通知音を選択");
// allow-any-unicode-next-line
const STR_PLAY_PREVIEW_ARIA = localize('paradis.notif.playPreviewAria', "試聴を再生");
// allow-any-unicode-next-line
const STR_STOP_PREVIEW_ARIA = localize('paradis.notif.stopPreviewAria', "試聴を停止");

const VOLUME_LEVELS: readonly { readonly value: number; readonly label: string }[] = [
	// allow-any-unicode-next-line
	{ value: 20, label: localize('paradis.notif.volume.quiet', "小さめ") },
	// allow-any-unicode-next-line
	{ value: 40, label: localize('paradis.notif.volume.low', "やや小さめ") },
	// allow-any-unicode-next-line
	{ value: 60, label: localize('paradis.notif.volume.medium', "標準") },
	// allow-any-unicode-next-line
	{ value: 80, label: localize('paradis.notif.volume.high', "やや大きめ") },
	// allow-any-unicode-next-line
	{ value: 100, label: localize('paradis.notif.volume.max', "最大") },
];

/**
 * 通知設定ダイアログ本体。1回のopenごとに生成し、閉じるとdisposeされる。
 */
export class ParadisNotificationSettingsDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _player: ParadisNotificationSoundPlayer;

	private _playingRingtoneId: string | undefined;
	private _playingButton: HTMLButtonElement | undefined;
	private _playingAutoStopTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILayoutService layoutService: ILayoutService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._player = this._register(this.instantiationService.createInstance(ParadisNotificationSoundPlayer));

		this._backdrop = $('.paradis-notif-settings-backdrop');
		const modal = $('.paradis-notif-settings');
		this._backdrop.appendChild(modal);

		const header = dom.append(modal, $('.pns-header'));
		dom.append(header, $('h2')).textContent = STR_TITLE;
		const closeBtn = dom.append(header, $('.pns-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.close()));

		this._body = dom.append(modal, $('.pns-body'));

		modal.tabIndex = -1;
		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.close();
			}
		}));
		this._register(dom.addDisposableListener(this._backdrop, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.close();
			}
		}));

		this._register(this.settingsService.onDidChange(() => this._renderNotificationsSection()));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._render();
		modal.focus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		if (this._playingAutoStopTimer !== undefined) {
			clearTimeout(this._playingAutoStopTimer);
		}
		this._player.stop();
		this._backdrop.remove();
		super.dispose();
	}

	private _render(): void {
		dom.clearNode(this._body);

		const notifSection = dom.append(this._body, $('.pns-section'));
		this._notifSectionEl = notifSection;
		this._renderNotificationsSection();

		const aivisSection = dom.append(this._body, $('.pns-section'));
		this._register(this.instantiationService.createInstance(ParadisAivisVoiceSection, aivisSection));

		const dictSection = dom.append(this._body, $('.pns-section'));
		this._register(this.instantiationService.createInstance(ParadisAivisDictionarySection, dictSection));

		const usageSection = dom.append(this._body, $('.pns-section'));
		this._register(this.instantiationService.createInstance(ParadisAivisUsageSection, usageSection));
	}

	private _notifSectionEl: HTMLElement | undefined;
	private _notifRenderToken = 0;

	private _renderNotificationsSection(): void {
		const container = this._notifSectionEl;
		if (!container) {
			return;
		}

		// 再描画で直前にフォーカスされていた要素(チェックボックス等)がDOMから外れると、
		// ブラウザの既定のフォーカス移動により .pns-body が先頭までスクロールされてしまう
		// ことがあるため、再描画の前後でスクロール位置を保存・復元する。
		// 着信音リストは _fetchCustomRingtone().then(...) で非同期に追加されるため、同期復元だけだと
		// 一旦空リストで縮んだ本文高さに scrollTop がクランプされ、行が揃った後に上へ飛ぶ。
		// そのため非同期のリスト構築が完了した後にも同じ位置へ復元する（トークンで最新の再描画のみ有効化）。
		const scrollTop = this._body.scrollTop;
		const token = ++this._notifRenderToken;
		this._renderNotificationsSectionBody(container, () => {
			if (token === this._notifRenderToken && !this._store.isDisposed) {
				this._body.scrollTop = scrollTop;
			}
		});
		this._body.scrollTop = scrollTop;
	}

	private _renderNotificationsSectionBody(container: HTMLElement, onListPopulated: () => void): void {
		dom.clearNode(container);
		this._renderDisposables.clear();

		dom.append(container, $('.pns-section-title')).textContent = STR_SECTION_TITLE;
		dom.append(container, $('.pns-section-desc')).textContent = STR_SECTION_DESC;

		const muted = this.settingsService.getSoundsMuted();
		const volume = this.settingsService.getVolume();
		const selectedId = this.settingsService.getSelectedRingtoneId();

		// --- サウンドトグル ---
		const toggleRow = dom.append(container, $('.pns-row'));
		const toggleLabels = dom.append(toggleRow, $('div'));
		dom.append(toggleLabels, $('.pns-row-label')).textContent = STR_TOGGLE_LABEL;
		dom.append(toggleLabels, $('.pns-row-hint')).textContent = STR_TOGGLE_HINT;
		const toggle = dom.append(toggleRow, $('input.pns-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = !muted;
		this._renderDisposables.add(dom.addDisposableListener(toggle, 'change', () => {
			this.settingsService.setSoundsMuted(!toggle.checked);
		}));

		// --- デスクトップ通知 (OS通知センター) トグル ---
		const osEnabled = this.settingsService.getOsNotificationsEnabled();
		const osRow = dom.append(container, $('.pns-row'));
		const osLabels = dom.append(osRow, $('div'));
		dom.append(osLabels, $('.pns-row-label')).textContent = STR_OS_TOGGLE_LABEL;
		dom.append(osLabels, $('.pns-row-hint')).textContent = STR_OS_TOGGLE_HINT;
		const osToggle = dom.append(osRow, $('input.pns-toggle')) as HTMLInputElement;
		osToggle.type = 'checkbox';
		osToggle.checked = osEnabled;
		this._renderDisposables.add(dom.addDisposableListener(osToggle, 'change', () => {
			this.settingsService.setOsNotificationsEnabled(osToggle.checked);
		}));

		// --- 通知するイベント (デスクトップ通知が有効なときのみ) ---
		if (osEnabled) {
			const eventsRow = dom.append(container, $('.pns-row'));
			dom.append(eventsRow, $('.pns-row-label')).textContent = STR_OS_EVENTS_LABEL;
			const eventsBox = dom.append(eventsRow, $('div'));
			eventsBox.style.display = 'flex';
			eventsBox.style.gap = '14px';
			eventsBox.style.flexShrink = '0';
			const eventCheckbox = (label: string, checked: boolean, onChange: (value: boolean) => void) => {
				const wrap = dom.append(eventsBox, $('label'));
				wrap.style.display = 'flex';
				wrap.style.alignItems = 'center';
				wrap.style.gap = '5px';
				wrap.style.cursor = 'pointer';
				const checkbox = dom.append(wrap, $('input')) as HTMLInputElement;
				checkbox.type = 'checkbox';
				checkbox.checked = checked;
				const labelText = dom.append(wrap, $('span'));
				labelText.textContent = label;
				labelText.style.whiteSpace = 'nowrap';
				this._renderDisposables.add(dom.addDisposableListener(checkbox, 'change', () => onChange(checkbox.checked)));
			};
			eventCheckbox(STR_OS_EVENT_PERMISSION, this.settingsService.getOsNotifyOnPermission(), value => this.settingsService.setOsNotifyOnPermission(value));
			eventCheckbox(STR_OS_EVENT_REVIEW, this.settingsService.getOsNotifyOnReview(), value => this.settingsService.setOsNotifyOnReview(value));
		}

		// --- フォーカス中も通知する ---
		const focusedRow = dom.append(container, $('.pns-row'));
		const focusedLabels = dom.append(focusedRow, $('div'));
		dom.append(focusedLabels, $('.pns-row-label')).textContent = STR_FOCUSED_TOGGLE_LABEL;
		dom.append(focusedLabels, $('.pns-row-hint')).textContent = STR_FOCUSED_TOGGLE_HINT;
		const focusedToggle = dom.append(focusedRow, $('input.pns-toggle')) as HTMLInputElement;
		focusedToggle.type = 'checkbox';
		focusedToggle.checked = this.settingsService.getNotifyWhileFocused();
		this._renderDisposables.add(dom.addDisposableListener(focusedToggle, 'change', () => {
			this.settingsService.setNotifyWhileFocused(focusedToggle.checked);
		}));

		if (muted) {
			onListPopulated();
			return;
		}

		// --- 音量 ---
		const volumeRow = dom.append(container, $('.pns-row'));
		dom.append(volumeRow, $('.pns-row-label')).textContent = STR_VOLUME_LABEL;
		const volumeSelect = dom.append(volumeRow, $('select')) as HTMLSelectElement;
		volumeSelect.style.width = '160px';
		for (const level of VOLUME_LEVELS) {
			const option = dom.append(volumeSelect, $('option')) as HTMLOptionElement;
			option.value = String(level.value);
			option.textContent = `${level.label} (${level.value}%)`;
		}
		volumeSelect.value = String(volume);
		this._renderDisposables.add(dom.addDisposableListener(volumeSelect, 'change', () => {
			this.settingsService.setVolume(Number(volumeSelect.value));
		}));

		// --- 着信音リスト ---
		const listHeader = dom.append(container, $('.pns-row'));
		const listTitles = dom.append(listHeader, $('div'));
		dom.append(listTitles, $('.pns-row-label')).textContent = STR_RINGTONE_TITLE;
		dom.append(listTitles, $('.pns-row-hint')).textContent = STR_RINGTONE_DESC;

		const actions = dom.append(listHeader, $('div'));
		actions.style.display = 'flex';
		actions.style.gap = '6px';
		actions.style.flexShrink = '0';

		const importBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		importBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		this._renderDisposables.add(dom.addDisposableListener(importBtn, 'click', () => this._importCustomAudio()));

		const youtubeBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		youtubeBtn.textContent = STR_FROM_YOUTUBE;
		this._renderDisposables.add(dom.addDisposableListener(youtubeBtn, 'click', () => {
			this.instantiationService.invokeFunction(accessor => openParadisYouTubeImportDialog(accessor, () => this._renderNotificationsSection()));
		}));

		const list = dom.append(container, $('.pns-ringtone-list'));

		void this._fetchCustomRingtone().then(custom => {
			if (this._store.isDisposed) {
				return;
			}
			importBtn.textContent = custom ? STR_REPLACE_CUSTOM : STR_ADD_CUSTOM;
			const ringtones: (IParadisRingtoneData | IParadisCustomRingtoneInfo)[] = custom ? [...PARADIS_RINGTONES, custom] : [...PARADIS_RINGTONES];
			for (const ringtone of ringtones) {
				this._renderRingtoneRow(list, ringtone, ringtone.id === selectedId, volume);
			}
			// 着信音リストが揃って本文高さが確定した後にスクロール位置を復元する。
			onListPopulated();
		});
	}

	private async _fetchCustomRingtone(): Promise<IParadisCustomRingtoneInfo | null> {
		try {
			return await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisCustomRingtoneInfo | null>('getCustomRingtoneInfo');
		} catch (error) {
			this.logService.warn('[ParadisNotifications] failed to fetch custom ringtone', error);
			return null;
		}
	}

	private _renderRingtoneRow(list: HTMLElement, ringtone: IParadisRingtoneData | IParadisCustomRingtoneInfo, selected: boolean, volume: number): void {
		const row = dom.append(list, $('.pns-ringtone-row'));
		if (selected) {
			row.classList.add('selected');
		}
		dom.append(row, $('.pns-ringtone-emoji')).textContent = ringtone.emoji;

		const info = dom.append(row, $('.pns-ringtone-info'));
		const nameRow = dom.append(info, $('.pns-ringtone-name'));
		dom.append(nameRow, $('span')).textContent = ringtone.name;
		if (ringtone.duration) {
			dom.append(nameRow, $('span.pns-ringtone-duration')).textContent = `${ringtone.duration}s`;
		}
		dom.append(info, $('.pns-ringtone-desc')).textContent = ringtone.description;

		const check = dom.append(row, $('.pns-ringtone-check'));
		if (selected) {
			check.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
		}

		const playBtn = dom.append(row, $('button.pns-ringtone-play')) as HTMLButtonElement;
		const isPlaying = this._playingRingtoneId === ringtone.id;
		this._setPlayButtonPlaying(playBtn, isPlaying);
		if (isPlaying) {
			this._playingButton = playBtn;
		}

		this._renderDisposables.add(dom.addDisposableListener(row, 'click', () => {
			this.settingsService.setSelectedRingtoneId(ringtone.id);
		}));
		// 試聴の再生/停止は一過性の状態変化であり、セクション全体を再描画すると
		// クリックされたボタン自身がDOMから外れてフォーカスが失われ、.pns-bodyが
		// 先頭までスクロールされてしまう（paradisPreserveScroll適用対象外の経路）。
		// そのため該当ボタンのアイコン/クラスだけを直接更新し、再描画は行わない。
		this._renderDisposables.add(dom.addDisposableListener(playBtn, 'click', e => {
			e.stopPropagation();
			this._togglePreview(playBtn, ringtone.id, ringtone.duration, volume);
		}));
	}

	private _setPlayButtonPlaying(playBtn: HTMLButtonElement, playing: boolean): void {
		playBtn.classList.toggle('playing', playing);
		dom.clearNode(playBtn);
		playBtn.appendChild($(`span${ThemeIcon.asCSSSelector(playing ? Codicon.primitiveSquare : Codicon.play)}`));
		playBtn.setAttribute('aria-label', playing ? STR_STOP_PREVIEW_ARIA : STR_PLAY_PREVIEW_ARIA);
	}

	private _stopPreview(): void {
		if (this._playingAutoStopTimer !== undefined) {
			clearTimeout(this._playingAutoStopTimer);
			this._playingAutoStopTimer = undefined;
		}
		this._player.stop();
		if (this._playingButton) {
			this._setPlayButtonPlaying(this._playingButton, false);
		}
		this._playingButton = undefined;
		this._playingRingtoneId = undefined;
	}

	private _togglePreview(playBtn: HTMLButtonElement, ringtoneId: string, duration: number | undefined, volume: number): void {
		const wasPlayingSame = this._playingRingtoneId === ringtoneId;
		this._stopPreview();
		if (wasPlayingSame) {
			return; // 同じ行を再クリック: 停止のみ
		}

		this._playingRingtoneId = ringtoneId;
		this._playingButton = playBtn;
		this._setPlayButtonPlaying(playBtn, true);
		void this._player.play(ringtoneId, volume);

		// 着信音の実際の長さ(+0.5秒の余裕)で自動的に再生中表示を解除する(Superset同様の挙動)。
		const durationMs = ((duration ?? 5) + 0.5) * 1000;
		this._playingAutoStopTimer = setTimeout(() => {
			if (this._playingRingtoneId === ringtoneId) {
				this._stopPreview();
			}
		}, durationMs);
	}

	private async _importCustomAudio(): Promise<void> {
		const uris = await this.fileDialogService.showOpenDialog({
			title: STR_IMPORT_TITLE,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }],
		});
		if (!uris || uris.length === 0) {
			return;
		}
		try {
			await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('importCustomAudio', [uris[0].fsPath]);
			this.settingsService.setSelectedRingtoneId(CUSTOM_RINGTONE_ID);
			this._renderNotificationsSection();
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログのシェル（自前backdrop+モーダル。paradisBindingDialog.ts と同じ方式）。
// Settings Editor 風のレイアウト: ヘッダー（検索ボックス + 自動保存フラッシュ）、左ナビ、
// 右コンテンツ（おやすみモード / デスクトップ通知 / 通知サウンド / Aivis Voice Announcement /
// ユーザー辞書 / 使用量）。検索は全セクションの setting-row を横断フィルタする。
// 「Aivis Voice Announcement / ユーザー辞書 / 使用量」の各セクションは別ファイルのクラスに委譲する。

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
import { CUSTOM_RINGTONE_ID, DEFAULT_RINGTONE_ID, IParadisCustomRingtoneInfo, IParadisRingtoneData, PARADIS_AIVIS_DEFAULT_FORMAT, PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION, PARADIS_NOTIFICATIONS_CHANNEL, PARADIS_RINGTONES, getRingtoneById } from '../common/paradisNotifications.js';
import { clearAivisApiCaches } from './paradisAivisApiCache.js';
import { ParadisAivisDictionarySection } from './paradisAivisDictionarySection.js';
import { ParadisAivisUsageSection } from './paradisAivisUsageSection.js';
import { ParadisAivisVoiceSection } from './paradisAivisVoiceSection.js';
import { ParadisDoNotDisturbSection } from './paradisDoNotDisturbSection.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';
import { ParadisNotificationSoundPlayer } from './paradisNotificationSoundPlayer.js';
import { openParadisYouTubeImportDialog } from './paradisYouTubeImportDialog.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.title', "通知設定");
// allow-any-unicode-next-line
const STR_CLOSE_ARIA = localize('paradis.notif.closeAria', "閉じる");
// allow-any-unicode-next-line
const STR_SEARCH_PLACEHOLDER = localize('paradis.notif.searchPlaceholder', "設定を検索");
// allow-any-unicode-next-line
const STR_SAVED = localize('paradis.notif.saved', "✓ 自動保存");

// --- フッター ---
// allow-any-unicode-next-line
const STR_RESET_DEFAULTS = localize('paradis.notif.resetDefaults', "すべて既定へ戻す");
// allow-any-unicode-next-line
const STR_FOOTER_CLOSE = localize('paradis.notif.footerClose', "閉じる");

// --- 左ナビ ---
// allow-any-unicode-next-line
const STR_NAV_CAPTION_GENERAL = localize('paradis.notif.navCaptionGeneral', "一般");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_SOUND = localize('paradis.notif.navCaptionSound', "サウンド");
// allow-any-unicode-next-line
const STR_NAV_CAPTION_AIVIS = localize('paradis.notif.navCaptionAivis', "Aivis");
// allow-any-unicode-next-line
const STR_NAV_DND = localize('paradis.notif.navDnd', "おやすみモード");
// allow-any-unicode-next-line
const STR_NAV_DESKTOP = localize('paradis.notif.navDesktop', "デスクトップ通知");
// allow-any-unicode-next-line
const STR_NAV_SOUND = localize('paradis.notif.navSound', "通知サウンド");
// allow-any-unicode-next-line
const STR_NAV_AIVIS = localize('paradis.notif.navAivis', "音声報告");
// allow-any-unicode-next-line
const STR_NAV_DICT = localize('paradis.notif.navDict', "ユーザー辞書");
// allow-any-unicode-next-line
const STR_NAV_USAGE = localize('paradis.notif.navUsage', "使用量 (日別)");
// allow-any-unicode-next-line
const STR_ON = localize('paradis.notif.navOn', "オン");
// allow-any-unicode-next-line
const STR_OFF = localize('paradis.notif.navOff', "オフ");

// --- デスクトップ通知セクション ---
// allow-any-unicode-next-line
const STR_DESKTOP_TITLE = localize('paradis.notif.desktopTitle', "デスクトップ通知");
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

// --- 通知サウンドセクション ---
// allow-any-unicode-next-line
const STR_SECTION_TITLE = localize('paradis.notif.sectionTitle', "通知サウンド");
// allow-any-unicode-next-line
const STR_SECTION_DESC = localize('paradis.notif.sectionDesc', "タスク完了時のサウンドと着信音");
// allow-any-unicode-next-line
const STR_TOGGLE_LABEL = localize('paradis.notif.toggleLabel', "通知サウンドを再生");
// allow-any-unicode-next-line
const STR_TOGGLE_HINT = localize('paradis.notif.toggleHint', "タスク完了時にサウンドを再生します");
// allow-any-unicode-next-line
const STR_VOLUME_LABEL = localize('paradis.notif.volumeLabel', "音量");
// allow-any-unicode-next-line
const STR_RINGTONE_TITLE = localize('paradis.notif.ringtoneTitle', "着信音を選択");
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
// allow-any-unicode-next-line
const STR_CUSTOM_RINGTONE_NAV_NAME = localize('paradis.notif.customRingtoneNavName', "カスタム");

// おやすみモード中に封印（半透明オーバーレイ）されるセクション。
const DND_SEAL_SECTION_IDS = ['pns-sec-desktop', 'pns-sec-sound', 'pns-sec-aivis'] as const;

/** 検索フィルタで行単位の表示切替を行う要素。ヒット0のセクションは丸ごと非表示になる。 */
const FILTERABLE_SELECTOR = '.setting-row, .pns-ringtone-card, .pns-dict-card, .pns-stat-card, .pns-preset-tile';

interface INavItemEntry {
	readonly item: HTMLElement;
	readonly chip: HTMLElement;
	readonly status?: HTMLElement;
}

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
	private readonly _contentEl: HTMLElement;
	private readonly _searchInput: HTMLInputElement;
	private readonly _savedFlashEl: HTMLElement;
	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _player: ParadisNotificationSoundPlayer;

	private readonly _navItems = new Map<string, INavItemEntry>();
	private readonly _sectionEls: { readonly id: string; readonly el: HTMLElement }[] = [];
	private _desktopSectionEl!: HTMLElement;
	private _soundSectionEl!: HTMLElement;
	private _aivisSectionEl!: HTMLElement;

	private _savedFlashTimer: ReturnType<typeof setTimeout> | undefined;
	private _filterRenderToken = 0;
	/** 通知セクション再描画の最新性トークン（非同期の着信音リスト構築後の復元を最新だけ有効化）。 */
	private _notifRenderToken = 0;

	// --- 試聴（着信音プレビュー）の状態 ---
	private _playingRingtoneId: string | undefined;
	private _playingButton: HTMLButtonElement | undefined;
	private _playingCard: HTMLElement | undefined;
	private _playingDurationSeconds = 5;
	private _playingStartedAt: number | undefined;
	private _playingAutoStopTimer: ReturnType<typeof setTimeout> | undefined;
	private _playingProgressTimer: ReturnType<typeof setInterval> | undefined;

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

		// ダイアログを閉じている間にAivisSpeech側（外部）で辞書・モデルが変更されている可能性が
		// あるため、開くたびにAivis関連APIのキャッシュ（paradisAivisApiCache.ts）を破棄する。
		clearAivisApiCaches();

		this._player = this._register(this.instantiationService.createInstance(ParadisNotificationSoundPlayer));

		this._backdrop = $('.paradis-notif-settings-backdrop');
		const modal = $('.paradis-notif-settings');
		this._backdrop.appendChild(modal);

		// ---------- header ----------
		const header = dom.append(modal, $('.pns-header'));
		dom.append(header, $('h2')).textContent = STR_TITLE;

		const searchBox = dom.append(header, $('.pns-search'));
		searchBox.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.search)}`));
		this._searchInput = dom.append(searchBox, $('input')) as HTMLInputElement;
		this._searchInput.type = 'text';
		this._searchInput.placeholder = STR_SEARCH_PLACEHOLDER;
		this._register(dom.addDisposableListener(this._searchInput, 'input', () => this._applySearchFilter()));
		// 検索欄内の Escape は「検索語クリア」として扱い、ダイアログは閉じない
		// （空のときはそのまま背景側の Escape ハンドラへ渡して閉じる）。
		this._register(dom.addDisposableListener(this._searchInput, 'keydown', e => {
			const event = new StandardKeyboardEvent(e);
			if (event.keyCode === KeyCode.Escape && this._searchInput.value.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				this._searchInput.value = '';
				this._applySearchFilter();
			}
		}));

		this._savedFlashEl = dom.append(header, $('.pns-saved-flash'));
		this._savedFlashEl.textContent = STR_SAVED;

		const closeBtn = dom.append(header, $('.pns-close'));
		closeBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		closeBtn.setAttribute('role', 'button');
		closeBtn.setAttribute('aria-label', STR_CLOSE_ARIA);
		this._register(dom.addDisposableListener(closeBtn, 'click', () => this.close()));

		// ---------- body（左ナビ + 右コンテンツ） ----------
		const body = dom.append(modal, $('.pns-body'));
		this._buildNav(dom.append(body, $('nav.pns-nav')));
		this._contentEl = dom.append(body, $('.pns-content'));

		// ---------- footer ----------
		const footer = dom.append(modal, $('.pns-footer'));
		const resetBtn = dom.append(footer, $('button.pns-btn.pns-btn-danger.pns-reset-defaults')) as HTMLButtonElement;
		resetBtn.textContent = STR_RESET_DEFAULTS;
		this._register(dom.addDisposableListener(resetBtn, 'click', () => this._resetAllToDefaults()));
		const footerCloseBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary.pns-footer-close')) as HTMLButtonElement;
		footerCloseBtn.textContent = STR_FOOTER_CLOSE;
		this._register(dom.addDisposableListener(footerCloseBtn, 'click', () => this.close()));

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

		// 設定変更 → 自動保存フラッシュ。セクションクラスは同じイベントで自身を再描画するため、
		// 検索フィルタの再適用は全リスナーの処理が終わった後（setTimeout 0）に行う。
		this._register(this.settingsService.onDidChange(scope => {
			this._flashSaved();
			if (scope === 'notifications') {
				this._renderNotificationsSections();
			}
			if (scope === 'notifications' || scope === 'dnd') {
				this._updateNavStatuses();
			}
			if (scope === 'dnd') {
				this._updateDndSeal();
			}
			this._scheduleApplySearchFilter();
		}));
		// 別ウィンドウ等からの外部変更（onDidChange が発火しない経路）でも封印・バッジを追従させる。
		this._register(this.settingsService.onDidChangeDoNotDisturb(() => {
			this._updateDndSeal();
			this._updateNavStatuses();
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._render();
		modal.focus();
	}

	close(): void {
		this.dispose();
	}

	override dispose(): void {
		this._clearPlaybackTimers();
		if (this._savedFlashTimer !== undefined) {
			clearTimeout(this._savedFlashTimer);
			this._savedFlashTimer = undefined;
		}
		this._player.stop();
		this._backdrop.remove();
		super.dispose();
	}

	// ==========================================================================================
	// シェル構築（ナビ・セクション枠）
	// ==========================================================================================

	private _buildNav(nav: HTMLElement): void {
		this._addNavCaption(nav, STR_NAV_CAPTION_GENERAL);
		this._addNavItem(nav, STR_NAV_DND, 'pns-sec-dnd', { status: true });
		this._addNavItem(nav, STR_NAV_DESKTOP, 'pns-sec-desktop', { status: true });

		this._addNavCaption(nav, STR_NAV_CAPTION_SOUND);
		this._addNavItem(nav, STR_NAV_SOUND, 'pns-sec-sound', { status: true });

		this._addNavCaption(nav, STR_NAV_CAPTION_AIVIS);
		this._addNavItem(nav, STR_NAV_AIVIS, 'pns-sec-aivis', {});
		this._addNavItem(nav, STR_NAV_DICT, 'pns-sec-dict', {});
		this._addNavItem(nav, STR_NAV_USAGE, 'pns-sec-usage', {});
	}

	private _addNavCaption(nav: HTMLElement, label: string): void {
		dom.append(nav, $('.pns-nav-caption')).textContent = label;
	}

	private _addNavItem(nav: HTMLElement, label: string, targetId: string, opts: { status?: boolean }): void {
		const item = dom.append(nav, $('.pns-nav-item'));
		item.setAttribute('role', 'button');
		dom.append(item, $('span.pns-nav-label')).textContent = label;
		const status = opts.status ? dom.append(item, $('span.pns-nav-status')) : undefined;
		const chip = dom.append(item, $('span.pns-nav-chip'));
		this._navItems.set(targetId, { item, chip, status });
		// ナビはシェルの一部のため _renderDisposables（通知セクション再描画ごとに clear される）ではなく
		// ダイアログ自身の store へ登録する。
		this._register(dom.addDisposableListener(item, 'click', () => this._navigateTo(targetId)));
	}

	private _navigateTo(targetId: string): void {
		this._activateNavItem(targetId);
		this._sectionEls.find(section => section.id === targetId)?.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	/** ナビ項目の active 表示だけを切り替える（初回オープン時の初期選択でも使う）。 */
	private _activateNavItem(targetId: string): void {
		for (const entry of this._navItems.values()) {
			entry.item.classList.remove('active');
		}
		this._navItems.get(targetId)?.item.classList.add('active');
	}

	private _createSection(id: string, keywords: string): HTMLElement {
		const section = dom.append(this._contentEl, $('section.pns-section'));
		section.id = id;
		section.setAttribute('data-name', keywords);
		this._sectionEls.push({ id, el: section });
		return section;
	}

	private _render(): void {
		const dndSection = this._createSection(
			'pns-sec-dnd',
			// allow-any-unicode-next-line
			'おやすみモード dnd do not disturb 解除 タイミング',
		);
		this._register(this.instantiationService.createInstance(ParadisDoNotDisturbSection, dndSection));

		this._desktopSectionEl = this._createSection(
			'pns-sec-desktop',
			// allow-any-unicode-next-line
			'デスクトップ通知 os notification 通知するイベント 対応待ち 作業完了 フォーカス',
		);

		this._soundSectionEl = this._createSection(
			'pns-sec-sound',
			// allow-any-unicode-next-line
			'通知サウンド 着信音 ringtone 音量 volume カスタム youtube',
		);

		this._aivisSectionEl = this._createSection(
			'pns-sec-aivis',
			// allow-any-unicode-next-line
			'aivis 音声 読み上げ voice api key model uuid 辞書 テスト再生 プリセット',
		);
		this._register(this.instantiationService.createInstance(ParadisAivisVoiceSection, this._aivisSectionEl));

		const dictSection = this._createSection(
			'pns-sec-dict',
			// allow-any-unicode-next-line
			'ユーザー辞書 dictionary 単語 import export',
		);
		this._register(this.instantiationService.createInstance(ParadisAivisDictionarySection, dictSection));

		const usageSection = this._createSection(
			'pns-sec-usage',
			// allow-any-unicode-next-line
			'使用量 usage requests characters credits 日別',
		);
		this._register(this.instantiationService.createInstance(ParadisAivisUsageSection, usageSection));

		this._renderNotificationsSections();
		this._updateDndSeal();
		this._updateNavStatuses();
		// 初回オープン時は先頭（おやすみモード）を選択状態にしておく
		this._activateNavItem('pns-sec-dnd');
	}

	// ==========================================================================================
	// おやすみモード連動の封印・ナビステータス
	// ==========================================================================================

	private _updateDndSeal(): void {
		const sealed = this.settingsService.getDoNotDisturb().enabled;
		for (const id of DND_SEAL_SECTION_IDS) {
			this._sectionEls.find(section => section.id === id)?.el.classList.toggle('disabled-veil', sealed);
		}
	}

	private _updateNavStatuses(): void {
		const dndEntry = this._navItems.get('pns-sec-dnd');
		if (dndEntry?.status) {
			const enabled = this.settingsService.getDoNotDisturb().enabled;
			dndEntry.status.textContent = enabled ? STR_ON : STR_OFF;
			dndEntry.status.className = `pns-nav-status ${enabled ? 'st-warn' : 'st-off'}`;
		}
		const desktopEntry = this._navItems.get('pns-sec-desktop');
		if (desktopEntry?.status) {
			const enabled = this.settingsService.getOsNotificationsEnabled();
			desktopEntry.status.textContent = enabled ? STR_ON : STR_OFF;
			desktopEntry.status.className = `pns-nav-status ${enabled ? 'st-ok' : 'st-off'}`;
		}
		const soundEntry = this._navItems.get('pns-sec-sound');
		if (soundEntry?.status) {
			const id = this.settingsService.getSelectedRingtoneId();
			soundEntry.status.textContent = id === CUSTOM_RINGTONE_ID
				? STR_CUSTOM_RINGTONE_NAV_NAME
				: (getRingtoneById(id)?.name ?? id);
			soundEntry.status.className = 'pns-nav-status st-ok';
		}
	}

	// ==========================================================================================
	// すべて既定へ戻す
	// ==========================================================================================

	/**
	 * 全設定を既定値へ書き戻す。カスタム音源ファイル・ユーザー辞書・カスタムモデルプリセットは
	 * 「データ」であり設定値ではないため対象外。
	 */
	private _resetAllToDefaults(): void {
		this.settingsService.setDoNotDisturb(false, undefined);
		this.settingsService.setOsNotificationsEnabled(true);
		this.settingsService.setOsNotifyOnPermission(true);
		this.settingsService.setOsNotifyOnReview(true);
		this.settingsService.setNotifyWhileFocused(false);
		this.settingsService.setSoundsMuted(false);
		this.settingsService.setVolume(100);
		this.settingsService.setSelectedRingtoneId(DEFAULT_RINGTONE_ID);
		this.settingsService.setAivisSettings({
			enabled: false,
			apiKey: '',
			modelUuid: '',
			userDictionaryUuid: '',
			format: PARADIS_AIVIS_DEFAULT_FORMAT,
			formatPermission: PARADIS_AIVIS_DEFAULT_FORMAT_PERMISSION,
			volume: 100,
			speakingRate: 1.0,
		});
	}

	// ==========================================================================================
	// 自動保存フラッシュ
	// ==========================================================================================

	private _flashSaved(): void {
		this._savedFlashEl.classList.add('visible');
		if (this._savedFlashTimer !== undefined) {
			clearTimeout(this._savedFlashTimer);
		}
		this._savedFlashTimer = setTimeout(() => {
			this._savedFlashEl.classList.remove('visible');
			this._savedFlashTimer = undefined;
		}, 1200);
	}

	// ==========================================================================================
	// 検索フィルタ
	// ==========================================================================================

	private _applySearchFilter(): void {
		const query = this._searchInput.value.trim().toLowerCase();
		for (const { el, id } of this._sectionEls) {
			const keywords = (el.getAttribute('data-name') ?? '').toLowerCase();
			let hits = 0;
			for (const unit of el.querySelectorAll(FILTERABLE_SELECTOR)) {
				const hit = !query || keywords.includes(query) || (unit.textContent ?? '').toLowerCase().includes(query);
				unit.classList.toggle('row-hidden', !hit);
				if (query && hit) {
					hits++;
				}
			}
			el.style.display = !query || hits > 0 || keywords.includes(query) ? '' : 'none';
			const navEntry = this._navItems.get(id);
			if (navEntry) {
				navEntry.chip.textContent = query ? String(hits) : '';
				navEntry.item.classList.toggle('filtering', !!query);
			}
		}
	}

	/**
	 * セクションクラス群（Aivis 等）は同じ onDidChange イベントの中で自分のDOMを作り直すため、
	 * ダイアログ側のリスナーから同期的にフィルタを再適用すると古いDOMを見てしまう。
	 * 全リスナーの処理が済んだ後に再適用する。
	 */
	private _scheduleApplySearchFilter(): void {
		const token = ++this._filterRenderToken;
		setTimeout(() => {
			if (token === this._filterRenderToken && !this._store.isDisposed) {
				this._applySearchFilter();
			}
		}, 0);
	}

	// ==========================================================================================
	// デスクトップ通知・通知サウンドセクション（ダイアログ本体が描画）
	// ==========================================================================================

	private _renderNotificationsSections(): void {
		// 再描画で直前にフォーカスされていた要素(チェックボックス等)がDOMから外れると、
		// ブラウザの既定のフォーカス移動により .pns-content が先頭までスクロールされてしまう
		// ことがあるため、再描画の前後でスクロール位置を保存・復元する。
		// 着信音リストは _fetchCustomRingtone().then(...) で非同期に追加されるため、同期復元だけだと
		// 一旦空リストで縮んだ本文高さに scrollTop がクランプされ、行が揃った後に上へ飛ぶ。
		// そのため非同期のリスト構築が完了した後にも同じ位置へ復元する（トークンで最新の再描画のみ有効化）。
		const scrollTop = this._contentEl.scrollTop;
		const token = ++this._notifRenderToken;
		const onListPopulated = () => {
			if (token === this._notifRenderToken && !this._store.isDisposed) {
				this._contentEl.scrollTop = scrollTop;
				this._applySearchFilter();
			}
		};

		this._renderDisposables.clear();
		this._renderDesktopSectionBody();
		this._renderSoundSectionBody(onListPopulated);
		this._contentEl.scrollTop = scrollTop;
		this._applySearchFilter();
	}

	private _renderDesktopSectionBody(): void {
		const container = this._desktopSectionEl;
		dom.clearNode(container);

		dom.append(container, $('.pns-section-title')).textContent = STR_DESKTOP_TITLE;

		const osEnabled = this.settingsService.getOsNotificationsEnabled();

		// --- デスクトップ通知トグル ---
		const osRow = dom.append(container, $('.setting-row'));
		const osLabels = dom.append(osRow, $('.sr-main'));
		dom.append(osLabels, $('.sr-label')).textContent = STR_OS_TOGGLE_LABEL;
		dom.append(osLabels, $('.sr-desc')).textContent = STR_OS_TOGGLE_HINT;
		const osToggle = dom.append(osRow, $('input.pns-toggle')) as HTMLInputElement;
		osToggle.type = 'checkbox';
		osToggle.checked = osEnabled;
		this._renderDisposables.add(dom.addDisposableListener(osToggle, 'change', () => {
			this.settingsService.setOsNotificationsEnabled(osToggle.checked);
		}));

		// --- 通知するイベント (デスクトップ通知が有効なときのみ) ---
		if (osEnabled) {
			const eventsRow = dom.append(container, $('.setting-row'));
			const eventsMain = dom.append(eventsRow, $('.sr-main'));
			dom.append(eventsMain, $('.sr-label')).textContent = STR_OS_EVENTS_LABEL;
			const eventsBox = dom.append(eventsRow, $('div.pns-events-box'));
			const eventCheckbox = (label: string, checked: boolean, onChange: (value: boolean) => void) => {
				const wrap = dom.append(eventsBox, $('label'));
				const checkbox = dom.append(wrap, $('input')) as HTMLInputElement;
				checkbox.type = 'checkbox';
				checkbox.checked = checked;
				dom.append(wrap, $('span')).textContent = label;
				this._renderDisposables.add(dom.addDisposableListener(checkbox, 'change', () => onChange(checkbox.checked)));
			};
			eventCheckbox(STR_OS_EVENT_PERMISSION, this.settingsService.getOsNotifyOnPermission(), value => this.settingsService.setOsNotifyOnPermission(value));
			eventCheckbox(STR_OS_EVENT_REVIEW, this.settingsService.getOsNotifyOnReview(), value => this.settingsService.setOsNotifyOnReview(value));
		}

		// --- フォーカス中も通知する ---
		const focusedRow = dom.append(container, $('.setting-row'));
		const focusedLabels = dom.append(focusedRow, $('.sr-main'));
		dom.append(focusedLabels, $('.sr-label')).textContent = STR_FOCUSED_TOGGLE_LABEL;
		dom.append(focusedLabels, $('.sr-desc')).textContent = STR_FOCUSED_TOGGLE_HINT;
		const focusedToggle = dom.append(focusedRow, $('input.pns-toggle')) as HTMLInputElement;
		focusedToggle.type = 'checkbox';
		focusedToggle.checked = this.settingsService.getNotifyWhileFocused();
		this._renderDisposables.add(dom.addDisposableListener(focusedToggle, 'change', () => {
			this.settingsService.setNotifyWhileFocused(focusedToggle.checked);
		}));
	}

	private _renderSoundSectionBody(onListPopulated: () => void): void {
		const container = this._soundSectionEl;
		dom.clearNode(container);

		dom.append(container, $('.pns-section-title')).textContent = STR_SECTION_TITLE;
		dom.append(container, $('.pns-section-desc')).textContent = STR_SECTION_DESC;

		const muted = this.settingsService.getSoundsMuted();
		const volume = this.settingsService.getVolume();
		const selectedId = this.settingsService.getSelectedRingtoneId();

		// --- サウンドトグル ---
		const toggleRow = dom.append(container, $('.setting-row'));
		const toggleLabels = dom.append(toggleRow, $('.sr-main'));
		dom.append(toggleLabels, $('.sr-label')).textContent = STR_TOGGLE_LABEL;
		dom.append(toggleLabels, $('.sr-desc')).textContent = STR_TOGGLE_HINT;
		const toggle = dom.append(toggleRow, $('input.pns-toggle')) as HTMLInputElement;
		toggle.type = 'checkbox';
		toggle.checked = !muted;
		this._renderDisposables.add(dom.addDisposableListener(toggle, 'change', () => {
			this.settingsService.setSoundsMuted(!toggle.checked);
		}));

		if (muted) {
			onListPopulated();
			return;
		}

		// --- 音量 ---
		const volumeRow = dom.append(container, $('.setting-row'));
		const volumeMain = dom.append(volumeRow, $('.sr-main'));
		dom.append(volumeMain, $('.sr-label')).textContent = STR_VOLUME_LABEL;
		const volumeSelect = dom.append(volumeRow, $('select')) as HTMLSelectElement;
		volumeSelect.style.width = '170px';
		volumeSelect.style.flexShrink = '0';
		for (const level of VOLUME_LEVELS) {
			const option = dom.append(volumeSelect, $('option')) as HTMLOptionElement;
			option.value = String(level.value);
			option.textContent = `${level.label} (${level.value}%)`;
		}
		volumeSelect.value = String(volume);
		this._renderDisposables.add(dom.addDisposableListener(volumeSelect, 'change', () => {
			this.settingsService.setVolume(Number(volumeSelect.value));
		}));

		// --- 着信音リストのヘッダー（取込アクション） ---
		const listHeader = dom.append(container, $('.setting-row'));
		const listTitles = dom.append(listHeader, $('.sr-main'));
		dom.append(listTitles, $('.sr-label')).textContent = STR_RINGTONE_TITLE;
		dom.append(listTitles, $('.sr-desc')).textContent = STR_RINGTONE_DESC;
		const actions = dom.append(listHeader, $('div.pns-events-box'));

		const importBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		importBtn.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.add)}`));
		this._renderDisposables.add(dom.addDisposableListener(importBtn, 'click', () => this._importCustomAudio()));

		const youtubeBtn = dom.append(actions, $('button.pns-btn')) as HTMLButtonElement;
		youtubeBtn.textContent = STR_FROM_YOUTUBE;
		this._renderDisposables.add(dom.addDisposableListener(youtubeBtn, 'click', () => {
			this.instantiationService.invokeFunction(accessor => openParadisYouTubeImportDialog(accessor, () => this._renderNotificationsSections()));
		}));

		// --- 着信音カード（2列グリッド） ---
		const grid = dom.append(container, $('.pns-ringtone-grid'));

		void this._fetchCustomRingtone().then(custom => {
			if (this._store.isDisposed) {
				return;
			}
			importBtn.textContent = custom ? STR_REPLACE_CUSTOM : STR_ADD_CUSTOM;
			const ringtones: (IParadisRingtoneData | IParadisCustomRingtoneInfo)[] = custom ? [...PARADIS_RINGTONES, custom] : [...PARADIS_RINGTONES];
			for (const ringtone of ringtones) {
				this._renderRingtoneCard(grid, ringtone, ringtone.id === selectedId, volume);
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

	private _renderRingtoneCard(grid: HTMLElement, ringtone: IParadisRingtoneData | IParadisCustomRingtoneInfo, selected: boolean, volume: number): void {
		const card = dom.append(grid, $('.pns-ringtone-card'));
		if (selected) {
			card.classList.add('selected');
		}

		const check = dom.append(card, $('.pns-ringtone-check'));
		if (selected) {
			check.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.check)}`));
		}

		dom.append(card, $('.pns-ringtone-emoji')).textContent = ringtone.emoji;

		const info = dom.append(card, $('.pns-ringtone-info'));
		const nameRow = dom.append(info, $('.pns-ringtone-name'));
		nameRow.append(ringtone.name);
		if (ringtone.duration) {
			dom.append(nameRow, $('span.pns-ringtone-duration')).textContent = `${ringtone.duration}s`;
		}
		dom.append(info, $('.pns-ringtone-desc')).textContent = ringtone.description;
		dom.append(info, $('div.pns-rt-progress')).appendChild($('i.pns-rt-progress-fill'));

		const playBtn = dom.append(card, $('button.pns-ringtone-play')) as HTMLButtonElement;
		const isPlaying = this._playingRingtoneId === ringtone.id;
		this._setPlayButtonPlaying(playBtn, isPlaying);

		this._renderDisposables.add(dom.addDisposableListener(card, 'click', () => {
			this.settingsService.setSelectedRingtoneId(ringtone.id);
		}));
		// 試聴の再生/停止は一過性の状態変化であり、セクション全体を再描画すると
		// クリックされたボタン自身がDOMから外れてフォーカスが失われ、.pns-contentが
		// 先頭までスクロールされてしまう（paradisPreserveScroll適用対象外の経路）。
		// そのため該当ボタンのアイコン/クラスだけを直接更新し、再描画は行わない。
		this._renderDisposables.add(dom.addDisposableListener(playBtn, 'click', e => {
			e.stopPropagation();
			this._togglePreview(playBtn, card, ringtone.id, ringtone.duration, volume);
		}));

		// 再描画をまたいで再生中表示（⏹ + 進捗バー）を復元する。進捗は保存済みの
		// 開始時刻から継続計算するため、再描画してもバーが巻き戻らない。
		if (isPlaying) {
			this._playingButton = playBtn;
			this._playingCard = card;
			card.classList.add('playing');
			this._startProgressBar();
		}
	}

	private _setPlayButtonPlaying(playBtn: HTMLButtonElement, playing: boolean): void {
		playBtn.classList.toggle('playing', playing);
		dom.clearNode(playBtn);
		playBtn.appendChild($(`span${ThemeIcon.asCSSSelector(playing ? Codicon.primitiveSquare : Codicon.play)}`));
		playBtn.setAttribute('aria-label', playing ? STR_STOP_PREVIEW_ARIA : STR_PLAY_PREVIEW_ARIA);
	}

	private _clearPlaybackTimers(): void {
		if (this._playingAutoStopTimer !== undefined) {
			clearTimeout(this._playingAutoStopTimer);
			this._playingAutoStopTimer = undefined;
		}
		this._stopProgressBar();
	}

	private _stopPreview(): void {
		this._clearPlaybackTimers();
		this._player.stop();
		if (this._playingButton) {
			this._setPlayButtonPlaying(this._playingButton, false);
		}
		if (this._playingCard) {
			this._playingCard.classList.remove('playing');
			const fill = this._playingCard.querySelector<HTMLElement>('.pns-rt-progress-fill');
			if (fill) {
				fill.style.width = '0%';
			}
		}
		this._playingButton = undefined;
		this._playingCard = undefined;
		this._playingStartedAt = undefined;
		this._playingRingtoneId = undefined;
	}

	private _togglePreview(playBtn: HTMLButtonElement, card: HTMLElement, ringtoneId: string, duration: number | undefined, volume: number): void {
		const wasPlayingSame = this._playingRingtoneId === ringtoneId;
		this._stopPreview();
		if (wasPlayingSame) {
			return; // 同じ行を再クリック: 停止のみ
		}

		this._playingRingtoneId = ringtoneId;
		this._playingButton = playBtn;
		this._playingCard = card;
		this._playingDurationSeconds = duration ?? 5;
		this._playingStartedAt = Date.now();
		this._setPlayButtonPlaying(playBtn, true);
		card.classList.add('playing');
		void this._player.play(ringtoneId, volume);
		this._startProgressBar();

		// 着信音の実際の長さ(+0.5秒の余裕)で自動的に再生中表示を解除する(Superset同様の挙動)。
		const durationMs = ((duration ?? 5) + 0.5) * 1000;
		this._playingAutoStopTimer = setTimeout(() => {
			if (this._playingRingtoneId === ringtoneId) {
				this._stopPreview();
			}
		}, durationMs);
	}

	/** 再生中カードの進捗バーを rt.dur 秒いっぱいまで動かす。 */
	private _startProgressBar(): void {
		this._stopProgressBar();
		if (!this._playingCard || this._playingStartedAt === undefined) {
			return;
		}
		const fill = this._playingCard.querySelector<HTMLElement>('.pns-rt-progress-fill');
		if (!fill) {
			return;
		}
		const startedAt = this._playingStartedAt;
		const totalMs = this._playingDurationSeconds * 1000;
		const update = () => {
			const elapsed = Date.now() - startedAt;
			fill.style.width = `${Math.min(100, (elapsed / totalMs) * 100)}%`;
			if (elapsed >= totalMs) {
				this._stopProgressBar(); // 100%で停止。表示リセットは自動停止時に行う。
			}
		};
		update();
		this._playingProgressTimer = setInterval(update, 60);
	}

	private _stopProgressBar(): void {
		if (this._playingProgressTimer !== undefined) {
			clearInterval(this._playingProgressTimer);
			this._playingProgressTimer = undefined;
		}
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
			this._renderNotificationsSections();
		} catch (error) {
			this.notificationService.error(error instanceof Error ? error.message : String(error));
		}
	}
}

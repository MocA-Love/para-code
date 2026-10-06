/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Myinstants 取り込みダイアログ（paradisYouTubeImportDialog.ts と同じ入れ子ダイアログの作り）。
// mp3 の直リンクを貼る → 読み込む（shared process が 1 回だけ取得）→ 試聴 → 名前を付けて保存、の流れ。
// アプリは Myinstants を検索も一覧化もしない（規約が自動の検索・リクエストを禁じているため）。

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IParadisCustomRingtoneInfo, PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES, PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';
import { IParadisMyinstantsDownloadResult, PARADIS_MYINSTANTS_HOME_URL, ParadisMyinstantsDownloadFailure, paradisCheckMyinstantsUrl } from '../common/paradisMyinstants.js';
import { base64ToBlobUrl } from './paradisNotificationSoundPlayer.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.myinstants.title', "Myinstants から取り込み");
// allow-any-unicode-next-line
const STR_URL_LABEL = localize('paradis.notif.myinstants.urlLabel', "音の mp3 の URL");
const STR_URL_PLACEHOLDER = 'https://www.myinstants.com/media/sounds/....mp3';
// allow-any-unicode-next-line
const STR_URL_HINT = localize('paradis.notif.myinstants.urlHint', "Myinstants の音のページで \"Download MP3\" を右クリックし、リンクをコピーして貼ってください。");
// allow-any-unicode-next-line
const STR_OPEN_SITE = localize('paradis.notif.myinstants.openSite', "Myinstants を開く");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.notif.myinstants.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_LOAD = localize('paradis.notif.myinstants.load', "読み込む");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.myinstants.loading', "読み込み中…");
// allow-any-unicode-next-line
const STR_NAME_LABEL = localize('paradis.notif.myinstants.nameLabel', "表示名");
// allow-any-unicode-next-line
const STR_SAVE = localize('paradis.notif.myinstants.save', "通知音にする");
// allow-any-unicode-next-line
const STR_SAVING = localize('paradis.notif.myinstants.saving', "取り込み中…");
// allow-any-unicode-next-line
const STR_PLAY_ARIA = localize('paradis.notif.myinstants.playAria', "試聴を再生");
// allow-any-unicode-next-line
const STR_STOP_ARIA = localize('paradis.notif.myinstants.stopAria', "試聴を停止");
// allow-any-unicode-next-line
const STR_COPYRIGHT = localize('paradis.notif.myinstants.copyright', "著作権は投稿者・権利者にあります。個人の通知音としてのみ使ってください。出典の URL を一緒に保存します。");
// allow-any-unicode-next-line
const STR_OVERWRITE = localize('paradis.notif.myinstants.overwrite', "カスタム音源は 1 つだけ持てます。取り込むと今のカスタム音源は置き換わります。");
// allow-any-unicode-next-line
const strOverwriteNamed = (name: string) => localize('paradis.notif.myinstants.overwriteNamed', "カスタム音源は 1 つだけ持てます。取り込むと今のカスタム音源（{0}）は置き換わります。", name);

// allow-any-unicode-next-line
const STR_ERR_EMPTY = localize('paradis.notif.myinstants.errEmpty', "mp3 の URL を貼ってください。");
// allow-any-unicode-next-line
const STR_ERR_INVALID = localize('paradis.notif.myinstants.errInvalid', "Myinstants の mp3 の URL（https://www.myinstants.com/media/sounds/ で始まり .mp3 で終わるもの）を貼ってください。");
// allow-any-unicode-next-line
const STR_ERR_PAGE = localize('paradis.notif.myinstants.errPage', "これは音のページの URL です。ページの \"Download MP3\" を右クリックしてリンクをコピーし、その URL を貼ってください。");
// allow-any-unicode-next-line
const STR_ERR_REDIRECT = localize('paradis.notif.myinstants.errRedirect', "Myinstants の mp3 以外への転送が返ったため、取得をやめました。");
// allow-any-unicode-next-line
const STR_ERR_NOT_FOUND = localize('paradis.notif.myinstants.errNotFound', "この音は削除された可能性があります。");
// allow-any-unicode-next-line
const STR_ERR_BLOCKED = localize('paradis.notif.myinstants.errBlocked', "Myinstants が取得を止めました。ブラウザで \"Download MP3\" から保存し、「カスタム音源を追加」で取り込んでください。");
// allow-any-unicode-next-line
const strErrHttp = (status: number) => localize('paradis.notif.myinstants.errHttp', "取得できませんでした (HTTP {0})。", status);
// allow-any-unicode-next-line
const STR_ERR_NOT_MP3 = localize('paradis.notif.myinstants.errNotMp3', "mp3 ではないデータが返りました。URL を確かめてください。");
// allow-any-unicode-next-line
const strErrTooLarge = (megabytes: number) => localize('paradis.notif.myinstants.errTooLarge', "音源が大きすぎます。最大 {0}MB です。", megabytes);
// allow-any-unicode-next-line
const STR_ERR_TIMEOUT = localize('paradis.notif.myinstants.errTimeout', "時間内に取得できませんでした。もう一度試してください。");
// allow-any-unicode-next-line
const STR_ERR_NETWORK = localize('paradis.notif.myinstants.errNetwork', "取得できませんでした。ネットワークの接続を確かめてください。");

function failureMessage(reason: ParadisMyinstantsDownloadFailure, status: number | undefined): string {
	switch (reason) {
		case 'invalidUrl': return STR_ERR_INVALID;
		case 'pageUrl': return STR_ERR_PAGE;
		case 'redirect': return STR_ERR_REDIRECT;
		case 'notFound': return STR_ERR_NOT_FOUND;
		case 'blocked': return STR_ERR_BLOCKED;
		case 'http': return strErrHttp(status ?? 0);
		case 'notMp3': return STR_ERR_NOT_MP3;
		case 'tooLarge': return strErrTooLarge(Math.round(PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES / 1024 / 1024));
		case 'timeout': return STR_ERR_TIMEOUT;
		case 'network': return STR_ERR_NETWORK;
	}
}

function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type ParadisMyinstantsLoaded = Extract<IParadisMyinstantsDownloadResult, { ok: true }>;

/**
 * Myinstants 取り込みダイアログを開く。`onImported` は保存に成功した後に呼ぶ（呼び出し元はカスタム音源を選び直して再描画する）。
 * `volume` は試聴の音量（0-100）。
 */
export function openParadisMyinstantsImportDialog(accessor: ServicesAccessor, volume: number, onImported: () => void): void {
	const layoutService = accessor.get(ILayoutService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	const openerService = accessor.get(IOpenerService);
	// ダイアログは自身のcloseで自己disposeするため、呼び出し元での追跡・登録は不要。
	const dialog = new ParadisMyinstantsImportDialog(layoutService, sharedProcessService, openerService, volume, onImported);
	void dialog;
}

class ParadisMyinstantsImportDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;
	private readonly _urlInput: HTMLInputElement;
	private readonly _urlErrorEl: HTMLElement;
	private readonly _previewEl: HTMLElement;
	private readonly _loadBtn: HTMLButtonElement;
	private readonly _saveBtn: HTMLButtonElement;
	/** 読み込んだ音ごとの試聴・入力欄のリスナ。読み直しや URL の書き換えで丸ごと捨てる。 */
	private readonly _previewDisposables = this._register(new DisposableStore());
	private _loaded: ParadisMyinstantsLoaded | undefined;
	/** 読み込んだときの入力欄の文字列。書き換えられたら読み込んだ音を捨てる。 */
	private _loadedInput: string | undefined;
	private _nameInput: HTMLInputElement | undefined;
	private _saveErrorEl: HTMLElement | undefined;
	/** 読み込み中の入力欄の文字列。 */
	private _pendingInput: string | undefined;
	/** 読み込みの世代。読み込み中に URL を書き換えたり読み直したりしたら、古い結果は捨てる。 */
	private _loadGeneration = 0;
	private _saving = false;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly openerService: IOpenerService,
		private readonly volume: number,
		private readonly onImported: () => void,
	) {
		super();

		this._backdrop = $('.paradis-notif-nested-backdrop');
		this._dialog = $('.paradis-notif-nested-dialog.pns-myinstants');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			// 保存中は閉じない（閉じると保存の結果を受け取れず、一時ファイルの後始末と競合する）。
			if (e.target === this._backdrop && !this._saving) {
				this.dispose();
			}
		}));

		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;

		const urlField = dom.append(this._dialog, $('.pns-field'));
		dom.append(urlField, $('label.pns-label')).textContent = STR_URL_LABEL;
		this._urlInput = dom.append(urlField, $('input')) as HTMLInputElement;
		this._urlInput.type = 'url';
		this._urlInput.placeholder = STR_URL_PLACEHOLDER;
		this._urlInput.autofocus = true;
		const hint = dom.append(urlField, $('.pns-row-hint'));
		hint.append(STR_URL_HINT, ' ');
		const openSite = dom.append(hint, $('a.pns-mi-link')) as HTMLAnchorElement;
		openSite.textContent = STR_OPEN_SITE;
		openSite.href = '#';
		this._register(dom.addDisposableListener(openSite, 'click', e => {
			e.preventDefault();
			void this.openerService.open(URI.parse(PARADIS_MYINSTANTS_HOME_URL), { openExternal: true });
		}));
		this._urlErrorEl = dom.append(urlField, $('.pns-error.pns-mi-error'));

		this._previewEl = dom.append(this._dialog, $('.pns-mi-body'));

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => {
			if (!this._saving) {
				this.dispose();
			}
		}));

		this._loadBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		this._loadBtn.textContent = STR_LOAD;
		this._register(dom.addDisposableListener(this._loadBtn, 'click', () => this._load()));

		this._saveBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		this._saveBtn.textContent = STR_SAVE;
		this._saveBtn.disabled = true;
		this._register(dom.addDisposableListener(this._saveBtn, 'click', () => this._save()));

		this._register(dom.addDisposableListener(this._urlInput, 'keydown', e => {
			if (e.key === 'Enter') {
				this._load();
			}
		}));
		// 読み込んだ後に URL を書き換えたら、試聴中の音と保存の対象は捨てる（貼った URL と保存する音を食い違わせない）。
		this._register(dom.addDisposableListener(this._urlInput, 'input', () => {
			this._urlErrorEl.textContent = '';
			const value = this._urlInput.value.trim();
			if (this._loaded && value !== this._loadedInput) {
				this._discardLoaded();
			}
			if (this._pendingInput !== undefined && value !== this._pendingInput) {
				// 読み込み中の URL を書き換えた。届く結果は捨てる。
				this._pendingInput = undefined;
				this._loadGeneration++;
				this._loadBtn.disabled = false;
				this._loadBtn.textContent = STR_LOAD;
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._urlInput.focus();
	}

	override dispose(): void {
		this._loadGeneration++;
		this._discardLoaded();
		this._backdrop.remove();
		super.dispose();
	}

	private _channel() {
		return this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL);
	}

	/** 読み込み済みの音と試聴を捨て、shared process の一時ファイルも消す。 */
	private _discardLoaded(): void {
		this._previewDisposables.clear();
		dom.clearNode(this._previewEl);
		this._nameInput = undefined;
		this._saveErrorEl = undefined;
		this._loadedInput = undefined;
		this._saveBtn.disabled = true;
		const loaded = this._loaded;
		this._loaded = undefined;
		if (loaded) {
			void this._channel().call('cleanupTempAudio', [loaded.tempId]).catch(() => { /* ignore */ });
		}
	}

	private _load(): void {
		if (this._saving) {
			return;
		}
		const check = paradisCheckMyinstantsUrl(this._urlInput.value);
		if (check.kind !== 'mp3') {
			this._urlErrorEl.textContent = check.kind === 'empty' ? STR_ERR_EMPTY : check.kind === 'page' ? STR_ERR_PAGE : STR_ERR_INVALID;
			return;
		}
		this._discardLoaded();
		this._urlErrorEl.textContent = '';
		const generation = ++this._loadGeneration;
		const input = this._urlInput.value.trim();
		this._pendingInput = input;
		this._loadBtn.disabled = true;
		this._loadBtn.textContent = STR_LOADING;

		void this._channel().call<IParadisMyinstantsDownloadResult>('downloadMyinstantsAudio', [check.url]).then(async result => {
			if (this._store.isDisposed || generation !== this._loadGeneration) {
				if (result.ok) {
					void this._channel().call('cleanupTempAudio', [result.tempId]).catch(() => { /* ignore */ });
				}
				return;
			}
			if (!result.ok) {
				this._urlErrorEl.textContent = failureMessage(result.reason, result.status);
				return;
			}
			this._loaded = result;
			this._loadedInput = input;
			const custom = await this._channel().call<IParadisCustomRingtoneInfo | null>('getCustomRingtoneInfo').catch(() => null);
			if (this._store.isDisposed || this._loaded !== result) {
				return;
			}
			this._renderPreview(result, custom);
		}, error => {
			if (this._store.isDisposed || generation !== this._loadGeneration) {
				return;
			}
			this._urlErrorEl.textContent = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			if (!this._store.isDisposed && generation === this._loadGeneration) {
				this._pendingInput = undefined;
				this._loadBtn.disabled = false;
				this._loadBtn.textContent = STR_LOAD;
			}
		});
	}

	private _renderPreview(loaded: ParadisMyinstantsLoaded, custom: IParadisCustomRingtoneInfo | null): void {
		this._previewDisposables.clear();
		dom.clearNode(this._previewEl);
		const store = this._previewDisposables;

		// --- 試聴の行（形式・名前・長さ・大きさとホスト・再生/停止） ---
		const card = dom.append(this._previewEl, $('.pns-mi-preview'));
		dom.append(card, $('.pns-mi-badge')).textContent = 'mp3';
		const info = dom.append(card, $('.pns-mi-info'));
		const nameRow = dom.append(info, $('.pns-mi-name'));
		nameRow.append(loaded.fileName.replace(/\.mp3$/i, ''));
		const durationEl = dom.append(nameRow, $('span.pns-mi-duration'));
		let host = '';
		try {
			host = new URL(loaded.sourceUrl).hostname;
		} catch {
			// 判定済みの URL なので起こらない
		}
		dom.append(info, $('.pns-mi-meta')).textContent = `${formatSize(loaded.sizeBytes)} / ${host}`;
		const playBtn = dom.append(card, $('button.pns-mi-play')) as HTMLButtonElement;

		const audio = new Audio();
		audio.volume = Math.max(0, Math.min(1, this.volume / 100));
		let blobUrl: string | undefined;
		let alive = true;
		store.add(toDisposable(() => {
			alive = false;
			audio.pause();
			audio.removeAttribute('src');
			if (blobUrl) {
				URL.revokeObjectURL(blobUrl);
			}
		}));
		const setPlaying = (playing: boolean) => {
			playBtn.classList.toggle('playing', playing);
			dom.clearNode(playBtn);
			playBtn.appendChild($(`span${ThemeIcon.asCSSSelector(playing ? Codicon.primitiveSquare : Codicon.play)}`));
			playBtn.setAttribute('aria-label', playing ? STR_STOP_ARIA : STR_PLAY_ARIA);
		};
		setPlaying(false);
		store.add(dom.addDisposableListener(audio, 'loadedmetadata', () => {
			if (Number.isFinite(audio.duration) && audio.duration > 0) {
				durationEl.textContent = `${audio.duration.toFixed(1)}s`;
			}
		}));
		store.add(dom.addDisposableListener(audio, 'ended', () => setPlaying(false)));
		store.add(dom.addDisposableListener(audio, 'pause', () => setPlaying(false)));
		store.add(dom.addDisposableListener(audio, 'play', () => setPlaying(true)));
		store.add(dom.addDisposableListener(playBtn, 'click', () => {
			if (!audio.paused) {
				audio.pause();
				audio.currentTime = 0;
				return;
			}
			void audio.play().catch(() => setPlaying(false));
		}));
		// 試聴は取得済みのバイト列を使う（Myinstants へ取りに行き直さない）。
		void this._channel().call<{ base64: string; mimeType: string } | null>('readTempAudioFile', [loaded.tempId]).then(file => {
			if (!file || !alive) {
				return;
			}
			blobUrl = base64ToBlobUrl(file.base64, file.mimeType);
			audio.src = blobUrl;
		}, () => { /* 試聴できなくても保存はできる */ });

		// --- 表示名 ---
		const nameField = dom.append(this._previewEl, $('.pns-field'));
		dom.append(nameField, $('label.pns-label')).textContent = STR_NAME_LABEL;
		const nameInput = dom.append(nameField, $('input')) as HTMLInputElement;
		nameInput.type = 'text';
		nameInput.maxLength = 80;
		nameInput.value = loaded.suggestedName;
		this._nameInput = nameInput;
		store.add(dom.addDisposableListener(nameInput, 'keydown', e => {
			if (e.key === 'Enter') {
				this._save();
			}
		}));

		// --- 注意書き（著作権と上書き） ---
		const notice = dom.append(this._previewEl, $('.pns-mi-notice'));
		dom.append(notice, $('div')).textContent = STR_COPYRIGHT;
		dom.append(notice, $('div')).textContent = custom ? strOverwriteNamed(custom.name) : STR_OVERWRITE;

		this._saveErrorEl = dom.append(this._previewEl, $('.pns-error.pns-mi-error'));
		this._saveBtn.disabled = false;
	}

	private async _save(): Promise<void> {
		const loaded = this._loaded;
		if (!loaded || this._saving) {
			return;
		}
		this._saving = true;
		this._saveBtn.disabled = true;
		this._loadBtn.disabled = true;
		this._saveBtn.textContent = STR_SAVING;
		try {
			await this._channel().call('importMyinstantsAudio', [loaded.tempId, this._nameInput?.value ?? '']);
			// 一時ファイルは shared process が保存後に消した。dispose で二重に消しに行かない。
			this._loaded = undefined;
			this.onImported();
			this.dispose();
		} catch (error) {
			if (this._store.isDisposed) {
				return;
			}
			if (this._saveErrorEl) {
				this._saveErrorEl.textContent = error instanceof Error ? error.message : String(error);
			}
			this._saveBtn.disabled = false;
			this._loadBtn.disabled = false;
			this._saveBtn.textContent = STR_SAVE;
		} finally {
			this._saving = false;
		}
	}
}

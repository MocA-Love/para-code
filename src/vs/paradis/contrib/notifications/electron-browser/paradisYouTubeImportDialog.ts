/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// YouTube取込ダイアログ（Superset apps/desktop の YouTubeImportDialog.tsx の移植）。
// url → (未導入なら)インストールログ表示 → ダウンロード → 波形エディタ、の4ステップ構成。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import {
	IParadisInstallLogResult,
	IParadisRenderClipRequest,
	IParadisYouTubeDownloadResult,
	PARADIS_NOTIFICATIONS_CHANNEL,
} from '../common/paradisNotifications.js';
import { ParadisAudioEditor, paradisAudioEditorOutputExceedsMessage } from './paradisAudioEditor.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_TITLE = localize('paradis.notif.youtube.title', "YouTubeから取り込み");
// allow-any-unicode-next-line
const STR_URL_LABEL = localize('paradis.notif.youtube.urlLabel', "YouTube URL");
// allow-any-unicode-next-line
const STR_URL_PLACEHOLDER = localize('paradis.notif.youtube.urlPlaceholder', "https://www.youtube.com/watch?v=...");
// allow-any-unicode-next-line
const STR_URL_INVALID = localize('paradis.notif.youtube.urlInvalid', "youtube.com または youtu.be の URL を入力してください。");
// allow-any-unicode-next-line
const STR_CANCEL = localize('paradis.notif.youtube.cancel', "キャンセル");
// allow-any-unicode-next-line
const STR_LOAD = localize('paradis.notif.youtube.load', "読み込む");
// allow-any-unicode-next-line
const STR_DOWNLOADING = localize('paradis.notif.youtube.downloading', "YouTubeから音声をダウンロード中…");
// allow-any-unicode-next-line
const STR_INSTALLING_TITLE = localize('paradis.notif.youtube.installingTitle', "依存ツールをインストール中…");
// allow-any-unicode-next-line
const strMissingBinaries = (list: string) => localize('paradis.notif.youtube.missingBinaries', "必要なツールが見つかりません: {0}", list);
// allow-any-unicode-next-line
const STR_INSTALL_HOMEBREW = localize('paradis.notif.youtube.installHomebrew', "Homebrewでインストール");
// allow-any-unicode-next-line
const STR_BACK = localize('paradis.notif.youtube.back', "戻る");
// allow-any-unicode-next-line
const STR_IMPORT = localize('paradis.notif.youtube.import', "取り込む");
// allow-any-unicode-next-line
const STR_IMPORTING = localize('paradis.notif.youtube.importing', "取り込み中…");

const YOUTUBE_URL_HINT = /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i;

type Step = 'url' | 'installing' | 'downloading' | 'editor';

export function openParadisYouTubeImportDialog(accessor: ServicesAccessor, onImported: () => void): void {
	const layoutService = accessor.get(ILayoutService);
	const sharedProcessService = accessor.get(ISharedProcessService);
	// ダイアログは自身のcloseで自己disposeするため、呼び出し元での追跡・登録は不要。
	const dialog = new ParadisYouTubeImportDialog(layoutService, sharedProcessService, onImported);
	void dialog;
}

class ParadisYouTubeImportDialog extends Disposable {

	private readonly _backdrop: HTMLElement;
	private readonly _dialog: HTMLElement;
	private _step: Step = 'url';
	private _downloaded: IParadisYouTubeDownloadResult | undefined;
	private _audioEditor: ParadisAudioEditor | undefined;

	constructor(
		layoutService: ILayoutService,
		private readonly sharedProcessService: ISharedProcessService,
		private readonly onImported: () => void,
	) {
		super();

		this._backdrop = $('.paradis-notif-nested-backdrop');
		this._dialog = $('.paradis-notif-nested-dialog');
		this._backdrop.appendChild(this._dialog);

		this._register(dom.addDisposableListener(this._backdrop, 'mousedown', e => {
			if (e.target === this._backdrop) {
				this.dispose();
			}
		}));

		layoutService.activeContainer.appendChild(this._backdrop);
		this._renderUrlStep();
	}

	override dispose(): void {
		this._audioEditor?.dispose();
		if (this._downloaded) {
			void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('cleanupTempAudio', [this._downloaded.tempId]).catch(() => { /* ignore */ });
		}
		this._backdrop.remove();
		super.dispose();
	}

	private _renderUrlStep(initialError?: string): void {
		this._step = 'url';
		dom.clearNode(this._dialog);
		this._dialog.classList.remove('wide');
		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<{ missing: string[] }>('checkYtDlp').then(result => {
			if (this._store.isDisposed || this._step !== 'url') {
				return;
			}
			if (result.missing.length > 0) {
				this._renderMissingBinariesNotice(result.missing);
			}
		});

		const urlField = dom.append(this._dialog, $('.pns-field'));
		dom.append(urlField, $('label.pns-label')).textContent = STR_URL_LABEL;
		const urlInput = dom.append(urlField, $('input')) as HTMLInputElement;
		urlInput.type = 'url';
		urlInput.placeholder = STR_URL_PLACEHOLDER;
		urlInput.autofocus = true;

		const urlErrorEl = dom.append(urlField, $('.pns-error'));

		const errorEl = dom.append(this._dialog, $('.pns-error'));
		if (initialError) {
			errorEl.textContent = initialError;
		}

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

		const loadBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		loadBtn.textContent = STR_LOAD;

		const doLoad = () => {
			const url = urlInput.value.trim();
			if (!YOUTUBE_URL_HINT.test(url)) {
				urlErrorEl.textContent = STR_URL_INVALID;
				return;
			}
			this._renderDownloadingStep(url);
		};
		this._register(dom.addDisposableListener(loadBtn, 'click', doLoad));
		this._register(dom.addDisposableListener(urlInput, 'keydown', e => {
			if (e.key === 'Enter') {
				doLoad();
			}
		}));
	}

	private _renderMissingBinariesNotice(missing: string[]): void {
		const notice = dom.append(this._dialog, $('.pns-field'));
		const hint = dom.append(notice, $('.pns-row-hint'));
		hint.textContent = strMissingBinaries(missing.join(', '));
		if (process.platform === 'darwin') {
			const installBtn = dom.append(notice, $('button.pns-btn')) as HTMLButtonElement;
			installBtn.textContent = STR_INSTALL_HOMEBREW;
			installBtn.style.marginTop = '6px';
			this._register(dom.addDisposableListener(installBtn, 'click', () => this._renderInstallingStep()));
		}
	}

	private _renderInstallingStep(): void {
		this._step = 'installing';
		dom.clearNode(this._dialog);
		dom.append(this._dialog, $('h3')).textContent = STR_INSTALLING_TITLE;

		const consoleEl = dom.append(this._dialog, $('.pns-log-console'));

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const backBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		backBtn.style.display = 'none';
		this._register(dom.addDisposableListener(backBtn, 'click', () => this._renderUrlStep()));

		const installId = generateUuid();
		let lastSeq = 0;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('installYtDlp', [installId]);

		const poll = () => {
			if (this._store.isDisposed || this._step !== 'installing') {
				return;
			}
			void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisInstallLogResult>('getInstallLog', [installId, lastSeq]).then(result => {
				if (this._store.isDisposed || this._step !== 'installing') {
					return;
				}
				for (const line of result.lines) {
					lastSeq = line.seq;
					const lineEl = dom.append(consoleEl, $(`div.pns-log-line.${line.level}`));
					lineEl.textContent = line.message;
				}
				consoleEl.scrollTop = consoleEl.scrollHeight;
				if (result.done) {
					backBtn.style.display = '';
					if (!result.error) {
						this._renderUrlStep();
					}
					return;
				}
				setTimeout(poll, 500);
			}, () => setTimeout(poll, 1000));
		};
		poll();
	}

	private _renderDownloadingStep(url: string): void {
		this._step = 'downloading';
		dom.clearNode(this._dialog);
		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;
		dom.append(this._dialog, $('.pns-nested-desc')).textContent = STR_DOWNLOADING;

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisYouTubeDownloadResult>('downloadYouTubeAudio', [url]).then(result => {
			if (this._store.isDisposed) {
				return;
			}
			this._downloaded = result;
			this._renderEditorStep(url, result);
		}, error => {
			if (this._store.isDisposed) {
				return;
			}
			this._renderUrlStep(error instanceof Error ? error.message : String(error));
		});
	}

	private _renderEditorStep(url: string, downloaded: IParadisYouTubeDownloadResult): void {
		this._step = 'editor';
		dom.clearNode(this._dialog);
		this._dialog.classList.add('wide');
		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;

		const editorContainer = dom.append(this._dialog, $('div'));
		this._audioEditor = this._register(new ParadisAudioEditor(editorContainer, {
			tempId: downloaded.tempId,
			videoTitle: downloaded.info.title,
			totalDuration: downloaded.info.durationSeconds,
			initialDisplayName: downloaded.info.title.slice(0, 80),
		}, this.sharedProcessService));

		const errorEl = dom.append(this._dialog, $('.pns-error'));

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._register(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

		const importBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		importBtn.textContent = STR_IMPORT;
		this._register(dom.addDisposableListener(importBtn, 'click', async () => {
			if (!this._audioEditor) {
				return;
			}
			if (!this._audioEditor.isOutputValid()) {
				const params = this._audioEditor.getParams();
				errorEl.textContent = paradisAudioEditorOutputExceedsMessage((params.endSeconds - params.startSeconds) / params.playbackRate);
				return;
			}
			const params = this._audioEditor.getParams();
			importBtn.disabled = true;
			importBtn.textContent = STR_IMPORTING;
			const request: IParadisRenderClipRequest = {
				tempId: downloaded.tempId,
				startSeconds: params.startSeconds,
				endSeconds: params.endSeconds,
				fadeInSeconds: params.fadeInSeconds > 0 ? params.fadeInSeconds : undefined,
				fadeOutSeconds: params.fadeOutSeconds > 0 ? params.fadeOutSeconds : undefined,
				playbackRate: params.playbackRate !== 1.0 ? params.playbackRate : undefined,
				displayName: params.displayName || undefined,
				thumbnailUrl: downloaded.info.thumbnailUrl || undefined,
				sourceTitle: downloaded.info.title,
				sourceUrl: url,
			};
			try {
				await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call('renderClip', [request]);
				this._downloaded = undefined; // renderClip完了後は cleanupTempAudio 不要 (取り込み済み)
				this.onImported();
				this.dispose();
			} catch (error) {
				errorEl.textContent = error instanceof Error ? error.message : String(error);
				importBtn.disabled = false;
				importBtn.textContent = STR_IMPORT;
			}
		}));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// YouTube取込ダイアログ（Superset apps/desktop の YouTubeImportDialog.tsx の移植）。
// url → (未導入なら)インストールログ表示 → ダウンロード → 波形エディタ、の4ステップ構成。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { IParadisYtDlpCheckResult, IParadisYtDlpStatus, ParadisYtDlpPrecursor } from '../common/paradisYtDlp.js';
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
// allow-any-unicode-next-line
const STR_DENO_MISSING = localize('paradis.notif.youtube.denoMissing', "deno が見つかりません。無くても取り込めますが、YouTube の一部の動画は取れないことがあります。Para Code は自動では入れないため、「brew install deno」（macOS）か https://deno.com の手順で入れてください。");
// allow-any-unicode-next-line
const strYtDlpBroken = (version: string) => localize('paradis.notif.youtube.ytDlpBroken', "yt-dlp {0} は、YouTube の変更で HTTP 403 が出て取り込めない版です。更新してください。", version);
// allow-any-unicode-next-line
const strYtDlpOutdated = (version: string, days: number) => localize('paradis.notif.youtube.ytDlpOutdated', "yt-dlp {0} は {1} 日前の版です。YouTube の変更で取り込めなくなることがあるため、更新してください。", version, days);
// allow-any-unicode-next-line
const strUpdateCommand = (command: string) => localize('paradis.notif.youtube.updateCommand', "更新のコマンド: {0}", command);
// allow-any-unicode-next-line
// allow-any-unicode-next-line
const strUpdatePip = (command: string) => localize('paradis.notif.youtube.updatePip', "pip で入れた yt-dlp です。yt-dlp を入れた Python の pip で更新してください（例: {0}）。", command);
// allow-any-unicode-next-line
const STR_UPDATE_UNKNOWN = localize('paradis.notif.youtube.updateUnknown', "yt-dlp の入れ方が分からないため、入れたときの方法で更新してください。");
// allow-any-unicode-next-line
const STR_UPDATE_BUTTON = localize('paradis.notif.youtube.updateButton', "yt-dlp を更新");
// allow-any-unicode-next-line
const STR_UPDATING_TITLE = localize('paradis.notif.youtube.updatingTitle', "yt-dlp を更新中…");

const PRECURSOR_MESSAGES: Readonly<Record<ParadisYtDlpPrecursor, string>> = {
	// allow-any-unicode-next-line
	outdated: localize('paradis.notif.youtube.precursor.outdated', "yt-dlp が自分の版が古いと警告しています。更新してください。"),
	// allow-any-unicode-next-line
	jsRuntime: localize('paradis.notif.youtube.precursor.jsRuntime', "JS ランタイム（deno）が無いため、一部の形式を取れませんでした。deno を入れると直ります。"),
	// allow-any-unicode-next-line
	signature: localize('paradis.notif.youtube.precursor.signature', "yt-dlp が YouTube の署名の解読に失敗しかけています。近いうちに取り込めなくなるおそれがあるため、yt-dlp を更新してください。"),
	// allow-any-unicode-next-line
	poToken: localize('paradis.notif.youtube.precursor.poToken', "PO Token が要る形式を飛ばしました。音質が下がったり、取り込めなくなったりすることがあります。"),
	// allow-any-unicode-next-line
	sabr: localize('paradis.notif.youtube.precursor.sabr', "YouTube の配信方式（SABR）の変更で、一部の形式を使えませんでした。yt-dlp を更新してください。"),
};

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
	// ステップ再描画のたびに破棄済みDOMのリスナが蓄積しないよう、ステップ単位で束ねて
	// 各 _renderXxxStep 冒頭で clear する（設定ダイアログ本体の _renderDisposables と同方式）。
	private readonly _stepDisposables = this._register(new DisposableStore());
	private _step: Step = 'url';
	/** URL の画面を描いた世代。描き直した後に届いた checkYtDlp の結果は捨てる。 */
	private _urlStepGeneration = 0;
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
		const generation = ++this._urlStepGeneration;
		this._stepDisposables.clear();
		dom.clearNode(this._dialog);
		this._dialog.classList.remove('wide');
		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;

		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<IParadisYtDlpCheckResult>('checkYtDlp').then(result => {
			if (this._store.isDisposed || this._step !== 'url' || generation !== this._urlStepGeneration) {
				return;
			}
			if (result.missing.length > 0) {
				this._renderMissingBinariesNotice(result.missing);
			}
			if (result.optionalMissing?.includes('deno')) {
				const notice = dom.append(this._dialog, $('.pns-field'));
				dom.append(notice, $('.pns-row-hint')).textContent = STR_DENO_MISSING;
			}
			if (result.ytDlp && result.ytDlp.status !== 'ok') {
				this._renderUpdateNotice(result.ytDlp);
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
		this._stepDisposables.add(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

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
		this._stepDisposables.add(dom.addDisposableListener(loadBtn, 'click', doLoad));
		this._stepDisposables.add(dom.addDisposableListener(urlInput, 'keydown', e => {
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
			this._stepDisposables.add(dom.addDisposableListener(installBtn, 'click', () => this._renderInstallingStep()));
		}
	}

	/** 既知の壊れた版・古すぎる版の yt-dlp に、入れ方に応じた更新の手段を添えて知らせる。更新は押したときだけ実行する。 */
	private _renderUpdateNotice(ytDlp: IParadisYtDlpStatus): void {
		const notice = dom.append(this._dialog, $('.pns-field'));
		const hint = dom.append(notice, $('.pns-row-hint'));
		hint.textContent = ytDlp.status === 'broken' ? strYtDlpBroken(ytDlp.version) : strYtDlpOutdated(ytDlp.version, ytDlp.ageDays);
		dom.append(notice, $('.pns-row-hint')).textContent = !ytDlp.update.command
			? STR_UPDATE_UNKNOWN
			: ytDlp.installMethod === 'pip' ? strUpdatePip(ytDlp.update.command) : strUpdateCommand(ytDlp.update.command);
		if (ytDlp.update.runnable) {
			const updateBtn = dom.append(notice, $('button.pns-btn')) as HTMLButtonElement;
			updateBtn.textContent = STR_UPDATE_BUTTON;
			updateBtn.style.marginTop = '6px';
			this._stepDisposables.add(dom.addDisposableListener(updateBtn, 'click', () => this._renderInstallingStep('update')));
		}
	}

	private _renderInstallingStep(mode: 'install' | 'update' = 'install'): void {
		this._step = 'installing';
		this._stepDisposables.clear();
		dom.clearNode(this._dialog);
		dom.append(this._dialog, $('h3')).textContent = mode === 'update' ? STR_UPDATING_TITLE : STR_INSTALLING_TITLE;

		const consoleEl = dom.append(this._dialog, $('.pns-log-console'));

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const backBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		backBtn.textContent = STR_BACK;
		backBtn.style.display = 'none';
		this._stepDisposables.add(dom.addDisposableListener(backBtn, 'click', () => this._renderUrlStep()));

		const installId = generateUuid();
		let lastSeq = 0;
		void this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call(mode === 'update' ? 'updateYtDlp' : 'installYtDlp', [installId]);

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
		this._stepDisposables.clear();
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
		this._stepDisposables.clear();
		dom.clearNode(this._dialog);
		this._dialog.classList.add('wide');
		dom.append(this._dialog, $('h3')).textContent = STR_TITLE;

		const editorContainer = dom.append(this._dialog, $('div'));
		this._audioEditor = this._stepDisposables.add(new ParadisAudioEditor(editorContainer, {
			tempId: downloaded.tempId,
			videoTitle: downloaded.info.title,
			totalDuration: downloaded.info.durationSeconds,
			initialDisplayName: downloaded.info.title.slice(0, 80),
		}, this.sharedProcessService));

		// 取り込めたが、yt-dlp の警告に壊れる前兆が出ていたら短く知らせる（詳しい警告はログにある）。
		for (const precursor of downloaded.precursors ?? []) {
			dom.append(this._dialog, $('.pns-row-hint')).textContent = PRECURSOR_MESSAGES[precursor];
		}

		const errorEl = dom.append(this._dialog, $('.pns-error'));

		const footer = dom.append(this._dialog, $('.pns-nested-footer'));
		const cancelBtn = dom.append(footer, $('button.pns-btn')) as HTMLButtonElement;
		cancelBtn.textContent = STR_CANCEL;
		this._stepDisposables.add(dom.addDisposableListener(cancelBtn, 'click', () => this.dispose()));

		const importBtn = dom.append(footer, $('button.pns-btn.pns-btn-primary')) as HTMLButtonElement;
		importBtn.textContent = STR_IMPORT;
		this._stepDisposables.add(dom.addDisposableListener(importBtn, 'click', async () => {
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
				// renderClip は再編集用にソースを assets へコピー済みなので temp は不要。
				// _downloaded は残したまま dispose() に cleanupTempAudio させ、
				// ダウンロード元 (paradis-ytfull-*) と _tempAudio エントリを確実に解放する。
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

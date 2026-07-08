/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 波形エディタ（Superset apps/desktop の AudioEditor.tsx の移植）。YouTube取込フローの
// クリップ範囲選択（開始/終了・フェード・再生速度・表示名）に使う。波形描画は Web Audio API の
// decodeAudioData でピーク値を計算し canvas に描画する。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_MAX_CLIP_DURATION_SECONDS, PARADIS_NOTIFICATIONS_CHANNEL } from '../common/paradisNotifications.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_START_LABEL = localize('paradis.notif.editor.start', "開始 (秒)");
// allow-any-unicode-next-line
const STR_END_LABEL = localize('paradis.notif.editor.end', "終了 (秒)");
// allow-any-unicode-next-line
const STR_PREVIEW = localize('paradis.notif.editor.preview', "プレビュー");
// allow-any-unicode-next-line
const STR_STOP = localize('paradis.notif.editor.stop', "停止");
// allow-any-unicode-next-line
const strOutputLabel = (duration: string) => localize('paradis.notif.editor.output', "出力: {0}秒 / 最大{1}秒", duration, String(PARADIS_MAX_CLIP_DURATION_SECONDS));
// allow-any-unicode-next-line
const strFadeIn = (v: string) => localize('paradis.notif.editor.fadeIn', "フェードイン: {0}秒", v);
// allow-any-unicode-next-line
const strFadeOut = (v: string) => localize('paradis.notif.editor.fadeOut', "フェードアウト: {0}秒", v);
// allow-any-unicode-next-line
const strSpeed = (v: string) => localize('paradis.notif.editor.speed', "再生速度: {0}x", v);
// allow-any-unicode-next-line
const STR_DISPLAY_NAME_LABEL = localize('paradis.notif.editor.displayName', "表示名");
// allow-any-unicode-next-line
const STR_LOADING = localize('paradis.notif.editor.loading', "波形を読み込み中…");
// allow-any-unicode-next-line
const strOutputExceeds = (duration: string) => localize('paradis.notif.editor.exceeds', "出力の長さ ({0}秒) が上限を超えています。選択範囲を短くするか再生速度を上げてください。", duration);

export interface IParadisAudioEditorParams {
	readonly startSeconds: number;
	readonly endSeconds: number;
	readonly fadeInSeconds: number;
	readonly fadeOutSeconds: number;
	readonly playbackRate: number;
	readonly displayName: string;
}

export interface IParadisAudioEditorOptions {
	readonly tempId: string;
	readonly videoTitle: string;
	readonly totalDuration: number;
	readonly initialDisplayName: string;
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.floor((seconds % 1) * 10);
	return `${m}:${String(s).padStart(2, '0')}.${ms}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * 波形エディタ本体。コンテナへ描画し、`getParams()` で現在の選択範囲を取得できる。
 */
export class ParadisAudioEditor extends Disposable {

	private readonly _canvas: HTMLCanvasElement;
	private readonly _audio: HTMLAudioElement;
	private readonly _outputHintEl: HTMLElement;
	private readonly _timesEl: HTMLElement;
	private readonly _nameInput: HTMLInputElement;

	private _peaks: number[] = [];
	private _duration: number;
	private _startSeconds = 0;
	private _endSeconds: number;
	private _fadeIn = 0;
	private _fadeOut = 0;
	private _playbackRate = 1.0;
	private _dragging: 'start' | 'end' | undefined;
	private _isPlaying = false;
	private _blobUrl: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: IParadisAudioEditorOptions,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
	) {
		super();
		this._duration = options.totalDuration;
		this._endSeconds = Math.min(10, options.totalDuration);

		const infoRow = dom.append(container, $('.pns-row'));
		infoRow.style.marginBottom = '6px';
		const infoText = dom.append(infoRow, $('div'));
		dom.append(infoText, $('div')).textContent = options.videoTitle;

		const waveformWrap = dom.append(container, $('.pns-field'));
		const loadingEl = dom.append(waveformWrap, $('.pns-row-hint'));
		loadingEl.textContent = STR_LOADING;
		this._canvas = dom.append(waveformWrap, $('canvas.pns-waveform')) as HTMLCanvasElement;
		this._canvas.width = 600;
		this._canvas.height = 80;
		this._timesEl = dom.append(waveformWrap, $('.pns-waveform-times'));

		const timeRow = dom.append(container, $('.pns-row'));
		const startField = dom.append(timeRow, $('.pns-field'));
		startField.style.flex = '1';
		startField.style.marginBottom = '0';
		dom.append(startField, $('label.pns-label')).textContent = STR_START_LABEL;
		const startInput = dom.append(startField, $('input')) as HTMLInputElement;
		startInput.type = 'number';
		startInput.step = '0.1';
		startInput.min = '0';

		const endField = dom.append(timeRow, $('.pns-field'));
		endField.style.flex = '1';
		endField.style.marginBottom = '0';
		dom.append(endField, $('label.pns-label')).textContent = STR_END_LABEL;
		const endInput = dom.append(endField, $('input')) as HTMLInputElement;
		endInput.type = 'number';
		endInput.step = '0.1';
		endInput.min = '0';

		const previewRow = dom.append(container, $('.pns-row'));
		const previewBtn = dom.append(previewRow, $('button.pns-btn')) as HTMLButtonElement;
		previewBtn.textContent = STR_PREVIEW;
		this._outputHintEl = dom.append(previewRow, $('span.pns-row-hint'));

		const fadeRow = dom.append(container, $('.pns-row'));
		const fadeInField = dom.append(fadeRow, $('.pns-field'));
		fadeInField.style.flex = '1';
		fadeInField.style.marginBottom = '0';
		const fadeInLabel = dom.append(fadeInField, $('label.pns-label'));
		const fadeInSlider = dom.append(fadeInField, $('input')) as HTMLInputElement;
		fadeInSlider.type = 'range';
		fadeInSlider.min = '0';
		fadeInSlider.step = '0.1';

		const fadeOutField = dom.append(fadeRow, $('.pns-field'));
		fadeOutField.style.flex = '1';
		fadeOutField.style.marginBottom = '0';
		const fadeOutLabel = dom.append(fadeOutField, $('label.pns-label'));
		const fadeOutSlider = dom.append(fadeOutField, $('input')) as HTMLInputElement;
		fadeOutSlider.type = 'range';
		fadeOutSlider.min = '0';
		fadeOutSlider.step = '0.1';

		const speedField = dom.append(container, $('.pns-field'));
		const speedLabel = dom.append(speedField, $('label.pns-label'));
		const speedSlider = dom.append(speedField, $('input')) as HTMLInputElement;
		speedSlider.type = 'range';
		speedSlider.min = '-1';
		speedSlider.max = '1';
		speedSlider.step = '0.01';
		speedSlider.value = '0';

		const nameField = dom.append(container, $('.pns-field'));
		dom.append(nameField, $('label.pns-label')).textContent = STR_DISPLAY_NAME_LABEL;
		this._nameInput = dom.append(nameField, $('input')) as HTMLInputElement;
		this._nameInput.maxLength = 80;
		this._nameInput.placeholder = options.videoTitle;
		this._nameInput.value = options.initialDisplayName;

		const updateOutputHint = () => {
			const raw = this._endSeconds - this._startSeconds;
			const output = raw / this._playbackRate;
			this._outputHintEl.textContent = strOutputLabel(output.toFixed(1));
			this._outputHintEl.classList.toggle('pns-error', output > PARADIS_MAX_CLIP_DURATION_SECONDS || raw <= 0);
		};

		const syncInputs = () => {
			startInput.value = this._startSeconds.toFixed(1);
			endInput.value = this._endSeconds.toFixed(1);
			this._timesEl.textContent = '';
			const left = dom.append(this._timesEl, $('span'));
			left.textContent = formatTime(0);
			const mid = dom.append(this._timesEl, $('span'));
			mid.textContent = `${formatTime(this._startSeconds)} → ${formatTime(this._endSeconds)}`;
			const right = dom.append(this._timesEl, $('span'));
			right.textContent = formatTime(this._duration);
			updateOutputHint();
			this._redraw();
		};

		this._register(dom.addDisposableListener(startInput, 'change', () => {
			const n = Number.parseFloat(startInput.value);
			if (!Number.isNaN(n)) {
				this._startSeconds = clamp(n, 0, Math.min(this._endSeconds - 0.5, this._duration));
			}
			syncInputs();
		}));
		this._register(dom.addDisposableListener(endInput, 'change', () => {
			const n = Number.parseFloat(endInput.value);
			if (!Number.isNaN(n)) {
				this._endSeconds = clamp(n, Math.max(this._startSeconds + 0.5, 0), this._duration);
			}
			syncInputs();
		}));

		fadeInLabel.textContent = strFadeIn(this._fadeIn.toFixed(1));
		fadeOutLabel.textContent = strFadeOut(this._fadeOut.toFixed(1));
		this._register(dom.addDisposableListener(fadeInSlider, 'input', () => {
			this._fadeIn = Number(fadeInSlider.value);
			fadeInLabel.textContent = strFadeIn(this._fadeIn.toFixed(1));
		}));
		this._register(dom.addDisposableListener(fadeOutSlider, 'input', () => {
			this._fadeOut = Number(fadeOutSlider.value);
			fadeOutLabel.textContent = strFadeOut(this._fadeOut.toFixed(1));
		}));
		const refreshFadeBounds = () => {
			const maxFade = Math.min(5, (this._endSeconds - this._startSeconds) / 2);
			fadeInSlider.max = String(maxFade);
			fadeOutSlider.max = String(maxFade);
		};

		speedLabel.textContent = strSpeed(this._playbackRate.toFixed(2));
		this._register(dom.addDisposableListener(speedSlider, 'input', () => {
			const exp = Number(speedSlider.value);
			this._playbackRate = Math.abs(exp) < 0.02 ? 1.0 : 2 ** exp;
			speedLabel.textContent = strSpeed(this._playbackRate.toFixed(2));
			updateOutputHint();
		}));

		this._audio = new Audio();
		this._audio.preload = 'none';

		this._register(dom.addDisposableListener(previewBtn, 'click', () => {
			if (this._isPlaying) {
				this._audio.pause();
				this._isPlaying = false;
				previewBtn.textContent = STR_PREVIEW;
				return;
			}
			this._audio.playbackRate = this._playbackRate;
			this._audio.currentTime = this._startSeconds;
			void this._audio.play();
			this._isPlaying = true;
			previewBtn.textContent = STR_STOP;
		}));
		this._register(dom.addDisposableListener(this._audio, 'timeupdate', () => {
			if (this._isPlaying && this._audio.currentTime >= this._endSeconds) {
				this._audio.pause();
				this._isPlaying = false;
				previewBtn.textContent = STR_PREVIEW;
			}
		}));

		this._register(dom.addDisposableListener(this._canvas, 'mousedown', e => this._onCanvasMouseDown(e)));
		this._register(dom.addDisposableListener(this._canvas, 'mousemove', e => this._onCanvasMouseMove(e, () => { syncInputs(); refreshFadeBounds(); })));
		this._register(dom.addDisposableListener(this._canvas, 'mouseup', () => { this._dragging = undefined; }));
		this._register(dom.addDisposableListener(this._canvas, 'mouseleave', () => { this._dragging = undefined; }));

		syncInputs();
		refreshFadeBounds();

		void this._loadWaveform().then(() => {
			loadingEl.style.display = 'none';
			refreshFadeBounds();
			syncInputs();
		});
	}

	private async _loadWaveform(): Promise<void> {
		try {
			const result = await this.sharedProcessService.getChannel(PARADIS_NOTIFICATIONS_CHANNEL).call<{ base64: string; mimeType: string } | null>('readTempAudioFile', [this.options.tempId]);
			if (!result || this._store.isDisposed) {
				return;
			}
			const binary = atob(result.base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			this._blobUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
			this._audio.src = this._blobUrl;

			const AudioContextCtor = dom.getWindow(this._canvas).AudioContext;
			const audioContext = new AudioContextCtor();
			try {
				const audioBuffer = await audioContext.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
				const channelData = audioBuffer.getChannelData(0);
				const numPeaks = 1200;
				const blockSize = Math.max(1, Math.floor(channelData.length / numPeaks));
				const peaks: number[] = [];
				for (let i = 0; i < numPeaks; i++) {
					let max = 0;
					const start = i * blockSize;
					const end = Math.min(start + blockSize, channelData.length);
					for (let j = start; j < end; j++) {
						const abs = Math.abs(channelData[j] ?? 0);
						if (abs > max) {
							max = abs;
						}
					}
					peaks.push(max);
				}
				this._peaks = peaks;
				this._duration = audioBuffer.duration || this.options.totalDuration;
				if (this._endSeconds > this._duration) {
					this._endSeconds = Math.min(10, this._duration);
				}
			} finally {
				await audioContext.close();
			}
			// 防御: decodeAudioData / audioContext.close の await 中に dispose された場合に備える。
			// _blobUrl は上で dispose チェック後に同期代入するため通常は dispose() 側が revoke するが、
			// async ギャップを跨いだ後にも disposed を再確認し、blob URL を確実に解放する（二重 revoke でも無害）。
			if (this._store.isDisposed && this._blobUrl) {
				URL.revokeObjectURL(this._blobUrl);
				this._blobUrl = undefined;
			}
		} catch {
			// 波形の取得に失敗しても開始/終了は手入力で編集できるため致命的ではない。
		}
	}

	private _onCanvasMouseDown(e: MouseEvent): void {
		const rect = this._canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const totalWidth = rect.width;
		const sx = (this._startSeconds / this._duration) * totalWidth;
		const ex = (this._endSeconds / this._duration) * totalWidth;
		const distStart = Math.abs(x - sx);
		const distEnd = Math.abs(x - ex);
		if (distStart <= 10 && distStart <= distEnd) {
			this._dragging = 'start';
		} else if (distEnd <= 10) {
			this._dragging = 'end';
		}
	}

	private _onCanvasMouseMove(e: MouseEvent, onChange: () => void): void {
		if (!this._dragging) {
			return;
		}
		const rect = this._canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const time = clamp((x / rect.width) * this._duration, 0, this._duration);
		if (this._dragging === 'start') {
			this._startSeconds = Math.min(time, this._endSeconds - 0.5);
		} else {
			this._endSeconds = Math.max(time, this._startSeconds + 0.5);
		}
		onChange();
	}

	private _redraw(): void {
		const ctx = this._canvas.getContext('2d');
		if (!ctx || this._peaks.length === 0) {
			return;
		}
		const { width, height } = this._canvas;
		ctx.clearRect(0, 0, width, height);
		const midY = height / 2;
		const barWidth = width / this._peaks.length;
		const startFrac = this._startSeconds / this._duration;
		const endFrac = this._endSeconds / this._duration;
		for (let i = 0; i < this._peaks.length; i++) {
			const x = i * barWidth;
			const frac = i / this._peaks.length;
			const barH = Math.max(2, this._peaks[i] * height * 0.85);
			ctx.fillStyle = (frac >= startFrac && frac < endFrac) ? 'rgba(99,102,241,0.85)' : 'rgba(128,128,128,0.25)';
			ctx.fillRect(x, midY - barH / 2, Math.max(1, barWidth - 0.5), barH);
		}
		const sx = startFrac * width;
		ctx.fillStyle = 'rgb(34,197,94)';
		ctx.fillRect(sx - 1, 0, 2, height);
		const ex = endFrac * width;
		ctx.fillStyle = 'rgb(239,68,68)';
		ctx.fillRect(ex - 1, 0, 2, height);
	}

	getParams(): IParadisAudioEditorParams {
		return {
			startSeconds: this._startSeconds,
			endSeconds: this._endSeconds,
			fadeInSeconds: this._fadeIn,
			fadeOutSeconds: this._fadeOut,
			playbackRate: this._playbackRate,
			displayName: this._nameInput.value.trim(),
		};
	}

	isOutputValid(): boolean {
		const raw = this._endSeconds - this._startSeconds;
		return raw > 0 && (raw / this._playbackRate) <= PARADIS_MAX_CLIP_DURATION_SECONDS;
	}

	override dispose(): void {
		this._audio.pause();
		this._audio.src = '';
		if (this._blobUrl) {
			URL.revokeObjectURL(this._blobUrl);
		}
		super.dispose();
	}
}

/** 出力クリップが上限を超えている場合のエラーメッセージ（YouTube取込ダイアログの取り込みボタンから使う）。 */
export function paradisAudioEditorOutputExceedsMessage(outputDuration: number): string {
	return strOutputExceeds(outputDuration.toFixed(1));
}

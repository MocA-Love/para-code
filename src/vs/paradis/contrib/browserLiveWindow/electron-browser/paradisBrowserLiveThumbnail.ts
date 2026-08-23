/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { $, addDisposableListener, append, getWindow } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CodeWindow } from '../../../../base/browser/window.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	ParadisBrowserLiveCadence,
	paradisBrowserLiveCaptureDelayMs,
	paradisBrowserLiveRetryDelayMs,
} from '../common/paradisBrowserLiveWindow.js';

/**
 * スクリーンショットの符号化。
 *
 * 矩形を指定しない撮影は、そのビューの「最後のスクリーンショット」として main 側へ保存され、
 * エディタでタブを切り替えたときに出る静止画にもなる (browserView.ts の _lastScreenshot)。
 * ここで粗い品質を指定すると本体の静止画まで粗くなるので、upstream の既定と同じ値にする。
 */
const CAPTURE_QUALITY = 80;

/** まだ1枚も出せていないタイルが、撮らない条件のときに再挑戦するまでの待ち時間 (ms)。 */
const FIRST_FRAME_RETRY_DELAY = 3000;

/** 生成からこの時間 (ms) を過ぎたら、開いた直後用の待ち (startDelayMs) は使わない。 */
const STAGGER_WINDOW = 3000;

/**
 * この回数だけ連続で失敗し、かつ1枚も撮れていない場合に「一時的な競合ではなく永続的に
 * 撮影できていない」と見なして Sentry へ報告する回数。`paradisBrowserLiveRetryDelayMs` の
 * バックオフは failures=4 で既に上限(factor=8)へ頭打ちになっており、この閾値はそこから
 * さらに1回リトライしても直らなかった、単発の失敗とは区別できる状態を表す。`failures` は
 * 単調増加なので、この値ちょうどで一度だけ発火する。
 */
const PERSISTENT_FAILURE_THRESHOLD = 5;

/**
 * タイル1枚分のライブサムネイル。
 *
 * 内蔵ブラウザの実体 (WebContentsView) は同時に1つの親にしか置けないため、一覧に本物を
 * 並べることはできない (元のタブから消える)。そこで「そのビューのスクリーンショットを
 * 繰り返し撮って img に流す」写しを作る。エージェントのカーソル演出や撮影フラッシュは
 * ページ本体に描かれているので、この写しにもそのまま写る。
 *
 * 撮る回数がそのまま負荷 (と、ビューごとに直列化される撮影キューの占有) になるので、
 * 次の条件では自分から止まる。
 * - 一覧の中で見えていない (スクロールで画面外・絞り込みで DOM から外れた)
 * - ウィンドウ自体が隠れている
 * - 更新頻度の設定が「止める」
 *
 * 画面に出ていないページ (裏のタブ・別スペース) は止めずに、間隔だけ空けて追いかける。
 */
export class ParadisBrowserLiveThumbnail extends Disposable {

	private readonly image: HTMLImageElement;
	/**
	 * この img が属するウィンドウ。
	 *
	 * 破棄のたびに getWindow() で引き直すと、ウィンドウが閉じた後は defaultView が無くなって
	 * メインウィンドウへフォールバックしてしまう (別ウィンドウのタイマーIDと blob ストアに
	 * 対して解放を呼ぶことになる)。生成時に1度だけ掴んでおく。
	 */
	private readonly targetWindow: CodeWindow;

	private cadence: ParadisBrowserLiveCadence = 'normal';
	/** エディタ上で描かれているか。View が変化のたびに押し込む。 */
	private visible = false;
	private active = false;
	private timer: number | undefined;
	private capturing = false;
	private failures = 0;
	/** いま img が指している blob URL。差し替えのたびに前の URL を解放する。 */
	private currentUrl: string | undefined;
	/** 読み込みが終わったら解放する1つ前の blob URL。 */
	private staleUrl: string | undefined;
	private hasFrame = false;
	/** 最初の撮影がまだなら true。一覧を開いた瞬間に全タイルが一斉に撮りに行かないための印。 */
	private firstCapturePending = true;
	/** 生成時刻 (ms)。時間が経ってからの初回撮影で、開いた直後用の待ちを払わないための基準。 */
	private readonly createdAt: number;

	constructor(
		container: HTMLElement,
		private readonly resolveModel: () => IBrowserViewModel | undefined,
		/** 最初の撮影までの待ち時間 (ms)。タイルごとにずらして同時実行を散らす。 */
		private readonly startDelayMs: number,
		private readonly logService: ILogService,
	) {
		super();

		this.targetWindow = getWindow(container);
		this.createdAt = this.targetWindow.performance.now();
		this.image = append(container, $('img.paradis-browser-live-frame')) as HTMLImageElement;
		this.image.setAttribute('alt', '');
		this.image.setAttribute('aria-hidden', 'true');
		this.image.draggable = false;

		this._register(addDisposableListener(this.image, 'load', () => this.releaseStale()));
		this._register(addDisposableListener(this.image, 'error', () => this.releaseStale()));
		this._register({ dispose: () => this.releaseAll() });

		// 最後に撮られた絵があれば先に出す。開いた瞬間から灰色の箱を見せないため。
		const last = this.resolveModel()?.screenshot;
		if (last) {
			this.show(last);
		}
	}

	/**
	 * いま出している絵のピクセル寸法。まだ1枚も撮れていなければ undefined。
	 *
	 * エージェントのカーソルを重ねる側が、`object-fit: cover` で切り取られているぶんを
	 * 補正するのに使う (枠と画像の縦横比が違うと、割合をそのまま置いてもずれる)。
	 */
	frameSize(): { readonly width: number; readonly height: number } | undefined {
		if (!this.hasFrame || this.image.naturalWidth === 0 || this.image.naturalHeight === 0) {
			return undefined;
		}
		return { width: this.image.naturalWidth, height: this.image.naturalHeight };
	}

	setCadence(cadence: ParadisBrowserLiveCadence): void {
		if (this.cadence === cadence) {
			return;
		}
		this.cadence = cadence;
		this.restart();
	}

	/**
	 * エディタ上で描かれているか。
	 *
	 * 撮る間隔がこの値で変わる (裏のページは間隔を空ける)。前面に出た瞬間から追いつけるよう、
	 * 変化したら必ず組み直す。
	 */
	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		this.restart();
	}

	/** 一覧の中で見えているか (画面外・ウィンドウ非表示・絞り込みで外れた間は false)。 */
	setActive(active: boolean): void {
		if (this.active === active) {
			return;
		}
		this.active = active;
		this.restart();
	}

	/** いま撮り直す (共有状態が変わった直後など、絵を早く合わせたいとき)。 */
	refreshNow(): void {
		if (this._store.isDisposed || !this.active) {
			return;
		}
		this.clearTimer();
		void this.capture();
	}

	/** いまこのタイルを撮る間隔 (ms)。0 は「撮らない」。 */
	private captureDelay(): number {
		return paradisBrowserLiveCaptureDelayMs(this.cadence, { visible: this.visible });
	}

	/**
	 * 状態が変わったので撮影の予定を組み直す。
	 *
	 * 更新頻度が「止める」のタイルはここでも撮りに行かない (スクロールで可視判定を出入り
	 * するたびに1枚ずつ撮ってしまうため)。例外は絵が1枚も無いときだけで、これは空のタイルを
	 * 見せないための最初の1枚。
	 */
	private restart(): void {
		this.clearTimer();
		if (this._store.isDisposed || !this.active) {
			return;
		}
		if (this.hasFrame && this.captureDelay() <= 0) {
			return;
		}
		// 待ちを入れるのは「一覧を開いた直後の一斉撮影」を散らすときだけ。しばらく経ってから
		// 初めて撮る場合 (画面外だったタイルがスクロールで見えた等) に待たせる意味はない。
		const staggering = this.firstCapturePending && this.targetWindow.performance.now() - this.createdAt < STAGGER_WINDOW;
		this.armTimer(staggering ? this.startDelayMs : 0);
	}

	private scheduleNext(): void {
		if (this._store.isDisposed || !this.active) {
			return;
		}
		const base = this.captureDelay();
		if (base <= 0) {
			// 撮らない条件。ただし1枚も出せていない間は空のタイルのままになるので、
			// 絵が手に入るまで低頻度で試し続ける。撮影自体が失敗し続けるページ
			// (ビューポートが大きすぎる等) を3秒ごとに叩き続けないよう、失敗の回数だけ離す。
			if (!this.hasFrame) {
				this.armTimer(this.failures > 0
					? paradisBrowserLiveRetryDelayMs(FIRST_FRAME_RETRY_DELAY, this.failures)
					: FIRST_FRAME_RETRY_DELAY);
			}
			return;
		}
		this.armTimer(this.failures > 0 ? paradisBrowserLiveRetryDelayMs(base, this.failures) : base);
	}

	private armTimer(delay: number): void {
		this.clearTimer();
		this.timer = this.targetWindow.setTimeout(() => {
			this.timer = undefined;
			void this.capture();
		}, delay);
	}

	private async capture(): Promise<void> {
		if (this.capturing || this._store.isDisposed || !this.active) {
			return;
		}
		this.firstCapturePending = false;
		const model = this.resolveModel();
		if (!model) {
			// まだエディタが解決されていない (背景のタブ)。絵が出せる状態になるまで待つ。
			this.failures++;
			this.scheduleNext();
			return;
		}
		this.capturing = true;
		try {
			const buffer = await model.captureScreenshot({ format: 'jpeg', quality: CAPTURE_QUALITY });
			if (this._store.isDisposed) {
				return;
			}
			this.failures = 0;
			this.show(buffer);
		} catch (error) {
			this.failures++;
			// 撮影の失敗は日常的に起きる (ページ破棄との競合、撮影の輻輳)。次の間隔を離して
			// 静かに続ける —— 通知や画面上の見た目は変えない。
			this.logService.trace(`[paradisBrowserLive] capture failed (${this.failures}): ${error}`);
			if (!this.hasFrame && this.failures === PERSISTENT_FAILURE_THRESHOLD) {
				// 1枚も撮れないまま連続で失敗し続けている。単発の競合ではなく永続的な失敗
				// なので、無音のまま静止画が出ない状態が続かないよう報告する。
				reportParadisDiagnosticError('owned', 'browser-live-window', 'capture-persistently-failing', error, undefined, 'warning');
			}
		} finally {
			this.capturing = false;
			if (!this._store.isDisposed) {
				this.scheduleNext();
			}
		}
	}

	private show(buffer: VSBuffer): void {
		const blob = new Blob([buffer.buffer as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
		const url = this.targetWindow.URL.createObjectURL(blob);
		// 直前の URL は、新しい絵が読み込まれてから解放する (先に解放すると1フレーム空白になる)。
		this.releaseStale();
		this.staleUrl = this.currentUrl;
		this.currentUrl = url;
		this.image.src = url;
		this.hasFrame = true;
		this.image.classList.add('loaded');
	}

	private releaseStale(): void {
		if (this.staleUrl) {
			this.targetWindow.URL.revokeObjectURL(this.staleUrl);
			this.staleUrl = undefined;
		}
	}

	private releaseAll(): void {
		this.clearTimer();
		for (const url of [this.staleUrl, this.currentUrl]) {
			if (url) {
				this.targetWindow.URL.revokeObjectURL(url);
			}
		}
		this.staleUrl = undefined;
		this.currentUrl = undefined;
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			this.targetWindow.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

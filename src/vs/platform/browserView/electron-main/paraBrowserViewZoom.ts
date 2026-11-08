/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの表示サイズを固定したとき、ページを縮めて見せる方法を、デバイスのエミュレーションの `scale` から
// ページの拡大率（zoom）に替える（q.html Q540）。
//
// なぜ: エミュレーションの `scale` で縮めると、Chromium がブラウザ側の当たり判定をページ本体のプロセスに聞き直す場合
// （角の丸い iframe、重なる iframe。1Password の候補のメニューなど）に倍率を考えず、クリックがページ本体に吸われる
// （Electron 43 で実測。CDP の Emulation.setDeviceMetricsOverride でも同じ）。拡大率で縮めれば正しく当たる。
//
// 拡大率は Chromium ではサイトごとに 1 つの値で、`webContents.setZoomFactor` は同じサイトのほかのタブにも効く。
// Electron に組み込みの拡張機能の API `chrome.tabs.setZoomSettings({ scope: 'per-tab' })` でタブごとに切り離せるので、
// 拡大率が 1 でないタブは、セッションごとに 1 つ読み込む小さな拡張機能（ページを持つだけ）から切り離してから拡大率を当てる。
// 切り離しは文書が替わるたびに外れる（Chromium の決まり）ので、移動のたびに切り離し直す。
//
// 拡大率で縮めている間は、エミュレーションは `scale: 1` で、表示域（viewSize）を縮めた大きさにし、
// `deviceScaleFactor` で devicePixelRatio を補う（拡大率を下げると devicePixelRatio も下がり、粗い画像が選ばれるため）。
// 切り離せない（拡張機能を読み込めない）間は、今までどおりエミュレーションの `scale` で縮める。

import * as electron from 'electron';
import type { WebContents } from 'electron';
import { promises as fs } from 'fs';
import { join } from '../../../base/common/path.js';
import { paraBrowserViewShrinkLayout } from '../common/paraBrowserViewShrinkLayout.js';

/** 拡大率が 1 とみなす差。 */
const ZOOM_EPSILON = 0.0001;
/** devicePixelRatio を補うためのエミュレーションの deviceScaleFactor の上限（大きいと描画が重い）。 */
const MAX_EMULATED_DEVICE_SCALE_FACTOR = 6;

/** タブを切り離すための拡張機能の名前（Para Code の拡張機能の一覧から外すときに見る）。 */
export const PARA_BROWSER_ZOOM_HELPER_EXTENSION_NAME = 'Para Code browser zoom';

/** タブを切り離す口（テストで差し替える）。 */
export interface IParaBrowserZoomIsolator {
	/** そのタブの拡大率を、同じサイトのほかのタブから切り離す。切り離せたら true、切り離せなければ false か理由の文。 */
	isolate(webContents: WebContents): Promise<boolean | string>;
}

/** 縮め方の分かれ道を main のログへ書く口（`browserViewEmulator.ts` の logService）。 */
export interface IParaBrowserViewZoomLog {
	info(message: string): void;
	warn(message: string): void;
}

const LOG_PREFIX = '[ParaBrowserViewZoom]';

/** 切り離しの結果。`stale` は、試している間に文書が替わって結果が今の文書に当てはまらないもの（失敗ではない）。 */
type ParaIsolation = 'isolated' | 'failed' | 'stale';

interface IZoomState {
	/** 利用者の拡大率（Ctrl+±、browserZoom）。 */
	user: number;
	/** 表示サイズを固定して縮める分。縮めていなければ 1。 */
	emulation: number;
	/** 今の文書で切り離し済みか。 */
	isolated: boolean;
	/** 切り離している最中。 */
	isolating: Promise<ParaIsolation> | undefined;
	/** メインフレームの移動が始まるたびに進める。途中の切り離しの試みが古くなったかを見る。 */
	generation: number;
	/** 切り離せたとき・画面の倍率が替わったときに呼ぶ（エミュレーションを当て直す）。 */
	onIsolated: (() => void) | undefined;
	/** devicePixelRatio を補うのに使った画面の倍率。 */
	displayScaleFactor: number | undefined;
	/** 画面の移動を見張っているウィンドウ。 */
	watchedWindow: Electron.BaseWindow | undefined;
	/** 分かれ道を書くログ（表示サイズを固定したときに emulator から受け取る）。 */
	log: IParaBrowserViewZoomLog | undefined;
	/** 最後に書いた縮め方（同じものを続けて書かない。リサイズのたびに呼ばれるため）。 */
	loggedMode: string | undefined;
}

const states = new WeakMap<WebContents, IZoomState>();

function nearlyOne(value: number): boolean {
	return Math.abs(value - 1) < ZOOM_EPSILON;
}

let isolatorOverride: IParaBrowserZoomIsolator | undefined;

/** テスト用: 切り離しの口を差し替える（undefined で元に戻す）。 */
export function paraSetBrowserZoomIsolatorForTest(isolator: IParaBrowserZoomIsolator | undefined): void {
	isolatorOverride = isolator;
}

function isolatorFor(webContents: WebContents): IParaBrowserZoomIsolator {
	return isolatorOverride ?? ParaBrowserZoomHelper.forSession(webContents.session);
}

function stateOf(webContents: WebContents): IZoomState {
	let state = states.get(webContents);
	if (!state) {
		state = { user: 1, emulation: 1, isolated: false, isolating: undefined, generation: 0, onIsolated: undefined, displayScaleFactor: undefined, watchedWindow: undefined, log: undefined, loggedMode: undefined };
		states.set(webContents, state);
		const created = state;
		// 文書が確定すると切り離しが外れる（エラーのページへの移動は did-navigate を出さず did-fail-load だけ）。ほかの受け手
		// （拡大率を当て直す処理）より先に知る。移動の始まりでは、まだ今の文書のまま切り離しは効いているので、途中の試みを
		// 古いものにするだけ（ダウンロード・204・取り消しのように確定しない移動もある）
		const committed = () => {
			created.generation++;
			created.isolated = false;
			created.isolating = undefined;
		};
		webContents.prependListener('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
			if (details?.isMainFrame !== false && details?.isSameDocument !== true) {
				created.generation++;
			}
		});
		webContents.prependListener('did-navigate', committed);
		webContents.prependListener('did-fail-load', (_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean) => {
			if (isMainFrame) {
				committed();
				// エラーのページでは、拡大率を当て直す処理（did-navigate の受け手）が走らないので、ここで当て直す
				apply(webContents, created);
			}
		});
	}
	return state;
}

/** 今の拡大率（利用者の分 × 縮める分）を当てる。1 でないなら、先にタブを切り離す。 */
function apply(webContents: WebContents, state: IZoomState): void {
	if (webContents.isDestroyed()) {
		return;
	}
	const factor = state.user * state.emulation;
	if (state.isolated || nearlyOne(factor)) {
		// 切り離していない 1 は、サイトの値（ほかのタブも 1）をそのまま使うのと同じ
		webContents.setZoomFactor(factor);
		return;
	}
	void isolate(webContents, state).then(isolation => {
		if (webContents.isDestroyed()) {
			return;
		}
		if (isolation === 'stale') {
			// 試している間に移動が始まった・文書が替わった。この結果では何も当てない（サイトの値として当てると同じサイトの
			// タブへ広がる）。切り離しから試し直す（文書が替わっていれば、移動の後の当て直しとまとめて 1 回になる）
			if (!state.isolated && !state.isolating) {
				apply(webContents, state);
			}
			return;
		}
		if (isolation === 'isolated') {
			webContents.setZoomFactor(state.user * state.emulation);
		} else if (nearlyOne(state.emulation)) {
			// 切り離せないとき（拡張機能を読み込めないメモリだけのセッションなど）は、利用者の拡大率だけを今までどおり
			// （サイトごとに）当てる
			webContents.setZoomFactor(state.user);
		}
	});
}

/** 切り離しの結果をログへ書く（移動のたびに切り離し直すので、その都度 1 行）。 */
function logIsolation(webContents: WebContents, state: IZoomState, result: true | string): void {
	if (!state.log) {
		return;
	}
	if (result === true) {
		state.log.info(`${LOG_PREFIX} tab ${webContents.id}: isolated its zoom from the site; a fixed size is shrunk by page zoom`);
	} else {
		state.log.warn(`${LOG_PREFIX} tab ${webContents.id}: could not isolate its zoom (${result}); a fixed size stays shrunk by the emulation scale, so clicks on rounded or overlapping cross-process iframes can miss`);
	}
}

function isolate(webContents: WebContents, state: IZoomState): Promise<ParaIsolation> {
	if (state.isolated) {
		return Promise.resolve('isolated');
	}
	if (!state.isolating) {
		const generation = state.generation;
		const attempt: Promise<ParaIsolation> = isolatorFor(webContents).isolate(webContents).catch((error: unknown) => error instanceof Error ? error.message : String(error)).then(outcome => {
			const isolated = outcome === true;
			if (state.isolating !== attempt || state.generation !== generation) {
				// 試している間に移動が始まった・文書が替わった
				if (state.isolating === attempt) {
					state.isolating = undefined;
				}
				state.log?.info(`${LOG_PREFIX} tab ${webContents.id}: the page navigated while its zoom was being isolated; isolating it again`);
				return 'stale';
			}
			state.isolating = undefined;
			state.isolated = isolated;
			logIsolation(webContents, state, isolated ? true : typeof outcome === 'string' ? outcome : 'the zoom helper did not settle');
			if (isolated) {
				state.onIsolated?.();
			}
			return isolated ? 'isolated' : 'failed';
		});
		state.isolating = attempt;
	}
	return state.isolating;
}

/**
 * 利用者の拡大率（Ctrl+±）を当てる。`browserView.ts` の `setZoomFactor` の代わりに呼ぶ。縮めている分と掛け合わせ、
 * 1 でなければこのタブだけに効かせる。
 */
export function paraSetBrowserViewUserZoom(webContents: WebContents, factor: number): void {
	const state = stateOf(webContents);
	state.user = factor;
	apply(webContents, state);
}

/** 拡大率で縮めているか。縮めている間、CDP の入力の座標とスクリーンショットの倍率は拡大率に含まれる。 */
export function paraBrowserViewScalesByZoom(webContents: WebContents): boolean {
	const state = states.get(webContents);
	return state !== undefined && state.isolated && !nearlyOne(state.emulation);
}

/**
 * 拡大率で縮めている倍率（縮めていなければ 1）。縮めている間もページの devicePixelRatio は保つので、スクリーンショットの
 * 画素の見積もり（拡大率 × devicePixelRatio）はこの分だけ割り戻す。
 */
export function paraBrowserViewZoomShrink(webContents: WebContents): number {
	const state = states.get(webContents);
	return state !== undefined && state.isolated && !nearlyOne(state.emulation) ? state.emulation : 1;
}

/** エミュレーションの表示域の計算に要るもの。 */
export interface IParaBrowserViewEmulationRequest {
	/** 表示サイズ（CSS px）。 */
	readonly width: number;
	readonly height: number;
	/** 表示サイズをエディタに収める倍率 × ワークベンチの拡大率。 */
	readonly pageScale: number;
	readonly mobile: boolean;
	/** 表示サイズで決めた devicePixelRatio（決めていなければ undefined）。 */
	readonly deviceScaleFactor: number | undefined;
	/** 拡大率の形に切り替えられるようになったら呼ぶ（エミュレーションを当て直す）。 */
	readonly onReady: () => void;
	/** 縮め方の分かれ道を書くログ。 */
	readonly log?: IParaBrowserViewZoomLog;
}

/** 選んだ縮め方をログへ書く（前と同じなら書かない）。 */
function logMode(webContents: WebContents, state: IZoomState, mode: string): void {
	if (!state.log || state.loggedMode === mode) {
		return;
	}
	state.loggedMode = mode;
	state.log.info(`${LOG_PREFIX} tab ${webContents.id}: ${mode}`);
}

/**
 * 表示サイズを固定したときのエミュレーションの値を返し、縮める分の拡大率を当てる。`browserViewEmulator.ts` の
 * `_reapply` から呼ぶ。縮める必要が無い（倍率 1）なら縮めない。切り離しが済むまでは今までどおり `scale` で縮め、
 * 済んだら `onReady` で当て直してもらう。
 */
export function paraBrowserViewEmulationParams(webContents: WebContents, request: IParaBrowserViewEmulationRequest): Electron.Parameters {
	const state = stateOf(webContents);
	state.onIsolated = request.onReady;
	state.log = request.log ?? state.log;
	const screenPosition = request.mobile ? 'mobile' as const : 'desktop' as const;
	const size = { width: request.width, height: request.height };
	const scaleByEmulation = (): Electron.Parameters => ({ screenPosition, screenSize: size, viewSize: size, deviceScaleFactor: request.deviceScaleFactor ?? 0, viewPosition: { x: 0, y: 0 }, scale: request.pageScale });
	if (nearlyOne(request.pageScale)) {
		// 縮める必要が無い（エディタが表示サイズ以上）。拡大率も使わない
		paraSetBrowserViewEmulationZoom(webContents, 1);
		logMode(webContents, state, 'not shrunk (the editor fits the fixed size)');
		return scaleByEmulation();
	}
	if (!state.isolated) {
		// 切り離しが済むまでは今までどおり。済んだら onReady で当て直してもらう
		if (!nearlyOne(state.emulation)) {
			paraSetBrowserViewEmulationZoom(webContents, 1);
		}
		void isolate(webContents, state);
		logMode(webContents, state, `${request.width}x${request.height} shrunk by the emulation scale ${request.pageScale.toFixed(3)} until the tab's zoom is isolated`);
		return scaleByEmulation();
	}
	const { viewSize, zoom } = paraBrowserViewShrinkLayout(request.width, request.height, request.pageScale);
	paraSetBrowserViewEmulationZoom(webContents, zoom);
	const targetPixelRatio = request.deviceScaleFactor ?? watchDisplayScaleFactor(webContents, state);
	logMode(webContents, state, `${request.width}x${request.height} shrunk by page zoom ${zoom.toFixed(3)} (view ${viewSize.width}x${viewSize.height}, devicePixelRatio ${targetPixelRatio})`);
	return {
		screenPosition,
		screenSize: size,
		viewSize,
		// 拡大率で下がる devicePixelRatio を、表示サイズで決めた値（無ければ画面の値）に戻す
		deviceScaleFactor: Math.min(MAX_EMULATED_DEVICE_SCALE_FACTOR, targetPixelRatio / zoom),
		viewPosition: { x: 0, y: 0 },
		scale: 1,
	};
}

/** そのタブ（WebContentsView）を持つウィンドウ。見つからなければ undefined。 */
function windowOf(webContents: WebContents): Electron.BaseWindow | undefined {
	const contains = (view: Electron.View): boolean => (view as Partial<Electron.WebContentsView>).webContents === webContents || view.children.some(contains);
	try {
		return electron.BaseWindow.getAllWindows().find(window => !window.isDestroyed() && contains(window.contentView));
	} catch {
		return undefined;
	}
}

/**
 * タブのウィンドウがある画面の倍率（Retina なら 2）。ウィンドウが別の画面へ移って倍率が替わったら、エミュレーションを
 * 当て直す（devicePixelRatio を補う値が替わる）。分からなければ 1。
 */
function watchDisplayScaleFactor(webContents: WebContents, state: IZoomState): number {
	const window = windowOf(webContents);
	const read = (): number => {
		try {
			const display = window && !window.isDestroyed() ? electron.screen.getDisplayMatching(window.getBounds()) : electron.screen.getPrimaryDisplay();
			return display.scaleFactor > 0 ? display.scaleFactor : 1;
		} catch {
			return 1;
		}
	};
	if (window && state.watchedWindow !== window) {
		const onMoved = () => {
			if (webContents.isDestroyed() || state.watchedWindow !== window) {
				window.removeListener('move', onMoved);
				electron.screen.removeListener('display-metrics-changed', onMoved);
				return;
			}
			if (paraBrowserViewScalesByZoom(webContents) && read() !== state.displayScaleFactor) {
				state.onIsolated?.();
			}
		};
		state.watchedWindow = window;
		window.on('move', onMoved);
		// 画面の倍率そのものが替わったとき（設定の変更・外部ディスプレイのつなぎ替え）も拾う
		electron.screen.on('display-metrics-changed', onMoved);
		webContents.once('destroyed', () => {
			window.removeListener('move', onMoved);
			electron.screen.removeListener('display-metrics-changed', onMoved);
		});
	}
	state.displayScaleFactor = read();
	return state.displayScaleFactor;
}

/** 縮める分の拡大率を替える（表示サイズを「エディタに合わせる」へ戻したときは 1）。 */
export function paraSetBrowserViewEmulationZoom(webContents: WebContents, factor: number): void {
	const state = stateOf(webContents);
	if (nearlyOne(state.emulation) && nearlyOne(factor)) {
		return;
	}
	state.emulation = factor;
	apply(webContents, state);
}

/**
 * セッションごとに 1 つ読み込む、タブを切り離すための拡張機能。ページ（zoom.html）を見えない WebContents で開き、
 * そこから `chrome.tabs.setZoomSettings` を呼ぶ。中身は manifest と空のページだけで、ページにも通信にも触れない。
 *
 * - 利用者の拡張機能の設定（`paradis.browser.extensions.*`）がオフのセッションでも読み込む。これは Para Code の内部用で、
 *   利用者の拡張機能の台帳には載らず、content script も権限も持たない（拡張機能の仕組みを、タブの拡大率を切り離す口として
 *   使うだけ）
 * - メモリだけのセッション（使い捨て・エージェントのタブ）には Electron が拡張機能を読み込ませず（"Extensions cannot be
 *   loaded in a temporary session"）、別のセッションの拡張機能からはそのタブを操作できない（"No such tab"）。そこでは
 *   切り離せないので、今までどおりエミュレーションの `scale` で縮める
 * - 見えない WebContents は、切り離したタブがそのセッションに 1 つも無くなったら閉じる（次に要るときに開き直す）
 */
class ParaBrowserZoomHelper implements IParaBrowserZoomIsolator {

	private static readonly helpers = new WeakMap<Electron.Session, ParaBrowserZoomHelper>();

	static forSession(session: Electron.Session): ParaBrowserZoomHelper {
		let helper = ParaBrowserZoomHelper.helpers.get(session);
		if (!helper) {
			helper = new ParaBrowserZoomHelper(session);
			ParaBrowserZoomHelper.helpers.set(session, helper);
		}
		return helper;
	}

	private page: Promise<IParaBrowserZoomHelperPage | undefined> | undefined;
	/** 切り離したタブ（閉じたら外す。空になったらページを閉じる）。 */
	private readonly tabs = new Set<WebContents>();
	/** 切り離している最中の数（その間はページを閉じない）。 */
	private pending = 0;
	/** 拡張機能を読み込めないセッション（メモリだけのセッション）。 */
	private unsupported = false;
	/** 読み込んだ拡張機能の id（ページを閉じても拡張機能は読み込んだまま）。 */
	private extensionId: string | undefined;
	/** ページを開けなかった理由（ログに書く）。 */
	private openFailure: string | undefined;

	constructor(
		private readonly session: Electron.Session,
		/** ページを開く口（テストで差し替える）。 */
		private readonly openPageOverride?: () => Promise<IParaBrowserZoomHelperPage | undefined>,
	) { }

	async isolate(webContents: WebContents): Promise<boolean | string> {
		if (this.unsupported) {
			return 'extensions cannot be loaded in this session';
		}
		this.pending++;
		let settled: unknown;
		try {
			// 開いてあったページが壊れていた（拡張機能のプロセスが落ちた・外された）ときは、開き直して 1 回だけ試し直す
			for (let attempt = 0; ; attempt++) {
				const reused = this.page !== undefined;
				this.page ??= this.openPageOverride ? this.openPageOverride() : this.open();
				const page = await this.page;
				if (webContents.isDestroyed()) {
					return 'the tab was closed';
				}
				if (!page || page.contents.isDestroyed()) {
					this.dropPage(page);
					if (reused && attempt === 0) {
						continue;
					}
					return this.openFailure ?? 'the zoom helper page is not open';
				}
				try {
					settled = await page.contents.executeJavaScript(`(async () => { if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.setZoomSettings !== 'function') { return 'chrome.tabs.setZoomSettings is not available'; } try { await chrome.tabs.setZoomSettings(${webContents.id}, { mode: 'automatic', scope: 'per-tab' }); return true; } catch (error) { return 'chrome.tabs.setZoomSettings: ' + String(error && error.message || error); } })()`);
					break;
				} catch (error) {
					this.dropPage(page);
					if (attempt === 0) {
						continue;
					}
					return `the zoom helper page failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
		} finally {
			this.pending--;
		}
		if (settled === true && !this.tabs.has(webContents)) {
			this.tabs.add(webContents);
			webContents.once('destroyed', () => {
				this.tabs.delete(webContents);
				if (this.tabs.size === 0 && this.pending === 0) {
					this.close();
				}
			});
		}
		return settled === true ? true : typeof settled === 'string' ? settled : 'the zoom helper returned no result';
	}

	/** 壊れたページを捨てる（次は開き直す）。 */
	private dropPage(page: IParaBrowserZoomHelperPage | undefined): void {
		this.page = undefined;
		page?.dispose();
	}

	private close(): void {
		const page = this.page;
		this.page = undefined;
		void page?.then(opened => opened?.dispose());
	}

	private async open(): Promise<IParaBrowserZoomHelperPage | undefined> {
		if (this.extensionId === undefined) {
			try {
				const folder = join(electron.app.getPath('userData'), 'paradis-browser-zoom-helper');
				await fs.mkdir(folder, { recursive: true });
				await fs.writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: PARA_BROWSER_ZOOM_HELPER_EXTENSION_NAME, version: '1.0', description: 'Keeps the zoom of each Para Code browser tab to that tab.' }));
				await fs.writeFile(join(folder, 'zoom.html'), '<!doctype html><title>zoom</title>');
				this.extensionId = (await this.session.extensions.loadExtension(folder)).id;
			} catch (error) {
				// メモリだけのセッションは拡張機能を読み込めない。このセッションでは二度と試さない（ほかの失敗は次にまた試す）
				const message = error instanceof Error ? error.message : String(error);
				if (/temporary session/i.test(message)) {
					this.unsupported = true;
				}
				this.openFailure = `loading the zoom helper extension failed: ${message}`;
				return undefined;
			}
		}
		// View 本体を持ち続ける。webContents だけを持つと、どこにも付けていない View が GC で回収されて webContents も
		// 壊れ、その後の切り離しがすべて失敗して、エミュレーションの scale に戻っていた（実測）
		const view = new electron.WebContentsView({ webPreferences: { session: this.session, sandbox: true } });
		const page: IParaBrowserZoomHelperPage = {
			contents: view.webContents,
			dispose: () => {
				if (!view.webContents.isDestroyed()) {
					view.webContents.close();
				}
			},
		};
		try {
			await view.webContents.loadURL(`chrome-extension://${this.extensionId}/zoom.html`);
			this.openFailure = undefined;
			return page;
		} catch (error) {
			page.dispose();
			this.openFailure = `opening the zoom helper page failed: ${error instanceof Error ? error.message : String(error)}`;
			return undefined;
		}
	}
}

/** 切り離しに使うページ。`dispose` まで View 本体を持ち続ける。 */
interface IParaBrowserZoomHelperPage {
	readonly contents: Pick<WebContents, 'isDestroyed' | 'executeJavaScript'>;
	dispose(): void;
}

/** テスト用: ページを開く口を差し替えた切り離しの口を作る。 */
export function paraCreateBrowserZoomHelperForTest(openPage: () => Promise<{ readonly contents: Pick<WebContents, 'isDestroyed' | 'executeJavaScript'>; dispose(): void } | undefined>): IParaBrowserZoomIsolator {
	return new ParaBrowserZoomHelper(undefined as unknown as Electron.Session, openPage);
}

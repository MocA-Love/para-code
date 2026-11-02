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

/** 拡大率が 1 とみなす差。 */
const ZOOM_EPSILON = 0.0001;
/** devicePixelRatio を補うためのエミュレーションの deviceScaleFactor の上限（大きいと描画が重い）。 */
const MAX_EMULATED_DEVICE_SCALE_FACTOR = 6;

/** タブを切り離すための拡張機能の名前（Para Code の拡張機能の一覧から外すときに見る）。 */
export const PARA_BROWSER_ZOOM_HELPER_EXTENSION_NAME = 'Para Code browser zoom';

/** タブを切り離す口（テストで差し替える）。 */
export interface IParaBrowserZoomIsolator {
	/** そのタブの拡大率を、同じサイトのほかのタブから切り離す。切り離せたら true。 */
	isolate(webContents: WebContents): Promise<boolean>;
}

interface IZoomState {
	/** 利用者の拡大率（Ctrl+±、browserZoom）。 */
	user: number;
	/** 表示サイズを固定して縮める分。縮めていなければ 1。 */
	emulation: number;
	/** 今の文書で切り離し済みか。 */
	isolated: boolean;
	/** 切り離している最中。 */
	isolating: Promise<boolean> | undefined;
	/** 切り離せたら呼ぶ（エミュレーションを拡大率の形で当て直す）。 */
	onIsolated: (() => void) | undefined;
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
		state = { user: 1, emulation: 1, isolated: false, isolating: undefined, onIsolated: undefined };
		states.set(webContents, state);
		const created = state;
		// 文書が替わると切り離しが外れる。ほかの受け手（拡大率を当て直す処理）より先に知る
		webContents.prependListener('did-navigate', () => {
			created.isolated = false;
			created.isolating = undefined;
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
	void isolate(webContents, state).then(isolated => {
		if (webContents.isDestroyed()) {
			return;
		}
		if (isolated) {
			webContents.setZoomFactor(state.user * state.emulation);
		} else if (nearlyOne(state.emulation)) {
			// 切り離せないときは、利用者の拡大率だけを今までどおり（サイトごとに）当てる
			webContents.setZoomFactor(state.user);
		}
	});
}

function isolate(webContents: WebContents, state: IZoomState): Promise<boolean> {
	if (state.isolated) {
		return Promise.resolve(true);
	}
	if (!state.isolating) {
		const attempt = isolatorFor(webContents).isolate(webContents).catch(() => false).then(isolated => {
			if (state.isolating === attempt) {
				state.isolating = undefined;
				state.isolated = isolated;
				if (isolated) {
					state.onIsolated?.();
				}
			}
			return isolated && state.isolated;
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
}

/**
 * 表示サイズを固定したときのエミュレーションの値を返し、縮める分の拡大率を当てる。`browserViewEmulator.ts` の
 * `_reapply` から呼ぶ。縮める必要が無い（倍率 1）なら縮めない。切り離しが済むまでは今までどおり `scale` で縮め、
 * 済んだら `onReady` で当て直してもらう。
 */
export function paraBrowserViewEmulationParams(webContents: WebContents, request: IParaBrowserViewEmulationRequest): Electron.Parameters {
	const state = stateOf(webContents);
	state.onIsolated = request.onReady;
	const screenPosition = request.mobile ? 'mobile' as const : 'desktop' as const;
	const size = { width: request.width, height: request.height };
	const scaleByEmulation = (): Electron.Parameters => ({ screenPosition, screenSize: size, viewSize: size, deviceScaleFactor: request.deviceScaleFactor ?? 0, viewPosition: { x: 0, y: 0 }, scale: request.pageScale });
	if (nearlyOne(request.pageScale)) {
		// 縮める必要が無い（エディタが表示サイズ以上）。拡大率も使わない
		paraSetBrowserViewEmulationZoom(webContents, 1);
		return scaleByEmulation();
	}
	if (!state.isolated) {
		// 切り離しが済むまでは今までどおり。済んだら onReady で当て直してもらう
		if (!nearlyOne(state.emulation)) {
			paraSetBrowserViewEmulationZoom(webContents, 1);
		}
		void isolate(webContents, state);
		return scaleByEmulation();
	}
	paraSetBrowserViewEmulationZoom(webContents, request.pageScale);
	const targetPixelRatio = request.deviceScaleFactor ?? displayScaleFactor();
	return {
		screenPosition,
		screenSize: size,
		viewSize: { width: Math.max(1, Math.round(request.width * request.pageScale)), height: Math.max(1, Math.round(request.height * request.pageScale)) },
		// 拡大率で下がる devicePixelRatio を、表示サイズで決めた値（無ければ画面の値）に戻す
		deviceScaleFactor: Math.min(MAX_EMULATED_DEVICE_SCALE_FACTOR, targetPixelRatio / request.pageScale),
		viewPosition: { x: 0, y: 0 },
		scale: 1,
	};
}

/**
 * 画面の倍率（Retina なら 2）。表示サイズを替えるのは利用者かエージェントの操作の直後なので、ポインタのある画面の値を使う。
 * 分からなければ 1。
 */
function displayScaleFactor(): number {
	try {
		const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
		return display.scaleFactor > 0 ? display.scaleFactor : 1;
	} catch {
		return 1;
	}
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

	private page: Promise<WebContents | undefined> | undefined;

	private constructor(private readonly session: Electron.Session) { }

	async isolate(webContents: WebContents): Promise<boolean> {
		this.page ??= this.open();
		const page = await this.page;
		if (!page || page.isDestroyed() || webContents.isDestroyed()) {
			if (page?.isDestroyed()) {
				this.page = undefined;
			}
			return false;
		}
		const settled = await page.executeJavaScript(`chrome.tabs.setZoomSettings(${webContents.id}, { mode: 'automatic', scope: 'per-tab' }).then(() => true, () => false)`);
		return settled === true;
	}

	private async open(): Promise<WebContents | undefined> {
		try {
			const folder = join(electron.app.getPath('userData'), 'paradis-browser-zoom-helper');
			await fs.mkdir(folder, { recursive: true });
			await fs.writeFile(join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: PARA_BROWSER_ZOOM_HELPER_EXTENSION_NAME, version: '1.0', description: 'Keeps the zoom of each Para Code browser tab to that tab.' }));
			await fs.writeFile(join(folder, 'zoom.html'), '<!doctype html><title>zoom</title>');
			const extension = await this.session.extensions.loadExtension(folder);
			const view = new electron.WebContentsView({ webPreferences: { session: this.session, sandbox: true } });
			await view.webContents.loadURL(`chrome-extension://${extension.id}/zoom.html`);
			return view.webContents;
		} catch {
			return undefined;
		}
	}
}

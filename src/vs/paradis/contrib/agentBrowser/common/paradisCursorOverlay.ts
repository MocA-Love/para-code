/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントが内蔵ブラウザを操作しているあいだ、ページ上に「合成マウスカーソル」を描いて
// 見せるためのページ側スクリプト生成（純粋関数のみ。Electron/DOMには一切触らない）。
//
// 実行はelectron-mainの `ParadisCursorOverlayController` が
// `webContents.executeJavaScriptInIsolatedWorld(browserViewIsolatedWorldId, ...)` で行う。
// 対象ページのJSコンテキストとは分離されたisolated worldで動くため、ページのCSPや
// Trusted Types、prototype改変の影響を受けない。加えてスクリプト側でも
// `innerHTML` と `<style>` を一切使わず、DOM生成はCSSOM（`element.style`）と
// Web Animations API（`element.animate()`）だけで組み立てている。
//
// 移動アニメーションの長さはmain側が決めて `durationMs` として渡す。ページに計算させて
// 戻り値を待つと、入力配送1コマンドあたりにIPC往復ぶんの遅延が乗る。入力キューは
// 1コマンド5秒を超えるとそのキューを恒久的にpoisonするため（`paradisCdpInputQueue.ts`）、
// 演出のために往復を挟まないことが重要。
//
// move・press・focus はページの事情（動きを減らす設定・カーソルを正しい位置に描けない <html>）を
// `IParadisCursorOverlayPageTraits` として返す。main は投げっぱなしの実行の結果からそれを覚え、
// 次の入力から待ち時間を 0 にする（入力の配送の途中では待たない）。
//
// 状態はisolated worldの `window[STATE_KEY]` に保持する。ナビゲーションで自動的に消えるため
// 「再訪時は作り直し」が自然に成立する。加えてコマンドが長く途切れたら自分でフェードアウトして
// 消える（`idleMs`）。共有解除・ユーザーの手動操作開始・設定OFFのときは待たせる意味がないので、
// electron-main側から明示的に `remove` を送る。

import type { IParadisCursorKeyframe } from './paradisCursorMotion.js';

/** カーソル演出の見た目・時間まわりの調整値。 */
export interface IParadisCursorOverlayTuning {
	/** 移動アニメーションの最短時間（ms）。 */
	readonly minMs: number;
	/** 通常移動の最長時間（ms）。 */
	readonly maxMs: number;
	/** ドラッグ中（ボタン押下したままの移動）の最長時間（ms）。追従が遅いと不自然なので短くする。 */
	readonly dragMaxMs: number;
	/** 移動速度（px/ms）。距離をこれで割って所要時間を出す。 */
	readonly pxPerMs: number;
	/** この距離（px）未満の移動はアニメーションせず瞬間移動する。 */
	readonly snapPx: number;
	/** 初回出現時のフェードイン待ち時間（ms）。 */
	readonly appearMs: number;
	/**
	 * 最後のコマンドからこの時間（ms）操作が無ければ、自分でフェードアウトして消える。
	 *
	 * エージェントは考えている間や別の作業をしている間もページを掴んだままなので、
	 * 短く切ると操作のたびにカーソルが消えては現れて落ち着かない。ここはあくまで保険で、
	 * 共有解除・手動操作の開始・設定OFFでは待たずに消している。
	 */
	readonly idleMs: number;
	/** クリック波紋の再生時間（ms）。 */
	readonly rippleMs: number;
	/** スクリーンショット撮影フラッシュの再生時間（ms）。 */
	readonly flashMs: number;
	/** 撮影完了の知らせを出しておく時間（ms）。 */
	readonly toastMs: number;
	/**
	 * フォーカス移動に合わせてカーソルを寄せるときの移動時間（ms）。
	 *
	 * 寄せるのは main がキー入力を送るとき（`focus` コマンド）だけ。ページのフォーカスを定期的に
	 * 見に行くことはしない。ページのスクリプトが動かしたフォーカスに付いていくと、エージェントが
	 * 触っていない場所へカーソルが動き、そこを操作したように見えるため。
	 */
	readonly focusMs: number;
	/** 非表示化してから撮影して良いと判断するまでの最大待ち時間（ms）。 */
	readonly settleMs: number;
	/** 一度きりの状態（押せなかった・選んだ など）と印を出しておく時間（ms）。 */
	readonly markMs: number;
	/** キーの札を出しておく時間（ms）。 */
	readonly keyMs: number;
	/** 最後のキー入力から入力欄の枠と「入力中」を消すまでの時間（ms）。 */
	readonly typingMs: number;
	/** ボタンを離してからドラッグの軌跡を消し終えるまでの時間（ms）。 */
	readonly trailFadeMs: number;
	/** 押したときの縮みの時間（ms）。 */
	readonly squishMs: number;
}

export const PARADIS_CURSOR_OVERLAY_TUNING: IParadisCursorOverlayTuning = Object.freeze({
	minMs: 90,
	maxMs: 380,
	dragMaxMs: 90,
	pxPerMs: 2.2,
	snapPx: 6,
	appearMs: 140,
	idleMs: 60_000,
	rippleMs: 460,
	flashMs: 340,
	toastMs: 1600,
	focusMs: 140,
	settleMs: 250,
	markMs: 1600,
	keyMs: 1000,
	typingMs: 1200,
	trailFadeMs: 600,
	squishMs: 220,
});

/**
 * カーソル移動のために入力配送を待たせる絶対上限（ms）。
 *
 * 入力は1コマンド5秒でキューがpoisonされ、そのページの入力が以後ずっと通らなくなる。
 * 演出でその予算を大きく削らないよう、計算結果は必ずこの値で頭打ちにする。
 */
export const PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS = 400;

/**
 * カーソルの名札に出す状態（q.html Q275 A「標準」）。`idle` は状態を消して名前だけに戻す。
 *
 * - 長く続くもの（`script`・`waiting`）は次の状態か `idle` まで残す
 * - 一度きりのもの（`failed`・`missing`・`select`・`value`・`upload`・`scroll`）は少し出して消える
 */
export type ParadisCursorStatus = 'idle' | 'script' | 'waiting' | 'failed' | 'missing' | 'select' | 'value' | 'upload' | 'scroll';

/** キー入力の名札の文言（ページ側で行き先を見て選ぶ）。 */
export interface IParadisCursorTypingTexts {
	/** 文字の入力。 */
	readonly typing: string;
	/** パスワード欄への入力（文字そのものはどの場合も出さない）。 */
	readonly secret: string;
	/** 行き先がページの本体（フォーカスされた入力欄が無い）。 */
	readonly page: string;
}

/** ページ側スクリプトへ渡すコマンド。 */
export type ParadisCursorOverlayCommand =
	/**
	 * 目標座標へカーソルを動かす（必要なら生成する）。軌跡は main が cursor-motion で計算した
	 * keyframes（`paradisCursorMotion.ts`）で、ページはそれを `element.animate()` で再生するだけ。
	 * `drag` はボタンを押したままの移動で、押した点からの軌跡を残す。
	 */
	| { readonly kind: 'move'; readonly x: number; readonly y: number; readonly label: string; readonly durationMs: number; readonly frames: readonly IParadisCursorKeyframe[]; readonly drag?: boolean }
	/**
	 * 押した座標へカーソルを合わせて波紋と縮みを出す（未生成ならその場に作る）。
	 *
	 * `delayMs` は、直前の move がまだ滑っている途中のときの残り時間。押す前の move は待たずに
	 * 配送するので、ページは先に押され、カーソルは後から着く。そのときは滑りを途中で切らず、
	 * 着いた時に波紋を出す。
	 */
	| { readonly kind: 'press'; readonly x: number; readonly y: number; readonly label: string; readonly delayMs?: number }
	/** ボタンを離した。ドラッグの軌跡を消し始める。 */
	| { readonly kind: 'release' }
	/**
	 * キー入力。いまフォーカスされている要素へカーソルを寄せ、名札に入力中と出して入力欄に枠を描く。
	 * `key` は Enter・⌘K のような特別なキーの札（文字の入力では付けない）。
	 */
	| { readonly kind: 'focus'; readonly label: string; readonly texts: IParadisCursorTypingTexts; readonly key?: string }
	/** ホイール。カーソルの横に向きの矢印を出す。 */
	| { readonly kind: 'wheel'; readonly label: string; readonly dx: number; readonly dy: number; readonly text: string }
	/**
	 * 道具の状態（スクリプト実行中・待機中・押せなかった など）。`frames` があれば対象の要素へ寄せる
	 * （入力を伴わない道具の対象。待たない）。
	 */
	| { readonly kind: 'status'; readonly label: string; readonly status: ParadisCursorStatus; readonly text: string; readonly frames?: readonly IParadisCursorKeyframe[]; readonly durationMs?: number }
	/** 撮影のため即座に隠す（進行中のフラッシュも消す）。描画が反映されるまで待ってから解決する。 */
	| { readonly kind: 'hide' }
	/** 隠していたカーソルを元に戻すだけ（フラッシュは出さない）。 */
	| { readonly kind: 'show' }
	/** 撮影完了。隠していたカーソルを戻し、フラッシュと知らせを出す。 */
	| { readonly kind: 'captured'; readonly toast: string }
	/** オーバーレイもフラッシュも完全に取り除く。 */
	| { readonly kind: 'remove' };

/**
 * move・press・focus の実行結果としてページが返す事情。
 *
 * - `calm`: `prefers-reduced-motion: reduce`。ページ側は瞬間移動するので、main も待たない
 * - `blocked`: `<html>` に transform・filter・zoom などがあり、`position:fixed` の基準がずれる。
 *   ずれた位置にカーソルを描くよりは描かない（補正はしない）。待つ意味も無い
 */
export interface IParadisCursorOverlayPageTraits {
	readonly calm: boolean;
	readonly blocked: boolean;
}

/** 実行結果からページの事情を取り出す。形が違えば undefined（古いページの戻り値・例外）。 */
export function paradisParseCursorOverlayPageTraits(value: unknown): IParadisCursorOverlayPageTraits | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { calm, blocked } = value as { calm?: unknown; blocked?: unknown };
	return typeof calm === 'boolean' && typeof blocked === 'boolean' ? { calm, blocked } : undefined;
}

/**
 * 1 回の入力の配送で、カーソルの演出のために待ってよいかの指示（shared process から main へ）。
 *
 * - `pressFollows`: この move の直後に press が続く（click・click_at・click_by など）。位置を測ってから
 *   押すまでの間に待つと、その間にページが動いたとき古い座標を押すので、待たずに配送する
 * - `maxWaitMs`: この配送で待ってよい上限。1 回のツール呼び出しで待つ合計を抑えるために使う
 */
export interface IParadisCursorPacing {
	readonly pressFollows?: boolean;
	readonly maxWaitMs?: number;
}

/** shared process から main へ送る道具の状態。`point` は対象の要素の中心（ビューポートの CSS ピクセル）。 */
export interface IParadisCursorStatusNote {
	readonly status: ParadisCursorStatus;
	readonly detail?: string;
	readonly point?: { readonly x: number; readonly y: number };
}

const PARADIS_CURSOR_STATUSES: ReadonlySet<string> = new Set<ParadisCursorStatus>(['idle', 'script', 'waiting', 'failed', 'missing', 'select', 'value', 'upload', 'scroll']);

/** IPC で受けた道具の状態を確かめる。知らない形は捨てる。 */
export function paradisParseCursorStatusNote(value: unknown): IParadisCursorStatusNote | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { status, detail, point } = value as { status?: unknown; detail?: unknown; point?: unknown };
	if (typeof status !== 'string' || !PARADIS_CURSOR_STATUSES.has(status)) {
		return undefined;
	}
	const result: { status: ParadisCursorStatus; detail?: string; point?: { x: number; y: number } } = { status: status as ParadisCursorStatus };
	if (typeof detail === 'string' && detail.length > 0) {
		result.detail = detail.slice(0, 200);
	}
	if (typeof point === 'object' && point !== null) {
		const { x, y } = point as { x?: unknown; y?: unknown };
		if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100_000 && Math.abs(y) <= 100_000) {
			result.point = { x, y };
		}
	}
	return result;
}

/** IPC で受けた指示を確かめる。知らない形は「指示なし」（今までどおり待つ）として扱う。 */
export function paradisParseCursorPacing(value: unknown): IParadisCursorPacing | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const { pressFollows, maxWaitMs } = value as { pressFollows?: unknown; maxWaitMs?: unknown };
	const result: { pressFollows?: boolean; maxWaitMs?: number } = {};
	if (pressFollows === true) {
		result.pressFollows = true;
	}
	if (typeof maxWaitMs === 'number' && Number.isFinite(maxWaitMs)) {
		result.maxWaitMs = Math.max(0, Math.round(maxWaitMs));
	}
	return result;
}

/**
 * `window` へ状態を置くときのキー。isolated worldごとに独立しているため、
 * ページ側スクリプトから見えることはない。
 */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

/** カーソルとラベルのアクセントカラー（ワークベンチのアクセントに合わせた固定値）。 */
const ACCENT_COLOR = '#5b8cff';

/** 押せなかった印の色。 */
const DANGER_COLOR = '#cf222e';

/**
 * cursor-motion の矢印（Cua Driver のカーソル、./cursorMotion/README.md と同じ取得元の `render.ts` の
 * `CURSOR_PATH`）。128 の正方形の上で、先端（クリックの点）が (55, 30)。
 */
const CURSOR_PATH = 'M55 30 C48 28 42 33 43 41 C43 41 64 98 64 98 C67 106 73 106 77 99 C77 99 86 79 86 79 C88 75 91 72 95 70 C95 70 108 63 108 63 C115 59 114 53 107 50 C107 50 55 30 55 30 Z';
/** 画面での大きさ（px、Cua Driver の表示の大きさ）。 */
const CURSOR_SIZE = 42;

/**
 * JSONをスクリプトへ埋め込むためにシリアライズする。
 *
 * U+2028 / U+2029 はJSONでは生のまま出力されるが、古い実行環境では行終端子として
 * 解釈されうるためエスケープしておく（渡すのは自前の値だけだが、埋め込みの安全性は
 * 入力に依存させない）。
 */
export function paradisEncodeCursorOverlayPayload(command: ParadisCursorOverlayCommand, tuning: IParadisCursorOverlayTuning): string {
	return JSON.stringify({ ...tuning, ...command })
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/** 札を出すキー（文字の入力でないもの）。CDP の `key` の値 → 札の文字。 */
const PARADIS_CURSOR_NAMED_KEYS: Readonly<Record<string, string>> = {
	Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: '\u232b', Delete: 'Del',
	ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
	PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
};

/**
 * キーの札の文字（Enter・⌘K など）。文字の入力（修飾キーなしの 1 文字）・キーを離した・修飾キーそのものは
 * undefined（札を出さない。パスワード欄があるので打った文字は出さない）。
 */
export function paradisCursorKeyLabel(params: Readonly<Record<string, unknown>>, mac: boolean): string | undefined {
	if (params.type !== 'keyDown' && params.type !== 'rawKeyDown') {
		return undefined;
	}
	const key = typeof params.key === 'string' ? params.key : '';
	if (key === '' || key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
		return undefined;
	}
	const modifiers = typeof params.modifiers === 'number' ? params.modifiers : 0;
	// CDP の modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
	const alt = (modifiers & 1) !== 0, ctrl = (modifiers & 2) !== 0, meta = (modifiers & 4) !== 0, shift = (modifiers & 8) !== 0;
	const named = PARADIS_CURSOR_NAMED_KEYS[key] ?? (/^F\d{1,2}$/.test(key) ? key : undefined);
	// 名前の無いキーは Ctrl・⌘ のショートカットだけ札にする。Option・AltGr（Ctrl+Alt）で打つ文字（@・€・é）は
	// 文字の入力なので出さない
	if (named === undefined && (!(ctrl || meta) || alt)) {
		return undefined;
	}
	const base = named ?? ([...key].length === 1 ? key.toUpperCase() : key.slice(0, 8));
	const parts = mac
		? [ctrl ? '\u2303' : '', alt ? '\u2325' : '', shift ? '\u21e7' : '', meta ? '\u2318' : ''].join('') + base
		: [ctrl ? 'Ctrl+' : '', alt ? 'Alt+' : '', shift ? 'Shift+' : '', meta ? 'Win+' : ''].join('') + base;
	return parts;
}

/** 入力配送を待たせる時間を、安全な範囲へ丸める。 */
export function paradisClampCursorWaitMs(raw: unknown, maxWaitMs: number = PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		return 0;
	}
	return Math.min(Math.round(raw), Math.max(0, Math.round(maxWaitMs)));
}

/**
 * このマウスイベントで使う移動アニメーションの最長時間を決める。
 *
 * ドラッグ中（`buttons` が立っている移動）はカーソルが実際の掴んでいる点から
 * 離れて見えると不自然なので、通常より大幅に短くする。
 */
export function paradisCursorMoveMaxMs(params: Readonly<Record<string, unknown>>, tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING): number {
	const buttons = params.buttons;
	const dragging = typeof buttons === 'number' && Number.isFinite(buttons) && buttons !== 0;
	return dragging ? tuning.dragMaxMs : tuning.maxMs;
}

/**
 * 直前の位置から目標座標までの移動にかける時間（ms）を決める。
 *
 * ページへ問い合わせず main 側だけで決めるのは、入力配送の途中にIPC往復を挟まないため。
 * 直前の位置が無い／古すぎる（ページ側は `idleMs` で自ら消えている）ときは、
 * 距離ではなくフェードインぶんだけ待つ。
 */
export function paradisCursorGlideMs(
	previous: { readonly x: number; readonly y: number; readonly at: number } | undefined,
	next: { readonly x: number; readonly y: number; readonly at: number },
	maxMs: number,
	tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING,
): number {
	if (!previous || next.at - previous.at > tuning.idleMs) {
		return tuning.appearMs;
	}
	const distance = Math.sqrt((next.x - previous.x) ** 2 + (next.y - previous.y) ** 2);
	if (distance < tuning.snapPx) {
		return 0;
	}
	return Math.round(Math.max(tuning.minMs, Math.min(maxMs, distance / tuning.pxPerMs)));
}

/**
 * isolated worldで実行する自己完結スクリプトを組み立てる。
 *
 * 毎回まるごと送る（差分注入や `Page.addScriptToEvaluateOnNewDocument` による常駐はしない）。
 * ナビゲーション後もそのまま作り直せるうえ、送り先はelectron-main→レンダラのIPCなので
 * CDPゲートウェイの帯域予算とは無関係だからである。
 */
export function paradisBuildCursorOverlayScript(command: ParadisCursorOverlayCommand, tuning: IParadisCursorOverlayTuning = PARADIS_CURSOR_OVERLAY_TUNING): string {
	return `(function (c) {
	'use strict';
	try {
		var K = ${JSON.stringify(STATE_KEY)};
		var A = ${JSON.stringify(ACCENT_COLOR)};
		var SVGNS = 'http://www.w3.org/2000/svg';
		var doc = document;
		if (!doc) { return 0; }
		var calm = false;
		try { calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
		function sx(el, o) { for (var k in o) { try { el.style[k] = o[k]; } catch (e) { } } }
		function sv(n, a) { var e = doc.createElementNS(SVGNS, n); for (var k in a) { e.setAttribute(k, a[k]); } return e; }
		// documentElement を優先する。body に transform / filter / will-change があると
		// position:fixed の基準が body になり、カーソルが実際のクリック位置からずれるため。
		function root() { return doc.documentElement || doc.body; }
		/** 状態だけを取り出す（cursorのDOMは作らない）。撮影の退避や後始末が、無かったはずの
		 *  カーソルを作ってしまわないようにするための分離。 */
		function state(create) {
			var s = window[K];
			if (!s && create) {
				s = window[K] = { h: null, mv: null, gl: null, sq: null, rp: null, rg: null, mk: null, lb: null, lt: null, kb: null, fr: null, tr: null, tl2: null, t: '', name: '', st: '', sticky: '', x: null, y: null, r: 0, tm: 0, stt: 0, kbt: 0, frt: 0, mkt: 0, trt: 0, am: null, ag: null, ao: null, aw: null, awo: null, atr: null, f: null, ts: null, tst: 0, hid: false, shown: false, fading: false, typing: false, wt: false, pp: null, tl: null, tp: null };
			}
			return s || null;
		}

		/** いまフォーカスされている要素（shadow root の中まで辿る）。 */
		function deepActive() {
			var el = doc.activeElement, guard = 0;
			while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 20) { el = el.shadowRoot.activeElement; }
			return el;
		}
		/**
		 * '<html>' に 'position:fixed' の基準を変える指定があるか。あるとカーソルがクリックの位置から
		 * ずれるので描かない（補正はしない）。body は避けて html に置いているが、html 自身は避けられない。
		 */
		function blockedRoot() {
			try {
				var de = doc.documentElement;
				if (!de || !window.getComputedStyle) { return false; }
				var cs = window.getComputedStyle(de);
				if (cs.transform && cs.transform !== 'none') { return true; }
				if (cs.filter && cs.filter !== 'none') { return true; }
				if (cs.backdropFilter && cs.backdropFilter !== 'none') { return true; }
				if (cs.perspective && cs.perspective !== 'none') { return true; }
				if ((cs.translate && cs.translate !== 'none') || (cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')) { return true; }
				if (cs.containerType && cs.containerType !== 'normal') { return true; }
				var z = cs.zoom;
				if (z && z !== '1' && z !== 'normal') { return true; }
				if (/transform|filter|perspective/.test(cs.willChange || '')) { return true; }
				if (/paint|layout|strict|content/.test(cs.contain || '')) { return true; }
			} catch (e) { }
			return false;
		}
		/** ページの事情を main へ返す（'IParadisCursorOverlayPageTraits'）。 */
		function traits(blocked) { return { calm: calm, blocked: !!blocked }; }
		/**
		 * いま top layer にあるもの（全画面・モーダルのダイアログ・開いている popover）の目印。
		 * top layer は z-index に関係なく上に描かれるので、そこにカーソルを出すには自分も top layer の
		 * 最後に積む必要がある。
		 */
		function topLayerKey(s) {
			var n = 0, last = null;
			try {
				var fs = doc.fullscreenElement;
				if (fs) { n++; last = fs; }
				var list = doc.querySelectorAll(':modal, :popover-open');
				for (var i = 0; i < list.length; i++) { if (list[i] !== s.h) { n++; last = list[i]; } }
			} catch (e) { }
			return n === 0 ? null : { n: n, last: last };
		}
		/** top layer に何かあれば、カーソルを popover にして top layer の最後へ積み直す。 */
		function lift(s) {
			var k = topLayerKey(s);
			var h = s.h;
			if (!k) {
				s.tl = null;
				// popover のまま閉じられていると（付け直した・ページが popover を一括で閉じた）、UA の
				// '[popover]:not(:popover-open)' で消えたままになる。top layer が空なら普通の要素に戻す。
				try { if (h.hasAttribute('popover') && !h.matches(':popover-open')) { h.removeAttribute('popover'); } } catch (e) { }
				return;
			}
			var open = false;
			try { open = h.matches(':popover-open'); } catch (e) { }
			// 積み直すと表示が一度切れて滑りが止まるので、top layer の中身が変わったときだけ行う。
			if (open && s.tl && s.tl.n === k.n && s.tl.last === k.last) { return; }
			s.tl = k;
			try {
				if (!h.hasAttribute('popover')) { h.setAttribute('popover', 'manual'); }
				if (open) { h.hidePopover(); }
				h.showPopover();
			} catch (e) {
				// popover を使えない。UA の '[popover]:not(:popover-open)' で消えないよう属性を外す。
				try { h.removeAttribute('popover'); } catch (e2) { }
				s.tl = null;
			}
		}
		/** 要素のどこにカーソルを置くか。画面外・大きさ0なら置かない。 */
		function pointOf(el) {
			if (!el || !el.getBoundingClientRect || el === doc.body || el === doc.documentElement) { return null; }
			var r;
			try { r = el.getBoundingClientRect(); } catch (e) { return null; }
			if (!r || (r.width <= 0 && r.height <= 0)) { return null; }
			var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
			if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) { return null; }
			return { x: Math.round(r.left + Math.min(14, Math.max(2, r.width / 2))), y: Math.round(r.top + r.height / 2) };
		}

		/** 押した点の上下左右の枠（入力欄の枠を描く）。iframe の中の要素は iframe の位置を足す。 */
		function rectOf(el) {
			try {
				var r = el.getBoundingClientRect();
				return r && (r.width > 0 || r.height > 0) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
			} catch (e) { return null; }
		}
		/**
		 * キー入力の行き先。iframe にフォーカスがあれば、読める（同じ origin の）ときは中の要素まで辿る。
		 * 戻り値の 'kind' は 'field'（入力欄）・'secret'（パスワード欄）・'page'（本体）。
		 */
		function typingTarget() {
			var el = deepActive(), ox = 0, oy = 0, guard = 0;
			while (el && el.tagName === 'IFRAME' && guard++ < 5) {
				var fr = rectOf(el);
				var inner = null;
				try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { inner = null; }
				if (!fr || !inner || inner === el.contentDocument.body) { break; }
				ox += fr.left; oy += fr.top; el = inner;
			}
			if (!el || el === doc.body || el === doc.documentElement || (el.ownerDocument && el === el.ownerDocument.body)) { return { kind: 'page', el: null, rect: null }; }
			var r = rectOf(el);
			if (r) { r.left += ox; r.top += oy; }
			var type = '';
			try { type = String(el.type || '').toLowerCase(); } catch (e) { }
			return { kind: type === 'password' ? 'secret' : 'field', el: el, rect: r };
		}

		function buildCursor(s) {
			// ホストは画面の左上に止めたまま、中の 'mv' だけを keyframes で動かす。入力欄の枠と
			// ドラッグの軌跡は画面の座標で描くので、動く要素の外（ホストの直下）に置く。
			var h = doc.createElement('div');
			h.setAttribute('aria-hidden', 'true');
			sx(h, {
				position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto', width: '0px', height: '0px',
				margin: '0px', padding: '0px', border: '0px', background: 'none', overflow: 'visible',
				zIndex: '2147483647', pointerEvents: 'none'
			});
			var sr = h.attachShadow ? h.attachShadow({ mode: 'closed' }) : h;
			var fr = doc.createElement('div');
			sx(fr, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', boxSizing: 'border-box', border: '2px solid ' + A, borderRadius: '5px', opacity: '0', pointerEvents: 'none' });
			var tr = sv('svg', { width: '1', height: '1' });
			sx(tr, { position: 'absolute', left: '0px', top: '0px', overflow: 'visible', opacity: '0', pointerEvents: 'none' });
			var tl = sv('polyline', { fill: 'none', stroke: A, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': '0.65', points: '' });
			tr.appendChild(tl);
			var mv = doc.createElement('div');
			sx(mv, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', pointerEvents: 'none', opacity: '0', transform: 'translate3d(-99999px,-99999px,0)' });
			var rp = doc.createElement('div');
			sx(rp, {
				position: 'absolute', left: '-18px', top: '-18px', width: '36px', height: '36px',
				boxSizing: 'border-box', borderRadius: '50%', border: '2px solid ' + A, opacity: '0'
			});
			// 待機中の輪（回る）
			var rg = doc.createElement('div');
			sx(rg, {
				position: 'absolute', left: '-15px', top: '-15px', width: '30px', height: '30px',
				boxSizing: 'border-box', borderRadius: '50%', border: '2px solid ' + A, borderTopColor: 'transparent', opacity: '0'
			});
			// 矢印。先端（クリックの点）が 'gl' の原点に来るよう、cursor-motion の 128 の正方形をずらして置く。
			var gl = doc.createElement('div');
			sx(gl, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px' });
			var sq = doc.createElement('div');
			sx(sq, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px' });
			var scale = ${CURSOR_SIZE} / 128;
			var g = sv('svg', { viewBox: '0 0 128 128', width: String(${CURSOR_SIZE}), height: String(${CURSOR_SIZE}) });
			sx(g, { position: 'absolute', left: (-55 * scale) + 'px', top: (-30 * scale) + 'px', overflow: 'visible', filter: 'drop-shadow(0 0 3px ' + A + ') drop-shadow(0 2px 3px rgba(0,0,0,0.3))' });
			g.appendChild(sv('path', { d: ${JSON.stringify(CURSOR_PATH)}, fill: A, stroke: '#ffffff', 'stroke-width': '5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
			sq.appendChild(g); gl.appendChild(sq);
			// 印（押せなかった ✕・スクロールの矢印）
			var mk = doc.createElement('div');
			sx(mk, {
				position: 'absolute', left: '-11px', top: '-11px', width: '22px', height: '22px', borderRadius: '50%',
				display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', background: A,
				font: '700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif', opacity: '0',
				boxShadow: '0 1px 4px rgba(0,0,0,0.3)'
			});
			var lb = doc.createElement('div');
			sx(lb, {
				position: 'absolute', left: '18px', top: '22px', display: 'flex', alignItems: 'center', gap: '5px',
				background: A, color: '#ffffff',
				font: '500 10.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
				padding: '2px 7px', borderRadius: '5px', whiteSpace: 'nowrap',
				boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
			});
			var lt = doc.createElement('span');
			var kb = doc.createElement('span');
			sx(kb, {
				display: 'none', padding: '0px 5px', borderRadius: '3px', background: 'rgba(255,255,255,0.22)',
				border: '1px solid rgba(255,255,255,0.45)', font: '600 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace'
			});
			lb.appendChild(lt); lb.appendChild(kb);
			mv.appendChild(rp); mv.appendChild(rg); mv.appendChild(gl); mv.appendChild(mk); mv.appendChild(lb);
			sr.appendChild(fr); sr.appendChild(tr); sr.appendChild(mv);
			// 撮影のために隠している最中に作ったなら、作った時から隠す
			if (s.hid) { sx(h, { display: 'none' }); }
			s.h = h; s.mv = mv; s.gl = gl; s.sq = sq; s.rp = rp; s.rg = rg; s.mk = mk; s.lb = lb; s.lt = lt; s.kb = kb; s.fr = fr; s.tr = tr; s.tl2 = tl;
		}
		function anim(el, frames, opts) { try { return el.animate(frames, opts); } catch (e) { return null; } }
		function stop(a) { if (a) { try { a.cancel(); } catch (e) { } } }
		function dropFlash(s) {
			if (s.f) { if (s.f.parentNode) { s.f.parentNode.removeChild(s.f); } s.f = null; }
		}
		function dropToast(s) {
			if (s.tst) { clearTimeout(s.tst); s.tst = 0; }
			if (s.ts) { if (s.ts.parentNode) { s.ts.parentNode.removeChild(s.ts); } s.ts = null; }
		}
		function clearTimers(s) {
			var names = ['tm', 'stt', 'kbt', 'frt', 'mkt', 'trt'];
			for (var i = 0; i < names.length; i++) { if (s[names[i]]) { clearTimeout(s[names[i]]); s[names[i]] = 0; } }
		}
		function kill(s) {
			clearTimers(s);
			dropFlash(s); dropToast(s);
			if (s.h && s.h.parentNode) { s.h.parentNode.removeChild(s.h); }
			if (window[K] === s) { try { delete window[K]; } catch (e) { window[K] = void 0; } }
		}
		function arm(s, ms) {
			if (s.tm) { clearTimeout(s.tm); }
			s.tm = setTimeout(function () {
				stop(s.ao);
				s.fading = true;
				s.ao = anim(s.mv, [{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: 'forwards', easing: 'ease' });
				s.tm = setTimeout(function () { kill(s); }, 440);
			}, ms);
		}
		function attachCursor(s) {
			if (!s.h) { buildCursor(s); }
			if (!s.h) { return false; }
			if (!s.h.isConnected) {
				var p = root();
				if (!p) { return false; }
				p.appendChild(s.h);
				s.tl = null;
			}
			lift(s);
			return true;
		}
		/** 見えるようにする（撮影のために隠している間は出さない）。 */
		function reveal(s) {
			if (s.hid) { return; }
			sx(s.h, { display: '' });
			if (s.fading) { s.fading = false; stop(s.ao); s.ao = null; }
			if (s.shown) { return; }
			// 不透明にするのは出すときの 1 回だけ（移動のたびに style を書かない）。
			s.shown = true;
			sx(s.mv, { opacity: '1' });
			if (!calm) { anim(s.mv, [{ opacity: 0 }, { opacity: 1 }], { duration: 170, easing: 'ease' }); }
		}
		/**
		 * keyframes を再生する。前の再生は止めるが、新しい再生は main が計算した「今いる点」から始まる
		 * ので位置は跳ばない。style の属性は書き換えない（ページのセッション録画に残りにくくするため）。
		 */
		function play(s, frames, dur) {
			if (!attachCursor(s)) { return; }
			var last = frames[frames.length - 1];
			var fs = (calm || !(dur > 0) || frames.length < 2 || s.x === null) ? [{ x: last.x, y: last.y, r: last.r, o: 0 }, { x: last.x, y: last.y, r: last.r, o: 1 }] : frames;
			var d = fs === frames ? dur : 1;
			if (fs === frames && s.am) {
				// main は寄せ（入力欄へ）や押した点の行き過ぎを知らないので、再生の頭を今いる点へ合わせる
				try {
					var m = new DOMMatrixReadOnly(getComputedStyle(s.mv).transform);
					if (Math.abs(m.m41 - frames[0].x) > 2 || Math.abs(m.m42 - frames[0].y) > 2) {
						fs = frames.slice();
						fs[0] = { x: Math.round(m.m41 * 10) / 10, y: Math.round(m.m42 * 10) / 10, r: frames[0].r, o: 0 };
					}
				} catch (e) { }
			}
			s.x = last.x; s.y = last.y; s.r = last.r;
			stop(s.am); stop(s.ag);
			s.am = anim(s.mv, fs.map(function (f) { return { transform: 'translate3d(' + f.x + 'px,' + f.y + 'px,0)', offset: f.o }; }), { duration: d, fill: 'forwards', easing: 'linear' });
			s.ag = anim(s.gl, fs.map(function (f) { return { transform: 'rotate(' + f.r + 'deg)', offset: f.o }; }), { duration: d, fill: 'forwards', easing: 'linear' });
			reveal(s);
			arm(s, c.idleMs + d);
		}
		/** 今の向きのまま、点へ真っすぐ動かす（press・focus・ホイール）。 */
		function glideTo(s, x, y, dur) {
			var r = s.r || 0;
			var from = s.x === null ? { x: x, y: y } : { x: s.x, y: s.y };
			play(s, [{ x: from.x, y: from.y, r: r, o: 0 }, { x: x, y: y, r: 0, o: 1 }], dur);
		}
		/** 名札。名前の後ろに状態を出す。 */
		function render(s) {
			if (!s.lt) { return; }
			var text = s.st ? s.name + ' \\u00b7 ' + s.st : s.name;
			if (s.t !== text) { s.t = text; s.lt.textContent = text; }
		}
		function setLabel(s, label) { s.name = label; if (!s.st && s.sticky) { s.st = s.sticky; } render(s); }
		/** 状態を出す。'ms' があればその後に消す（長く続く状態は次の状態まで残す）。 */
		function setStatus(s, text, ms) {
			if (s.stt) { clearTimeout(s.stt); s.stt = 0; }
			s.st = text || '';
			render(s);
			if (ms > 0) { s.stt = setTimeout(function () { s.stt = 0; s.st = s.sticky || ''; render(s); }, ms); }
		}
		/** 待機中: カーソルを薄くして輪を回す。 */
		function setWaiting(s, on) {
			if (!!s.wt === !!on) { return; }
			s.wt = !!on;
			stop(s.aw); stop(s.awo); s.aw = null; s.awo = null;
			if (on) {
				sx(s.rg, { opacity: '1' });
				if (!calm) { s.aw = anim(s.rg, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 900, iterations: Infinity }); }
				s.awo = anim(s.gl, [{ opacity: 0.5 }, { opacity: 0.5 }], { duration: 1, fill: 'forwards' });
			} else {
				sx(s.rg, { opacity: '0' });
			}
		}
		/** 印（✕・矢印）を少し出す。 */
		function mark(s, glyph, color) {
			if (s.mkt) { clearTimeout(s.mkt); s.mkt = 0; }
			s.mk.textContent = glyph;
			sx(s.mk, { background: color, opacity: '1' });
			s.mkt = setTimeout(function () { s.mkt = 0; sx(s.mk, { opacity: '0' }); }, c.markMs);
		}
		/** キーの札を少し出す。 */
		function keyBadge(s, key) {
			if (s.kbt) { clearTimeout(s.kbt); s.kbt = 0; }
			s.kb.textContent = key;
			sx(s.kb, { display: '' });
			s.kbt = setTimeout(function () { s.kbt = 0; sx(s.kb, { display: 'none' }); }, c.keyMs);
		}
		/** 入力欄の枠。打つのが止まったら消す。 */
		function fieldFrame(s, r) {
			if (s.frt) { clearTimeout(s.frt); s.frt = 0; }
			var done = function () { s.frt = 0; sx(s.fr, { opacity: '0' }); if (s.typing) { s.typing = false; setStatus(s, s.sticky || '', 0); } };
			if (!r) { sx(s.fr, { opacity: '0' }); s.frt = setTimeout(done, c.typingMs); return; }
			sx(s.fr, { left: Math.round(r.left - 3) + 'px', top: Math.round(r.top - 3) + 'px', width: Math.round(r.width + 6) + 'px', height: Math.round(r.height + 6) + 'px', opacity: '1' });
			s.frt = setTimeout(done, c.typingMs);
		}
		/** ドラッグの軌跡（押した点から）。 */
		function trail(s, x, y) {
			if (s.trt) { clearTimeout(s.trt); s.trt = 0; stop(s.atr); s.atr = null; }
			if (!s.tp) { s.tp = s.pp ? [s.pp.x + ',' + s.pp.y] : []; }
			s.tp.push(x + ',' + y);
			if (s.tp.length > 400) { s.tp.splice(1, s.tp.length - 400); }
			s.tl2.setAttribute('points', s.tp.join(' '));
			sx(s.tr, { opacity: '1' });
		}
		function endTrail(s) {
			if (!s.tp) { return; }
			s.tp = null;
			stop(s.atr);
			s.atr = calm ? null : anim(s.tr, [{ opacity: 1 }, { opacity: 0 }], { duration: c.trailFadeMs, fill: 'forwards' });
			s.trt = setTimeout(function () { s.trt = 0; stop(s.atr); s.atr = null; sx(s.tr, { opacity: '0' }); s.tl2.setAttribute('points', ''); }, c.trailFadeMs);
		}

		if (c.kind === 'move' || c.kind === 'press' || c.kind === 'focus' || c.kind === 'wheel' || c.kind === 'status') {
			if (blockedRoot()) {
				// ずれた位置に出すより出さない。前に描いていたものも片付ける。
				var sb = state(false);
				if (sb) { kill(sb); }
				return traits(true);
			}
			var sm = state(true);
			if (!sm) { return 0; }
			// まだカーソルを出していないページで、置き場所の無い状態・ホイールのために DOM を作らない
			// （見えないホストがページに残り、消すタイマーも張られない）。
			if ((c.kind === 'wheel' || (c.kind === 'status' && !(c.frames && c.frames.length))) && (sm.x === null || !sm.h)) {
				if (c.kind === 'status') { sm.sticky = c.status === 'script' || c.status === 'waiting' ? c.text : ''; }
				return traits(false);
			}
			if (!attachCursor(sm)) { return 0; }
			setLabel(sm, c.label);
			if (c.kind === 'focus') {
				var tt = typingTarget();
				// パスワード欄では、特別なキーの札も出さない（何を打ったかの手がかりになる）
				if (c.key && tt.kind !== 'secret') { keyBadge(sm, c.key); }
				if (!c.key || tt.kind !== 'page') {
					sm.typing = true;
					setStatus(sm, tt.kind === 'secret' ? c.texts.secret : tt.kind === 'page' ? c.texts.page : c.texts.typing, 0);
				}
				fieldFrame(sm, tt.rect);
				var r0 = tt.rect;
				// 直前に押した点がその要素の中なら、押した点に留める（クリックした入力欄へ打つとき、
				// カーソルが要素の左端へ滑ると、端を押したように見える）。
				if (sm.pp && r0 && sm.pp.x >= r0.left && sm.pp.x <= r0.left + r0.width && sm.pp.y >= r0.top && sm.pp.y <= r0.top + r0.height) {
					if (sm.x === null) { glideTo(sm, sm.pp.x, sm.pp.y, 0); } else { reveal(sm); arm(sm, c.idleMs); }
					return traits(false);
				}
				var fp = tt.el ? pointOf(tt.el) : null;
				if (fp && r0) { fp = { x: Math.round(r0.left + Math.min(14, Math.max(2, r0.width / 2))), y: Math.round(r0.top + r0.height / 2) }; }
				if (!fp) {
					if (sm.x !== null) { reveal(sm); arm(sm, c.idleMs); }
					return traits(false);
				}
				sm.pp = null;
				glideTo(sm, fp.x, fp.y, calm ? 0 : c.focusMs);
				return traits(false);
			}
			if (c.kind === 'wheel') {
				var ax = Math.abs(c.dx), ay = Math.abs(c.dy);
				mark(sm, ay >= ax ? (c.dy > 0 ? '\\u2193' : '\\u2191') : (c.dx > 0 ? '\\u2192' : '\\u2190'), A);
				setStatus(sm, c.text, c.markMs);
				reveal(sm); arm(sm, c.idleMs);
				return traits(false);
			}
			if (c.kind === 'status') {
				if (c.frames && c.frames.length) { sm.pp = null; play(sm, c.frames, c.durationMs || 0); } else { reveal(sm); arm(sm, c.idleMs); }
				setWaiting(sm, c.status === 'waiting');
				if (c.status === 'idle') { sm.sticky = ''; setStatus(sm, '', 0); return traits(false); }
				if (c.status === 'script' || c.status === 'waiting') { sm.sticky = c.text; setStatus(sm, c.text, 0); return traits(false); }
				if (c.status === 'failed') { mark(sm, '\\u2715', ${JSON.stringify(DANGER_COLOR)}); }
				if (c.status === 'scroll') { mark(sm, '\\u2195', A); }
				setStatus(sm, c.text, c.markMs);
				return traits(false);
			}
			// move・press は道具が入力を始めた合図なので、待機中は解く。
			setWaiting(sm, false);
			if (c.kind === 'move') {
				if (!c.drag) { sm.pp = null; endTrail(sm); }
				play(sm, c.frames, c.durationMs);
				if (c.drag) { trail(sm, c.x, c.y); }
				return traits(false);
			}
			// press: 押した点そのものへ合わせてから波紋と縮みを出す。移動のコマンドが届いて
			// いなくてもクリックが無音にならないよう、ここでも作る。
			// 直前の move がまだその点へ滑っている途中なら、滑りを切らずに着いた時に波紋を出す。
			var delay = !calm && c.delayMs > 0 && sm.x !== null && Math.abs(sm.x - c.x) < 1 && Math.abs(sm.y - c.y) < 1 ? c.delayMs : 0;
			if (delay > 0) {
				reveal(sm);
				arm(sm, c.idleMs + delay);
			} else {
				glideTo(sm, c.x, c.y, 0);
			}
			sm.pp = { x: c.x, y: c.y };
			endTrail(sm);
			if (calm) { return traits(false); }
			anim(sm.rp, [{ transform: 'scale(0.35)', opacity: 0.75 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: c.rippleMs, delay: delay, easing: 'cubic-bezier(0.2,0.7,0.3,1)' });
			anim(sm.sq, [{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: c.squishMs, delay: delay, easing: 'ease-out' });
			return traits(false);
		}

		if (c.kind === 'release') {
			var sr2 = state(false);
			if (sr2 && sr2.h) { endTrail(sr2); }
			return 0;
		}

		if (c.kind === 'captured') {
			var sc = state(true);
			if (!sc) { return 0; }
			sc.hid = false;
			if (sc.h) { sx(sc.h, { display: '' }); }
			var p2 = root();
			if (!p2) { return 0; }
			// 知らせは撮影が終わってから出すので画像には写らない。動きを抑える設定でも
			// 「撮れた」ことは伝えたいので、こちらは出したうえで動きだけ止める。
			dropToast(sc);
			var ts = doc.createElement('div');
			ts.setAttribute('aria-hidden', 'true');
			sx(ts, {
				position: 'fixed', top: '12px', right: '12px', margin: '0px',
				display: 'flex', alignItems: 'center', gap: '8px',
				background: '#16181c', color: '#ffffff',
				font: '400 11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
				padding: '8px 12px', borderRadius: '8px', whiteSpace: 'nowrap',
				boxShadow: '0 4px 14px rgba(0,0,0,0.35)', pointerEvents: 'none',
				zIndex: '2147483647', opacity: calm ? '1' : '0'
			});
			var thumb = doc.createElement('div');
			sx(thumb, { width: '26px', height: '18px', flex: 'none', background: '#3a3d44', border: '1px solid #565961', borderRadius: '3px' });
			var text = doc.createElement('span');
			text.textContent = c.toast;
			ts.appendChild(thumb); ts.appendChild(text);
			p2.appendChild(ts);
			sc.ts = ts;
			sc.tst = setTimeout(function () { if (window[K] === sc && sc.ts === ts) { dropToast(sc); } else if (ts.parentNode) { ts.parentNode.removeChild(ts); } }, c.toastMs + 120);
			if (!calm) {
				try {
					ts.animate([
						{ opacity: 0, transform: 'translateY(-8px) scale(0.92)' },
						{ opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.12 },
						{ opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.82 },
						{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }
					], { duration: c.toastMs, easing: 'ease-out' });
				} catch (e) { }
				dropFlash(sc);
				var f = doc.createElement('div');
				f.setAttribute('aria-hidden', 'true');
				sx(f, {
					position: 'fixed', left: '0px', top: '0px', width: '100%', height: '100%',
					margin: '0px', padding: '0px', border: '0px', background: '#ffffff',
					opacity: '0', pointerEvents: 'none', zIndex: '2147483647'
				});
				p2.appendChild(f);
				sc.f = f;
				var gone = function () { if (sc.f === f) { dropFlash(sc); } else if (f.parentNode) { f.parentNode.removeChild(f); } };
				try {
					var an = f.animate([{ opacity: 0 }, { opacity: 0.92, offset: 0.16 }, { opacity: 0 }], { duration: c.flashMs, easing: 'ease-out' });
					an.onfinish = gone; an.oncancel = gone;
				} catch (e) { }
				setTimeout(gone, c.flashMs + 500);
			}
			// カーソルだけが理由で state を生かし続けない。演出しか無いなら畳む。
			if (!sc.h) { setTimeout(function () { if (window[K] === sc && !sc.h && !sc.f && !sc.ts) { kill(sc); } }, c.toastMs + 600); }
			return 0;
		}

		// ここから先は既にあるものにしか作用しない。
		var s = state(false);
		if (!s) { return 0; }
		if (c.kind === 'remove') { kill(s); return 0; }
		if (c.kind === 'show') {
			s.hid = false;
			if (s.h) { sx(s.h, { display: '' }); if (!s.shown && s.x !== null) { reveal(s); } }
			return 0;
		}
		if (c.kind === 'hide') {
			// 撮影に入るので、進行中の演出も必ず消す（残っていると次の1枚に写る）。
			dropFlash(s); dropToast(s);
			s.hid = true;
			if (s.h) { sx(s.h, { transition: 'none', display: 'none' }); }
			return new Promise(function (res) {
				var settled = false;
				var done = function () { if (!settled) { settled = true; res(0); } };
				setTimeout(done, c.settleMs);
				if (typeof requestAnimationFrame === 'function') {
					requestAnimationFrame(function () { requestAnimationFrame(done); });
				} else { done(); }
			});
		}
		return 0;
	} catch (e) { return 0; }
})(${paradisEncodeCursorOverlayPayload(command, tuning)})`;
}

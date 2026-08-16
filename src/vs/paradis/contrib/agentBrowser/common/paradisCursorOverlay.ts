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
// 状態はisolated worldの `window[STATE_KEY]` に保持する。ナビゲーションで自動的に消えるため
// 「再訪時は作り直し」が自然に成立する。加えてコマンドが長く途切れたら自分でフェードアウトして
// 消える（`idleMs`）。共有解除・ユーザーの手動操作開始・設定OFFのときは待たせる意味がないので、
// electron-main側から明示的に `remove` を送る。

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
	/** フォーカス移動に合わせてカーソルを寄せるときの移動時間（ms）。 */
	readonly focusMs: number;
	/**
	 * フォーカスの移り先を見に行く間隔（ms）。
	 *
	 * `focusin` を使えないため定期的に見る。エージェント操作中のビューは必ず未フォーカスで
	 * （`dispatchExactViewInput` がフォーカス中の配送を拒む）、未フォーカスのドキュメントでは
	 * Chromium がフォーカス系イベントの発火を抑えるため、購読しても永久に呼ばれない。
	 */
	readonly focusPollMs: number;
	/**
	 * 直前のマウス操作からこの時間（ms）はフォーカス追従を見送る。
	 *
	 * クリック直後はその要素にフォーカスが移るので、追従させるとカーソルが押した点から
	 * 勝手にずれる。マウスが動かしているあいだはマウスを優先する。
	 */
	readonly focusHoldOffMs: number;
	/** 非表示化してから撮影して良いと判断するまでの最大待ち時間（ms）。 */
	readonly settleMs: number;
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
	focusPollMs: 250,
	focusHoldOffMs: 1_200,
	settleMs: 250,
});

/**
 * カーソル移動のために入力配送を待たせる絶対上限（ms）。
 *
 * 入力は1コマンド5秒でキューがpoisonされ、そのページの入力が以後ずっと通らなくなる。
 * 演出でその予算を大きく削らないよう、計算結果は必ずこの値で頭打ちにする。
 */
export const PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS = 400;

/** ページ側スクリプトへ渡すコマンド。 */
export type ParadisCursorOverlayCommand =
	/** 目標座標へカーソルを滑らせる（必要なら生成する）。長さはmain側が決める。 */
	| { readonly kind: 'move'; readonly x: number; readonly y: number; readonly label: string; readonly durationMs: number }
	/** 押した座標へカーソルを合わせて波紋を出す（未生成ならその場に作る）。 */
	| { readonly kind: 'press'; readonly x: number; readonly y: number; readonly label: string }
	/**
	 * いまフォーカスされている要素へカーソルを寄せる。
	 *
	 * `fill` のようにキーボードもマウスも使わない操作（`element.value` を直接書く）は
	 * CDPの入力を一切出さないため、座標を持たないこのコマンドで面倒を見る。
	 */
	| { readonly kind: 'focus'; readonly label: string }
	/** 撮影のため即座に隠す（進行中のフラッシュも消す）。描画が反映されるまで待ってから解決する。 */
	| { readonly kind: 'hide' }
	/** 隠していたカーソルを元に戻すだけ（フラッシュは出さない）。 */
	| { readonly kind: 'show' }
	/** 撮影完了。隠していたカーソルを戻し、フラッシュと知らせを出す。 */
	| { readonly kind: 'captured'; readonly toast: string }
	/** オーバーレイもフラッシュも完全に取り除く。 */
	| { readonly kind: 'remove' };

/**
 * `window` へ状態を置くときのキー。isolated worldごとに独立しているため、
 * ページ側スクリプトから見えることはない。
 */
const STATE_KEY = '__paraCodeAgentCursorOverlay';

/** カーソルとラベルのアクセントカラー（ワークベンチのアクセントに合わせた固定値）。 */
const ACCENT_COLOR = '#5b8cff';

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
				s = window[K] = { h: null, rp: null, lb: null, t: '', x: null, y: null, tm: 0, f: null, ts: null, tst: 0, hid: false, fo: null, fe: null, mt: 0 };
			}
			return s || null;
		}

		/** いまフォーカスされている要素（shadow root の中まで辿る）。 */
		function deepActive() {
			var el = doc.activeElement, guard = 0;
			while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 20) { el = el.shadowRoot.activeElement; }
			return el;
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

		function buildCursor(s) {
			var h = doc.createElement('div');
			h.setAttribute('aria-hidden', 'true');
			sx(h, {
				position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px',
				margin: '0px', padding: '0px', border: '0px', background: 'none',
				zIndex: '2147483647', pointerEvents: 'none', opacity: '0',
				transform: 'translate3d(-99999px,-99999px,0)'
			});
			var sr = h.attachShadow ? h.attachShadow({ mode: 'closed' }) : h;
			var w = doc.createElement('div');
			sx(w, { position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', pointerEvents: 'none' });
			var rp = doc.createElement('div');
			sx(rp, {
				position: 'absolute', left: '-18px', top: '-18px', width: '36px', height: '36px',
				boxSizing: 'border-box', borderRadius: '50%', border: '2px solid ' + A, opacity: '0'
			});
			var g = sv('svg', { viewBox: '0 0 24 24', width: '20', height: '20' });
			sx(g, { position: 'absolute', left: '0px', top: '0px', overflow: 'visible', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.35))' });
			g.appendChild(sv('path', {
				d: 'M4 2 L4 20 L9 15.5 L12.5 22 L15.5 20.5 L12 14 L19 14 Z',
				fill: '#ffffff', stroke: A, 'stroke-width': '1.4', 'stroke-linejoin': 'round'
			}));
			var lb = doc.createElement('div');
			sx(lb, {
				position: 'absolute', left: '16px', top: '18px', background: A, color: '#ffffff',
				font: '500 10.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
				padding: '2px 7px', borderRadius: '5px', whiteSpace: 'nowrap',
				boxShadow: '0 2px 6px rgba(0,0,0,0.25)'
			});
			w.appendChild(rp); w.appendChild(g); w.appendChild(lb);
			sr.appendChild(w);
			s.h = h; s.rp = rp; s.lb = lb;
			// キーボードもマウスも使わない操作（fill 等）はCDPの入力を一切出さないので、
			// フォーカスの移り先を定期的に見て寄せる。focusin を購読しないのは、エージェントが
			// 操作しているビューは必ず未フォーカスで、そのドキュメントでは Chromium が
			// フォーカス系イベントを発火しないため（購読しても永久に呼ばれない）。
			try {
				s.fo = setInterval(function () {
					try {
						var st = window[K];
						if (!st || !st.h) { return; }
						if (st.mt && Date.now() - st.mt < c.focusHoldOffMs) { return; }
						var el = deepActive();
						if (!el || st.fe === el) { return; }
						var p = pointOf(el);
						if (!p) { return; }
						st.fe = el;
						place(st, p.x, p.y, calm ? 0 : c.focusMs, true);
					} catch (e) { }
				}, c.focusPollMs);
			} catch (e) { s.fo = null; }
		}
		function dropFlash(s) {
			if (s.f) { if (s.f.parentNode) { s.f.parentNode.removeChild(s.f); } s.f = null; }
		}
		function dropToast(s) {
			if (s.tst) { clearTimeout(s.tst); s.tst = 0; }
			if (s.ts) { if (s.ts.parentNode) { s.ts.parentNode.removeChild(s.ts); } s.ts = null; }
		}
		function kill(s) {
			if (s.tm) { clearTimeout(s.tm); s.tm = 0; }
			dropFlash(s); dropToast(s);
			if (s.fo) { try { clearInterval(s.fo); } catch (e) { } s.fo = null; }
			s.fe = null;
			if (s.h && s.h.parentNode) { s.h.parentNode.removeChild(s.h); }
			if (window[K] === s) { try { delete window[K]; } catch (e) { window[K] = void 0; } }
		}
		function arm(s, ms) {
			if (s.tm) { clearTimeout(s.tm); }
			s.tm = setTimeout(function () {
				if (s.h) { sx(s.h, { transition: 'opacity 380ms ease', opacity: '0' }); }
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
			}
			return true;
		}
		/** カーソルを座標へ置く。移動・押下・フォーカス追従で共通。 */
		function place(s, x, y, dur, fromFocus) {
			if (!attachCursor(s)) { return; }
			// マウス由来の配置はフォーカス追従より優先する（クリック直後に勝手にずれない）。
			if (!fromFocus) { s.mt = Date.now(); }
			// 撮影のために隠している間は絶対に出さない。別のペインが同じページを操作していると
			// ここで復活してしまい、進行中の撮影にカーソルが写る。
			if (!s.hid) { sx(s.h, { display: '' }); }
			var first = s.x === null;
			var tr = 'translate3d(' + x + 'px,' + y + 'px,0)';
			s.x = x; s.y = y;
			if (first || calm || !(dur > 0)) {
				sx(s.h, { transition: 'none', transform: tr });
				void s.h.offsetWidth;
				sx(s.h, { transition: calm ? 'none' : 'opacity 170ms ease', opacity: '1' });
			} else {
				sx(s.h, {
					transition: 'transform ' + dur + 'ms cubic-bezier(0.33,0.02,0.18,1), opacity 170ms ease',
					transform: tr, opacity: '1'
				});
			}
			arm(s, c.idleMs + (first ? 0 : dur));
		}
		function setLabel(s, label) {
			if (s.lb && s.t !== label) { s.t = label; s.lb.textContent = label; }
		}

		if (c.kind === 'move' || c.kind === 'press' || c.kind === 'focus') {
			var sm = state(true);
			if (!sm) { return 0; }
			if (c.kind === 'focus') {
				var fel = deepActive();
				var fp = pointOf(fel);
				if (!fp) { return 0; }
				if (!attachCursor(sm)) { return 0; }
				setLabel(sm, c.label);
				sm.fe = fel;
				place(sm, fp.x, fp.y, calm ? 0 : c.focusMs, true);
				return 0;
			}
			if (!attachCursor(sm)) { return 0; }
			setLabel(sm, c.label);
			if (c.kind === 'move') {
				place(sm, c.x, c.y, c.durationMs);
				return 0;
			}
			// press: 押した点そのものへ合わせてから波紋を出す。移動のコマンドが届いて
			// いなくてもクリックが無音にならないよう、ここでも作る。
			place(sm, c.x, c.y, 0);
			if (calm) { return 0; }
			try {
				sm.rp.animate(
					[{ transform: 'scale(0.35)', opacity: 0.75 }, { transform: 'scale(1.6)', opacity: 0 }],
					{ duration: c.rippleMs, easing: 'cubic-bezier(0.2,0.7,0.3,1)' }
				);
			} catch (e) { }
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
		if (c.kind === 'show') { s.hid = false; if (s.h) { sx(s.h, { display: '' }); } return 0; }
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

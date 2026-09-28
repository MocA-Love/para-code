// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * xterm.js を WebView に載せた読み取り用ターミナルビュー。
 * PCから届く生のANSIストリームをそのまま xterm に流すことで、claude / codex などの
 * TUI（カーソル制御・代替スクリーン・256色）も PC と同じように描画される。
 *
 * 2系統の描画モードを持つ:
 * - 同期ストリームモード（新PC）: subscribe 経由の snapshot/data イベントを WebView 内の
 *   xterm に直接適用する。snapshot は「reset→resize→unicode設定→write」を1回のinjectで
 *   原子的に行い、cols/rows・unicode幅版もsnapshotに同梱された値へ追従する。
 *   RN→WebView の inject には連番を付け、WebView側で欠落を検出したら onNeedResync で
 *   再attach（=snapshot再同期）を要求する（自己修復）。
 * - レガシーモード（旧PC）: output 文字列プロップの差分書き込み（従来動作）。
 *   同期ストリームの snapshot を一度でも受けたら以後 output は無視する。
 *
 * - xterm.js/css/unicode11 は assets/xterm/xtermBundle.json に vendor した文字列を HTML に
 *   埋め込む（オフラインで完結、CDN・ネイティブアセット読み込み不要）
 * - 寸法の決め方は2通り:
 *   - **追従モード（既定）**: cols/rows は PC 側ターミナルと同じ値に resize し、フォントサイズを
 *     画面幅に合わせて自動計算する（TUIはPCの端末寸法前提でレイアウトするため寸法一致が必須）。
 *     ただし `TERMINAL_FOLLOW_MIN_FONT_SIZE`（7pt 固定。理由は terminalViewport.ts）より小さくはしない。
 *     7pt でも入りきらないときだけ横スクロールにする。入りきらない分の見せ方は `fit()` の説明を読むこと。
 *     設定「文字サイズ」は追従モードでは使わない（固定モード専用）。
 *   - **固定モード（設定「スマホの幅に合わせる」オン）**: フォントサイズを先に決め、そこから
 *     何桁×何行入るかを逆算する。求めた寸法は `onGridChange` で上へ渡され、PCへ申告されて
 *     PTY自体がその寸法へ寄る。以後 PC から届く cols/rows は申告した値と一致するので、
 *     フォントを縮める必要がなくなる。
 * - 入力は使わない（既存のネイティブ入力バーから送る）。表示専用。
 * - iOSがメモリ圧でWebViewのコンテンツプロセスを落とした場合は自動reloadし、
 *   onNeedResync で最新snapshotを取り直す（画面状態はWebView内にしか無いため）。
 * - 出力の書き込みは 48ms の窓でまとめて inject する（`termWriteCoalescer.ts`）。inject の連番は
 *   まとめた単位で振る。snapshot・破棄・裏に回る直前は溜まった分を先に流す。
 * - 準備完了が 15 秒来なければ 1 回だけ読み直し、それでも来なければエラーと［再試行］を出す
 *   （`termReadyWatchdog.ts`。裏に回っている間は判定しない）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import xtermBundle from '../../assets/xterm/xtermBundle.json';
import type { TermStreamEvent } from '../store.js';
import { TERMINAL_FOLLOW_MIN_FONT_SIZE, TERMINAL_FONT_SIZE_MIN, terminalGridFor, type TerminalGrid } from '../terminalViewport.js';
import { colors } from '../theme.js';
import { EmptyState } from './emptyState.js';
import { createTermReadyWatchdog } from './termReadyWatchdog.js';
import { createTermWriteCoalescer } from './termWriteCoalescer.js';

interface TermViewProps {
	/** レガシーモード（旧PC）用: これまでに受信した出力バッファ全体（差分書き込みする）。 */
	output: string;
	/** stateチャネル由来の寸法（レガシーモード用。同期モードではsnapshot同梱値を優先）。 */
	cols?: number;
	rows?: number;
	/** 同期ストリームの購読（新PC）。購読時にリプレイキャッシュが同期再生される。 */
	subscribe?: (listener: (ev: TermStreamEvent) => void) => () => void;
	/** WebViewプロセス死・inject欠落などで再同期（再attach）が必要になったときに呼ばれる。 */
	onNeedResync?: () => void;
	/**
	 * 固定モードの文字サイズ（pt）。指定するとフォントを縮めるのをやめ、このサイズで
	 * 何桁×何行入るかを実測して `onGridChange` へ渡す。未指定なら従来の追従モード。
	 */
	fontSize?: number;
	/** 固定モードで実測したグリッド（追従モードでは `undefined`）。 */
	onGridChange?: (grid: TerminalGrid | undefined) => void;
	/**
	 * TUI（代替スクリーン）上のスワイプ。「どちらへ何行」だけを渡し、実際にどの
	 * シーケンスを送るかはPC側が決める（この端末のモードはPCのミラーでしかないため）。
	 */
	onScroll?: (dir: 'up' | 'down', lines: number) => void;
}

/** WebView から来るメッセージ（旧形式の 'ready' / 'desync' も引き続き受ける）。 */
type TermViewMessage =
	| { t: 'metrics'; width: number; height: number; charWidth100: number; lineHeight100: number; rowHeights?: Record<string, number> }
	| { t: 'scroll'; dir: 'up' | 'down'; lines: number }
	| { t: 'warn'; text: string };

/** WebView に流す HTML/CSS 用の地色。RN 側のスタイルは `colors.terminalBg`（同じ値）を使う。 */
const TERM_BG = '#1e1e1e';
/**
 * 1回のスワイプで送るスクロール行数の上限。速くなぞったときにPCへ大量のキーを
 * 撃ち込まないための歯止め（PC側の TERM_SCROLL_MAX_LINES と対）。
 */
const MAX_SCROLL_LINES_PER_GESTURE = 40;

function buildHtml(): string {
	return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${xtermBundle.css}</style>
<style>
	/* overflow: hidden で WebView 自体のページスクロールを封じる。xterm 自身の
	   .xterm-viewport は自前で overflow-y: scroll を持つので通常バッファのスクロールバックは
	   これで壊れない。無いと、寸法計算の端数などでごく僅かに横へはみ出しただけで
	   WebView のネイティブスクロールがその隙間を拾い、横方向にだけ意図せず動く
	   （代替バッファのスワイプは touchmove ハンドラが専有する設計なので、ページ自体が
	   動く余地を無くしておく）。 */
	html, body { margin: 0; padding: 0; background: ${TERM_BG}; height: 100%; overflow: hidden; }
	#wrap { padding: 4px; height: 100%; box-sizing: border-box; overflow: hidden; }
	/* 文字を下限より小さくできず、端末が表示領域に入りきらないときの見せ方（fit() の説明）。
	   横: #wrap だけを横スクロールにする。常時 auto にしないのは、上の body と同じく
	   端数ぶんのはみ出しで横へ動いてしまうのを避けるため（本当にはみ出すときだけクラスを付ける）。
	   横スクロール中はカーソルの列が見える位置へ寄せる（followCursor）。
	   縦: 下端（プロンプト行）に揃えて上側を切る。 */
	body.pan-x #wrap { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
	body.clip-top #wrap { display: flex; flex-direction: column; justify-content: flex-end; }
	body.clip-top #term { flex: none; }
	.xterm .xterm-viewport { background-color: ${TERM_BG} !important; }
</style>
</head><body><div id="wrap"><div id="term"></div></div>
<script>${xtermBundle.js}</script>
<script>${xtermBundle.unicode11Js}</script>
<script>
(function () {
	// 開発ビルドだけ: xterm は描く面が画面と重なっていないと IntersectionObserver から知らされると
	// 描画を止め、重なったと知らされるまで溜める（RenderService の _handleIntersectionChange）。
	// 「キーボードを出している間だけ真っ黒で、閉じると出る」報告の原因候補なので、止められたら
	// RN 側へ警告を送る（console.warn で Metro のログに出る）。本番の動きは変えない。
	if (${__DEV__ ? 'true' : 'false'} && typeof window.IntersectionObserver === 'function') {
		var NativeIntersectionObserver = window.IntersectionObserver;
		window.IntersectionObserver = function (callback, options) {
			return new NativeIntersectionObserver(function (entries, observer) {
				var last = entries[entries.length - 1];
				if (last && !last.isIntersecting) {
					window.ReactNativeWebView.postMessage(JSON.stringify({
						t: 'warn',
						text: 'xterm paused rendering: not intersecting the viewport (root ' + JSON.stringify(last.rootBounds) + ', target ' + JSON.stringify(last.boundingClientRect) + ')',
					}));
				}
				callback(entries, observer);
			}, options);
		};
	}
	var term = new Terminal({
		cols: 80, rows: 24,
		disableStdin: true,
		scrollback: 5000,
		fontFamily: 'Menlo, monospace',
		fontSize: 11,
		theme: { background: '${TERM_BG}' },
	});
	// PC側（VS Code）は既定で Unicode 11 の文字幅で描画する。モバイルも同じ幅表に
	// しないと絵文字・一部CJK記号の桁数が食い違い、行レイアウトがずれる。
	// アドオンが欠けていても端末表示自体は生かす（幅一致より表示継続を優先）。
	try {
		term.loadAddon(new Unicode11Addon.Unicode11Addon());
		term.unicode.activeVersion = '11';
	} catch (e) { /* 古い/破損バンドル: Unicode 6 幅のまま続行 */ }
	var wrapEl = document.getElementById('wrap');
	var termEl = document.getElementById('term');
	term.open(termEl);
	var currentCols = 80;
	var currentRows = 24;
	// RN→WebView の inject 連番。欠落（=injectの取りこぼし）を検出したら desync を
	// 通知して再同期してもらう。snapshot 適用で連番は張り直される。
	var injectSeq = 0;
	var desynced = false;
	function checkSeq(n) {
		if (desynced) {
			return false;
		}
		if (n !== injectSeq + 1) {
			desynced = true;
			window.ReactNativeWebView.postMessage('desync');
			return false;
		}
		injectSeq = n;
		return true;
	}
	// 固定モードの文字サイズ（pt）。0 なら追従モード（従来どおりフォントを縮めて収める）。
	var pinnedFontSize = 0;
	// 追従モードで縮める下限（pt）。固定値（terminalViewport.ts の TERMINAL_FOLLOW_MIN_FONT_SIZE）。
	var followFloor = ${TERMINAL_FOLLOW_MIN_FONT_SIZE};
	// 横スクロール中か（applyOverflow が決める）と、そのときの1桁ぶんの幅（px）。
	var panningX = false;
	var cellWidthPx = 0;
	// 利用者が横へ動かしている最中・直後は、カーソルへ寄せない（見たい所から引き戻さない）。
	var userPanning = false;
	var userPanUntil = 0;
	// フォントの実寸を測る（100px時の1文字送りと行送り）。フォント・OS・端末で変わるため、
	// 定数ではなく毎回測る。
	function measure() {
		var probe = document.createElement('span');
		probe.style.fontFamily = 'Menlo, monospace';
		probe.style.fontSize = '100px';
		probe.style.lineHeight = 'normal';
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		probe.style.whiteSpace = 'pre';
		probe.textContent = 'WWWWWWWWWW';
		document.body.appendChild(probe);
		var rect = probe.getBoundingClientRect();
		document.body.removeChild(probe);
		return {
			charWidth100: rect.width / 10,
			// フォントの自然な行送り（100px時）。xtermの実セル高は行送りにほぼ比例するため、
			// 実レンダラの寸法を取得しなくてもこの比率で十分近似できる。
			lineHeight100: rect.height,
		};
	}
	// xterm が実際に描く1行の高さ（px）。**lineHeight100 の比例にはならない**ので、行数を決めるときはこちらを使う。
	//
	// xterm（DOM レンダラ）は文字の高さを canvas の measureText の fontBoundingBoxAscent + Descent
	// （使えなければ測り用の span の offsetHeight）で取り、画面の画素へ切り上げ（ceil(高さ × dpr)）、
	// 行の高さ（lineHeight 1）を掛けて切り捨てた値を1行にする（バンドルの CharSizeService と
	// DomRenderer._updateDimensions）。ここはその計算を同じ API でなぞる。xterm を更新したら、
	// 実際の行の高さ（.xterm-rows の子の高さ）と一致するかを確かめ直すこと。
	//
	// 見積もり（lineHeight: normal）との差は小さいが、行数ぶん積み上がる。iPad の 12pt では
	// 見積もり 14.04px に対して実際は 15px で、68行では 54px（3行半）が下にはみ出していた。
	var rowMeasureCtx = null;
	try {
		rowMeasureCtx = new OffscreenCanvas(100, 100).getContext('2d');
		var rowProbeText = rowMeasureCtx.measureText('W');
		if (!('fontBoundingBoxAscent' in rowProbeText) || !('fontBoundingBoxDescent' in rowProbeText)) {
			rowMeasureCtx = null;
		}
	} catch (e) { rowMeasureCtx = null; }
	function rowHeightAt(size) {
		var h = 0;
		if (rowMeasureCtx) {
			rowMeasureCtx.font = size + 'px ' + term.options.fontFamily;
			var tm = rowMeasureCtx.measureText('W');
			h = tm.fontBoundingBoxAscent + tm.fontBoundingBoxDescent;
		}
		if (!(h > 0)) {
			var span = document.createElement('span');
			span.style.fontFamily = term.options.fontFamily;
			span.style.fontSize = size + 'px';
			span.style.whiteSpace = 'pre';
			span.style.position = 'absolute';
			span.style.visibility = 'hidden';
			span.textContent = 'W';
			document.body.appendChild(span);
			h = span.offsetHeight;
			document.body.removeChild(span);
		}
		var dpr = window.devicePixelRatio || 1;
		return Math.floor(Math.ceil(h * dpr) * (term.options.lineHeight || 1)) / dpr;
	}
	// rows 行ぶんの高さ（xterm は全体の高さを CSS の px へ丸めて描く）。
	function rowsHeightAt(rows, size) {
		return Math.round(rows * rowHeightAt(size));
	}
	// RN へ渡す行の高さの表（文字サイズごと）。設定で選べる範囲と、追従モードで広い画面が使う大きさまで。
	var ROW_TABLE_MAX = 26;
	function rowHeightTable() {
		var table = {};
		for (var size = ${TERMINAL_FONT_SIZE_MIN}; size <= ROW_TABLE_MAX; size++) {
			table[size] = rowHeightAt(size);
		}
		return table;
	}
	// 表示領域の実測値をRNへ送る。固定モードではRN側がここから桁数・行数を決める
	// （計算をRN側に置くことで、WebViewを起動せずに境界の挙動をテストできる）。
	//
	// 回転・キーボード開閉の resize は連続で飛んでくる。1発ごとに報告すると、そのたびに
	// PTYのリサイズ（SIGWINCH → TUIの全画面再描画）とスナップショット再送まで波及するため、
	// 収まってから1回だけ送る。
	var metricsTimer = 0;
	function reportMetricsSoon() {
		clearTimeout(metricsTimer);
		metricsTimer = setTimeout(reportMetrics, 180);
	}
	// 開発ビルドだけ: rowHeightAt（xterm の計算を写したもの）が、xterm が実際に描いた行の高さと
	// 食い違っていないかを確かめる。xterm を更新して計算が変わると行数の見積もりが黙ってずれ、
	// また下の行が隠れるので、0.5px 以上ずれたら RN 側へ警告を送る（console.warn で Metro のログに出る）。
	var checkRowHeight = ${__DEV__ ? 'true' : 'false'};
	function verifyRowHeight() {
		var row = document.querySelector('.xterm-rows > div');
		if (!row) {
			return;
		}
		var actual = row.getBoundingClientRect().height;
		var expected = rowHeightAt(term.options.fontSize);
		if (actual > 0 && Math.abs(actual - expected) >= 0.5) {
			window.ReactNativeWebView.postMessage(JSON.stringify({
				t: 'warn',
				text: 'row height mismatch: xterm draws ' + actual + 'px but rowHeightAt(' + term.options.fontSize + ') = ' + expected + 'px. Re-check rowHeightAt against the bundled xterm.',
			}));
		}
	}
	function reportMetrics() {
		if (checkRowHeight) {
			verifyRowHeight();
		}
		var m = measure();
		window.ReactNativeWebView.postMessage(JSON.stringify({
			t: 'metrics',
			width: document.documentElement.clientWidth - 10,
			height: document.documentElement.clientHeight - 10,
			charWidth100: m.charWidth100,
			lineHeight100: m.lineHeight100,
			rowHeights: rowHeightTable(),
		}));
	}
	// PCと同じ cols/rows を維持したまま画面に収まるフォントサイズを実測ベースで求める。
	// 幅だけで決めると、キーボード表示等でWebViewの高さが縮んでも行数×行高は
	// 変わらないため、上部が画面外に押し出されてしまう。幅ベース・高さベース
	// それぞれで算出したフォントサイズの小さい方を採用し、両軸に収める。
	//
	// **ただし下限（7pt）より小さくはしない。** 以前は下限が4ptで、PCが150桁だとiPhoneでは読めない
	// 大きさまで潰れた。下限に当たって入りきらない分は、次のように見せる（applyOverflow）:
	//  - 横: 端末を横スクロールさせ、カーソルの列が見える位置へ寄せる（followCursor）。
	//    **折り返し（桁数をこちらで減らす）はしない。** PCのPTYは
	//    PCの桁数前提でカーソル位置を指定して描くので、xterm の桁数を変えると claude / codex の
	//    TUI も、シェルのプロンプト行の書き換えも崩れる（寸法一致が必須なのは冒頭の説明のとおり）
	//  - 縦: 下端（プロンプト行）に揃えて上側を切る。RN側でキーボードを出したときと同じ見せ方。
	//    縦スクロールにしないのは、通常バッファでは xterm 自身のスクロールバック、代替バッファでは
	//    PCへのスクロール送出（下の touchmove）が同じ縦の指の動きを使っているため
	// どちらも起きないようにするには、PC側の桁数をこの画面に合わせる（設定「スマホの幅に合わせる」）。
	function fit(cols, rows) {
		var m = measure();
		var charWidthAt100 = m.charWidth100;
		var lineHeightAt100 = m.lineHeight100;
		var availWidth = document.documentElement.clientWidth - 10;
		var availHeight = document.documentElement.clientHeight - 10;
		var fontSizeByWidth = Math.floor(100 * availWidth / (charWidthAt100 * cols));
		var fontSize = fontSizeByWidth;
		if (rows > 0) {
			var fontSizeByHeight = Math.floor(100 * availHeight / (lineHeightAt100 * rows));
			fontSize = Math.min(fontSizeByWidth, fontSizeByHeight);
		}
		var size;
		if (pinnedFontSize > 0) {
			// 固定モードでは選んだ文字サイズのまま描く。PCが寸法を合わせてくれていれば計算値は
			// 必ず選んだサイズ以上になる（その寸法に収まるよう桁数を決めたため）。PCが古くて
			// 寸法を合わせられない場合は、以前は縮めて収めていたが、いまは追従モードと同じく
			// 縮めずにはみ出し側の見せ方へ任せる（選んだ大きさより小さくすると読めなくなるため）。
			size = pinnedFontSize;
		} else {
			// 上限は画面の広さで変える。iPhone幅（<700px）はこれまで通り16ptで頭打ちにし、
			// iPadの広い幅では上限に張り付いて右側に黒帯が残らないところまで許す
			// （PC側のcols/rowsは変えられないので、埋められるのは文字を大きくする方向だけ）。
			var maxFontSize = availWidth >= 700 ? ROW_TABLE_MAX : 16;
			size = Math.max(followFloor, Math.min(maxFontSize, fontSize));
			// 高さで決めた大きさは見積もりの行送りによる。実際の行の高さで入りきらなければ1pt ずつ下げる
			// （入りきらないまま下限に当たったら、applyOverflow が上側を切って下端を見せる）。
			while (rows > 0 && size > followFloor && rowsHeightAt(rows, size) > availHeight + 2) {
				size--;
			}
		}
		term.options.fontSize = size;
		applyOverflow(cols, rows, size, m, availWidth, availHeight);
	}
	// 下限に当たって入りきらないときだけ、横スクロール／上側の切り落としを有効にする。
	// 寸法は描画を待たずに計算で出す（xterm の再描画は非同期なので DOM を測ると1拍遅れる）。
	// 端数ぶんのはみ出し（2px 以内）では何もしない。
	function applyOverflow(cols, rows, size, m, availWidth, availHeight) {
		var needWidth = Math.ceil(cols * m.charWidth100 / 100 * size);
		var panX = needWidth > availWidth + 2;
		var clipTop = rows > 0 && rowsHeightAt(rows, size) > availHeight + 2;
		document.body.classList.toggle('pan-x', panX);
		document.body.classList.toggle('clip-top', clipTop);
		// 横にはみ出すときは器の幅を端末の幅まで広げ、#wrap の横スクロールで見せる。
		// 実際のセル幅と数px違っても、はみ出た子孫もスクロール範囲に入るので欠けない。
		termEl.style.width = panX ? (needWidth + 2) + 'px' : '';
		panningX = panX;
		cellWidthPx = m.charWidth100 / 100 * size;
		if (!panX) {
			wrapEl.scrollLeft = 0;
		} else {
			followCursor();
		}
	}
	// 横スクロール中は、カーソルの列が見えていなければ見える位置まで寄せる。左右に数桁の余白を残す。
	// 既定の表示位置（左端）のままだと、入力中の行末やTUIの入力欄が画面の外に隠れる。
	var FOLLOW_MARGIN_COLS = 4;
	function followCursor() {
		if (!panningX || cellWidthPx <= 0 || userPanning || Date.now() < userPanUntil) {
			return;
		}
		// #wrap の padding（4px）ぶんを足した、カーソルの左端・右端（#wrap の中の座標）。
		var left = 4 + term.buffer.active.cursorX * cellWidthPx;
		var right = left + cellWidthPx;
		var margin = FOLLOW_MARGIN_COLS * cellWidthPx;
		var viewLeft = wrapEl.scrollLeft;
		var viewWidth = wrapEl.clientWidth;
		if (left - margin < viewLeft) {
			wrapEl.scrollLeft = Math.max(0, left - margin);
		} else if (right + margin > viewLeft + viewWidth) {
			wrapEl.scrollLeft = right + margin - viewWidth;
		}
	}
	wrapEl.addEventListener('touchstart', function () { userPanning = true; }, { passive: true });
	function endUserPan() {
		userPanning = false;
		// 指を離したあとも慣性で動き、見たい所を読む時間も要る。しばらくは寄せない。
		userPanUntil = Date.now() + 3000;
	}
	wrapEl.addEventListener('touchend', endUserPan, { passive: true });
	wrapEl.addEventListener('touchcancel', endUserPan, { passive: true });
	window.__para = {
		resize: function (cols, rows) {
			currentCols = cols;
			currentRows = rows;
			fit(cols, rows);
			term.resize(cols, rows);
			term.scrollToBottom();
		},
		// 固定モードへ入る／文字サイズを変える。cols/rows はRN側が実測から決めた値。
		// PCが申告を受けて寸法を合わせるまでの間は、この先読みで描いておく（PCから届く
		// スナップショットの寸法が正なので、食い違っている間はそちらが優先される）。
		pin: function (fontSize, cols, rows) {
			pinnedFontSize = fontSize;
			currentCols = cols;
			currentRows = rows;
			if (cols !== term.cols || rows !== term.rows) {
				term.resize(cols, rows);
			}
			fit(cols, rows);
			term.scrollToBottom();
		},
		// 追従モードへ戻す（設定オフ）。次に届く寸法でフォントを計算し直す。
		unpin: function () {
			pinnedFontSize = 0;
			fit(currentCols, currentRows);
			term.scrollToBottom();
		},
		metrics: reportMetrics,
		write: function (n, data) {
			if (!checkSeq(n)) {
				return;
			}
			term.write(data, function () { term.scrollToBottom(); followCursor(); });
		},
		// snapshot: バッファ全体の置き換え。reset→unicode→resize→write を原子的に行い、
		// inject 連番もここで張り直す（desync からの復帰点でもある）。
		snapshot: function (n, data, cols, rows, unicode) {
			injectSeq = n;
			desynced = false;
			try {
				if (unicode && term.unicode.versions.indexOf(unicode) >= 0) {
					term.unicode.activeVersion = unicode;
				}
			} catch (e) { /* 幅版の切替失敗は表示継続を優先 */ }
			term.reset();
			// 画面の丸ごと置き換え（ターミナルへ付け直したとき）。横の位置は左端から始め直し、
			// 書き終えたらカーソルへ寄せる。ターミナルの切り替えは TermView ごと作り直す（key）ので
			// そちらも左端から始まる。
			wrapEl.scrollLeft = 0;
			userPanUntil = 0;
			if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) {
				currentCols = cols;
				currentRows = rows;
				fit(cols, rows);
				term.resize(cols, rows);
			}
			term.write(data, function () { term.scrollToBottom(); followCursor(); });
		},
		reset: function () { term.reset(); },
	};
	// --- 代替スクリーン（TUI）のスワイプスクロール ---
	//
	// xterm 自身もタッチスクロールに対応していて、代替バッファでは矢印キーへ変換して
	// 送ろうとする（MouseService の _handleTouchScrollAsKeys）。ところがこの端末は
	// disableStdin: true で作っているため、その送出は CoreService.triggerDataEvent の
	// 入口で捨てられ、何も起きない。表示専用という設計は変えたくないので、代替バッファの
	// ときだけ自前でスワイプを拾い、「どちらへ何行」だけを上へ渡す。
	//
	// **どのシーケンスを送るかはここでは決めない**。この xterm が持つモードは PC の
	// ミラーでしかなく、再同期の谷間では古い値になりうるうえ、マウスレポートの
	// エンコーディングは公開APIから読めない。判断は本物の端末を持つPC側に任せる。
	//
	// 通常バッファには手を出さない。そちらは xterm が自分のビューポートをスクロールでき、
	// PCへ送る必要もない。
	var touchLastY = 0;
	var touchAccum = 0;
	var touchTracking = false;
	var touchSentLines = 0;
	function cellHeightPx() {
		var rows = term.rows > 0 ? term.rows : 1;
		var screen = document.querySelector('.xterm-screen');
		return screen ? screen.getBoundingClientRect().height / rows : 0;
	}
	/** いま自前で扱うべきか（代替バッファ＝スクロールバックが無い画面のときだけ）。 */
	function shouldHandleTouchScroll() {
		return term.buffer.active.type === 'alternate';
	}
	document.addEventListener('touchstart', function (ev) {
		touchTracking = ev.touches.length === 1;
		touchAccum = 0;
		touchSentLines = 0;
		if (touchTracking) {
			touchLastY = ev.touches[0].clientY;
		}
	}, { passive: true });
	document.addEventListener('touchmove', function (ev) {
		if (!touchTracking || ev.touches.length !== 1) {
			return;
		}
		var y = ev.touches[0].clientY;
		var dy = y - touchLastY;
		touchLastY = y;
		// 指を離すまでの間にTUIが終了して通常バッファへ戻ることがある。毎回見る。
		if (!shouldHandleTouchScroll()) {
			touchAccum = 0;
			return;
		}
		// 指を下げる = 前の行を見に行く = 上スクロール（ネイティブの慣性方向に合わせる）。
		touchAccum += dy;
		var cellH = cellHeightPx();
		if (cellH <= 0) {
			return;
		}
		var lines = Math.trunc(touchAccum / cellH);
		if (lines === 0) {
			return;
		}
		touchAccum -= lines * cellH;
		// 1ジェスチャで送る総量を抑える（速いスワイプでPCへ大量のキーを撃ち込まない）。
		var remaining = ${MAX_SCROLL_LINES_PER_GESTURE} - touchSentLines;
		var count = Math.min(Math.abs(lines), remaining);
		if (count <= 0) {
			return;
		}
		touchSentLines += count;
		window.ReactNativeWebView.postMessage(JSON.stringify({
			t: 'scroll', dir: lines > 0 ? 'up' : 'down', lines: count,
		}));
	}, { passive: true });
	function endTouch() { touchTracking = false; }
	document.addEventListener('touchend', endTouch, { passive: true });
	// 着信バナーやシステムジェスチャに奪われると touchend が来ない。
	document.addEventListener('touchcancel', endTouch, { passive: true });

	// キーボード開閉・回転などでWebViewの高さが変わったら、フォントを合わせ直した上で
	// 最下部（プロンプト行）が見える位置までスクロールする。固定モードでは新しい表示領域を
	// RNへ報告し、桁数・行数を決め直してもらう（PCへの再申告もRN側が行う）。
	window.addEventListener('resize', function () {
		fit(currentCols, currentRows);
		term.scrollToBottom();
		reportMetricsSoon();
	});
	window.ReactNativeWebView.postMessage('ready');
	reportMetrics();
})();
</script></body></html>`;
}

/**
 * WebViewへ渡す `source`。**モジュールに1つだけ作って使い回す。**
 *
 * 中身は xterm.js のバンドルを丸ごと埋めた約41万文字で、**`source` のオブジェクトが
 * 変わるたびにHermesの文字列がC++のstd::stringへ丸ごと複製される**（react-native-webview
 * は毎レンダー `source` を組み直し、Fabricのstring propとして渡す）。以前はこれを
 * コンポーネントの中で `useMemo(() => buildHtml(), [])` していたため、端末ごとに1回では
 * なく**この画面が再レンダーするたび**に41万文字の変換がJSスレッドで走っていた。
 * PCからの再送は最大10Hzなので秒間4〜8MBに達し、画面遷移が数百ms止まる主因だった。
 *
 * `buildHtml()` は引数を1つも取らない純粋関数なので、ここで1回だけ作って参照を固定する。
 * 最初にターミナルを描くときまで作らないのは、起動時の負荷に足さないため。
 */
let termSource: { readonly html: string } | undefined;
function termHtmlSource(): { readonly html: string } {
	termSource ??= { html: buildHtml() };
	return termSource;
}

export function TermView({ output, cols, rows, subscribe, onNeedResync, fontSize, onGridChange, onScroll }: TermViewProps) {
	const webRef = useRef<WebView>(null);
	const [ready, setReady] = useState(false);
	const writtenRef = useRef('');
	// 同期ストリームのsnapshotを受けたら true（以後レガシーの output プロップは無視）。
	const streamModeRef = useRef(false);
	// RN→WebView の inject 連番（WebView側の欠落検出と対）。
	const injectSeqRef = useRef(0);
	// WebView の ready 前に届いた同期イベントのキュー（ready後に順番に適用する）。
	const pendingRef = useRef<TermStreamEvent[]>([]);
	const readyRef = useRef(false);
	const firstReadyRef = useRef(true);
	const onNeedResyncRef = useRef(onNeedResync);
	onNeedResyncRef.current = onNeedResync;
	const onGridChangeRef = useRef(onGridChange);
	onGridChangeRef.current = onGridChange;
	const onScrollRef = useRef(onScroll);
	onScrollRef.current = onScroll;
	// WebView が最後に報告した表示領域とフォント実寸（回転・キーボード開閉のたびに更新される）。
	const metricsRef = useRef<{ width: number; height: number; charWidth100: number; lineHeight100: number; rowHeights?: Record<string, number> } | undefined>(undefined);
	// 固定モードで最後に適用したグリッド（同じ値の再適用・再申告を避ける）。
	const gridRef = useRef<TerminalGrid | undefined>(undefined);

	const inject = (script: string) => {
		webRef.current?.injectJavaScript(`${script}; true;`);
	};

	// 出力のまとめ役。流す単位 1 つが inject 1 回で、連番もこの単位で振る（WebView 側の欠落検出と対）。
	const coalescerRef = useRef<ReturnType<typeof createTermWriteCoalescer> | undefined>(undefined);
	coalescerRef.current ??= createTermWriteCoalescer(data => {
		const n = ++injectSeqRef.current;
		inject(`window.__para.write(${n}, ${JSON.stringify(data)})`);
	});
	const coalescer = coalescerRef.current;

	// 準備完了の見張り。時間切れで 1 回だけ読み直し、だめならエラーと［再試行］を出す。
	const [loadFailed, setLoadFailed] = useState(false);
	/** WebView を読み直す。画面は WebView の中にしか無いので、準備完了の後に snapshot を取り直す。 */
	const reloadWebView = () => {
		readyRef.current = false;
		setReady(false);
		coalescer.clear();
		webRef.current?.reload();
	};
	const watchdogRef = useRef<ReturnType<typeof createTermReadyWatchdog> | undefined>(undefined);
	watchdogRef.current ??= createTermReadyWatchdog({
		isForeground: () => AppState.currentState === 'active',
		reload: reloadWebView,
		fail: () => setLoadFailed(true),
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	});
	const watchdog = watchdogRef.current;
	useEffect(() => {
		watchdog.arm();
		return () => {
			watchdog.dispose();
			coalescer.clear();
		};
	}, [watchdog, coalescer]);
	const retryLoad = () => {
		setLoadFailed(false);
		watchdog.retry();
	};

	// 裏に回る直前に溜まった分を流す（戻ったときに、止まる前の出力が欠けて見えないように）。
	useEffect(() => {
		const subscription = AppState.addEventListener('change', state => {
			if (state !== 'active') {
				coalescer.flushNow();
			}
		});
		return () => subscription.remove();
	}, [coalescer]);

	/**
	 * 実測値と設定から固定モードの寸法を決め、WebViewへ適用して上へ通知する。
	 * 追従モードのときは固定を解除し、`undefined` を通知する（PCへの申告も取り下げられる）。
	 */
	const applyPinnedGrid = useCallback(() => {
		const metrics = metricsRef.current;
		if (fontSize === undefined || metrics === undefined) {
			if (gridRef.current !== undefined) {
				gridRef.current = undefined;
				inject('window.__para.unpin()');
			}
			onGridChangeRef.current?.(undefined);
			return;
		}
		const grid = terminalGridFor(metrics.width, metrics.height, fontSize, metrics);
		if (grid === undefined) {
			return;
		}
		const previous = gridRef.current;
		if (previous?.cols === grid.cols && previous.rows === grid.rows) {
			// 寸法は同じでも文字サイズだけ変わり得る（設定変更直後）。適用は毎回通す。
			inject(`window.__para.pin(${fontSize}, ${grid.cols}, ${grid.rows})`);
			return;
		}
		gridRef.current = grid;
		inject(`window.__para.pin(${fontSize}, ${grid.cols}, ${grid.rows})`);
		onGridChangeRef.current?.(grid);
	}, [fontSize]);
	// WebView要素は端末ごとに1回だけ作るので（下の `webView`）、そこから呼ぶものはrefで受ける。
	// 直に閉じ込めると `fontSize` が変わるたびに要素が作り直され、41万文字の再変換を招く
	// ——しかも `fontSize` はタブの出入りで出し入れされるので、いちばん混んでいる瞬間に当たる。
	const applyPinnedGridRef = useRef(applyPinnedGrid);
	applyPinnedGridRef.current = applyPinnedGrid;

	// 設定（文字サイズ・モード）が変わったら、いまの実測値で決め直す。
	useEffect(() => {
		if (ready) {
			applyPinnedGrid();
		}
	}, [ready, applyPinnedGrid]);

	const applyStreamEvent = (ev: TermStreamEvent) => {
		if (ev.kind === 'exit') {
			return; // 端末終了は state 側でタブごと消える（画面はそのまま）
		}
		if (typeof ev.data !== 'string') {
			return;
		}
		if (ev.kind === 'snapshot') {
			// 溜まった分を先に流してから置き換える（順序を崩さない。流した分は reset で消える）。
			coalescer.flushNow();
			streamModeRef.current = true;
			const n = ++injectSeqRef.current;
			inject(`window.__para.snapshot(${n}, ${JSON.stringify(ev.data)}, ${ev.cols ?? 0}, ${ev.rows ?? 0}, ${JSON.stringify(ev.unicode ?? '')})`);
		} else {
			coalescer.write(ev.data);
		}
	};

	// 同期ストリームの購読。ready 前のイベントはキューに溜め、ready 後に順番に適用する。
	useEffect(() => {
		if (!subscribe) {
			return;
		}
		return subscribe(ev => {
			if (readyRef.current) {
				applyStreamEvent(ev);
			} else {
				if (ev.kind === 'snapshot') {
					pendingRef.current = []; // snapshotが置き換えるので、それ以前は不要
				}
				pendingRef.current.push(ev);
			}
		});
		// applyStreamEvent はrefのみ参照で安定。subscribe は端末ごとのマウント（key=id）で固定。
	}, [subscribe]);

	// レガシーモード: stateチャネル由来の cols/rows への追従。
	useEffect(() => {
		if (!ready || !cols || !rows || streamModeRef.current) {
			return;
		}
		inject(`window.__para.resize(${cols}, ${rows})`);
	}, [ready, cols, rows]);

	// レガシーモード: output 文字列の差分書き込み。同期ストリームが動き出したら無視する。
	useEffect(() => {
		if (!ready || streamModeRef.current) {
			return;
		}
		const written = writtenRef.current;
		if (output === written) {
			return;
		}
		// 前回書き込み分の続きなら差分だけ流す。バッファのトリム等で先頭が変わったら書き直す。
		// レガシー経路は連番検証をしない（injectSeq は同期モード専用。write の第1引数は
		// WebView 側 checkSeq を通すため、レガシーでも連番を進める）。
		if (written.length > 0 && output.startsWith(written)) {
			coalescer.write(output.slice(written.length));
		} else {
			// 書き直しの前に溜まった差分を流す（reset の後に古い差分が届かないように）。
			coalescer.flushNow();
			const n = ++injectSeqRef.current;
			inject(`window.__para.reset(); window.__para.write(${n}, ${JSON.stringify(output)})`);
		}
		writtenRef.current = output;
	}, [ready, output]);

	// **WebView要素は端末ごとに1回だけ作る。** `source` に41万文字が載っているため、要素を
	// 作り直すとそのぶんの文字列変換がJSスレッドで走る（`termHtmlSource` の説明を読むこと）。
	// 中で使うものは全てref経由か安定した参照なので、依存は空でよい。`applyStreamEvent` も
	// refしか触らないので初回の参照を捕まえたままで正しい（購読側の :438 と同じ理由）。
	const webView = useMemo(() => (
		<WebView
			ref={webRef}
			style={styles.web}
			source={termHtmlSource()}
			originWhitelist={['*']}
			javaScriptEnabled
			scrollEnabled
			bounces={false}
			hideKeyboardAccessoryView
			keyboardDisplayRequiresUserAction
			onContentProcessDidTerminate={() => {
				// iOSがメモリ圧でコンテンツプロセスを落とした。画面状態はWebView内にしか
				// 無いため、reloadして ready を待ち、再attach（snapshot再同期）で復旧する。
				reloadWebView();
				watchdog.arm();
			}}
			onMessage={event => {
				// 実測値の報告はJSON。旧形式の 'ready' / 'desync' と混ざらないよう先頭で振り分ける。
				if (event.nativeEvent.data.startsWith('{')) {
					let msg: TermViewMessage;
					try {
						msg = JSON.parse(event.nativeEvent.data) as TermViewMessage;
					} catch {
						return;
					}
					if (msg.t === 'metrics') {
						metricsRef.current = msg;
						applyPinnedGridRef.current();
					} else if (msg.t === 'scroll' && (msg.dir === 'up' || msg.dir === 'down') && msg.lines > 0) {
						onScrollRef.current?.(msg.dir, msg.lines);
					} else if (msg.t === 'warn' && __DEV__) {
						console.warn('[termView]', msg.text);
					}
					return;
				}
				if (event.nativeEvent.data === 'ready') {
					watchdog.ready();
					setLoadFailed(false);
					// 読み直す前のページ宛てに溜まっていた分は、新しいページには流さない（snapshot で取り直す）。
					coalescer.clear();
					writtenRef.current = '';
					injectSeqRef.current = 0;
					readyRef.current = true;
					setReady(true);
					if (firstReadyRef.current) {
						firstReadyRef.current = false;
						// 購読時に再生されたリプレイキャッシュ（ready前のキュー）を適用する。
						const queued = pendingRef.current;
						pendingRef.current = [];
						for (const ev of queued) {
							applyStreamEvent(ev);
						}
					} else {
						// reload後（プロセス死など）: WebView内の画面は失われている。
						// キューは捨てて最新snapshotを取り直す。
						pendingRef.current = [];
						if (streamModeRef.current) {
							onNeedResyncRef.current?.();
						}
					}
				} else if (event.nativeEvent.data === 'desync') {
					// inject の取りこぼし検出。再attachで snapshot から復旧する。
					onNeedResyncRef.current?.();
				}
			}}
		/>
	), []);

	// WebView は常に同じ位置に置き、失敗の表示はその上に重ねるだけにする（木の形を変えると WebView が作り直される）。
	return (
		<View style={styles.root}>
			{webView}
			{loadFailed ? (
				<View style={styles.failed}>
					<EmptyState
						icon="alert-circle-outline"
						title="ターミナルを表示できませんでした"
						message="画面の読み込みが終わりませんでした。［再試行］で読み込み直します。"
						action={{ label: '再試行', onPress: retryLoad }}
					/>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: colors.terminalBg },
	web: { flex: 1, backgroundColor: colors.terminalBg },
	failed: {
		...StyleSheet.absoluteFill,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.terminalBg,
	},
});

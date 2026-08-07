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
 *     PCが150桁だとフォントが下限の4ptまで潰れる。
 *   - **固定モード（設定「スマホの幅に合わせる」オン）**: フォントサイズを先に決め、そこから
 *     何桁×何行入るかを逆算する。求めた寸法は `onGridChange` で上へ渡され、PCへ申告されて
 *     PTY自体がその寸法へ寄る。以後 PC から届く cols/rows は申告した値と一致するので、
 *     フォントを縮める必要がなくなる。
 * - 入力は使わない（既存のネイティブ入力バーから送る）。表示専用。
 * - iOSがメモリ圧でWebViewのコンテンツプロセスを落とした場合は自動reloadし、
 *   onNeedResync で最新snapshotを取り直す（画面状態はWebView内にしか無いため）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import xtermBundle from '../../assets/xterm/xtermBundle.json';
import type { TermStreamEvent } from '../store.js';
import { terminalGridFor, type TerminalGrid } from '../terminalViewport.js';

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
	| { t: 'metrics'; width: number; height: number; charWidth100: number; lineHeight100: number }
	| { t: 'scroll'; dir: 'up' | 'down'; lines: number };

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
	html, body { margin: 0; padding: 0; background: ${TERM_BG}; height: 100%; }
	#wrap { padding: 4px; height: 100%; box-sizing: border-box; }
	.xterm .xterm-viewport { background-color: ${TERM_BG} !important; }
</style>
</head><body><div id="wrap"></div>
<script>${xtermBundle.js}</script>
<script>${xtermBundle.unicode11Js}</script>
<script>
(function () {
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
	term.open(document.getElementById('wrap'));
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
	function reportMetrics() {
		var m = measure();
		window.ReactNativeWebView.postMessage(JSON.stringify({
			t: 'metrics',
			width: document.documentElement.clientWidth - 10,
			height: document.documentElement.clientHeight - 10,
			charWidth100: m.charWidth100,
			lineHeight100: m.lineHeight100,
		}));
	}
	// PCと同じ cols/rows を維持したまま画面に収まるフォントサイズを実測ベースで求める。
	// 幅だけで決めると、キーボード表示等でWebViewの高さが縮んでも行数×行高は
	// 変わらないため、上部が画面外に押し出されてしまう。幅ベース・高さベース
	// それぞれで算出したフォントサイズの小さい方を採用し、両軸に収める。
	function fit(cols, rows) {
		var m = measure();
		var charWidthAt100 = m.charWidth100;
		var lineHeightAt100 = m.lineHeight100;
		var availWidth = document.documentElement.clientWidth - 10;
		var fontSizeByWidth = Math.floor(100 * availWidth / (charWidthAt100 * cols));
		var fontSize = fontSizeByWidth;
		if (rows > 0) {
			var availHeight = document.documentElement.clientHeight - 10;
			var fontSizeByHeight = Math.floor(100 * availHeight / (lineHeightAt100 * rows));
			fontSize = Math.min(fontSizeByWidth, fontSizeByHeight);
		}
		// 固定モードでは選んだ文字サイズを**上限**として扱う。PCが寸法を合わせてくれていれば
		// 計算値は必ず選んだサイズ以上になる（その寸法に収まるよう桁数を決めたため）ので、
		// そのまま選んだサイズが使われる。PCが古くて寸法を合わせられない場合だけ計算値が
		// 下回り、従来どおり縮めて収める側へ自動で落ちる（画面外へはみ出させない）。
		if (pinnedFontSize > 0) {
			term.options.fontSize = Math.max(4, Math.min(pinnedFontSize, fontSize));
			return;
		}
		// 上限は画面の広さで変える。iPhone幅（<700px）はこれまで通り16ptで頭打ちにし、
		// iPadの広い幅では上限に張り付いて右側に黒帯が残らないところまで許す
		// （PC側のcols/rowsは変えられないので、埋められるのは文字を大きくする方向だけ）。
		var maxFontSize = availWidth >= 700 ? 26 : 16;
		term.options.fontSize = Math.max(4, Math.min(maxFontSize, fontSize));
	}
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
			term.write(data, function () { term.scrollToBottom(); });
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
			if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) {
				currentCols = cols;
				currentRows = rows;
				fit(cols, rows);
				term.resize(cols, rows);
			}
			term.write(data, function () { term.scrollToBottom(); });
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
		window.scrollTo(0, document.body.scrollHeight);
		reportMetricsSoon();
	});
	window.ReactNativeWebView.postMessage('ready');
	reportMetrics();
})();
</script></body></html>`;
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
	const metricsRef = useRef<{ width: number; height: number; charWidth100: number; lineHeight100: number } | undefined>(undefined);
	// 固定モードで最後に適用したグリッド（同じ値の再適用・再申告を避ける）。
	const gridRef = useRef<TerminalGrid | undefined>(undefined);
	const html = useMemo(() => buildHtml(), []);

	const inject = (script: string) => {
		webRef.current?.injectJavaScript(`${script}; true;`);
	};

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
			streamModeRef.current = true;
			const n = ++injectSeqRef.current;
			inject(`window.__para.snapshot(${n}, ${JSON.stringify(ev.data)}, ${ev.cols ?? 0}, ${ev.rows ?? 0}, ${JSON.stringify(ev.unicode ?? '')})`);
		} else {
			const n = ++injectSeqRef.current;
			inject(`window.__para.write(${n}, ${JSON.stringify(ev.data)})`);
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
			const n = ++injectSeqRef.current;
			inject(`window.__para.write(${n}, ${JSON.stringify(output.slice(written.length))})`);
		} else {
			const n = ++injectSeqRef.current;
			inject(`window.__para.reset(); window.__para.write(${n}, ${JSON.stringify(output)})`);
		}
		writtenRef.current = output;
	}, [ready, output]);

	return (
		<WebView
			ref={webRef}
			style={styles.web}
			source={{ html }}
			originWhitelist={['*']}
			javaScriptEnabled
			scrollEnabled
			bounces={false}
			hideKeyboardAccessoryView
			keyboardDisplayRequiresUserAction
			onContentProcessDidTerminate={() => {
				// iOSがメモリ圧でコンテンツプロセスを落とした。画面状態はWebView内にしか
				// 無いため、reloadして ready を待ち、再attach（snapshot再同期）で復旧する。
				readyRef.current = false;
				setReady(false);
				webRef.current?.reload();
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
						applyPinnedGrid();
					} else if (msg.t === 'scroll' && (msg.dir === 'up' || msg.dir === 'down') && msg.lines > 0) {
						onScrollRef.current?.(msg.dir, msg.lines);
					}
					return;
				}
				if (event.nativeEvent.data === 'ready') {
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
	);
}

const styles = StyleSheet.create({
	web: { flex: 1, backgroundColor: TERM_BG },
});

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
 * - cols/rows は PC 側ターミナルと同じ値に resize し、フォントサイズを画面幅に
 *   合わせて自動計算する（TUIはPCの端末寸法前提でレイアウトするため寸法一致が必須）
 * - 入力は使わない（既存のネイティブ入力バーから送る）。表示専用。
 * - iOSがメモリ圧でWebViewのコンテンツプロセスを落とした場合は自動reloadし、
 *   onNeedResync で最新snapshotを取り直す（画面状態はWebView内にしか無いため）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import xtermBundle from '../../assets/xterm/xtermBundle.json';
import type { TermStreamEvent } from '../store.js';

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
}

const TERM_BG = '#1e1e1e';

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
	// PCと同じ cols/rows を維持したまま画面に収まるフォントサイズを実測ベースで求める。
	// 幅だけで決めると、キーボード表示等でWebViewの高さが縮んでも行数×行高は
	// 変わらないため、上部が画面外に押し出されてしまう。幅ベース・高さベース
	// それぞれで算出したフォントサイズの小さい方を採用し、両軸に収める。
	function fit(cols, rows) {
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
		var charWidthAt100 = rect.width / 10;
		// フォントの自然な行送り（100px時）。xtermの実セル高は行送りにほぼ比例するため、
		// 実レンダラの寸法を取得しなくてもこの比率で十分近似できる。
		var lineHeightAt100 = rect.height;
		document.body.removeChild(probe);
		var availWidth = document.documentElement.clientWidth - 10;
		var fontSizeByWidth = Math.floor(100 * availWidth / (charWidthAt100 * cols));
		var fontSize = fontSizeByWidth;
		if (rows > 0) {
			var availHeight = document.documentElement.clientHeight - 10;
			var fontSizeByHeight = Math.floor(100 * availHeight / (lineHeightAt100 * rows));
			fontSize = Math.min(fontSizeByWidth, fontSizeByHeight);
		}
		term.options.fontSize = Math.max(4, Math.min(16, fontSize));
	}
	window.__para = {
		resize: function (cols, rows) {
			currentCols = cols;
			currentRows = rows;
			fit(cols, rows);
			term.resize(cols, rows);
			term.scrollToBottom();
		},
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
	// キーボード開閉などでWebViewの高さが変わったら、フォントを合わせ直した上で
	// 最下部（プロンプト行）が見える位置までスクロールする。
	window.addEventListener('resize', function () {
		fit(currentCols, currentRows);
		term.scrollToBottom();
		window.scrollTo(0, document.body.scrollHeight);
	});
	window.ReactNativeWebView.postMessage('ready');
})();
</script></body></html>`;
}

export function TermView({ output, cols, rows, subscribe, onNeedResync }: TermViewProps) {
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
	const html = useMemo(() => buildHtml(), []);

	const inject = (script: string) => {
		webRef.current?.injectJavaScript(`${script}; true;`);
	};

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

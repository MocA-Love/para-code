// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * xterm.js を WebView に載せた読み取り用ターミナルビュー。
 * PCから届く生のANSIストリームをそのまま xterm に流すことで、claude / codex などの
 * TUI（カーソル制御・代替スクリーン・256色）も PC と同じように描画される。
 *
 * - xterm.js/css は assets/xterm/xtermBundle.json に vendor した文字列を HTML に埋め込む
 *   （オフラインで完結、CDN・ネイティブアセット読み込み不要）
 * - cols/rows は PC 側ターミナルと同じ値に resize し、フォントサイズを画面幅に
 *   合わせて自動計算する（TUIはPCの端末寸法前提でレイアウトするため寸法一致が必須）
 * - 入力は使わない（既存のネイティブ入力バーから送る）。表示専用。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import xtermBundle from '../../assets/xterm/xtermBundle.json';

interface TermViewProps {
	/** これまでに受信した出力バッファ全体（先頭からの追記を差分書き込みする）。 */
	output: string;
	cols?: number;
	rows?: number;
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
	term.open(document.getElementById('wrap'));
	var currentCols = 80;
	// PCと同じ cols を維持したまま画面幅に収まるフォントサイズを実測ベースで求める
	function fit(cols) {
		var probe = document.createElement('span');
		probe.style.fontFamily = 'Menlo, monospace';
		probe.style.fontSize = '100px';
		probe.style.position = 'absolute';
		probe.style.visibility = 'hidden';
		probe.style.whiteSpace = 'pre';
		probe.textContent = 'WWWWWWWWWW';
		document.body.appendChild(probe);
		var charWidthAt100 = probe.getBoundingClientRect().width / 10;
		document.body.removeChild(probe);
		var avail = document.documentElement.clientWidth - 10;
		var fontSize = Math.floor(100 * avail / (charWidthAt100 * cols));
		term.options.fontSize = Math.max(4, Math.min(16, fontSize));
	}
	window.__para = {
		resize: function (cols, rows) {
			currentCols = cols;
			fit(cols);
			term.resize(cols, rows);
			term.scrollToBottom();
		},
		write: function (data) {
			term.write(data, function () { term.scrollToBottom(); });
		},
		reset: function () { term.reset(); },
	};
	window.addEventListener('resize', function () { fit(currentCols); });
	window.ReactNativeWebView.postMessage('ready');
})();
</script></body></html>`;
}

export function TermView({ output, cols, rows }: TermViewProps) {
	const webRef = useRef<WebView>(null);
	const [ready, setReady] = useState(false);
	const writtenRef = useRef('');
	const html = useMemo(() => buildHtml(), []);

	const inject = (script: string) => {
		webRef.current?.injectJavaScript(`${script}; true;`);
	};

	useEffect(() => {
		if (!ready || !cols || !rows) {
			return;
		}
		inject(`window.__para.resize(${cols}, ${rows})`);
	}, [ready, cols, rows]);

	useEffect(() => {
		if (!ready) {
			return;
		}
		const written = writtenRef.current;
		if (output === written) {
			return;
		}
		// 前回書き込み分の続きなら差分だけ流す。バッファのトリム等で先頭が変わったら書き直す。
		if (written.length > 0 && output.startsWith(written)) {
			inject(`window.__para.write(${JSON.stringify(output.slice(written.length))})`);
		} else {
			inject(`window.__para.reset(); window.__para.write(${JSON.stringify(output)})`);
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
			onMessage={event => {
				if (event.nativeEvent.data === 'ready') {
					writtenRef.current = '';
					setReady(true);
				}
			}}
		/>
	);
}

const styles = StyleSheet.create({
	web: { flex: 1, backgroundColor: TERM_BG },
});

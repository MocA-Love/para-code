// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { createMobileOfficeNonce, MOBILE_OFFICE_ORIGIN_WHITELIST } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { alpha, colors, withAlpha } from '../../theme.js';
import { useChatTextScale } from '../../ui/chatTextScale.js';
import { useThemeColors } from '../../ui/index.js';
import { buildInplaceSelectHtml, parseInplaceSelectMessage, type InplaceSelectPoint, type InplaceSelectSegment } from './inplaceSelectHtml.js';

/**
 * 読み込みを終えた後、スクリプトが「描き終えた」を知らせてこないときに、それでも出すまでの待ち（ms）。
 * 読み込みを終えないうち（白紙のまま）は出さない（元の表示を隠して空の発言にしないように）。
 */
const READY_AFTER_LOAD_MS = 300;

/**
 * 発言の表示の上に重ねる、範囲を選ぶための WebView（Q551 案 4）。重ねる位置と大きさは呼び出し側
 * （`MessageContextMenu`）が決める。OS のつまみ・選択の色・編集メニュー（コピー・すべてを選択・共有）をそのまま使う。
 *
 * - 描き終えるまでは透明にしておき（下の元の表示が見えたまま）、描き終えたら `onReady` を呼ぶ。呼び出し側はそこで
 *   元の表示を隠す（差し替えのちらつきを抑える）
 * - `segments` と `point` は差し替えを始めたときの写しを渡すこと。変わると HTML を作り直して選択が消える
 * - WebView の編集メニューに `menuItems` を足さない（足すと react-native-webview が OS の項目を全部消す）
 */
export function InplaceSelectWebView({ segments, point, fg, onReady, onHeight, onGone }: {
	segments: readonly InplaceSelectSegment[];
	point: InplaceSelectPoint | undefined;
	/** 本文の色。 */
	fg: string;
	onReady: () => void;
	/** 中身の高さ（pt）が分かった・変わった。 */
	onHeight: (height: number) => void;
	/** iOS が中身のプロセスを落とした。呼び出し側は差し替えをやめて元の表示へ戻す（隠したままにしない）。 */
	onGone?: () => void;
}) {
	const theme = useThemeColors();
	const scale = useChatTextScale();
	const { fontScale } = useWindowDimensions();
	const [ready, setReady] = useState(false);
	const readyRef = useRef(false);
	const callbacks = useRef({ onReady, onHeight });
	callbacks.current = { onReady, onHeight };
	const html = useMemo(() => buildInplaceSelectHtml(segments, {
		scale,
		osFontScale: fontScale,
		hairline: StyleSheet.hairlineWidth,
		fg,
		accent: theme.accent,
		accentWash: theme.accentWash,
		selection: withAlpha(theme.accent, alpha.line) ?? theme.accent,
	}, createMobileOfficeNonce(), point), [segments, point, fg, scale, fontScale, theme.accent, theme.accentWash]);

	const markReady = () => {
		if (!readyRef.current) {
			readyRef.current = true;
			setReady(true);
			callbacks.current.onReady();
		}
	};
	// 読み込んだのにスクリプトが知らせてこないときも、選べるように出す（高さは元の表示のまま）
	const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(loadTimer.current), []);
	const onLoadEnd = () => {
		clearTimeout(loadTimer.current);
		loadTimer.current = setTimeout(markReady, READY_AFTER_LOAD_MS);
	};

	const onMessage = (event: WebViewMessageEvent) => {
		const message = parseInplaceSelectMessage(event.nativeEvent.data);
		if (message === undefined) {
			return;
		}
		callbacks.current.onHeight(message.height);
		if (message.kind === 'ready') {
			markReady();
		}
	};

	return (
		<View style={[styles.fill, ready ? null : styles.pending]}>
			<WebView
				style={styles.web}
				containerStyle={styles.web}
				source={{ html }}
				originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
				javaScriptEnabled
				onMessage={onMessage}
				onLoadEnd={onLoadEnd}
				onContentProcessDidTerminate={() => onGone?.()}
				onShouldStartLoadWithRequest={guardWebViewNavigation}
				// 縦のスクロールは会話の一覧に任せる（中身の高さまで WebView を伸ばすので、中でスクロールしない）
				scrollEnabled={false}
				bounces={false}
				showsVerticalScrollIndicator={false}
				showsHorizontalScrollIndicator={false}
				automaticallyAdjustContentInsets={false}
				contentInsetAdjustmentBehavior="never"
				allowsLinkPreview={false}
				dataDetectorTypes="none"
				allowsInlineMediaPlayback={false}
				mediaPlaybackRequiresUserAction
				textInteractionEnabled
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	pending: { opacity: 0 },
	web: { flex: 1, backgroundColor: 'transparent' },
});

/** 自分の発言は吹き出しの上の色、それ以外は本文の色。 */
export function inplaceSelectForeground(markdown: boolean, onBubble: string): string {
	return markdown ? colors.text : onBubble;
}

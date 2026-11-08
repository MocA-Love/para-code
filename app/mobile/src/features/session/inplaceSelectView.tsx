// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { createMobileOfficeNonce, MOBILE_OFFICE_ORIGIN_WHITELIST } from '../../components/officeCapability.js';
import { guardWebViewNavigation } from '../../components/webViewLinkGuard.js';
import { alpha, colors, withAlpha } from '../../theme.js';
import { useChatTextScale } from '../../ui/chatTextScale.js';
import { useThemeColors } from '../../ui/index.js';
import { peekCodeHighlight } from '../../components/codeHighlightCache.js';
import { buildInplaceSelectHtml, inplaceSelectStartScript, parseInplaceSelectMessage, type InplaceSelectPoint, type InplaceSelectScrollLayout, type InplaceSelectSegment } from './inplaceSelectHtml.js';

/**
 * 読み込みを終えた後、スクリプトが「描き終えた」を知らせてこないときに、それでも出すまでの待ち（ms）。
 * 読み込みを終えないうち（白紙のまま）は出さない（元の表示を隠して空の発言にしないように）。
 */
const READY_AFTER_LOAD_MS = 300;

/**
 * 見せてから選ぶまでの待ち（ms）。透明を外した描画と first responder になるのを待ってから選び、遅れたときのために数回やり直す
 * （先に選ぶと WebKit はつまみも OS のメニューも出さない。`inplaceSelectHtml.ts` の selectScript）。
 */
const SELECT_ATTEMPTS_MS = [30, 200, 500] as const;

/**
 * 発言の表示の上に重ねる、範囲を選ぶための WebView（Q551 案 4）。重ねる位置と大きさは呼び出し側
 * （`MessageContextMenu`）が決める。OS のつまみ・選択の色・編集メニュー（コピー・すべてを選択・共有）をそのまま使う。
 *
 * - 描き終えるまでは透明にしておき（下の元の表示が見えたまま）、描き終えたら `onReady` を呼ぶ。呼び出し側はそこで
 *   元の表示を隠す（差し替えのちらつきを抑える）
 * - 見せた後に WebView を first responder にして（`requestFocus()`。入力欄のキーボードは閉じる）、押した点の単語か
 *   発言の全体を選ぶ。入った時点でつまみと OS のメニューが出ているように
 * - `segments` と `point` は差し替えを始めたときの写しを渡すこと。変わると HTML を作り直して選択が消える
 * - WebView の編集メニューに `menuItems` を足さない（足すと react-native-webview が OS の項目を全部消す）
 */
export function InplaceSelectWebView({ active, segments, point, layout, fg, onReady, onHeight, onGone }: {
	/**
	 * 選んでいる間か。false の間は見えないまま読み込んでおく（長押しのメニューが出た時点で用意し、押されたら同じ
	 * WebView を見せる。WebView の起動に数秒かかることがあるため）。
	 */
	active: boolean;
	segments: readonly InplaceSelectSegment[];
	point: InplaceSelectPoint | undefined;
	/**
	 * 前後の発言をまとめて選ぶとき（`crossSelect.tsx`）。中で縦にスクロールでき、押した発言を元の位置に合わせて見せる。
	 * 無いときは発言 1 つの上に重ね、中ではスクロールしない（高さは `onHeight` で呼び出し側が合わせる）。差し替えを始めたときの写しを渡すこと。
	 */
	layout?: InplaceSelectScrollLayout;
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
	const webRef = useRef<WebView>(null);
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
		// コードは会話の描画が PC から取ってある色で描く（新しく PC へは頼まない）
		codeHighlight: peekCodeHighlight,
	}, createMobileOfficeNonce(), point, layout), [segments, point, layout, fg, scale, fontScale, theme.accent, theme.accentWash]);

	const markReady = () => {
		if (!readyRef.current) {
			readyRef.current = true;
			setReady(true);
			callbacks.current.onReady();
		}
	};
	// 見せた後に、first responder にしてから選ぶ。first responder になるのが遅れたときのために数回やり直す
	// （ページは 2 回目からは何も選ばれていないときだけ選び直す。選び直したものを消さない）
	useEffect(() => {
		if (!ready || !active) {
			return undefined;
		}
		const timers = SELECT_ATTEMPTS_MS.map(delay => setTimeout(() => {
			webRef.current?.requestFocus();
			webRef.current?.injectJavaScript(inplaceSelectStartScript());
		}, delay));
		return () => timers.forEach(clearTimeout);
	}, [ready, active]);
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
		<View style={[styles.fill, ready && active ? null : styles.pending]}>
			<WebView
				ref={webRef}
				style={styles.web}
				containerStyle={styles.web}
				source={{ html }}
				originWhitelist={[...MOBILE_OFFICE_ORIGIN_WHITELIST]}
				javaScriptEnabled
				onMessage={onMessage}
				onLoadEnd={onLoadEnd}
				onContentProcessDidTerminate={() => onGone?.()}
				onShouldStartLoadWithRequest={guardWebViewNavigation}
				// 発言 1 つのときは、縦のスクロールは会話の一覧に任せる（中身の高さまで WebView を伸ばすので、中でスクロールしない）。
				// 前後の発言をまとめて選ぶときは、一覧の上に重ねて中でスクロールする
				scrollEnabled={layout !== undefined}
				bounces={false}
				showsVerticalScrollIndicator={layout !== undefined}
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

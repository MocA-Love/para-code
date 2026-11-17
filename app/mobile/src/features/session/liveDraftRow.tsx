// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { MarkdownText } from '../../components/markdownText.js';
import { parseInline } from '../../components/markdownParse.js';
import { useAppIsActive } from '../../hooks/useAppIsActive.js';
import { useReduceMotion } from '../../hooks/useReduceMotion.js';
import { monoFamily } from '../../monoFont.js';
import type { AgentLiveState } from '../../store.js';
import { alpha, colors, radius, space, tint, type } from '../../theme.js';
import { useChatStyles } from '../../ui/chatTextScale.js';
import { splitLiveDraft } from './liveDraft.js';

/** 描き直しの間隔の下限。PC は 150 ms ごとに送るが、それより細かく描き直さない（Q657 資料の「描き方の負荷」）。 */
const LIVE_DRAFT_REDRAW_MS = 150;
/** カーソルの点滅の半周期（モックの `blink 1s steps(2)`）。 */
const CARET_BLINK_MS = 500;

/**
 * 書いている最中の返信（Q657 案 C。モック mobile-streaming-2026-11-17 の `.writing-label`・`.tail`・`.caret`）。会話の一覧の末尾に置く。
 *  - 上に「書いています」の印（11pt・注記の色、点 3 つ）
 *  - 改行で確定した行は確定した返信と同じ地の文（既存の MarkdownText）。確定すると色だけが変わって見える
 *  - 書きかけの 1 行は一段弱い色の文字で、行内のコードと箇条の印だけを飾る。末尾にカーソル
 * アプリが前面にいない間は描き直さない。幅で形を変えない（iPad の詳細の列でもそのまま収まる）。
 */
export const LiveDraftRow = memo(function LiveDraftRow({ live }: { live: AgentLiveState }) {
	const styles = useChatStyles(baseStyles);
	const active = useAppIsActive();
	const text = useThrottledValue(live.text ?? '', LIVE_DRAFT_REDRAW_MS, active);
	const parts = useMemo(() => splitLiveDraft(text, { final: live.final, textOffset: live.textOffset }), [text, live.final, live.textOffset]);
	// 確定した行の Markdown は、行が増えたときだけ組み直す（書きかけの行が伸びるだけなら同じ要素を使い回す）
	const committed = useMemo(() => parts.committed.length > 0 ? <MarkdownText text={parts.committed} selectable={false} /> : null, [parts.committed]);
	return (
		<View style={styles.row} accessibilityLabel="エージェントが返信を書いています">
			<View style={styles.label}>
				<View style={styles.dots}>
					<View style={styles.dot} />
					<View style={styles.dot} />
					<View style={styles.dot} />
				</View>
				<Text style={styles.labelText}>書いています</Text>
			</View>
			<View style={styles.body}>
				{committed}
				{parts.inCode ? (parts.caret ? <Caret active={active} /> : null) : (parts.tail.length > 0 || parts.caret) ? (
					<Text style={styles.tail}>
						{parseInline(parts.tail).map((token, index) => token.kind === 'code'
							? <Text key={index} style={[styles.tail, styles.inlineCode]}>{token.text}</Text>
							: <Text key={index}>{token.kind === 'external' || token.kind === 'local' ? token.label : token.text}</Text>)}
						{parts.caret ? <Caret active={active} /> : null}
					</Text>
				) : null}
			</View>
		</View>
	);
});

/** 末尾のカーソル（7×15）。「視差効果を減らす」のときと、アプリが前面にいない間は点滅させない。 */
function Caret({ active }: { active: boolean }) {
	const reduceMotion = useReduceMotion();
	const opacity = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		if (reduceMotion || !active) {
			opacity.setValue(1);
			return undefined;
		}
		const loop = Animated.loop(Animated.sequence([
			Animated.delay(CARET_BLINK_MS),
			Animated.timing(opacity, { toValue: 0, duration: 0, useNativeDriver: true }),
			Animated.delay(CARET_BLINK_MS),
			Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
		]));
		loop.start();
		return () => loop.stop();
	}, [active, opacity, reduceMotion]);
	return <Animated.View style={[baseStyles.caret, { opacity }]} accessibilityElementsHidden importantForAccessibility="no" />;
}

/**
 * 値の変化を `intervalMs` に 1 回までにする（最後の値は必ず出す）。`enabled` が偽の間は描き直さず、真に戻ったら追いつく。
 */
function useThrottledValue<T>(value: T, intervalMs: number, enabled: boolean): T {
	const [shown, setShown] = useState(value);
	const shownAt = useRef(0);
	useEffect(() => {
		if (!enabled) {
			return undefined;
		}
		const wait = shownAt.current + intervalMs - Date.now();
		if (wait <= 0) {
			shownAt.current = Date.now();
			setShown(value);
			return undefined;
		}
		const timer = setTimeout(() => {
			shownAt.current = Date.now();
			setShown(value);
		}, wait);
		return () => clearTimeout(timer);
	}, [value, intervalMs, enabled]);
	return shown;
}

const baseStyles = StyleSheet.create({
	// 会話の行（chatItems の `row`。モックの `.mrow` の 8px 16px）
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
	label: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.snug,
		marginBottom: space.xs,
	},
	labelText: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	dots: {
		flexDirection: 'row',
		gap: space.xs,
	},
	dot: {
		width: 5,
		height: 5,
		borderRadius: radius.pill,
		backgroundColor: colors.textDim,
		opacity: 0.5,
	},
	// MarkdownText の段落の間隔（root の gap 6）と同じにして、書きかけの行を同じ文の続きに見せる
	body: {
		gap: 6,
	},
	tail: {
		color: colors.textDim,
		fontSize: type.body,
		lineHeight: 20,
	},
	// モックの `.md code`: 書きかけの行の中でもコードは本文の色
	inlineCode: {
		color: colors.text,
		fontFamily: monoFamily,
		fontSize: type.meta,
		backgroundColor: tint(colors.idle, alpha.line),
		borderRadius: radius.key,
	},
	caret: {
		width: 7,
		height: 15,
		marginLeft: 2,
		borderRadius: 1,
		backgroundColor: colors.textDim,
	},
});

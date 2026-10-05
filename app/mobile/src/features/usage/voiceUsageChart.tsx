// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { haptic } from '../../haptics.js';
import { alpha, colors, radius, space, tint, type } from '../../theme.js';
import { barIndexAt, isHorizontalScrub, isTap } from './voiceChartGesture.js';

/** 棒 1 本（1 日）。 */
export interface VoiceChartBar {
	readonly key: string;
	readonly value: number;
	/** 押したときに上に出す日付（`10/2（木）`）。 */
	readonly dayLabel: string;
	/** 押したときに上に出す値（`3,920 文字`）。 */
	readonly valueLabel: string;
}

const CHART_HEIGHT = 96;
/** 値が 0 の日も見えるようにする最低の高さ（%）。 */
const MIN_BAR_PERCENT = 2;

/**
 * 読み上げの使用量の日別の棒グラフ。棒をタップするか、横になぞると、その日の値をグラフの上に出す。
 * 触れた瞬間には選ばない（縦のスクロールの始まりかもしれない）。横の動きが縦より勝ったときになぞりを始め、その間は
 * 縦のスクロールに取られないようにする。ほとんど動かずに離したらタップとして選ぶ（判定は `voiceChartGesture.ts`）。
 * 指を離しても選んだ日は残し、`selectionKey`（期間・キー・指標）が変わったら外す。
 * 幅は自分の `onLayout` で測る（ウィンドウ幅ではない）。
 */
export const VoiceUsageChart = memo(function VoiceUsageChart({ bars, firstLabel, lastLabel, emptyHint, selectionKey }: {
	bars: readonly VoiceChartBar[];
	firstLabel: string | undefined;
	lastLabel: string | undefined;
	/** 選んでいないときに上に出す一文。 */
	emptyHint: string;
	/** 変わったら選択を外す（期間・キー・指標の切り替え）。 */
	selectionKey: string;
}) {
	const [width, setWidth] = useState(0);
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const selectedRef = useRef<number | undefined>(undefined);
	// PanResponder は一度だけ作るので、いまの幅と本数は ref で読む
	const sizeRef = useRef({ width: 0, count: bars.length });
	useEffect(() => {
		sizeRef.current = { width, count: bars.length };
	}, [width, bars.length]);
	useEffect(() => {
		selectedRef.current = undefined;
		setSelected(undefined);
	}, [selectionKey]);
	const onLayout = useCallback((event: LayoutChangeEvent) => {
		const next = Math.round(event.nativeEvent.layout.width);
		setWidth(prev => (prev === next ? prev : next));
	}, []);
	const select = useCallback((index: number | undefined) => {
		if (index === undefined || index === selectedRef.current) {
			return;
		}
		selectedRef.current = index;
		haptic('tick');
		setSelected(index);
	}, []);
	const responder = useMemo(() => {
		let startX = 0;
		let scrubbing = false;
		const indexAt = (x: number) => barIndexAt(x, sizeRef.current.width, sizeRef.current.count);
		return PanResponder.create({
			// 触れた時点では応答者になるだけで、選ばない（タップか、なぞりかを見てから決める）
			onStartShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponder: (_event, gesture) => isHorizontalScrub(gesture.dx, gesture.dy),
			onPanResponderGrant: event => {
				startX = event.nativeEvent.locationX;
				scrubbing = false;
			},
			onPanResponderMove: (_event, gesture) => {
				if (!scrubbing && isHorizontalScrub(gesture.dx, gesture.dy)) {
					scrubbing = true;
				}
				if (scrubbing) {
					select(indexAt(startX + gesture.dx));
				}
			},
			// なぞっている間だけ縦のスクロールへ渡さない
			onPanResponderTerminationRequest: () => !scrubbing,
			onPanResponderRelease: (_event, gesture) => {
				if (!scrubbing && isTap(gesture.dx, gesture.dy)) {
					select(indexAt(startX));
				}
				scrubbing = false;
			},
			onPanResponderTerminate: () => {
				scrubbing = false;
			},
		});
	}, [select]);
	const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
		const current = selectedRef.current ?? bars.length - 1;
		const next = event.nativeEvent.actionName === 'increment' ? current + 1 : event.nativeEvent.actionName === 'decrement' ? current - 1 : current;
		select(Math.max(0, Math.min(bars.length - 1, next)));
	}, [select, bars.length]);

	// 期間を変えて本数が減ったら選択を外す
	const shown = selected !== undefined && selected < bars.length ? bars[selected] : undefined;
	const max = Math.max(1, ...bars.map(bar => bar.value));

	return (
		<View style={styles.box}>
			<Text style={[styles.tip, shown === undefined ? styles.tipHint : undefined]} numberOfLines={1}>
				{shown !== undefined ? <>{`${shown.dayLabel}　`}<Text style={styles.tipValue}>{shown.valueLabel}</Text></> : emptyHint}
			</Text>
			<View
				style={styles.chart}
				onLayout={onLayout}
				{...responder.panHandlers}
				accessible
				accessibilityRole="adjustable"
				accessibilityLabel="日別のグラフ"
				accessibilityValue={{ text: shown !== undefined ? `${shown.dayLabel} ${shown.valueLabel}` : emptyHint }}
				accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
				onAccessibilityAction={onAccessibilityAction}
			>
				{bars.map((bar, index) => (
					<View key={bar.key} style={styles.slot} pointerEvents="none">
						<View
							style={[
								styles.bar,
								{ height: `${Math.max(MIN_BAR_PERCENT, (bar.value / max) * 100)}%` },
								index === selected ? styles.barSelected : undefined,
							]}
						/>
					</View>
				))}
			</View>
			<View style={styles.caption}>
				<Text style={styles.captionText}>{firstLabel ?? ''}</Text>
				<Text style={styles.captionText}>{lastLabel ?? ''}</Text>
			</View>
		</View>
	);
});

const styles = StyleSheet.create({
	box: {
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
		borderRadius: radius.card,
		backgroundColor: colors.panel,
	},
	tip: {
		fontSize: type.meta,
		color: colors.textDim,
		marginBottom: space.xs + 2,
		fontVariant: ['tabular-nums'],
	},
	tipHint: {
		color: colors.textMuted,
	},
	tipValue: {
		fontWeight: '600',
		color: colors.text,
	},
	chart: {
		height: CHART_HEIGHT,
		flexDirection: 'row',
		alignItems: 'flex-end',
		gap: 2,
	},
	slot: {
		flex: 1,
		height: '100%',
		justifyContent: 'flex-end',
	},
	bar: {
		width: '100%',
		borderTopLeftRadius: 2,
		borderTopRightRadius: 2,
		backgroundColor: tint(colors.blue, alpha.strong),
	},
	barSelected: {
		backgroundColor: colors.blue,
	},
	caption: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		marginTop: space.xs,
	},
	captionText: {
		fontSize: type.caption,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
});

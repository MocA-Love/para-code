// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/** モデルが提供する順序を保ったまま選択する、コンポーザー用のEffortスライダー。 */
export function EffortSlider({ efforts, value, disabled, accentColor, onValueCommit }: {
	efforts: readonly string[];
	value: string | undefined;
	disabled: boolean;
	accentColor: string;
	onValueCommit: (effort: string) => void;
}) {
	const selectedIndex = Math.max(0, efforts.indexOf(value ?? ''));
	const [previewIndex, setPreviewIndex] = useState(selectedIndex);
	const [trackWidth, setTrackWidth] = useState(0);

	useEffect(() => {
		setPreviewIndex(selectedIndex);
	}, [selectedIndex]);

	const setPreview = useCallback((index: number) => {
		const nextIndex = Math.max(0, Math.min(index, efforts.length - 1));
		setPreviewIndex(currentIndex => {
			if (currentIndex !== nextIndex) {
				hapticSelection();
			}
			return nextIndex;
		});
		return nextIndex;
	}, [efforts.length]);

	const indexFromLocation = useCallback((locationX: number) => {
		if (efforts.length <= 1 || trackWidth <= 0) {
			return 0;
		}
		const ratio = Math.max(0, Math.min(1, locationX / trackWidth));
		return Math.round(ratio * (efforts.length - 1));
	}, [efforts.length, trackWidth]);

	const commitIndex = useCallback((index: number) => {
		const safeIndex = setPreview(index);
		const nextEffort = efforts[safeIndex];
		if (nextEffort !== undefined && nextEffort !== value) {
			onValueCommit(nextEffort);
		}
		// 設定の確定はClaude/Codex側の応答を正本にする。確認を取り消した場合や
		// 更新に失敗した場合に、スライダーだけが先行して見えないよう戻す。
		setPreviewIndex(selectedIndex);
	}, [efforts, onValueCommit, selectedIndex, setPreview, value]);

	const panResponder = useMemo(() => PanResponder.create({
		onStartShouldSetPanResponder: () => !disabled && efforts.length > 1,
		onMoveShouldSetPanResponder: () => !disabled && efforts.length > 1,
		onPanResponderGrant: event => { setPreview(indexFromLocation(event.nativeEvent.locationX)); },
		onPanResponderMove: event => { setPreview(indexFromLocation(event.nativeEvent.locationX)); },
		onPanResponderRelease: event => { commitIndex(indexFromLocation(event.nativeEvent.locationX)); },
		onPanResponderTerminate: event => { commitIndex(indexFromLocation(event.nativeEvent.locationX)); },
	}), [commitIndex, disabled, efforts.length, indexFromLocation, setPreview]);

	if (efforts.length === 0) {
		return null;
	}

	const progress = efforts.length === 1 ? 0 : previewIndex / (efforts.length - 1);
	const activeEffort = efforts[previewIndex] ?? efforts[0];
	const isMaximum = activeEffort === 'max' || activeEffort === 'ultra';
	const onLayout = (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width);

	return (
		<View style={[styles.container, disabled && styles.disabled]}>
			<View style={styles.labelRow}>
				<Text style={styles.label}>Effort</Text>
				<Text style={[styles.value, { color: accentColor }, isMaximum && styles.valueMaximum]}>{activeEffort}</Text>
			</View>
			<View
				{...panResponder.panHandlers}
				accessible
				accessibilityRole="adjustable"
				accessibilityLabel="推論の深さ"
				accessibilityValue={{ min: 0, max: efforts.length - 1, now: previewIndex, text: activeEffort }}
				accessibilityState={{ disabled }}
				accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
				onAccessibilityAction={event => {
					if (disabled) {
						return;
					}
					if (event.nativeEvent.actionName === 'increment') {
						commitIndex(previewIndex + 1);
					} else if (event.nativeEvent.actionName === 'decrement') {
						commitIndex(previewIndex - 1);
					}
				}}
				style={styles.slider}
				onLayout={onLayout}
			>
				<View style={styles.track}>
					<View style={[styles.range, { width: `${progress * 100}%`, backgroundColor: accentColor }, isMaximum && styles.rangeMaximum]} />
					{efforts.map((effort, index) => {
						const position = efforts.length === 1 ? 0 : index / (efforts.length - 1) * 100;
						return <View key={effort} style={[styles.tick, { left: `${position}%` }, index <= previewIndex && styles.tickActive]} />;
					})}
				</View>
				<View
					style={[styles.thumb, { left: `${progress * 100}%` }, isMaximum && styles.thumbMaximum]}
				/>
			</View>
			<View style={styles.scaleLabels}>
				<Text style={styles.scaleLabel}>速い</Text>
				<Text style={styles.scaleLabel}>深い</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { marginTop: 14 },
	disabled: { opacity: 0.55 },
	labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 },
	label: { color: colors.textDim, fontSize: 10.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
	value: { fontFamily: mono.ios, fontSize: 11, fontWeight: '800' },
	valueMaximum: { color: colors.yellow },
	slider: { height: 32, justifyContent: 'center' },
	track: { height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,.07)', borderWidth: 0.5, borderColor: colors.border, overflow: 'hidden' },
	range: { height: '100%', borderTopLeftRadius: 12, borderBottomLeftRadius: 12 },
	rangeMaximum: { backgroundColor: colors.yellow },
	tick: { position: 'absolute', top: 10, width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.27)' },
	tickActive: { backgroundColor: 'rgba(255,255,255,.68)' },
	thumb: { position: 'absolute', top: 2, width: 28, height: 28, marginLeft: -14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 0.5, borderColor: colors.borderStrong, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
	thumbMaximum: { shadowColor: colors.yellow, shadowOpacity: 0.8, shadowRadius: 10 },
	scaleLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
	scaleLabel: { color: colors.textDim, fontSize: 9.5 },
});

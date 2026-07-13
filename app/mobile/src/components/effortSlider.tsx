// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * モデルが提供する順序を保ったまま選択する、コンポーザー用のEffortスライダー。
 * ここでの選択はローカルな仮選択にとどまり、送信は呼び出し元（モデルセレクターの確定操作）が行う。
 */
export function EffortSlider({ efforts, value, disabled, accentColor, onChange }: {
	efforts: readonly string[];
	value: string | undefined;
	disabled: boolean;
	accentColor: string;
	onChange: (effort: string) => void;
}) {
	const selectedIndex = Math.max(0, efforts.indexOf(value ?? ''));
	const [previewIndex, setPreviewIndex] = useState(selectedIndex);
	const [trackWidth, setTrackWidth] = useState(0);
	const [reduceMotion, setReduceMotion] = useState(false);
	const thumbScale = useRef(new Animated.Value(1)).current;
	const burstProgress = useRef(new Animated.Value(0)).current;
	const particleValues = useRef(Array.from({ length: 10 }, () => new Animated.Value(0))).current;
	const sliderRef = useRef<View>(null);
	const sliderPageX = useRef(0);
	const sliderWidth = useRef(0);
	const progress = efforts.length <= 1 ? 0 : previewIndex / (efforts.length - 1);
	const activeEffort = efforts[previewIndex] ?? efforts[0] ?? '';
	const isMaximum = activeEffort === 'max' || activeEffort === 'ultra';

	useEffect(() => {
		let mounted = true;
		void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
			if (mounted) {
				setReduceMotion(enabled);
			}
		});
		const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
		return () => {
			mounted = false;
			subscription.remove();
		};
	}, []);

	useEffect(() => {
		setPreviewIndex(selectedIndex);
	}, [selectedIndex]);

	useEffect(() => {
		if (reduceMotion) {
			thumbScale.setValue(1);
			return;
		}
		thumbScale.setValue(0.9);
		const spring = Animated.spring(thumbScale, {
			toValue: 1,
			stiffness: 420,
			damping: 38,
			mass: 1,
			useNativeDriver: true,
		});
		spring.start();
		return () => spring.stop();
	}, [previewIndex, reduceMotion, thumbScale]);

	useEffect(() => {
		burstProgress.stopAnimation();
		burstProgress.setValue(0);
		if (!isMaximum || disabled || reduceMotion) {
			return;
		}
		const burst = Animated.timing(burstProgress, {
			toValue: 1,
			duration: 650,
			useNativeDriver: true,
		});
		burst.start();
		return () => burst.stop();
	}, [burstProgress, disabled, isMaximum, reduceMotion]);

	useEffect(() => {
		for (const particle of particleValues) {
			particle.stopAnimation();
			particle.setValue(0);
		}
		if (!isMaximum || disabled || reduceMotion || trackWidth <= 0) {
			return;
		}
		const stream = Animated.loop(Animated.stagger(105, particleValues.map((particle, index) => Animated.sequence([
			Animated.timing(particle, {
				toValue: 1,
				duration: 1_050 + index * 35,
				useNativeDriver: true,
			}),
			Animated.timing(particle, { toValue: 0, duration: 0, useNativeDriver: true }),
		]))));
		stream.start();
		return () => stream.stop();
	}, [disabled, isMaximum, particleValues, reduceMotion, trackWidth]);

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

	const indexFromPageX = useCallback((pageX: number) => {
		if (efforts.length <= 1 || sliderWidth.current <= 0) {
			return 0;
		}
		const ratio = Math.max(0, Math.min(1, (pageX - sliderPageX.current) / sliderWidth.current));
		return Math.round(ratio * (efforts.length - 1));
	}, [efforts.length]);

	const commitIndex = useCallback((index: number) => {
		const safeIndex = setPreview(index);
		const nextEffort = efforts[safeIndex];
		if (nextEffort !== undefined && nextEffort !== value) {
			onChange(nextEffort);
		}
	}, [efforts, onChange, setPreview, value]);

	const panResponder = useMemo(() => PanResponder.create({
		onStartShouldSetPanResponder: () => !disabled && efforts.length > 1,
		onMoveShouldSetPanResponder: () => !disabled && efforts.length > 1,
		onPanResponderGrant: event => { setPreview(indexFromPageX(event.nativeEvent.pageX)); },
		onPanResponderMove: (_event, gestureState) => { setPreview(indexFromPageX(gestureState.moveX)); },
		onPanResponderRelease: (event, gestureState) => {
			const pageX = gestureState.moveX === 0 ? event.nativeEvent.pageX : gestureState.moveX;
			commitIndex(indexFromPageX(pageX));
		},
		onPanResponderTerminate: () => { setPreviewIndex(selectedIndex); },
	}), [commitIndex, disabled, efforts.length, indexFromPageX, selectedIndex, setPreview]);

	if (efforts.length === 0) {
		return null;
	}

	const onLayout = (event: LayoutChangeEvent) => {
		const width = event.nativeEvent.layout.width;
		setTrackWidth(width);
		sliderWidth.current = width;
		sliderRef.current?.measureInWindow((pageX, _pageY, measuredWidth) => {
			sliderPageX.current = pageX;
			sliderWidth.current = measuredWidth;
		});
	};

	return (
		<View style={[styles.container, disabled && styles.disabled]}>
			<View style={styles.labelRow}>
				<Text style={styles.label}>Effort</Text>
				<Text style={[styles.value, { color: accentColor }]}>{activeEffort}</Text>
			</View>
			<View
				ref={sliderRef}
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
					<View style={[styles.range, { width: `${progress * 100}%`, backgroundColor: accentColor }]} />
					{isMaximum && !disabled && !reduceMotion ? (
						<View pointerEvents="none" style={[styles.particleClip, { width: `${progress * 100}%` }]}>
							{particleValues.map((particle, index) => (
								<Animated.View
									key={index}
									style={[
										styles.particle,
										{
											top: `${14 + index * 17 % 72}%`,
											opacity: particle.interpolate({ inputRange: [0, 0.15, 0.78, 1], outputRange: [0, 0.9, 0.55, 0] }),
											transform: [
												{ translateX: particle.interpolate({ inputRange: [0, 1], outputRange: [-12, trackWidth + 12] }) },
												{ scale: particle.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 1, 0.8] }) },
											],
										},
									]}
								/>
							))}
						</View>
					) : null}
					{efforts.map((effort, index) => {
						const position = efforts.length === 1 ? 0 : index / (efforts.length - 1) * 100;
						return <View key={effort} style={[styles.tick, { left: `${position}%` }, index <= previewIndex && styles.tickActive]} />;
					})}
				</View>
				{isMaximum && !disabled && !reduceMotion ? (
					<Animated.View
						pointerEvents="none"
						style={[
							styles.burstRing,
							{
								left: `${progress * 100}%`,
								borderColor: accentColor,
								shadowColor: accentColor,
								opacity: burstProgress.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.85, 0] }),
								transform: [{ scale: burstProgress.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.9] }) }],
							},
						]}
					/>
				) : null}
				<Animated.View
					style={[
						styles.thumb,
						{ left: `${progress * 100}%`, transform: [{ scale: thumbScale }] },
						isMaximum && styles.thumbMaximum,
						isMaximum && { shadowColor: accentColor },
					]}
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
	slider: { height: 32, justifyContent: 'center', marginHorizontal: 14 },
	track: { height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,.07)', borderWidth: 0.5, borderColor: colors.border, overflow: 'hidden' },
	range: { height: '100%', borderTopLeftRadius: 12, borderBottomLeftRadius: 12 },
	particleClip: { position: 'absolute', top: 0, left: 0, bottom: 0, overflow: 'hidden' },
	particle: { position: 'absolute', left: 0, width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,.78)', shadowColor: '#fff', shadowOpacity: 0.7, shadowRadius: 3 },
	tick: { position: 'absolute', top: 10, width: 4, height: 4, marginLeft: -2, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.27)' },
	tickActive: { backgroundColor: 'rgba(255,255,255,.68)' },
	burstRing: { position: 'absolute', top: -2, width: 36, height: 36, marginLeft: -18, borderRadius: 18, borderWidth: 2, shadowOpacity: 0.9, shadowRadius: 7 },
	thumb: { position: 'absolute', top: 2, width: 28, height: 28, marginLeft: -14, borderRadius: 14, backgroundColor: '#fff', borderWidth: 0.5, borderColor: colors.borderStrong, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
	thumbMaximum: { shadowOpacity: 0.8, shadowRadius: 10 },
	scaleLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
	scaleLabel: { color: colors.textDim, fontSize: 9.5 },
});

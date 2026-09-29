// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { colors } from '../theme.js';
import { PointerHover } from './pointerHover.js';

/** つかめる帯の幅（pt）。境界線をまたいで左右に半分ずつ置く。 */
const HANDLE_WIDTH = 20;
/** VoiceOver で1回に動かす幅（pt）。 */
const ACCESSIBILITY_STEP = 20;

/**
 * 列の境界をドラッグして幅を変えるつまみ（モックの `.sbgrab` / `.dockgrab`。Orca の左の列とドックの縁）。
 *
 * 親の中で `x`（境界線の位置）を中心に縦いっぱいの帯を重ねる。動かしている間は `onMove` に開始時からの
 * 横の移動量を渡し、動かしてから離したら `onEnd`（ここで保存する）。境界線は動かしている間だけ見えるように明るくする。
 */
export function ColumnResizeHandle({ x, label, onStart, onMove, onEnd, onStep }: {
	x: number;
	/** 読み上げの名前（「サイドバーの幅」など）。 */
	label: string;
	onStart: () => void;
	onMove: (dx: number) => void;
	onEnd: () => void;
	/** VoiceOver の上下スワイプで幅を変える（+1 で右へ広げる向き）。 */
	onStep: (delta: number) => void;
}) {
	const [dragging, setDragging] = useState(false);
	const callbacks = useRef({ onStart, onMove, onEnd });
	callbacks.current = { onStart, onMove, onEnd };
	const responder = useRef(PanResponder.create({
		onStartShouldSetPanResponder: () => true,
		onMoveShouldSetPanResponder: () => true,
		onPanResponderTerminationRequest: () => false,
		onPanResponderGrant: () => {
			setDragging(true);
			callbacks.current.onStart();
		},
		onPanResponderMove: (_, gesture) => callbacks.current.onMove(gesture.dx),
		// 動かさずに離した（触れただけ）なら幅は変わっていないので、保存しない。
		onPanResponderRelease: (_, gesture) => {
			setDragging(false);
			if (gesture.dx !== 0) {
				callbacks.current.onEnd();
			}
		},
		onPanResponderTerminate: (_, gesture) => {
			setDragging(false);
			if (gesture.dx !== 0) {
				callbacks.current.onEnd();
			}
		},
	})).current;
	return (
		<View style={[styles.handle, { left: x - HANDLE_WIDTH / 2 }]} {...responder.panHandlers}>
			<PointerHover effect="tint" cornerRadius={0} style={styles.fill}>
				<View
					style={styles.fill}
					accessible
					accessibilityRole="adjustable"
					accessibilityLabel={label}
					accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
					onAccessibilityAction={event => onStep(event.nativeEvent.actionName === 'increment' ? ACCESSIBILITY_STEP : -ACCESSIBILITY_STEP)}
				>
					<View style={[styles.line, dragging ? styles.lineActive : undefined]} />
				</View>
			</PointerHover>
		</View>
	);
}

const styles = StyleSheet.create({
	handle: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		width: HANDLE_WIDTH,
		zIndex: 20,
	},
	fill: {
		flex: 1,
	},
	line: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		left: HANDLE_WIDTH / 2 - 1,
		width: 2,
		backgroundColor: 'transparent',
	},
	lineActive: {
		backgroundColor: colors.textDim,
		opacity: 0.45,
	},
});

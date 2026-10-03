// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { CameraView } from 'expo-camera';
import { useAppLocked } from '../../appLock.js';
import { colors, radius, space, type } from '../../theme.js';
import { tintOf, useThemeColors } from '../../ui/index.js';

/** 枠の大きさ＝カメラの短い辺のこの割合（Orca の SCAN_RETICLE_SCALE）。 */
const RETICLE_SCALE = 0.62;
/** iPad で枠が大きくなりすぎないための上限（pt。Orca の SCAN_RETICLE_MAX_SIZE）。 */
const RETICLE_MAX_SIZE = 360;
/** 四隅の鉤の長さと太さ（pt。Orca の pair-scan-styles）。 */
const CORNER_SIZE = 28;
const CORNER_WIDTH = 2.5;
/** 四隅の鉤の不透明度。 */
const CORNER_OPACITY = 0.7;

/**
 * QR コードの読み取り（Orca の pair-scan のカメラ）。角丸の枠の中にカメラを出し、
 * 真ん中に四隅だけの正方形の目印を重ねる（iPad のカメラは横長でも、目印は正方形のまま）。
 */
export function PairScanner({ onScanned }: {
	/** 読み取った文字列。`undefined` を渡すと読み取りを止める（処理中・失敗の表示中）。 */
	onScanned: ((data: string) => void) | undefined;
}) {
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const onLayout = (event: LayoutChangeEvent) => {
		const width = Math.round(event.nativeEvent.layout.width);
		const height = Math.round(event.nativeEvent.layout.height);
		setBounds(current => (current.width === width && current.height === height ? current : { width, height }));
	};
	const theme = useThemeColors();
	// ロック中はカメラを止め、読み取りもしない（画面はロック画面の下に残る）。
	const locked = useAppLocked();
	// 四隅の鉤は主ボタンの色（設定 → 色）を 70% で。
	const cornerColor = { borderColor: tintOf(theme.primary, CORNER_OPACITY) };
	const reticle = Math.min(Math.round(Math.min(bounds.width, bounds.height) * RETICLE_SCALE), RETICLE_MAX_SIZE);
	return (
		<View style={styles.wrap} onLayout={onLayout}>
			<CameraView
				style={StyleSheet.absoluteFill}
				facing="back"
				active={!locked}
				barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
				onBarcodeScanned={onScanned !== undefined && !locked ? ({ data }) => onScanned(data) : undefined}
			/>
			<View style={styles.reticle} pointerEvents="none">
				<View style={{ width: reticle, height: reticle }}>
					<View style={[styles.corner, cornerColor, styles.cornerTL]} />
					<View style={[styles.corner, cornerColor, styles.cornerTR]} />
					<View style={[styles.corner, cornerColor, styles.cornerBL]} />
					<View style={[styles.corner, cornerColor, styles.cornerBR]} />
				</View>
			</View>
		</View>
	);
}

/** カメラを外している間（貼り付けのシートを出している間）も同じ場所を占めておく面。 */
export function PairScannerPlaceholder() {
	return <View style={[styles.wrap, styles.placeholder]} />;
}

/** 読み取りの手順（Orca の pair-scan の Step。22pt の丸に番号）。 */
export function PairStep({ number, text }: { number: number; text: string }) {
	return (
		<View style={styles.step}>
			<View style={styles.stepBadge}><Text style={styles.stepNumber}>{number}</Text></View>
			<Text style={styles.stepText}>{text}</Text>
		</View>
	);
}

/** 手順の番号の丸（pt）。 */
const STEP_BADGE = 22;

const styles = StyleSheet.create({
	wrap: {
		flex: 1,
		borderRadius: radius.tile,
		overflow: 'hidden',
		backgroundColor: colors.panel,
	},
	placeholder: {
		backgroundColor: colors.panel,
	},
	reticle: {
		...StyleSheet.absoluteFill,
		alignItems: 'center',
		justifyContent: 'center',
	},
	corner: {
		position: 'absolute',
		width: CORNER_SIZE,
		height: CORNER_SIZE,
	},
	cornerTL: {
		top: 0,
		left: 0,
		borderTopWidth: CORNER_WIDTH,
		borderLeftWidth: CORNER_WIDTH,
		borderTopLeftRadius: radius.row,
	},
	cornerTR: {
		top: 0,
		right: 0,
		borderTopWidth: CORNER_WIDTH,
		borderRightWidth: CORNER_WIDTH,
		borderTopRightRadius: radius.row,
	},
	cornerBL: {
		bottom: 0,
		left: 0,
		borderBottomWidth: CORNER_WIDTH,
		borderLeftWidth: CORNER_WIDTH,
		borderBottomLeftRadius: radius.row,
	},
	cornerBR: {
		bottom: 0,
		right: 0,
		borderBottomWidth: CORNER_WIDTH,
		borderRightWidth: CORNER_WIDTH,
		borderBottomRightRadius: radius.row,
	},
	step: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	stepBadge: {
		width: STEP_BADGE,
		height: STEP_BADGE,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	stepNumber: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.textDim,
	},
	stepText: {
		flex: 1,
		fontSize: type.body,
		lineHeight: 20,
		color: colors.textDim,
	},
});

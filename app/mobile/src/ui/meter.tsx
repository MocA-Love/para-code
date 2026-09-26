// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme.js';
import { meterColor, meterPercent, meterValueLabel } from './statusColors.js';

/**
 * 使用率のメーター（モックの `usageBar`、Orca の UsageBar）。「5時間」「7日」の枠の消費量を
 * 左のラベル・中の棒・右の % で出す。色は 60% 未満が緑、80% 未満が琥珀、それ以上が赤
 * （判定は `statusColors.ts` の `meterColor`）。値が無いときは灰の空の棒とダッシュ。
 *
 * ```tsx
 * <MeterRow>
 *   <Meter label="5時間" percent={42} reset="2時間10分後にリセット" />
 *   <Meter label="7日" percent={71} />
 * </MeterRow>
 * ```
 */
export function Meter({ label, percent, reset }: {
	label: string;
	/** 使った割合（%）。範囲外や小数はそろえてから描く。 */
	percent: number | undefined;
	/** 棒の下に添えるリセットまでの時間など。 */
	reset?: string;
}) {
	const value = meterPercent(percent);
	return (
		<View style={styles.column} accessible accessibilityLabel={`${label} ${meterValueLabel(value)}${reset !== undefined ? `、${reset}` : ''}`}>
			<View style={styles.bar}>
				<Text style={styles.label} numberOfLines={1}>{label}</Text>
				<View style={styles.track}>
					<View style={[styles.fill, { width: `${value ?? 0}%`, backgroundColor: meterColor(value) }]} />
				</View>
				<Text style={styles.value}>{meterValueLabel(value)}</Text>
			</View>
			{reset !== undefined ? <Text style={styles.reset} numberOfLines={1}>{reset}</Text> : null}
		</View>
	);
}

/** メーターを横に並べる（モックの `.ubars`。間隔 12）。 */
export function MeterRow({ children }: { children: ReactNode }) {
	return <View style={styles.row}>{children}</View>;
}

/** ラベルの幅・数字の幅（pt。モックの値）。リセットの行はラベルの幅＋間隔だけ字下げする。 */
const LABEL_WIDTH = 34;
const VALUE_WIDTH = 36;
const TRACK_HEIGHT = 6;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		gap: space.md,
		marginTop: space.xs,
	},
	column: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	bar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	label: {
		width: LABEL_WIDTH,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	track: {
		flex: 1,
		height: TRACK_HEIGHT,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
		overflow: 'hidden',
	},
	fill: {
		height: '100%',
		borderRadius: radius.pill,
	},
	value: {
		width: VALUE_WIDTH,
		fontSize: type.meta,
		color: colors.textDim,
		textAlign: 'right',
	},
	reset: {
		marginLeft: LABEL_WIDTH + space.xs,
		fontSize: type.meta,
		color: colors.textMuted,
	},
});

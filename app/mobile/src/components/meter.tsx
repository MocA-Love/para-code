// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors } from '../theme.js';

/**
 * 使用率に応じた色。60% 未満は緑、85% 未満は黄、それ以上は赤。
 *
 * しきい値は PC 版のタイトルバーの表示（limitsMonitor の SEVERITY_ELEVATED_PERCENT /
 * SEVERITY_HIGH_PERCENT）と同じにしている。Rate Limit 画面は PC と同じ値を並べて見せるので、
 * ここだけ変えると同じ使用率で PC とスマホの色が食い違う。
 *
 * 「残量」を表すメーターには使わない（意味が逆になる）。残量を見せたい場合も、
 * 使用率に直してからこのメーターで描く。
 */
export function meterColor(ratio: number): string {
	if (ratio >= 0.85) {
		return colors.red;
	}
	if (ratio >= 0.6) {
		return colors.yellow;
	}
	return colors.green;
}

/** 0 より大きいのに見えなくなるのを防ぐ最小幅（割合）。 */
const MIN_VISIBLE = 0.02;

/**
 * 横棒のメーター。高さ・角丸・下地の色をここで決め、画面ごとに描き方を変えない。
 *
 * 色を渡さなければ `meterColor` で使用率から決める。量を比べるだけのバー
 * （日別のコストなど）は `color` で固定色を渡す。
 */
export function Meter({ ratio, color, height = 6, style }: {
	/** 0〜1。範囲外は丸める。 */
	ratio: number;
	color?: string;
	height?: number;
	style?: StyleProp<ViewStyle>;
}) {
	const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
	const width = clamped > 0 ? Math.max(clamped, MIN_VISIBLE) : 0;
	const r = height / 2;
	return (
		<View style={[styles.track, { height, borderRadius: r }, style]}>
			<View style={{ width: `${width * 100}%`, height, borderRadius: r, backgroundColor: color ?? meterColor(clamped) }} />
		</View>
	);
}

const styles = StyleSheet.create({
	track: { flex: 1, backgroundColor: colors.surface3, overflow: 'hidden' },
});

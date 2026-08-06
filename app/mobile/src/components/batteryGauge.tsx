// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { batteryLevelClass } from '../batteryLevel.js';
import { colors } from '../theme.js';

/**
 * PCのバッテリー表示（電池グリフ + 残量%）。
 *
 * 色は残量だけを表す（`batteryLevel.ts` の判定）。充電しているかどうかは稲妻の有無だけが表し、
 * 稲妻自体はグレー固定にしてある。こうしておくと「色が変わった＝残量の段階が変わった」と
 * 一意に読めるので、充電を挿しただけで色が変わって驚く、ということが無い。
 *
 * ドロワー上部のPCカードと設定のPC一覧で同じ見た目を使うため、ここに切り出している。
 */
export function BatteryGauge({ level, charging }: { level: number; charging: boolean }) {
	const levelClass = batteryLevelClass(level, charging);
	const low = levelClass === 'low';
	const fill = low ? colors.red : levelClass === 'warn' ? colors.yellow : colors.green;
	return (
		<>
			{charging ? <Ionicons name="flash" size={9} color={colors.textDim} /> : null}
			<View style={[styles.body, low && styles.bodyLow]}>
				{/* 残量が少なくても「空の箱」に見えないよう、描画幅には下限を置く。 */}
				<View style={[styles.fill, { width: `${Math.max(8, level)}%`, backgroundColor: fill }]} />
			</View>
			<View style={[styles.tip, low && styles.tipLow]} />
			<Text style={[styles.pct, low && styles.pctLow]}>{level}%</Text>
		</>
	);
}

const styles = StyleSheet.create({
	body: { width: 17, height: 9, borderRadius: 2.5, borderWidth: 1.2, borderColor: 'rgba(255,255,255,0.5)', padding: 1.5, justifyContent: 'center' },
	bodyLow: { borderColor: 'rgba(244,114,114,0.7)' },
	fill: { height: '100%', borderRadius: 1 },
	tip: { width: 2, height: 3.5, borderTopRightRadius: 1, borderBottomRightRadius: 1, backgroundColor: 'rgba(255,255,255,0.5)', marginLeft: -3 },
	tipLow: { backgroundColor: 'rgba(244,114,114,0.7)' },
	pct: { color: colors.textDim, fontSize: 10.5, fontWeight: '700' },
	pctLow: { color: colors.red },
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import {
	TERMINAL_FONT_SIZE_MAX,
	TERMINAL_FONT_SIZE_MIN,
	terminalGridFor,
} from '../src/terminalViewport.js';
import { colors, mono } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

/**
 * 設定 →「ターミナル」。文字サイズと、PC側のターミナルをこの画面の幅に合わせるかを決める。
 *
 * ここでの選択はこの端末の中だけに保存し、PCへは送らない（PCが持つと複数台のスマホで
 * 奪い合いになる）。実際にPCへ届くのはターミナル画面を開いている間の寸法申告だけで、
 * その申告を出すかどうかを「スマホの幅に合わせる」が決めている。
 *
 * プレビューの桁数はターミナル画面と同じ計算（terminalViewport.ts）で出すが、
 *
 * - フォントの実寸はWebViewでしか測れないため、ここでは Menlo の代表値で概算する
 * - 幅はプレビュー枠を `onLayout` で実測して使う。ウィンドウ幅から引き算すると、iPadでは
 *   サイドバーと本文カラム幅ぶん過大になる（CLAUDE.md「ウィンドウ幅を本文幅と思って
 *   計算しない」）
 *
 * 行数はターミナル画面の高さに依存し、この画面からは分からないため出さない。
 */

/** Menlo の代表値（100px時の1文字送り / 行送り）。プレビューの概算にだけ使う。 */
const MENLO_APPROX = { charWidth100: 60.205, lineHeight100: 120 };

export default function TerminalSettingsScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useContentColumnStyle();
	const { terminalPrefs, setTerminalPref } = useAppStore(useShallow(s => ({
		terminalPrefs: s.terminalPrefs, setTerminalPref: s.setTerminalPref,
	})));
	// プレビュー枠の実測幅。ターミナル画面の本文幅もほぼ同じ（どちらも本文カラムいっぱい）なので、
	// ここから概算した桁数がそのまま目安になる。
	const [previewWidth, setPreviewWidth] = useState(0);

	const preview = useMemo(
		// 高さはこの画面からは分からないので、行数は使わず桁数だけを見る。
		() => terminalGridFor(previewWidth - 16, 1000, terminalPrefs.fontSize, MENLO_APPROX),
		[previewWidth, terminalPrefs.fontSize],
	);

	const stepFontSize = (delta: number) => {
		const next = terminalPrefs.fontSize + delta;
		if (next < TERMINAL_FONT_SIZE_MIN || next > TERMINAL_FONT_SIZE_MAX) {
			return;
		}
		hapticSelection();
		setTerminalPref('fontSize', next);
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Pressable style={styles.closeBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="戻る">
					<Ionicons name="chevron-back" size={16} color={colors.textDim} />
				</Pressable>
				<Text style={styles.title}>ターミナル</Text>
			</View>
			<ScrollView style={styles.scroll} contentContainerStyle={[{ paddingBottom: insets.bottom + 24 }, column]}>
				<Text style={styles.sectionTitle}>表示</Text>
				<View style={styles.card}>
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>文字サイズ</Text>
							<Text style={styles.rowDesc}>小さいほど1画面に入る情報が増えます</Text>
						</View>
						<View style={styles.stepper}>
							<Pressable
								style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
								onPress={() => stepFontSize(-1)}
								disabled={terminalPrefs.fontSize <= TERMINAL_FONT_SIZE_MIN}
								accessibilityLabel="文字を小さく"
							>
								<Ionicons name="remove" size={17} color={terminalPrefs.fontSize <= TERMINAL_FONT_SIZE_MIN ? colors.textDim : colors.accent} />
							</Pressable>
							<Text style={styles.stepValue}>{terminalPrefs.fontSize}pt</Text>
							<Pressable
								style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
								onPress={() => stepFontSize(1)}
								disabled={terminalPrefs.fontSize >= TERMINAL_FONT_SIZE_MAX}
								accessibilityLabel="文字を大きく"
							>
								<Ionicons name="add" size={17} color={terminalPrefs.fontSize >= TERMINAL_FONT_SIZE_MAX ? colors.textDim : colors.accent} />
							</Pressable>
						</View>
					</View>
					<View style={styles.preview} onLayout={event => setPreviewWidth(event.nativeEvent.layout.width)}>
						<Text style={[styles.previewLine, { fontSize: terminalPrefs.fontSize }]} numberOfLines={1}>
							user@paracode ~/projects/example % git status --short
						</Text>
						<Text style={[styles.previewLine, styles.previewDim, { fontSize: terminalPrefs.fontSize }]} numberOfLines={1}>
							 M src/components/termView.tsx
						</Text>
						<Text style={[styles.previewLine, { fontSize: terminalPrefs.fontSize }]} numberOfLines={1}>
							user@paracode ~/projects/example % ▊
						</Text>
					</View>
					{preview !== undefined ? (
						<Text style={styles.rowDesc}>この幅ではおよそ <Text style={styles.emphasis}>1行 {preview.cols} 桁</Text> になります</Text>
					) : null}
					<View style={styles.cardBottomPad} />
				</View>

				<Text style={styles.sectionTitle}>PC側の端末幅</Text>
				<View style={styles.card}>
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={styles.rowTitle}>スマホの幅に合わせる<Text style={styles.beta}>  ベータ</Text></Text>
							<Text style={styles.rowDesc}>
								見ている間だけ、PCのターミナルをこの画面に入る幅へ細くします。Claude や Codex の画面もその幅で描き直されます。見るのをやめると元に戻ります
							</Text>
						</View>
						<Switch
							value={terminalPrefs.matchPcWidth}
							onValueChange={value => { hapticSelection(); setTerminalPref('matchPcWidth', value); }}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
					<View style={styles.separator} />
					<View style={styles.row}>
						<View style={styles.rowBody}>
							<Text style={[styles.rowTitle, !terminalPrefs.matchPcWidth && styles.disabled]}>行数も合わせる</Text>
							<Text style={[styles.rowDesc, !terminalPrefs.matchPcWidth && styles.disabled]}>
								縦もこの画面に合わせます。オフにすると桁だけを合わせ、行数はPCのままにします（PCのターミナルが表示領域から縦にはみ出すのが気になるとき）
							</Text>
						</View>
						<Switch
							value={terminalPrefs.matchPcRows}
							onValueChange={value => { hapticSelection(); setTerminalPref('matchPcRows', value); }}
							disabled={!terminalPrefs.matchPcWidth}
							trackColor={{ true: colors.accent2 }}
						/>
					</View>
				</View>
				<Text style={styles.note}>
					幅を変えるとシェルやTUIが画面を描き直すため、コマンドの実行中でも表示が一度作り直されます（出力そのものが消えることはありません）。
					同じターミナルを他のスマホやiPadからも見ている場合は、いちばん狭い画面に合わせます。
				</Text>
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 10 },
	title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, flex: 1 },
	closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	scroll: { flex: 1, paddingHorizontal: 16 },
	sectionTitle: { color: colors.textDim, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 8 },
	card: { backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
	rowBody: { flex: 1, minWidth: 0 },
	rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
	rowDesc: { color: colors.textDim, fontSize: 11.5, marginTop: 2, lineHeight: 15 },
	emphasis: { color: colors.accent, fontFamily: mono.ios },
	beta: { color: colors.textDim, fontSize: 10.5, fontWeight: '600' },
	disabled: { opacity: 0.4 },
	separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
	stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: 9, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	stepBtn: { width: 34, height: 32, alignItems: 'center', justifyContent: 'center' },
	stepBtnPressed: { backgroundColor: colors.accentWash },
	stepValue: { color: colors.text, fontFamily: mono.ios, fontSize: 13, minWidth: 46, textAlign: 'center' },
	// 実際のターミナルと同じ背景で出す（選んだサイズが実物でどう見えるかを確かめるため）。
	preview: { backgroundColor: '#1e1e1e', borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 8, marginBottom: 10, overflow: 'hidden' },
	previewLine: { color: '#d4d4d4', fontFamily: mono.ios, lineHeight: undefined },
	previewDim: { color: '#d7ba7d' },
	cardBottomPad: { height: 12 },
	note: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 10, paddingHorizontal: 4 },
});

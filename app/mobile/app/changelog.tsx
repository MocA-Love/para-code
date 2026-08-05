// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MOBILE_CHANGELOG } from '../src/changelog.js';
import { APP_VERSION, ChangelogRow, formatDate } from '../src/components/updateSheet.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../src/ipad/useContentColumn.js';
import { colors } from '../src/theme.js';
import { hapticImpact } from '../src/haptics.js';

/**
 * 更新履歴の一覧。起動時のお知らせシートを閉じたあとでも読み返せるようにするための画面で、
 * データ（`src/changelog.ts`）はシートと共有する（書く場所は常に1箇所）。
 */
export default function ChangelogScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				<Pressable style={styles.backBtn} onPress={() => { hapticImpact('light'); router.back(); }} accessibilityRole="button" accessibilityLabel="戻る">
					<Ionicons name="chevron-back" size={20} color={colors.text} />
				</Pressable>
				<View style={styles.headerBody}>
					<Text style={styles.title}>更新履歴</Text>
					<Text style={styles.subtitle}>現在のバージョン {APP_VERSION}</Text>
				</View>
			</View>
			<ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }, column]}>
				{MOBILE_CHANGELOG.map(release => (
					<View key={release.version} style={styles.release}>
						<View style={styles.releaseHead}>
							<Text style={[styles.versionChip, release.version !== APP_VERSION && styles.versionChipOld]}>{release.version}</Text>
							<Text style={styles.date}>{formatDate(release.date)}</Text>
						</View>
						{release.headline !== undefined ? <Text style={styles.headline}>{release.headline}</Text> : null}
						{release.items.length > 0
							? <View style={styles.items}>{release.items.map(item => <ChangelogRow key={item.title} item={item} />)}</View>
							: <Text style={styles.empty}>内部の整備のみの更新です。</Text>}
					</View>
				))}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingBottom: 12 },
	backBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
	headerBody: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: 20, fontWeight: '800' },
	subtitle: { color: colors.textDim, fontSize: 11, marginTop: 1 },
	body: { paddingHorizontal: 18, paddingTop: 4, gap: 26 },
	release: { gap: 12 },
	releaseHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	versionChip: { color: colors.accent, backgroundColor: colors.accentWash, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(9,175,217,0.26)', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2, fontSize: 10.5, fontWeight: '800', overflow: 'hidden' },
	versionChipOld: { color: colors.textDim, backgroundColor: colors.surface2, borderColor: colors.border },
	date: { color: colors.textDim, fontSize: 11 },
	headline: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 21 },
	items: { gap: 14 },
	empty: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
});

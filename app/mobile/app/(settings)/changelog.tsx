// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { MOBILE_CHANGELOG } from '../../src/changelog.js';
import { APP_VERSION, ChangelogRow, formatDate } from '../../src/components/updateSheet.js';
import { ScreenHeader } from '../../src/components/screenHeader.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../src/ipad/useContentColumn.js';
import { colors, radius, squircle } from '../../src/theme.js';

/**
 * 更新履歴の一覧。起動時のお知らせシートを閉じたあとでも読み返せるようにするための画面で、
 * データ（`src/changelog.ts`）はシートと共有する（書く場所は常に1箇所）。
 */
export default function ChangelogScreen() {
	const insets = useStableInsets();
	// ヘッダーは本文の上に浮いているので、その実測高さぶんだけ本文の頭を空ける
	const [headerHeight, setHeaderHeight] = useState(0);
	// iPadの広い幅では本文を読みやすい列幅に収める（iPhoneでは無変化）
	const column = useContentColumnStyle();
	return (
		<View style={styles.screen}>
			<ScreenHeader title="更新履歴" subtitle={`現在のバージョン ${APP_VERSION}`} onHeightChange={setHeaderHeight} />
			<ScrollView contentContainerStyle={[styles.body, { paddingTop: headerHeight, paddingBottom: insets.bottom + 32 }, column]}>
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
	body: { paddingHorizontal: 18, gap: 26 },
	release: { gap: 12 },
	releaseHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	versionChip: { color: colors.accent, backgroundColor: colors.accentWash, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(9,175,217,0.26)', borderRadius: radius.pill, ...squircle, paddingHorizontal: 9, paddingVertical: 2, fontSize: 10.5, fontWeight: '800', overflow: 'hidden' },
	versionChipOld: { color: colors.textDim, backgroundColor: colors.surface2, borderColor: colors.border },
	date: { color: colors.textDim, fontSize: 11 },
	headline: { color: colors.text, fontSize: 15, fontWeight: '700', lineHeight: 21 },
	items: { gap: 14 },
	empty: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
});

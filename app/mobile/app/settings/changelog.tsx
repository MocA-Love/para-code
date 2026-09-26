// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MOBILE_CHANGELOG } from '../../src/changelog.js';
import { APP_VERSION, formatDate } from '../../src/components/updateSheet.js';
import { colors, radius, space, type } from '../../src/theme.js';
import { iconSize } from '../../src/ui/index.js';
import { GroupHeader, SettingsScreen } from '../../src/features/settings/settingsScaffold.js';

/** 項目のアイコンの台（pt）。 */
const ITEM_ICON = 32;

/**
 * 更新履歴（`/settings/changelog`）。起動時のお知らせを閉じたあとでも読み返せるようにする画面。
 * データは起動時のお知らせと同じ `src/changelog.ts` の `MOBILE_CHANGELOG`（書く場所は1か所）。
 *
 * 版ごとに見出し（版と日付）→ 目玉があれば大見出し → 項目の束。項目のアイコンは changelog の
 * データが Ionicons の名前で持っているので、ここだけ Ionicons で描く（色は付けない。色は状態のときだけ）。
 */
export default function ChangelogScreen() {
	return (
		<SettingsScreen title="更新履歴" subtitle={`いまのバージョン ${APP_VERSION}`}>
			{MOBILE_CHANGELOG.map((release, index) => (
				<Fragment key={release.version}>
					<GroupHeader title={`${release.version}${release.version === APP_VERSION ? '（いまの版）' : ''} · ${formatDate(release.date)}`} first={index === 0} />
					{release.headline !== undefined ? <Text style={styles.headline}>{release.headline}</Text> : null}
					<View style={styles.group}>
						{release.items.length === 0 ? (
							<Text style={styles.empty}>内部の整備だけの更新です。</Text>
						) : release.items.map((item, itemIndex) => (
							<Fragment key={item.title}>
								{itemIndex > 0 ? <View style={styles.separator} /> : null}
								<View style={styles.item}>
									<View style={styles.itemIcon}>
										<Ionicons name={item.icon as keyof typeof Ionicons.glyphMap} size={iconSize.md} color={colors.textDim} />
									</View>
									<View style={styles.itemText}>
										<Text style={styles.itemTitle}>{item.title}</Text>
										{item.body !== undefined ? <Text style={styles.itemBody}>{item.body}</Text> : null}
									</View>
								</View>
							</Fragment>
						))}
					</View>
				</Fragment>
			))}
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	headline: {
		fontSize: type.heading,
		fontWeight: '700',
		lineHeight: 22,
		color: colors.text,
		marginHorizontal: space.xs,
		marginBottom: space.sm,
	},
	group: {
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		overflow: 'hidden',
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
		marginHorizontal: space.md,
	},
	item: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.md,
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
	},
	itemIcon: {
		width: ITEM_ICON,
		height: ITEM_ICON,
		borderRadius: radius.row,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	itemText: {
		flex: 1,
		minWidth: 0,
	},
	itemTitle: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	itemBody: {
		fontSize: type.meta,
		lineHeight: 18,
		color: colors.textDim,
		marginTop: 3,
	},
	empty: {
		fontSize: type.meta,
		color: colors.textMuted,
		paddingVertical: space.md,
		paddingHorizontal: space.md + 2,
	},
});

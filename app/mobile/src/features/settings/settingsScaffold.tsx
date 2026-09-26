// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactElement, ReactNode } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View, type RefreshControlProps, type StyleProp, type ViewStyle } from 'react-native';
import { hapticSelection } from '../../haptics.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { colors, space, type } from '../../theme.js';
import { Screen, ScreenHeader, SectionHeader } from '../../ui/index.js';

/**
 * 設定まわりの画面の骨組み（モックの `.set` / `.settop` / `.gh` / `.gd` / `.sw`）。
 * 設定・使用量・通知の一覧・ターミナルなど `/settings/*` の画面はこれで組む。
 *
 * ```tsx
 * <SettingsScreen title="ターミナル">
 *   <GroupHeader title="文字サイズ" first />
 *   <GroupNote>スマホの幅に…</GroupNote>
 *   <ListGroup>
 *     <ListRow label="文字サイズ" hint="10pt" trailing="chevron" onPress={open} />
 *   </ListGroup>
 * </SettingsScreen>
 * ```
 *
 * src/ui へ上げたい部品（段階6の担当から親へ依頼済み）。
 */
export function SettingsScreen({ title, subtitle, right, children, refreshControl, footer }: {
	title: string;
	subtitle?: string;
	/** ヘッダーの右（`HeaderButton` か、文字のボタン）。 */
	right?: ReactNode;
	children: ReactNode;
	refreshControl?: ReactElement<RefreshControlProps>;
	/** スクロールの外、画面の下に置くもの（シートなど）。 */
	footer?: ReactNode;
}) {
	const insets = useStableInsets();
	// iPad の広い幅では読みやすい列幅に収める（iPhone では何もしない）
	const column = useContentColumnStyle();
	return (
		<Screen>
			<ScreenHeader title={title} subtitle={subtitle} right={right} variant="settings" />
			<ScrollView
				contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xl + space.lg }, column]}
				refreshControl={refreshControl}
				keyboardShouldPersistTaps="handled"
			>
				{children}
			</ScrollView>
			{footer}
		</Screen>
	);
}

/** まとまりの見出し（モックの `.gh`。11pt の弱い灰、上に 24 空ける）。先頭のまとまりは `first`。 */
export function GroupHeader({ title, first = false }: { title: string; first?: boolean }) {
	return <SectionHeader title={title} style={[styles.groupHeader, first ? styles.groupHeaderFirst : undefined]} />;
}

/**
 * 見出しの下の説明（モックの `.gd`。12pt の弱い灰）。束の下に添えるときは `after`（上に 8 空ける）。
 */
export function GroupNote({ children, after = false, style }: { children: ReactNode; after?: boolean; style?: StyleProp<ViewStyle> }) {
	return <View style={[after ? styles.noteAfter : undefined, style]}><Text style={styles.note}>{children}</Text></View>;
}

/** 束の下・束の中に添える注記（モックの `.hint`）。 */
export function GroupHint({ children }: { children: ReactNode }) {
	return <Text style={styles.hint}>{children}</Text>;
}

/** 束と束の間の余白（モックの `.sec + .sec` / `.secsp`）。 */
export function GroupGap() {
	return <View style={styles.gap} />;
}

/**
 * 設定の切り替え（モックの `.sw`: オフは一段明るい面、オンは補足の灰、つまみは本文の白）。
 * 切り替えると軽く震わせる。
 */
export function SettingsSwitch({ value, onValueChange, disabled = false, accessibilityLabel }: {
	value: boolean;
	onValueChange: (value: boolean) => void;
	disabled?: boolean;
	accessibilityLabel?: string;
}) {
	return (
		<Switch
			value={value}
			onValueChange={next => {
				hapticSelection();
				onValueChange(next);
			}}
			disabled={disabled}
			trackColor={{ false: colors.raised, true: colors.textDim }}
			ios_backgroundColor={colors.raised}
			thumbColor={colors.text}
			accessibilityLabel={accessibilityLabel}
		/>
	);
}

const styles = StyleSheet.create({
	body: {
		paddingHorizontal: space.lg,
		paddingTop: space.md,
	},
	groupHeader: {
		marginTop: space.xl,
		marginBottom: space.xs,
	},
	groupHeaderFirst: {
		marginTop: 0,
	},
	note: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
		marginHorizontal: space.xs,
		marginBottom: space.sm,
	},
	noteAfter: {
		marginTop: space.sm,
	},
	hint: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textMuted,
		paddingHorizontal: space.md + 2,
		paddingTop: space.sm,
		paddingBottom: space.md,
	},
	gap: {
		height: space.md,
	},
});

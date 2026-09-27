// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Archive, Bell, ChevronLeft, CircleUser, Funnel, Layers, PanelLeftClose, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticSelection } from '../../haptics.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { PointerHover } from '../../ipad/pointerHover.js';
import { useWindowControlsInset } from '../../ipad/windowControls.js';
import { colors, radius, space, type } from '../../theme.js';
import { Icon, connectionColor, iconSize, useThemeColors, type ConnectionKind, type LucideIcon } from '../../ui/index.js';

/**
 * PC の画面の2段のヘッダー（Orca の host-screen-header。モックの `.chrome`）。
 *  - 上段: 戻る（32）・状態の点と PC 名（15/600）・その下の補足（12）・切れているときの「再接続」
 *  - 下段（ツールバー）: 絞り込みのチップ・並び順・グループ・右端のアイコン（アーカイブ・使用量・通知・検索）
 */
export function PcHeader({ name, kind, detail, onReconnect, onBack, onCollapse, toolbar, search }: {
	name: string;
	kind: ConnectionKind;
	detail: string;
	/** 渡すと右上に「再接続」を出す（つながっていないとき）。 */
	onReconnect?: () => void;
	/** 戻る（PC の一覧へ）。省略すると前の画面へ。 */
	onBack?: () => void;
	/** 渡すと右上に「サイドバーを隠す」を出す（iPad の2列でセッションを開いているとき）。 */
	onCollapse?: () => void;
	toolbar: ReactNode;
	/** 検索欄（開いているときだけ渡す）。 */
	search?: ReactNode;
}) {
	const router = useRouter();
	const insets = useStableInsets();
	// iPad のウィンドウアプリで左上に出る操作ボタンの右から始める（上段だけ。下段のツールバーはボタンより下）。
	const controlsInset = useWindowControlsInset();
	const goBack = () => {
		hapticSelection();
		if (onBack !== undefined) {
			onBack();
			return;
		}
		if (router.canGoBack()) {
			router.back();
		} else {
			router.replace('/');
		}
	};
	return (
		<View style={[styles.chrome, { paddingTop: insets.top }]}>
			<View style={[styles.status, controlsInset > 0 ? { paddingLeft: space.lg + controlsInset } : undefined]}>
				<Pressable
					style={({ pressed }) => [styles.back, pressed ? styles.pressed : undefined]}
					hitSlop={hitSlopToMinimum(BACK_SIZE, BACK_SIZE)}
					onPress={goBack}
					accessibilityRole="button"
					accessibilityLabel="PC の一覧へ戻る"
				>
					<Icon icon={ChevronLeft} size={iconSize.back} color={colors.text} />
				</Pressable>
				<View style={styles.identity}>
					<View style={styles.nameLine}>
						<View style={[styles.dot, { backgroundColor: kind === 'connected' ? connectionColor(kind) : kind === 'connecting' ? colors.amber : colors.red }]} />
						<Text style={styles.name} numberOfLines={1} accessibilityRole="header">{name}</Text>
					</View>
					<Text style={styles.detail} numberOfLines={1}>{detail}</Text>
				</View>
				{onReconnect !== undefined ? (
					<Pressable
						style={({ pressed }) => [styles.reconnect, pressed ? styles.pressed : undefined]}
						hitSlop={hitSlopToMinimum(RECONNECT_HEIGHT)}
						onPress={onReconnect}
						accessibilityRole="button"
						accessibilityLabel="再接続"
					>
						<Text style={styles.reconnectText}>再接続</Text>
					</Pressable>
				) : null}
				{onCollapse !== undefined ? (
					<PointerHover effect="highlight" cornerRadius={radius.button}>
						<Pressable
							style={({ pressed }) => [styles.collapse, pressed ? styles.pressed : undefined]}
							hitSlop={hitSlopToMinimum(COLLAPSE_SIZE, COLLAPSE_SIZE)}
							onPress={() => { hapticSelection(); onCollapse(); }}
							accessibilityRole="button"
							accessibilityLabel="サイドバーを隠す"
							accessibilityHint={'⌘\\ でも隠せます'}
						>
							<Icon icon={PanelLeftClose} size={iconSize.sm} color={colors.textDim} />
						</Pressable>
					</PointerHover>
				) : null}
			</View>
			<View style={styles.toolbar}>{toolbar}</View>
			{search}
		</View>
	);
}

/** ツールバーの左端の「絞り込み」のチップ（選んでいる数を添える）。 */
export function FilterChip({ count, onPress }: { count: number; onPress: () => void }) {
	const on = count > 0;
	return (
		<Pressable
			style={({ pressed }) => [styles.chip, on ? styles.chipOn : undefined, pressed ? styles.pressed : undefined]}
			hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={on ? `絞り込み、${count}件選択中` : '絞り込み'}
		>
			<Icon icon={Funnel} size={iconSize.xs} color={on ? colors.text : colors.textDim} />
			<Text style={[styles.chipText, on ? styles.chipTextOn : undefined]}>{on ? `絞り込み ${count}` : '絞り込み'}</Text>
		</Pressable>
	);
}

/** 並び順・グループの切り替え（アイコンと今の値）。 */
export function ModeButton({ kind, label, onPress }: { kind: 'sort' | 'group'; label: string; onPress: () => void }) {
	return (
		<Pressable
			style={({ pressed }) => [styles.mode, pressed ? styles.pressed : undefined]}
			hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={kind === 'sort' ? `並び順、${label}` : `グループ、${label}`}
		>
			<Icon icon={kind === 'sort' ? SlidersHorizontal : Layers} size={iconSize.sm} color={colors.textDim} />
			<Text style={styles.modeText} numberOfLines={1}>{label}</Text>
		</Pressable>
	);
}

/** ツールバーの右端のアイコン（16pt、当たり判定は 44pt）。 */
export function ToolbarIcon({ icon, label, onPress, badge, disabled = false }: {
	icon: LucideIcon;
	label: string;
	onPress: () => void;
	badge?: number;
	disabled?: boolean;
}) {
	return (
		<PointerHover effect="highlight" cornerRadius={radius.button}>
		<Pressable
			style={({ pressed }) => [styles.toolIcon, pressed ? styles.pressed : undefined, disabled ? styles.disabled : undefined]}
			hitSlop={hitSlopToMinimum(TOOL_ICON_SIZE, TOOL_ICON_SIZE)}
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={badge !== undefined && badge > 0 ? `${label}、${badge}件` : label}
			accessibilityState={{ disabled }}
		>
			<Icon icon={icon} size={iconSize.md} color={colors.textDim} />
			{badge !== undefined && badge > 0 ? (
				<View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text></View>
			) : null}
		</Pressable>
		</PointerHover>
	);
}

/** ツールバーの右端のアイコンの並び（左から アーカイブ・使用量・通知・検索）。 */
export function ToolbarRight({ archivedCount, unread, searching, usageDisabled, onArchive, onUsage, onNotifications, onToggleSearch }: {
	archivedCount: number;
	unread: number;
	searching: boolean;
	usageDisabled: boolean;
	onArchive: () => void;
	onUsage: () => void;
	onNotifications: () => void;
	onToggleSearch: () => void;
}) {
	return (
		<>
			<View style={styles.spacer} />
			{/* アーカイブの入口は、しまってあるものが1件でもあるときだけ出す（旧ホームと同じ）。 */}
			{archivedCount > 0 ? <ToolbarIcon icon={Archive} label="アーカイブ" badge={archivedCount} onPress={onArchive} /> : null}
			<ToolbarIcon icon={CircleUser} label="使用量" onPress={onUsage} disabled={usageDisabled} />
			<ToolbarIcon icon={Bell} label="通知" badge={unread} onPress={onNotifications} />
			<ToolbarIcon icon={searching ? X : Search} label={searching ? '検索を閉じる' : '検索'} onPress={onToggleSearch} />
		</>
	);
}

/** ヘッダーの下の検索欄（モックの `.searchbar`）。 */
export function PcSearchBar({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const theme = useThemeColors();
	return (
		<View style={styles.searchBar}>
			<View style={styles.searchField}>
				<Icon icon={Search} size={iconSize.md} color={colors.textMuted} />
				<TextInput
					style={styles.searchInput}
					value={value}
					onChangeText={onChange}
					placeholder="エージェントやスペースを検索…"
					placeholderTextColor={colors.textMuted}
					selectionColor={theme.accent}
					autoFocus
					autoCapitalize="none"
					autoCorrect={false}
					keyboardAppearance="dark"
					returnKeyType="search"
					clearButtonMode="while-editing"
					accessibilityLabel="検索"
				/>
			</View>
		</View>
	);
}

/** モックの寸法（pt）。 */
const BACK_SIZE = 32;
const RECONNECT_HEIGHT = 26;
const CHIP_HEIGHT = 26;
const TOOL_ICON_SIZE = 24;
/** 「サイドバーを隠す」の見た目の大きさ（pt。モックの `.sbcollapse`）。当たり判定は 44 に広げる。 */
const COLLAPSE_SIZE = 28;
const SEARCH_HEIGHT = 36;
const DOT_SIZE = 8;

const styles = StyleSheet.create({
	chrome: {
		backgroundColor: colors.panel,
		borderBottomWidth: 1,
		borderBottomColor: colors.border,
	},
	status: {
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: 34,
		paddingTop: space.xs,
		paddingHorizontal: space.lg,
		paddingBottom: space.xs,
	},
	back: {
		width: BACK_SIZE,
		height: BACK_SIZE,
		borderRadius: radius.pill,
		alignItems: 'center',
		justifyContent: 'center',
		marginRight: space.xs,
	},
	identity: {
		flex: 1,
		minWidth: 0,
		marginRight: space.md,
	},
	nameLine: {
		flexDirection: 'row',
		alignItems: 'center',
		minWidth: 0,
	},
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: radius.pill,
		marginRight: space.sm,
	},
	name: {
		flex: 1,
		fontSize: type.input,
		fontWeight: '600',
		color: colors.text,
	},
	detail: {
		marginLeft: space.lg,
		fontSize: type.meta,
		color: colors.textDim,
	},
	collapse: {
		width: COLLAPSE_SIZE,
		height: COLLAPSE_SIZE,
		borderRadius: radius.button,
		alignItems: 'center',
		justifyContent: 'center',
		marginLeft: space.xs,
	},
	reconnect: {
		minHeight: RECONNECT_HEIGHT,
		justifyContent: 'center',
		paddingHorizontal: space.sm,
		borderRadius: radius.button,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
	},
	reconnectText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.text,
	},
	toolbar: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs + 2,
		paddingVertical: space.xs + 2,
		paddingHorizontal: space.md,
		borderTopWidth: 1,
		borderTopColor: colors.border,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minHeight: CHIP_HEIGHT,
		paddingHorizontal: space.sm + 2,
		borderRadius: radius.group,
		borderWidth: 1,
		borderColor: colors.border,
	},
	chipOn: {
		borderColor: colors.textDim,
		backgroundColor: colors.raised,
	},
	chipText: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	chipTextOn: {
		color: colors.text,
	},
	mode: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		minHeight: CHIP_HEIGHT,
		paddingHorizontal: space.xs + 2,
		flexShrink: 1,
	},
	modeText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.textDim,
	},
	spacer: {
		flex: 1,
	},
	toolIcon: {
		width: TOOL_ICON_SIZE,
		height: TOOL_ICON_SIZE,
		borderRadius: radius.button,
		alignItems: 'center',
		justifyContent: 'center',
	},
	badge: {
		position: 'absolute',
		top: -4,
		right: -6,
		minWidth: 16,
		height: 16,
		borderRadius: radius.pill,
		backgroundColor: colors.red,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xs,
	},
	badgeText: {
		fontSize: type.badge,
		fontWeight: '700',
		color: colors.onRed,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	disabled: {
		opacity: 0.45,
	},
	searchBar: {
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	searchField: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		height: SEARCH_HEIGHT,
		borderRadius: radius.tile,
		backgroundColor: colors.raised,
		paddingHorizontal: space.sm + 2,
	},
	searchInput: {
		flex: 1,
		minWidth: 0,
		fontSize: type.input,
		color: colors.text,
		paddingVertical: 0,
	},
});

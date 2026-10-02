// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { CircleAlert, FolderX, MonitorX, TriangleAlert } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { monoFamily } from '../../monoFont.js';
import { colors, radius, space, type } from '../../theme.js';
import { EmptyState, Icon, iconSize } from '../../ui/index.js';
import type { CodeSpaceGate } from './spaceLink.js';

/**
 * ソース管理・差分・ファイルの画面で共有する小さな部品（Orca のモック concept-orca.html の
 * `.banner` `.segs` `.rvbadge` `.state` に当たるもの）。
 */

/**
 * iPad の広い幅で、一覧を読みやすい列幅に収めて中央へ寄せるスタイル（iPhone では undefined）。
 * 差分とコードは広いほど読みやすいので使わない。中身は共通の `useContentColumnStyle()`。
 */
export function useReadableColumn(): StyleProp<ViewStyle> {
	return useContentColumnStyle();
}

/**
 * 接続が切れているときの琥珀のバナー（モックの `.banner`）。一覧は最後に読めたものを出したまま、
 * 操作できない理由をここに書く。
 */
export function OfflineBanner({ reason, style }: { reason: string | undefined; style?: StyleProp<ViewStyle> }) {
	if (reason === undefined) {
		return null;
	}
	return (
		<View style={[styles.banner, style]} accessibilityRole="alert">
			<Icon icon={TriangleAlert} size={iconSize.sm} color={colors.amber} />
			<Text style={styles.bannerText}>{reason}</Text>
		</View>
	);
}

/** 一覧の上の1行の失敗（読み直しに失敗したが、前回の一覧は出している）。 */
export function InlineError({ message, style }: { message: string | undefined; style?: StyleProp<ViewStyle> }) {
	if (message === undefined) {
		return null;
	}
	return (
		<View style={[styles.inlineError, style]}>
			<Icon icon={CircleAlert} size={iconSize.sm} color={colors.red} />
			<Text style={styles.inlineErrorText} numberOfLines={3}>{message}</Text>
		</View>
	);
}

/**
 * 上の区分の切り替え（モックの `.segs` / `.seg`。選択中は白い下線 2）。
 * `ScreenHeader` の children に置く。
 */
export function Segments<K extends string>({ items, value, onChange }: {
	items: readonly { readonly key: K; readonly label: string }[];
	value: K;
	onChange: (key: K) => void;
}) {
	return (
		<View style={styles.segs} accessibilityRole="tablist">
			{items.map(item => {
				const on = item.key === value;
				return (
					<Pressable
						key={item.key}
						onPress={() => { if (!on) { haptic('tick'); onChange(item.key); } }}
						hitSlop={hitSlopToMinimum(SEG_HEIGHT)}
						style={[styles.seg, on ? styles.segOn : undefined]}
						accessibilityRole="tab"
						accessibilityState={{ selected: on }}
					>
						<Text style={[styles.segText, on ? styles.segTextOn : undefined]} numberOfLines={1}>{item.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/** 変更の種類の札（モックの `.rvbadge`。枠と文字をその種類の色で描く）。 */
export function ChangeBadge({ symbol, color, small = false }: { symbol: string; color: string; small?: boolean }) {
	return (
		<View style={[styles.badge, small ? styles.badgeSmall : undefined, { borderColor: color }]}>
			<Text style={[styles.badgeText, small ? styles.badgeTextSmall : undefined, { color }]}>{symbol}</Text>
		</View>
	);
}

/** 画面の真ん中のくるくる（読み込み中）。 */
export function CenterSpinner({ label }: { label?: string }) {
	return (
		<View style={styles.center}>
			<ActivityIndicator color={colors.textDim} />
			{label !== undefined ? <Text style={styles.centerText}>{label}</Text> : null}
		</View>
	);
}

/**
 * 画面の土台がまだ表示できないときの中身（PC が台帳に無い・切り替え中・スペースが無い）。
 * 表示できるときは `children` をそのまま出す。
 */
export function SpaceGateBody({ gate, children }: { gate: CodeSpaceGate; children: ReactNode }) {
	if (gate === 'unknownPc') {
		return <EmptyState icon={MonitorX} title="この PC は見つかりません" body="ペアリングを解除した PC かもしれません。" />;
	}
	if (gate === 'missing') {
		return <EmptyState icon={FolderX} title="このスペースは見つかりません" body="PC 側で閉じられたかもしれません。" />;
	}
	if (gate === 'loading') {
		return <CenterSpinner />;
	}
	return <>{children}</>;
}

/** 区分の見出し（モックの `.ssh`。左に 11/700 の見出し、右に件数）。 */
export function GroupHeading({ title, count }: { title: string; count?: number }) {
	return (
		<View style={styles.heading}>
			<Text style={styles.headingTitle} accessibilityRole="header">{title}</Text>
			{count !== undefined ? <Text style={styles.headingCount}>{count}</Text> : null}
		</View>
	);
}

/** 区分の切り替えの見た目の高さ（pt。モックの `.seg`）。当たり判定は 44 に広げる。 */
const SEG_HEIGHT = 40;
/** 変更の種類の札の大きさ（pt。モックの `.rvbadge` と、ファイルの一覧の `.rfrow .rvbadge`）。 */
const BADGE_SIZE = 28;
const BADGE_SIZE_SMALL = 24;

const styles = StyleSheet.create({
	banner: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		marginHorizontal: space.lg,
		marginTop: space.sm,
		paddingVertical: space.sm,
		paddingHorizontal: space.md,
		borderRadius: radius.row,
		backgroundColor: colors.raised,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	bannerText: {
		flex: 1,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.text,
	},
	inlineError: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
	},
	inlineErrorText: {
		flex: 1,
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.red,
	},
	segs: {
		flexDirection: 'row',
		backgroundColor: colors.panel,
	},
	seg: {
		flex: 1,
		minHeight: SEG_HEIGHT,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.xs,
		borderBottomWidth: 2,
		borderBottomColor: 'transparent',
	},
	segOn: {
		borderBottomColor: colors.text,
	},
	segText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textDim,
	},
	segTextOn: {
		color: colors.text,
	},
	badge: {
		width: BADGE_SIZE,
		height: BADGE_SIZE,
		borderRadius: radius.row,
		borderWidth: StyleSheet.hairlineWidth,
		alignItems: 'center',
		justifyContent: 'center',
	},
	badgeSmall: {
		width: BADGE_SIZE_SMALL,
		height: BADGE_SIZE_SMALL,
	},
	badgeText: {
		fontSize: type.meta,
		fontWeight: '800',
		fontFamily: monoFamily,
	},
	badgeTextSmall: {
		fontSize: type.caption,
	},
	center: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.sm,
		padding: space.xl,
	},
	centerText: {
		fontSize: type.body,
		color: colors.textDim,
	},
	heading: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingTop: space.md,
		paddingBottom: space.xs,
	},
	headingTitle: {
		fontSize: type.caption,
		fontWeight: '700',
		color: colors.textDim,
	},
	headingCount: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textMuted,
	},
});

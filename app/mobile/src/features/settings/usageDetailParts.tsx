// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { RefreshCw, Unplug } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { haptic } from '../../haptics.js';
import { alpha, colors, radius, space, type } from '../../theme.js';
import { EmptyState, HeaderButton } from '../../ui/index.js';

/**
 * 使用量の詳細4画面（コスト・RTK の節約・GitHub API・システム）が共有する部品。
 * 見た目はモック（concept-orca.html）の使用量（`.acsec` / `.accard` / `.acrow` / `.big`）と
 * 設定（`.sec` / `.gd`）に合わせている。数字の算出は `usageDetailModel.ts`。
 */

/** 数字を束ねる面（モックの `.accard`）。子の間に細い区切り線を自動で入れる。 */
export function DetailCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const rows = Children.toArray(children).filter(isValidElement);
	return (
		<View style={[styles.card, style]}>
			{rows.map((row, index) => (
				<Fragment key={row.key ?? index}>
					{index > 0 ? <View style={styles.separator} /> : null}
					{row}
				</Fragment>
			))}
		</View>
	);
}

/** 面の中の「データがありません」などの1行。 */
export function DetailEmptyLine({ children }: { children: string }) {
	return <Text style={styles.emptyLine}>{children}</Text>;
}

/** 棒の区切り1つ（長さは %、色は意味のある色だけ渡す）。 */
export interface BarSegment {
	readonly percent: number;
	readonly color: string;
}

/** 横棒（モックの `.utrack` / `.ufill`。高さ 6、角丸は丸）。区切りを積み上げられる。 */
export function Bar({ segments }: { segments: readonly BarSegment[] }) {
	return (
		<View style={styles.track}>
			{segments.map((segment, index) => (
				<View key={index} style={[styles.fill, { width: `${Math.max(0, Math.min(100, segment.percent))}%`, backgroundColor: segment.color }]} />
			))}
		</View>
	);
}

/** 名前と値の行の下に棒を置く内訳の1行（モデル別・コマンド別・プロセス別など）。 */
export function BarItem({ name, value, sub, segments, footer, accessibilityLabel }: {
	name: string;
	value: string;
	sub?: string;
	segments: readonly BarSegment[];
	/** 棒の下に添えるもの（回数・失敗の数など）。 */
	footer?: ReactNode;
	accessibilityLabel?: string;
}) {
	return (
		<View style={styles.barItem} accessible={accessibilityLabel !== undefined} accessibilityLabel={accessibilityLabel}>
			<View style={styles.barHead}>
				<Text style={styles.barName} numberOfLines={1}>{name}</Text>
				<Text style={styles.barValue} numberOfLines={1}>{value}</Text>
			</View>
			{sub !== undefined ? <Text style={styles.barSub} numberOfLines={1}>{sub}</Text> : null}
			<Bar segments={segments} />
			{footer}
		</View>
	);
}

/** ラベル・棒・値を1行に並べる（日別の推移）。 */
export function InlineBarRow({ label, value, percent, color }: { label: string; value: string; percent: number; color: string }) {
	return (
		<View style={styles.inlineRow} accessible accessibilityLabel={`${label} ${value}`}>
			<Text style={styles.inlineLabel} numberOfLines={1}>{label}</Text>
			<View style={styles.inlineBar}><Bar segments={[{ percent, color }]} /></View>
			<Text style={styles.inlineValue} numberOfLines={1}>{value}</Text>
		</View>
	);
}

/** 大きな数字1つ（モックの `.acrow` の `.big` と補足）。2つを `StatTiles` で横に並べる。 */
export function StatTile({ label, value, sub, valueColor, children }: {
	label: string;
	value: string;
	sub?: string;
	valueColor?: string;
	/** 数字の下に置くもの（使用率の棒など）。 */
	children?: ReactNode;
}) {
	return (
		<View style={styles.tile} accessible accessibilityLabel={`${label} ${value}${sub !== undefined ? `、${sub}` : ''}`}>
			<Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
			<Text style={[styles.tileValue, valueColor !== undefined ? { color: valueColor } : undefined]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
			{sub !== undefined ? <Text style={styles.tileSub}>{sub}</Text> : null}
			{children}
		</View>
	);
}

export function StatTiles({ children }: { children: ReactNode }) {
	return <View style={styles.tiles}>{children}</View>;
}

export interface ChoiceOption<T extends string> {
	readonly value: T;
	readonly label: string;
}

/**
 * 表示の切り替え（期間・エージェント・内訳の軸）。選んでいるものは一段明るい面に白文字。
 * 見た目の高さは 32、当たり判定は 44 に広げる。
 */
export function ChoiceChips<T extends string>({ options, selected, onSelect }: {
	options: readonly ChoiceOption<T>[];
	selected: T;
	onSelect: (value: T) => void;
}) {
	return (
		<View style={styles.chips} accessibilityRole="tablist">
			{options.map(option => {
				const active = option.value === selected;
				return (
					<Pressable
						key={option.value}
						onPress={() => {
							haptic('tick');
							onSelect(option.value);
						}}
						hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
						style={({ pressed }) => [styles.chip, active ? styles.chipActive : undefined, pressed ? styles.chipPressed : undefined]}
						accessibilityRole="tab"
						accessibilityState={{ selected: active }}
						accessibilityLabel={option.label}
					>
						<Text style={[styles.chipText, active ? styles.chipTextActive : undefined]}>{option.label}</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/** 本文に挟む1文（`error` は赤、`warn` は琥珀、`note` は弱い灰の注記）。 */
export function DetailMessage({ tone, children }: { tone: 'error' | 'warn' | 'note'; children: ReactNode }) {
	return (
		<Text
			style={[styles.message, tone === 'error' ? styles.messageError : tone === 'warn' ? styles.messageWarn : styles.messageNote]}
			accessibilityRole={tone === 'error' ? 'alert' : undefined}
		>
			{children}
		</Text>
	);
}

/** 初回の読み込み中。 */
export function DetailLoading() {
	return <ActivityIndicator style={styles.loading} color={colors.textDim} />;
}

/** PC とつながっていないので値が無いとき。 */
export function DetailNotConnected() {
	return (
		<EmptyState
			icon={Unplug}
			title="PC に接続していません"
			body="PC の Para Code とつながると、ここに値が出ます。"
			style={styles.notConnected}
		/>
	);
}

/** ヘッダー右の「再取得」。 */
export function DetailRefreshButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
	return (
		<HeaderButton
			icon={RefreshCw}
			label="再取得"
			round
			disabled={disabled}
			onPress={() => {
				haptic('commit');
				onPress();
			}}
		/>
	);
}

/** 応答しない接続先の直近の値を薄く残す。 */
export const staleStyle: ViewStyle = { opacity: alpha.strong };

/** 見た目のチップの高さ（pt）。 */
const CHIP_HEIGHT = 32;
/** 日別の行のラベルと値の幅（pt）。 */
const INLINE_LABEL_WIDTH = 44;
const INLINE_VALUE_WIDTH = 60;
const TRACK_HEIGHT = 6;

const styles = StyleSheet.create({
	card: {
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		overflow: 'hidden',
		paddingHorizontal: space.md + 2,
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
	},
	emptyLine: {
		fontSize: type.meta,
		color: colors.textMuted,
		paddingVertical: space.md,
	},
	track: {
		flexDirection: 'row',
		height: TRACK_HEIGHT,
		borderRadius: radius.pill,
		backgroundColor: colors.raised,
		overflow: 'hidden',
	},
	fill: {
		height: TRACK_HEIGHT,
	},
	barItem: {
		paddingVertical: space.sm + 2,
		gap: space.xs,
	},
	barHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	barName: {
		flex: 1,
		minWidth: 0,
		fontSize: type.label,
		fontWeight: '500',
		color: colors.text,
	},
	barValue: {
		fontSize: type.meta,
		color: colors.textDim,
		fontVariant: ['tabular-nums'],
	},
	barSub: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	inlineRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
	},
	inlineLabel: {
		width: INLINE_LABEL_WIDTH,
		fontSize: type.meta,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	inlineBar: {
		flex: 1,
	},
	inlineValue: {
		width: INLINE_VALUE_WIDTH,
		fontSize: type.meta,
		color: colors.textDim,
		textAlign: 'right',
		fontVariant: ['tabular-nums'],
	},
	tiles: {
		flexDirection: 'row',
		gap: space.sm + 2,
	},
	tile: {
		flex: 1,
		minWidth: 0,
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		paddingHorizontal: space.md + 2,
		paddingVertical: space.md,
		gap: space.xs,
	},
	tileLabel: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	tileValue: {
		fontSize: type.hero,
		fontWeight: '700',
		letterSpacing: -0.4,
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	tileSub: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
		marginBottom: space.xs,
	},
	chip: {
		minHeight: CHIP_HEIGHT,
		paddingHorizontal: space.md,
		borderRadius: radius.pill,
		borderWidth: 1,
		borderColor: colors.border,
		alignItems: 'center',
		justifyContent: 'center',
	},
	chipActive: {
		backgroundColor: colors.raised,
		borderColor: colors.raised,
	},
	chipPressed: {
		opacity: 0.7,
	},
	chipText: {
		fontSize: type.label,
		fontWeight: '500',
		color: colors.textDim,
	},
	chipTextActive: {
		color: colors.text,
	},
	message: {
		fontSize: type.meta,
		lineHeight: 17,
		marginHorizontal: space.xs,
		marginBottom: space.sm,
	},
	messageError: {
		color: colors.red,
	},
	messageWarn: {
		color: colors.amber,
	},
	messageNote: {
		color: colors.textMuted,
		marginTop: space.sm,
	},
	loading: {
		marginVertical: space.xl,
	},
	notConnected: {
		flex: 0,
		marginTop: space.xl,
	},
});

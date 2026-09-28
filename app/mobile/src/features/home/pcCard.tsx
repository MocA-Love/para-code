// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EllipsisVertical, Monitor } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { colors, radius, space, status, type } from '../../theme.js';
import { Icon, connectionColor, iconSize, type ConnectionKind } from '../../ui/index.js';
import { bucketDotColor } from '../pc/pcListParts.js';
import type { PcCardCounts } from './homeSummary.js';
import { IconTile } from './homeParts.js';

/** 状態の件数の呼び名（theme.status に揃える）。 */
const BUCKET_LABEL = {
	waiting: status.attention.label,
	working: status.running.label,
	review: status.review.label,
	idle: status.idle.label,
} as const;

/**
 * 「デスクトップ」の PC のカード（Orca の MobileHostCard。モックの `hostCard`）。
 *  - 左に 46×46 のモニターの台、名前（15/600）、補足（バッテリー）、状態の点と接続の一文
 *  - つながっていれば「3 スペース · 7 エージェント」と状態ごとの件数、切れていれば再接続の案内
 *  - 右端の ⋮ と長押しで PC のメニュー
 */
export const PcCard = memo(function PcCard({ id, name, kind, connectionText, pairingRejected = false, detail, counts, onOpen, onMenu }: {
	id: string;
	name: string;
	kind: ConnectionKind;
	connectionText: string;
	/** リレーがこの端末の資格を拒んだ（`isPairingRejected`）。再接続ではなく再ペアリングへ案内する。 */
	pairingRejected?: boolean;
	/** 名前の下の補足（バッテリーなど）。無ければ出さない。 */
	detail: string | undefined;
	counts: PcCardCounts;
	onOpen: (id: string) => void;
	onMenu: (id: string) => void;
}) {
	const connected = kind === 'connected';
	return (
		<View style={styles.card}>
			<Pressable
				style={({ pressed }) => [styles.main, pressed ? styles.pressed : undefined]}
				onPress={() => {
					hapticSelection();
					onOpen(id);
				}}
				delayLongPress={400}
				onLongPress={() => {
					hapticImpact('medium');
					onMenu(id);
				}}
				accessibilityRole="button"
				accessibilityLabel={`${name}、${connectionText}`}
				accessibilityHint="長押しで PC の操作を開きます"
			>
				<IconTile><Icon icon={Monitor} size={HOST_ICON} color={connected ? colors.text : colors.textDim} /></IconTile>
				<View style={styles.body}>
					<Text style={[styles.name, connected ? undefined : styles.nameOffline]} numberOfLines={1}>{name}</Text>
					{detail !== undefined ? <Text style={styles.detail} numberOfLines={1}>{detail}</Text> : null}
					<View style={styles.meta}>
						<View style={[styles.dot, { backgroundColor: connected ? connectionColor(kind) : pairingRejected ? colors.red : kind === 'connecting' ? colors.amber : colors.textMuted }]} />
						<Text style={styles.metaText} numberOfLines={1}>{connectionText}</Text>
					</View>
					{connected ? (
						<>
							<Text style={styles.counts}>
								{counts.agents !== undefined ? `${counts.spaces} スペース · ${counts.agents} エージェント` : `${counts.spaces} スペース`}
							</Text>
							{counts.buckets.length > 0 ? (
								<View style={styles.chips}>
									{counts.buckets.map(entry => (
										<View key={entry.bucket} style={styles.chip}>
											<View style={[styles.chipDot, { backgroundColor: bucketDotColor(entry.bucket) }]} />
											<Text style={styles.chipText}>{`${BUCKET_LABEL[entry.bucket]} ${entry.count}`}</Text>
										</View>
									))}
								</View>
							) : null}
						</>
					) : (
						<Text style={styles.offlineHint}>{pairingRejected ? '押すと、ペアリングし直す手順を開きます' : 'PC の Para Code を起動すると、ここから再接続できます'}</Text>
					)}
				</View>
			</Pressable>
			<Pressable
				style={({ pressed }) => [styles.more, pressed ? styles.pressed : undefined]}
				hitSlop={hitSlopToMinimum(MORE_SIZE, MORE_SIZE)}
				onPress={() => {
					hapticSelection();
					onMenu(id);
				}}
				accessibilityRole="button"
				accessibilityLabel={`${name} の操作`}
			>
				<Icon icon={EllipsisVertical} size={iconSize.lg} color={colors.textDim} />
			</Pressable>
		</View>
	);
});

/** モックの寸法（pt）。 */
const MORE_SIZE = 40;
/** モニターのアイコン（モックの `.hosticon` の中身）。 */
const HOST_ICON = 20;
const DOT_SIZE = 8;
const CHIP_DOT = 6;
/** 件数の行の字下げ（点＋間隔ぶん。モックの `.hwt` の margin-left）。 */
const COUNTS_INDENT = 24;

const styles = StyleSheet.create({
	card: {
		flexDirection: 'row',
		alignItems: 'center',
		marginBottom: space.sm,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.card,
		overflow: 'hidden',
	},
	main: {
		flex: 1,
		minWidth: 0,
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: space.md,
		paddingLeft: space.md,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	body: {
		flex: 1,
		minWidth: 0,
		marginRight: space.sm,
	},
	name: {
		fontSize: type.input,
		fontWeight: '600',
		lineHeight: 20,
		color: colors.text,
	},
	nameOffline: {
		color: colors.textDim,
	},
	detail: {
		fontSize: type.meta,
		lineHeight: 16,
		color: colors.textDim,
	},
	meta: {
		flexDirection: 'row',
		alignItems: 'center',
		marginTop: 3,
		minWidth: 0,
	},
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: radius.pill,
		marginRight: space.sm,
	},
	metaText: {
		flexShrink: 1,
		fontSize: type.meta,
		color: colors.textDim,
	},
	counts: {
		marginTop: 2,
		marginLeft: COUNTS_INDENT,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		columnGap: space.sm,
		rowGap: 2,
		marginTop: 2,
		marginLeft: COUNTS_INDENT,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	chipDot: {
		width: CHIP_DOT,
		height: CHIP_DOT,
		borderRadius: radius.pill,
	},
	chipText: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	offlineHint: {
		marginTop: space.xs,
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textMuted,
	},
	more: {
		width: MORE_SIZE,
		height: MORE_SIZE,
		marginHorizontal: space.xs,
		borderRadius: radius.button,
		alignItems: 'center',
		justifyContent: 'center',
	},
});

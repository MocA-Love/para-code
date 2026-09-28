// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Clock, Folder } from 'lucide-react-native';
import type { HomeStatusBucket } from '../../homeSort.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import { lastKnownLabelFor, type LastKnownPcSnapshot } from '../../lastKnownPcs.js';
import { formatRelativeTime } from '../../time.js';
import { colors, radius, space, status, type } from '../../theme.js';
import { Button, Icon, iconSize } from '../../ui/index.js';
import { bucketDotColor } from './pcListParts.js';

const BUCKETS: readonly HomeStatusBucket[] = ['waiting', 'working', 'review', 'idle'];
const BUCKET_LABEL = {
	waiting: status.attention.label,
	working: status.running.label,
	review: status.review.label,
	idle: status.idle.label,
} as const;

/**
 * つながるまでのあいだ PC の画面に出す、前回の一覧（W2-25）。
 *
 * **読み取り専用。** 行は押せず、ここを根拠に「スペースがある」「起動できる」とは判断しない
 * （起動の ＋ や操作はいつもの接続の判定のまま）。ターミナルの題名は持っていないので、スペースの名前と
 * 件数・状態だけを並べる。つながって State が届くと、PC の画面はいつもの一覧へ切り替わる。
 */
export function LastKnownPcList({ snapshot, now, connecting, onReconnect }: {
	snapshot: LastKnownPcSnapshot;
	now: number;
	/** 接続を試みている最中か（false ならつながっていない。再接続のボタンを出す）。 */
	connecting: boolean;
	onReconnect: () => void;
}) {
	const insets = useStableInsets();
	const column = useContentColumnStyle();
	return (
		<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
			<View style={styles.notice}>
				<Icon icon={Clock} size={iconSize.sm} color={colors.textDim} />
				<View style={styles.noticeBody}>
					<Text style={styles.noticeTitle}>{lastKnownLabel(snapshot.savedAt, now)}</Text>
					<Text style={styles.noticeText}>
						{connecting
							? '接続しています… つながると最新の一覧に切り替わります。'
							: 'PC に接続できていません。前回つながったときの一覧を表示しています。'}
					</Text>
				</View>
				{connecting ? null : <Button label="再接続" variant="secondary" size="sm" onPress={onReconnect} />}
			</View>
			{snapshot.spaces.length === 0 ? (
				<Text style={styles.empty}>前回はスペースがありませんでした。</Text>
			) : snapshot.spaces.map((entry, index) => (
				<View key={`${index}:${entry.name}`} style={styles.row} accessible accessibilityLabel={`${entry.name}、${rowSummary(entry)}`}>
					<Icon icon={Folder} size={iconSize.sm} color={colors.textMuted} />
					<View style={styles.rowBody}>
						<Text style={styles.name} numberOfLines={1}>{entry.name}</Text>
						<View style={styles.chips}>
							<Text style={styles.meta}>{`ターミナル ${entry.terminals}`}</Text>
							{BUCKETS.filter(bucket => entry[bucket] > 0).map(bucket => (
								<View key={bucket} style={styles.chip}>
									<View style={[styles.dot, { backgroundColor: bucketDotColor(bucket) }]} />
									<Text style={styles.meta}>{`${BUCKET_LABEL[bucket]} ${entry[bucket]}`}</Text>
								</View>
							))}
						</View>
					</View>
				</View>
			))}
		</ScrollView>
	);
}

/** 「最終確認 ○分前」（ホームの PC のカードと PC の画面で共用）。 */
export function lastKnownLabel(savedAt: number, now: number): string {
	return lastKnownLabelFor(formatRelativeTime(savedAt, now));
}

function rowSummary(entry: LastKnownPcSnapshot['spaces'][number]): string {
	return [`ターミナル ${entry.terminals}`, ...BUCKETS.filter(bucket => entry[bucket] > 0).map(bucket => `${BUCKET_LABEL[bucket]} ${entry[bucket]}`)].join('、');
}

const DOT_SIZE = 6;

const styles = StyleSheet.create({
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.md,
	},
	notice: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		padding: space.md,
		marginBottom: space.md,
		backgroundColor: colors.panel,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: radius.card,
	},
	noticeBody: {
		flex: 1,
		minWidth: 0,
	},
	noticeTitle: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	noticeText: {
		marginTop: 2,
		fontSize: type.meta,
		lineHeight: 16,
		color: colors.textDim,
	},
	empty: {
		fontSize: type.body,
		color: colors.textDim,
		textAlign: 'center',
		marginTop: space.xl,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm + 2,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
		// 押せない目安の一覧なので、生きた一覧より一段薄く出す。
		opacity: 0.75,
	},
	rowBody: {
		flex: 1,
		minWidth: 0,
	},
	name: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		alignItems: 'center',
		gap: space.sm,
		marginTop: 2,
	},
	chip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	dot: {
		width: DOT_SIZE,
		height: DOT_SIZE,
		borderRadius: DOT_SIZE / 2,
	},
	meta: {
		fontSize: type.meta,
		color: colors.textDim,
	},
});

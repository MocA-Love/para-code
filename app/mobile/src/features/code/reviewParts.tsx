// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronLeft, ChevronRight, FileText, RefreshCw, X } from 'lucide-react-native';
import type { ParadisMobileReviewState } from '../../../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileDiffReview.js';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import type { DiffRow } from '../../components/diffParser.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { HeaderButton, Icon, iconSize, useThemeColors } from '../../ui/index.js';
import type { ReviewMarks } from './codeCache.js';
import { ChangeBadge } from './codeParts.js';
import { NoteBubble, StaleNotes } from './reviewNoteParts.js';
import { canAnnotateRow, type DiffLineItem, type PlacedNotes, type ReviewNote } from './reviewNotes.js';
import { REVIEW_FILTERS, diffLineNumber, diffSign, reviewStateOf, type ReviewFilter } from './diffReview.js';
import { splitPath, type ScmEntry } from './scmModel.js';
import { StageToggle } from './scmParts.js';

/**
 * 差分レビューの部品（Orca の MobileDiffReviewHeader / FileSummary / Line / Footer と、
 * ファイルの一覧。寸法はモックの `.rvh` `.rvfile` `.dl` `.rvfoot` `.rfrow`）。
 */

/** 見出しの下の「n/m 確認済み」と絞り込みのチップ。 */
export function ReviewSummary({ reviewed, total, synced, position, filter, onFilter, stage }: {
	reviewed: number;
	total: number;
	/** 確認の印を PC に保存しているか（`review.store.v1` の PC だけ。古い PC では出さない）。 */
	synced: boolean;
	/** いまのファイルが絞り込んだ一覧の何件目か（入っていなければ undefined）。 */
	position: { readonly index: number; readonly count: number } | undefined;
	filter: ReviewFilter;
	onFilter: (filter: ReviewFilter) => void;
	/**
	 * 「確認済みをステージ」（`review.stage.v1` の PC で、まだステージしていない確認済みがあるときだけ渡す。
	 * 確認した後に書き換えられたファイルは対象にしない。Orca W2-28）。
	 */
	stage?: { readonly count: number; readonly busy: boolean; readonly onPress: () => void };
}) {
	return (
		<View style={styles.summary}>
			<View style={styles.progress}>
				<Text style={styles.progressText}>{`${reviewed}/${total} 確認済み${synced ? ' · PC と同期' : ''}`}</Text>
				{position !== undefined ? <Text style={styles.progressText}>{`${position.index + 1} / ${position.count} 件目`}</Text> : null}
			</View>
			<View style={styles.chips}>
				{REVIEW_FILTERS.map(item => {
					const on = item.key === filter;
					return (
						<Pressable
							key={item.key}
							onPress={() => { if (!on) { hapticSelection(); onFilter(item.key); } }}
							hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
							style={[styles.chip, on ? styles.chipOn : undefined]}
							accessibilityRole="button"
							accessibilityState={{ selected: on }}
						>
							<Text style={[styles.chipText, on ? styles.chipTextOn : undefined]}>{item.label}</Text>
						</Pressable>
					);
				})}
			</View>
			{stage !== undefined ? (
				<Pressable
					onPress={() => { hapticImpact('light'); stage.onPress(); }}
					disabled={stage.busy}
					hitSlop={hitSlopToMinimum(CHIP_HEIGHT)}
					style={({ pressed }) => [styles.stage, pressed || stage.busy ? styles.pressed : undefined]}
					accessibilityRole="button"
					accessibilityLabel={`確認済みの ${stage.count} 件をステージ`}
				>
					<Icon icon={Check} size={iconSize.sm} color={colors.green} strokeWidth={2.4} />
					<Text style={styles.stageText}>{stage.busy ? 'ステージしています…' : `確認済みの ${stage.count} 件をステージ`}</Text>
				</Pressable>
			) : null}
		</View>
	);
}

/** いま見ているファイル（状態の札・パス・増減・確認済みの印）。 */
export function ReviewFileSummary({ entry, path, stats, state, stage }: {
	entry: ScmEntry | undefined;
	path: string;
	stats: { readonly add: number; readonly del: number } | undefined;
	/** `changed` は確認した後に中身が変わった（Orca W2-14）。 */
	state: ParadisMobileReviewState;
	/** ファイルごとのステージ（PC が扱えるときだけ。Orca W2-15）。 */
	stage?: { readonly busy: boolean; readonly disabled: boolean; readonly onPress: () => void };
}) {
	const parts = [
		entry?.staged === true ? 'ステージ済み' : undefined,
		entry?.meta.label,
		stats !== undefined ? `+${stats.add} −${stats.del}` : undefined,
	].filter((part): part is string => part !== undefined);
	return (
		<View style={styles.fileSummary}>
			{entry !== undefined ? <ChangeBadge symbol={entry.meta.symbol} color={entry.meta.color} /> : null}
			<View style={styles.fileSummaryCol}>
				<Text style={styles.fileSummaryPath} numberOfLines={2}>{path}</Text>
				{parts.length > 0 ? <Text style={styles.fileSummarySub} numberOfLines={1}>{parts.join(' · ')}</Text> : null}
			</View>
			{state === 'reviewed' ? <Text style={styles.reviewedMark}>確認済み</Text> : null}
			{state === 'changed' ? <Text style={styles.changedMark}>確認後に変更あり</Text> : null}
			{stage !== undefined && entry !== undefined ? <StageToggle staged={entry.staged} busy={stage.busy} disabled={stage.disabled} onPress={stage.onPress} path={path} /> : null}
		</View>
	);
}

/**
 * 差分の行（行番号 40・記号 12・本文。追加と削除は地の色で分ける）。
 * `notes` を渡すと、メモを付いた行のすぐ下に、行が見つからないメモを差分の上に出す（Orca W2-28）。
 * `onLongPressRow` を渡すと、削除行と見出し以外の行を長押しでメモを書ける。
 */
export function DiffLines({ rows, notes, onLongPressRow, onPressNote }: {
	rows: readonly DiffRow[];
	notes?: PlacedNotes;
	onLongPressRow?: (row: DiffRow & { newNo: number }) => void;
	onPressNote?: (note: ReviewNote) => void;
}) {
	const items: readonly DiffLineItem[] = notes?.items ?? rows.map((row, index) => ({ kind: 'row' as const, row, index }));
	return (
		<FlatList
			data={items}
			keyExtractor={item => item.kind === 'row' ? String(item.index) : `note-${item.note.id}`}
			style={styles.lines}
			contentContainerStyle={styles.linesContent}
			initialNumToRender={60}
			maxToRenderPerBatch={80}
			windowSize={15}
			ListHeaderComponent={notes !== undefined && onPressNote !== undefined ? <StaleNotes notes={notes.stale} onPress={onPressNote} /> : null}
			renderItem={({ item }) => item.kind === 'row'
				? <DiffLine row={item.row} onLongPress={onLongPressRow} />
				: <NoteBubble note={item.note} onPress={note => onPressNote?.(note)} />}
		/>
	);
}

function DiffLine({ row, onLongPress }: { row: DiffRow; onLongPress?: (row: DiffRow & { newNo: number }) => void }) {
	const number = diffLineNumber(row);
	const body = (
		<>
			<Text style={styles.lineNo}>{number !== undefined ? String(number) : ''}</Text>
			<Text style={styles.lineSign}>{diffSign(row)}</Text>
			<Text style={[styles.lineText, row.kind === 'hunk' ? styles.lineHunk : undefined]}>{row.text.length > 0 ? row.text : ' '}</Text>
		</>
	);
	const lineStyle = [styles.line, row.kind === 'add' ? styles.lineAdd : row.kind === 'del' ? styles.lineDel : undefined];
	if (onLongPress === undefined || !canAnnotateRow(row)) {
		return <View style={lineStyle}>{body}</View>;
	}
	return (
		<Pressable
			onLongPress={() => { hapticImpact('light'); onLongPress(row); }}
			delayLongPress={350}
			style={({ pressed }) => [...lineStyle, pressed ? styles.linePressed : undefined]}
			accessibilityHint="長押しでこの行にメモを書けます"
		>
			{body}
		</Pressable>
	);
}

/**
 * 下のフッター（モックの `.rvfoot`）。前後のファイル・実ファイルを開く・確認済みにする。
 * ステージと破棄は PC 側に操作が無いので置かない。
 */
export function ReviewFooter({ reviewed, changed, canOpen, canMove, bottomInset, onPrev, onNext, onOpen, onToggleReviewed }: {
	reviewed: boolean;
	/** 確認した後に中身が変わった（押すと今の中身で確認済みにし直す）。 */
	changed: boolean;
	canOpen: boolean;
	canMove: boolean;
	bottomInset: number;
	onPrev: () => void;
	onNext: () => void;
	onOpen: () => void;
	onToggleReviewed: () => void;
}) {
	const theme = useThemeColors();
	return (
		<View style={[styles.footer, { paddingBottom: space.sm + bottomInset }]}>
			<Pressable
				onPress={() => { hapticSelection(); onPrev(); }}
				disabled={!canMove}
				style={({ pressed }) => [styles.nav, pressed ? styles.pressed : undefined, !canMove ? styles.off : undefined]}
				accessibilityRole="button"
				accessibilityLabel="前のファイル"
			>
				<Icon icon={ChevronLeft} size={iconSize.lg} color={colors.text} />
			</Pressable>
			<Pressable
				onPress={() => { hapticSelection(); onOpen(); }}
				disabled={!canOpen}
				style={({ pressed }) => [styles.open, pressed ? styles.pressed : undefined, !canOpen ? styles.off : undefined]}
				accessibilityRole="button"
				accessibilityLabel={canOpen ? 'ファイルを開く' : '削除されたファイルは開けません'}
			>
				<Icon icon={FileText} size={iconSize.sm} color={colors.textDim} />
				<Text style={styles.openText}>開く</Text>
			</Pressable>
			<Pressable
				onPress={() => { hapticImpact('light'); onToggleReviewed(); }}
				style={({ pressed }) => [styles.mark, { backgroundColor: theme.primary }, reviewed ? styles.markDone : undefined, pressed ? styles.markPressed : undefined]}
				accessibilityRole="button"
				accessibilityState={{ checked: reviewed }}
				accessibilityLabel={reviewed ? '確認済み（押すと未確認に戻す）' : changed ? '変更後の中身を確認済みにする' : '確認済みにする'}
			>
				<Icon icon={Check} size={iconSize.md} color={reviewed ? colors.green : theme.onPrimary} strokeWidth={2.4} />
				<Text style={[styles.markText, { color: theme.onPrimary }, reviewed ? styles.markTextDone : undefined]}>{reviewed ? '確認済み' : changed ? 'もう一度確認済みにする' : '確認済みにする'}</Text>
			</Pressable>
			<Pressable
				onPress={() => { hapticSelection(); onNext(); }}
				disabled={!canMove}
				style={({ pressed }) => [styles.nav, pressed ? styles.pressed : undefined, !canMove ? styles.off : undefined]}
				accessibilityRole="button"
				accessibilityLabel="次のファイル"
			>
				<Icon icon={ChevronRight} size={iconSize.lg} color={colors.text} />
			</Pressable>
		</View>
	);
}

/** 変更のファイルの一覧（iPad は右から、iPhone は下から出すシートの中身）。押すとそのファイルへ移る。 */
export function ReviewFileList({ entries, marks, noteCounts, currentPath, onPick, onClose }: {
	entries: readonly ScmEntry[];
	marks: ReviewMarks;
	/** ファイルごとのメモの数（メモを扱える PC だけ）。 */
	noteCounts?: ReadonlyMap<string, number>;
	currentPath: string | undefined;
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const done = entries.filter(entry => reviewStateOf(entry, marks) === 'reviewed').length;
	return (
		<View>
			<View style={styles.listHead}>
				<Text style={styles.listTitle} accessibilityRole="header">ファイル</Text>
				<Text style={styles.listCount}>{`${done}/${entries.length} 確認済み`}</Text>
				<HeaderButton icon={X} label="閉じる" onPress={onClose} />
			</View>
			{entries.length === 0 ? (
				<Text style={styles.listEmpty}>変更はありません</Text>
			) : (
				<View style={styles.listGroup}>
					{entries.map((entry, index) => {
						const { name, dir } = splitPath(entry.path);
						const on = entry.path === currentPath;
						const state = reviewStateOf(entry, marks);
						return (
							<View key={entry.path}>
								{index > 0 ? <View style={styles.separator} /> : null}
								<Pressable
									onPress={() => { hapticSelection(); onPick(entry.path); }}
									style={({ pressed }) => [styles.listRow, on || pressed ? styles.listRowOn : undefined]}
									accessibilityRole="button"
									accessibilityState={{ selected: on, checked: state === 'reviewed' }}
									accessibilityLabel={`${entry.meta.label}: ${entry.path}${state === 'changed' ? '（確認後に変更あり）' : ''}`}
								>
									<ChangeBadge symbol={entry.meta.symbol} color={entry.meta.color} small />
									<View style={styles.listRowCol}>
										<Text style={styles.listRowName} numberOfLines={1}>{name}</Text>
										<Text style={styles.listRowSub} numberOfLines={1}>{[dir.length > 0 ? dir : '/', entry.meta.label, (noteCounts?.get(entry.path) ?? 0) > 0 ? `メモ ${noteCounts?.get(entry.path)}` : undefined].filter(Boolean).join(' · ')}</Text>
									</View>
									{state === 'reviewed' ? <Icon icon={Check} size={iconSize.md} color={colors.green} strokeWidth={2.4} /> : null}
									{state === 'changed' ? <Icon icon={RefreshCw} size={iconSize.sm} color={colors.yellow} strokeWidth={2.2} /> : null}
								</Pressable>
							</View>
						);
					})}
				</View>
			)}
		</View>
	);
}

/** 絞り込みのチップの高さ（pt。モックの `.chip`）。当たり判定は 44 に広げる。 */
const CHIP_HEIGHT = 34;
/** 差分の行番号の列の幅と、記号の列の幅（pt。モックの `.dln` `.dlp`）。 */
const LINE_NO_WIDTH = 40;
const LINE_SIGN_WIDTH = 12;
const LINE_HEIGHT = 17;

const styles = StyleSheet.create({
	summary: {
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
		paddingBottom: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	progress: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		gap: space.md,
	},
	progressText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.textDim,
	},
	chips: {
		flexDirection: 'row',
		gap: space.sm,
		paddingTop: space.md,
		paddingBottom: space.xs,
	},
	chip: {
		minHeight: CHIP_HEIGHT,
		borderRadius: radius.button,
		paddingHorizontal: space.md,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: colors.panel,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	chipOn: {
		backgroundColor: colors.text,
		borderColor: colors.text,
	},
	chipText: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.textDim,
	},
	chipTextOn: {
		color: colors.bg,
	},
	stage: {
		minHeight: CHIP_HEIGHT,
		flexDirection: 'row',
		alignItems: 'center',
		alignSelf: 'flex-start',
		gap: space.xs,
		marginTop: space.sm,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
	},
	stageText: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.text,
	},
	fileSummary: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.lg,
		paddingTop: space.md,
		paddingBottom: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	fileSummaryCol: {
		flex: 1,
		minWidth: 0,
	},
	fileSummaryPath: {
		fontSize: type.body,
		fontWeight: '700',
		color: colors.text,
	},
	fileSummarySub: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	reviewedMark: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.green,
	},
	changedMark: {
		fontSize: type.meta,
		fontWeight: '700',
		color: colors.yellow,
	},
	lines: {
		flex: 1,
		backgroundColor: colors.bg,
	},
	linesContent: {
		paddingTop: space.md,
		paddingBottom: space.lg,
	},
	line: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.xs,
		paddingVertical: 2,
		paddingHorizontal: space.xs,
	},
	lineAdd: {
		backgroundColor: colors.addBg,
	},
	lineDel: {
		backgroundColor: colors.delBg,
	},
	lineNo: {
		width: LINE_NO_WIDTH,
		textAlign: 'right',
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: LINE_HEIGHT,
		color: colors.textMuted,
	},
	lineSign: {
		width: LINE_SIGN_WIDTH,
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: LINE_HEIGHT,
		color: colors.textDim,
	},
	lineText: {
		flex: 1,
		fontFamily: monoFamily,
		fontSize: type.meta,
		lineHeight: LINE_HEIGHT,
		color: colors.text,
	},
	lineHunk: {
		color: colors.textMuted,
	},
	linePressed: {
		backgroundColor: colors.raised,
	},
	footer: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingTop: space.sm,
		paddingHorizontal: space.lg,
		backgroundColor: colors.panel,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	nav: {
		width: HIT_SIZE,
		height: HIT_SIZE,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
		alignItems: 'center',
		justifyContent: 'center',
	},
	open: {
		height: HIT_SIZE,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingHorizontal: space.md,
		borderRadius: radius.button,
		backgroundColor: colors.raised,
	},
	openText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textDim,
	},
	pressed: {
		opacity: 0.75,
	},
	off: {
		opacity: 0.45,
	},
	mark: {
		flex: 1,
		height: HIT_SIZE,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.xs + 2,
		borderRadius: radius.button,
		backgroundColor: colors.primary,
	},
	markDone: {
		backgroundColor: colors.raised,
	},
	markPressed: {
		opacity: 0.8,
	},
	markText: {
		fontSize: type.body,
		fontWeight: '700',
		color: colors.onPrimary,
	},
	markTextDone: {
		color: colors.green,
	},
	listHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingHorizontal: space.xs,
		paddingBottom: space.md,
	},
	listTitle: {
		flex: 1,
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
	},
	listCount: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	listEmpty: {
		fontSize: type.body,
		color: colors.textDim,
		textAlign: 'center',
		paddingVertical: space.xl,
	},
	listGroup: {
		backgroundColor: colors.panel,
		borderRadius: radius.group,
		overflow: 'hidden',
	},
	separator: {
		height: StyleSheet.hairlineWidth,
		backgroundColor: colors.border,
		marginHorizontal: space.md,
	},
	listRow: {
		minHeight: 48,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
	},
	listRowOn: {
		backgroundColor: colors.raised,
	},
	listRowCol: {
		flex: 1,
		minWidth: 0,
	},
	listRowName: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	listRowSub: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 2,
	},
});

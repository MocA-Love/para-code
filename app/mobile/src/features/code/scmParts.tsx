// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { ChevronDown, ChevronRight, ExternalLink, FileText, GitBranch, GitCommitHorizontal } from 'lucide-react-native';
import { hitSlopToMinimum } from '../../components/hitSlop.js';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { commitFileKind, scmChangeMeta } from '../../scmChangeKind.js';
import type { ScmLogResult } from '../../store.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { formatRelativeTime } from '../../time.js';
import { Icon, iconSize, useThemeColors } from '../../ui/index.js';
import type { CommitAction, ScmCounts, ScmEntry } from './scmModel.js';
import { splitPath } from './scmModel.js';
import type { CommitFiles } from './useScmData.js';

/**
 * ソース管理の画面の部品（Orca の MobileSourceControlBranchCard / FileRows / コミットバー /
 * MobileGitHistoryList。寸法はモックの `.bcard` `.frow` `.commitbar` `.hrow`）。
 */

/** ブランチのカード（ブランチ名・同期の状態・件数）。 */
export function BranchCard({ branch, sync, counts }: {
	branch: string | undefined;
	/** 右上の同期の状態（PC から先行・遅れの数が届かないので、最新のコミットの時刻を出す）。 */
	sync: string | undefined;
	counts: ScmCounts | undefined;
}) {
	return (
		<View style={styles.card}>
			<View style={styles.cardHead}>
				<View style={styles.branchLine}>
					<Icon icon={GitBranch} size={iconSize.md} color={colors.textDim} />
					<Text style={styles.branch} numberOfLines={1}>{branch ?? 'ブランチ不明'}</Text>
				</View>
				{sync !== undefined ? <Text style={styles.sync} numberOfLines={1}>{sync}</Text> : null}
			</View>
			<View style={styles.counts}>
				<Text style={styles.countText}>{counts !== undefined ? `${counts.unstaged} 件の変更` : '変更を読み込み中'}</Text>
				{counts !== undefined ? <Text style={styles.countText}>{counts.staged} 件ステージ済み</Text> : null}
			</View>
		</View>
	);
}

/** 変更の行（モックの `.frow`。状態の記号・ファイル名・フォルダ）。押すと差分レビューへ。 */
export function ScmFileRow({ entry, disabled, onPress }: { entry: ScmEntry; disabled: boolean; onPress: () => void }) {
	const { name, dir } = splitPath(entry.path);
	return (
		<Pressable
			onPress={() => { hapticSelection(); onPress(); }}
			disabled={disabled}
			style={({ pressed }) => [styles.fileRow, pressed ? styles.fileRowPressed : undefined, disabled ? styles.dim : undefined]}
			accessibilityRole="button"
			accessibilityLabel={`${entry.meta.label}: ${entry.path}`}
			accessibilityHint="差分を開きます"
		>
			<Text style={[styles.symbol, { color: entry.meta.color }]}>{entry.meta.symbol}</Text>
			<Icon icon={FileText} size={iconSize.md} color={colors.textDim} />
			<View style={styles.fileCol}>
				<Text style={styles.fileName} numberOfLines={1}>{name}</Text>
				<Text style={styles.fileSub} numberOfLines={1}>{dir.length > 0 ? `${dir} · ${entry.meta.label}` : entry.meta.label}</Text>
			</View>
			<Icon icon={ChevronRight} size={iconSize.md} color={colors.textMuted} />
		</Pressable>
	);
}

/**
 * 下に固定のコミットバー（モックの `.commitbar`）。メッセージの入力欄と、状況で決まる主ボタン。
 * コミットするものが無いときは入力欄の代わりに点線の札を出す。
 */
export function CommitBar({ action, message, onChangeMessage, onCommit, onBlocked, bottomInset, onLayout }: {
	action: CommitAction;
	message: string;
	onChangeMessage: (text: string) => void;
	onCommit: () => void;
	/** 押せないときに押された（理由をトーストで出す）。 */
	onBlocked: (reason: string) => void;
	/** 下端の余白（セーフエリア。キーボードが出ているときは 0 にしてよい）。 */
	bottomInset: number;
	onLayout?: (event: LayoutChangeEvent) => void;
}) {
	const theme = useThemeColors();
	const press = () => {
		if (action.disabled) {
			if (action.reason !== undefined) {
				onBlocked(action.reason);
			}
			return;
		}
		hapticImpact('medium');
		onCommit();
	};
	return (
		<View style={[styles.commitBar, { paddingBottom: space.md + bottomInset }]} onLayout={onLayout}>
			<View style={styles.commitRow}>
				{action.showInput ? (
					<TextInput
						style={styles.commitInput}
						value={message}
						onChangeText={onChangeMessage}
						placeholder="コミットメッセージ"
						placeholderTextColor={colors.textMuted}
						autoCapitalize="none"
						autoCorrect={false}
						returnKeyType="done"
						onSubmitEditing={press}
						editable={!action.busy}
						accessibilityLabel="コミットメッセージ"
					/>
				) : (
					<View style={styles.commitOff}>
						<Text style={styles.commitOffText} numberOfLines={1}>コミットする変更はありません</Text>
					</View>
				)}
				<Pressable
					onPress={press}
					hitSlop={hitSlopToMinimum(COMMIT_BAR_CONTROL)}
					style={({ pressed }) => [styles.primary, { backgroundColor: theme.primary }, action.disabled ? styles.primaryOff : pressed ? styles.primaryPressed : undefined]}
					accessibilityRole="button"
					accessibilityLabel={action.label}
					accessibilityState={{ disabled: action.disabled, busy: action.busy }}
					accessibilityHint={action.reason}
				>
					<Text style={[styles.primaryText, { color: theme.onPrimary }]} numberOfLines={1}>{action.label}</Text>
				</Pressable>
			</View>
			<Text style={styles.commitHint}>ステージの操作は PC で行います。ここからは未追跡を含むすべての変更をまとめてコミットします。</Text>
		</View>
	);
}

/** コミットの一覧（モックの `.hrow`）。行を押すとそのコミットで変わったファイルを開閉する。 */
export function HistoryList({ log, now, commitFiles, onExpand, onOpenWeb }: {
	log: ScmLogResult;
	now: number;
	commitFiles: Readonly<Record<string, CommitFiles>>;
	onExpand: (hash: string) => void;
	onOpenWeb: ((hash: string) => void) | undefined;
}) {
	const [expanded, setExpanded] = useState<string | undefined>(undefined);
	return (
		<View>
			{log.commits.map(commit => {
				const open = expanded === commit.hash;
				const detail = commitFiles[commit.hash];
				return (
					<View key={commit.hash} style={styles.historyItem}>
						<View style={styles.historyRowWrap}>
							<Pressable
								onPress={() => {
									hapticSelection();
									setExpanded(open ? undefined : commit.hash);
									if (!open) {
										onExpand(commit.hash);
									}
								}}
								style={({ pressed }) => [styles.historyRow, pressed ? styles.fileRowPressed : undefined]}
								accessibilityRole="button"
								accessibilityState={{ expanded: open }}
								accessibilityLabel={`${commit.subject}、変わったファイル`}
							>
								<Icon icon={open ? ChevronDown : GitCommitHorizontal} size={iconSize.md} color={colors.textMuted} />
								<View style={styles.fileCol}>
									<Text style={styles.historySubject} numberOfLines={2}>{commit.subject}</Text>
									<Text style={styles.historyMeta} numberOfLines={1}>
										{`${commit.hash.slice(0, 7)} · ${commit.at !== undefined ? formatRelativeTime(commit.at, now) : commit.when}`}
									</Text>
								</View>
							</Pressable>
							{onOpenWeb !== undefined ? (
								<Pressable
									onPress={() => { hapticImpact('light'); onOpenWeb(commit.hash); }}
									style={({ pressed }) => [styles.webButton, pressed ? styles.fileRowPressed : undefined]}
									accessibilityRole="link"
									accessibilityLabel="ブラウザでコミットを開く"
								>
									<Icon icon={ExternalLink} size={iconSize.md} color={colors.textDim} />
								</Pressable>
							) : null}
						</View>
						{open ? (
							<View style={styles.commitFiles}>
								{detail === undefined || (detail.files === undefined && detail.error === undefined) ? <ActivityIndicator size="small" color={colors.textDim} style={styles.commitFilesSpinner} /> : null}
								{detail?.error !== undefined ? <Text style={styles.commitFilesError}>{`変わったファイルを読み込めませんでした: ${detail.error}`}</Text> : null}
								{detail?.files !== undefined && detail.files.length === 0 ? <Text style={styles.historyMeta}>変わったファイルはありません</Text> : null}
								{(detail?.files ?? []).map(file => {
									const meta = scmChangeMeta(commitFileKind(file.status), file.status);
									return (
										<View key={`${file.status}${file.path}`} style={styles.commitFileRow} accessibilityLabel={`${meta.label}: ${file.path}`}>
											<Text style={[styles.symbolSmall, { color: meta.color }]}>{meta.symbol}</Text>
											<Text style={styles.commitFilePath} numberOfLines={1}>{file.path}</Text>
										</View>
									);
								})}
							</View>
						) : null}
					</View>
				);
			})}
		</View>
	);
}

/** コミットバーの入力欄と主ボタンの高さ（pt。モックの `.cmsg` `.cbtn`）。当たり判定は 44 に広げる。 */
const COMMIT_BAR_CONTROL = 42;
/** 主ボタンの最小幅（pt。モックの `.cbtn`）。 */
const PRIMARY_MIN_WIDTH = 88;
/** 状態の記号の列の幅（pt。モックの `.fst`）。 */
const SYMBOL_WIDTH = 24;

const styles = StyleSheet.create({
	card: {
		marginTop: space.lg,
		marginBottom: space.sm,
		padding: space.md,
		borderRadius: radius.card,
		backgroundColor: colors.panel,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	cardHead: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: space.md,
	},
	branchLine: {
		flex: 1,
		minWidth: 0,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	branch: {
		flexShrink: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
		fontFamily: monoFamily,
	},
	sync: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	counts: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.md,
		marginTop: space.sm,
	},
	countText: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	fileRow: {
		minHeight: 50,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	fileRowPressed: {
		backgroundColor: colors.panel,
	},
	dim: {
		opacity: 0.45,
	},
	symbol: {
		width: SYMBOL_WIDTH,
		textAlign: 'center',
		fontFamily: monoFamily,
		fontSize: type.meta,
		fontWeight: '700',
	},
	fileCol: {
		flex: 1,
		minWidth: 0,
	},
	fileName: {
		fontSize: type.body,
		color: colors.text,
	},
	fileSub: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	commitBar: {
		gap: space.xs,
		paddingTop: space.md,
		paddingHorizontal: space.lg,
		backgroundColor: colors.panel,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	commitRow: {
		flexDirection: 'row',
		gap: space.sm,
	},
	commitInput: {
		flex: 1,
		minWidth: 0,
		minHeight: COMMIT_BAR_CONTROL,
		borderRadius: radius.input,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.bg,
		paddingHorizontal: space.md,
		fontSize: type.input,
		color: colors.text,
	},
	commitOff: {
		flex: 1,
		minWidth: 0,
		minHeight: COMMIT_BAR_CONTROL,
		borderRadius: radius.input,
		borderWidth: 1,
		borderStyle: 'dashed',
		borderColor: colors.border,
		backgroundColor: colors.panel,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.md,
	},
	commitOffText: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textMuted,
	},
	primary: {
		minWidth: PRIMARY_MIN_WIDTH,
		minHeight: COMMIT_BAR_CONTROL,
		borderRadius: radius.button,
		backgroundColor: colors.primary,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: space.md,
	},
	primaryPressed: {
		opacity: 0.8,
	},
	primaryOff: {
		opacity: 0.45,
	},
	primaryText: {
		fontSize: type.body,
		fontWeight: '700',
		color: colors.onPrimary,
	},
	commitHint: {
		fontSize: type.caption,
		lineHeight: 15,
		color: colors.textMuted,
	},
	historyItem: {
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	historyRowWrap: {
		flexDirection: 'row',
		alignItems: 'stretch',
	},
	historyRow: {
		flex: 1,
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm + 2,
		paddingVertical: space.sm + 2,
		minHeight: HIT_SIZE,
	},
	historySubject: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	historyMeta: {
		fontSize: type.meta,
		color: colors.textMuted,
		fontFamily: monoFamily,
		marginTop: 2,
	},
	webButton: {
		width: HIT_SIZE,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.row,
	},
	commitFiles: {
		paddingLeft: space.xl + 2,
		paddingBottom: space.sm,
		gap: space.xs,
	},
	commitFilesSpinner: {
		alignSelf: 'flex-start',
	},
	commitFilesError: {
		fontSize: type.meta,
		color: colors.red,
	},
	commitFileRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	symbolSmall: {
		width: SYMBOL_WIDTH - space.xs,
		fontFamily: monoFamily,
		fontSize: type.meta,
		fontWeight: '700',
	},
	commitFilePath: {
		flex: 1,
		fontSize: type.meta,
		color: colors.textDim,
	},
});

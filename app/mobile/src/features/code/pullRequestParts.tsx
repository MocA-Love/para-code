// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, GitMerge, GitPullRequest, Sparkles } from 'lucide-react-native';
import { haptic } from '../../haptics.js';
import { monoFamily } from '../../monoFont.js';
import { HIT_SIZE, colors, radius, space, type } from '../../theme.js';
import { Button, EmptyState, Icon, iconSize, type LucideIcon } from '../../ui/index.js';
import { CenterSpinner, GroupHeading, InlineError } from './codeParts.js';
import {
	canFixChecks,
	checkBucketLabel,
	checkSummaryText,
	orderedChecks,
	prMergeButton,
	prStateLabel,
	prUnavailableText,
	type PrCheck,
	type PrDetail,
	type PrQueued,
	type PrViewResult,
} from './pullRequest.js';
import type { AgentHandoffResult } from './scmSync.js';

/**
 * ソース管理の「プルリクエスト」の区分（Orca W2-36 の最小版。Orca の MobilePRSidebar に当たる）。
 * PR の札・CI のチェックの一覧・失敗したチェックを AI に直してもらう・マージ（CI が失敗・実行中なら押せない）。
 * 画面の幅に合わせて縦に積むだけなので、iPhone と iPad（詳細の列・右のドック）で同じ部品を使う。
 */
export function PullRequestPanel({ view, loading, error, offline, canMerge, merging, mergeError, queued, handoff, onRetry, onFix, onFixWithNewAgent, onMerge }: {
	view: PrViewResult | undefined;
	loading: boolean;
	error: string | undefined;
	/** 操作できない理由（切断中など）。 */
	offline: string | undefined;
	canMerge: boolean;
	merging: boolean;
	mergeError: string | undefined;
	/** このスマホからマージキューに入れた PR。 */
	queued: PrQueued | undefined;
	handoff: { readonly sending: boolean; readonly result: AgentHandoffResult | undefined };
	onRetry: (() => void) | undefined;
	onFix: (pr: PrDetail) => void;
	onFixWithNewAgent: (pr: PrDetail) => void;
	onMerge: (pr: PrDetail) => void;
}) {
	if (view === undefined) {
		if (error !== undefined) {
			return <EmptyState icon={CircleAlert} title="PR を取得できませんでした" body={error} action={onRetry !== undefined ? { label: '再読み込み', onPress: onRetry } : undefined} style={styles.state} />;
		}
		return offline !== undefined && !loading
			? <EmptyState icon={GitPullRequest} title="読み込めません" body={`${offline}。つながると読み込みます。`} style={styles.state} />
			: <CenterSpinner label="PR を読み込み中…" />;
	}
	if (view.kind === 'unavailable') {
		const text = prUnavailableText(view.reason, view.message);
		return <EmptyState icon={GitPullRequest} title={text.title} body={text.body} action={onRetry !== undefined ? { label: '再読み込み', onPress: onRetry } : undefined} style={styles.state} />;
	}
	const pr = view.pr;
	const summary = checkSummaryText(pr.checks, pr.checkCounts);
	const merge = prMergeButton(pr, queued);
	const disabled = offline !== undefined;
	return (
		<View>
			<InlineError message={error !== undefined ? `読み直せませんでした: ${error}` : undefined} style={styles.inset} />
			<PrCard pr={pr} />
			{canFixChecks(pr) ? (
				<View style={styles.fix}>
					<Text style={styles.fixText}>失敗したチェックを、失敗したジョブのログの末尾（3 件まで）を添えてこのスペースのエージェントに頼めます。</Text>
					{handoff.result !== undefined ? (
						<Text style={[styles.fixText, handoff.result.delivered ? styles.done : styles.warn]}>{handoff.result.text}</Text>
					) : null}
					<View style={styles.buttons}>
						{handoff.result?.delivered === true ? null : (
							<Button label="AI に直してもらう" size="sm" icon={Sparkles} onPress={() => onFix(pr)} loading={handoff.sending} disabled={disabled} style={styles.grow} />
						)}
						{handoff.result?.delivered === false && handoff.result.busy ? (
							<Button label="新しいエージェントで" size="sm" variant="secondary" onPress={() => onFixWithNewAgent(pr)} disabled={disabled || handoff.sending} style={styles.grow} />
						) : null}
					</View>
				</View>
			) : null}
			<GroupHeading title={summary !== undefined ? `CI のチェック（${summary}）` : 'CI のチェック'} />
			{pr.checks.length === 0 ? <Text style={styles.empty}>チェックはありません。</Text> : orderedChecks(pr.checks).map((check, index) => <CheckRow key={`${check.name}-${index}`} check={check} />)}
			{pr.checksIncomplete === true ? <Text style={styles.empty}>チェックが多いため、一部だけを表示しています。</Text> : null}
			{canMerge && merge.visible ? (
				<View style={styles.merge}>
					<InlineError message={mergeError !== undefined ? mergeError : undefined} style={styles.inset} />
					{merge.reason !== undefined ? <Text style={styles.mergeReason}>{merge.reason}</Text> : null}
					<Button
						label="マージ"
						icon={GitMerge}
						onPress={() => { haptic('move'); onMerge(pr); }}
						disabled={disabled || merge.reason !== undefined}
						loading={merging}
						accessibilityLabel={merge.reason !== undefined ? `マージ（${merge.reason}）` : 'マージ'}
					/>
				</View>
			) : null}
		</View>
	);
}

const STATE_COLOR: Record<PrDetail['state'], string> = { open: colors.green, draft: colors.textDim, merged: colors.purple, closed: colors.red };

/** PR の札（状態・番号・題名・ブランチ・GitHub で開く）。 */
function PrCard({ pr }: { pr: PrDetail }) {
	const color = STATE_COLOR[pr.state];
	return (
		<View style={styles.card}>
			<View style={styles.cardHead}>
				<View style={[styles.stateChip, { borderColor: color }]}>
					<Icon icon={pr.state === 'merged' ? GitMerge : GitPullRequest} size={iconSize.sm} color={color} />
					<Text style={[styles.stateText, { color }]}>{prStateLabel(pr.state)}</Text>
				</View>
				<Text style={styles.number}>{`#${pr.number}`}</Text>
				<Pressable
					onPress={() => { void Linking.openURL(pr.url).catch(() => undefined); }}
					hitSlop={hitSlop}
					style={({ pressed }) => [styles.open, pressed ? styles.pressed : undefined]}
					accessibilityRole="link"
					accessibilityLabel="GitHub で PR を開く"
				>
					<Icon icon={ExternalLink} size={iconSize.md} color={colors.textDim} />
				</Pressable>
			</View>
			<Text style={styles.title} numberOfLines={3}>{pr.title.length > 0 ? pr.title : '（題名なし）'}</Text>
			<Text style={styles.branch} numberOfLines={1}>{`${pr.headRefName}${pr.baseRefName !== undefined ? ` → ${pr.baseRefName}` : ''} · ${pr.headSha.slice(0, 7)}`}</Text>
		</View>
	);
}

const BUCKET_ICON: Record<PrCheck['bucket'], { readonly icon: LucideIcon; readonly color: string }> = {
	pass: { icon: CircleCheck, color: colors.green },
	fail: { icon: CircleX, color: colors.red },
	cancel: { icon: CircleMinus, color: colors.red },
	pending: { icon: CircleDashed, color: colors.amber },
	skipping: { icon: CircleMinus, color: colors.textMuted },
};

/** チェックの行。詳細の URL があれば押して GitHub で開く。 */
function CheckRow({ check }: { check: PrCheck }) {
	const look = BUCKET_ICON[check.bucket];
	const url = check.url;
	const body = (
		<>
			<Icon icon={look.icon} size={iconSize.md} color={look.color} />
			<View style={styles.checkCol}>
				<Text style={styles.checkName} numberOfLines={2}>{check.name}</Text>
				<Text style={styles.checkSub} numberOfLines={1}>{check.workflow !== undefined ? `${check.workflow} · ${checkBucketLabel(check.bucket)}` : checkBucketLabel(check.bucket)}</Text>
			</View>
			{url !== undefined ? <Icon icon={ExternalLink} size={iconSize.sm} color={colors.textMuted} /> : null}
		</>
	);
	if (url === undefined) {
		return <View style={styles.checkRow} accessibilityLabel={`${check.name}: ${checkBucketLabel(check.bucket)}`}>{body}</View>;
	}
	return (
		<Pressable
			onPress={() => { void Linking.openURL(url).catch(() => undefined); }}
			style={({ pressed }) => [styles.checkRow, pressed ? styles.pressed : undefined]}
			accessibilityRole="link"
			accessibilityLabel={`${check.name}: ${checkBucketLabel(check.bucket)}。GitHub で開く`}
		>
			{body}
		</Pressable>
	);
}

const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 };

const styles = StyleSheet.create({
	state: {
		flex: 0,
		paddingTop: space.xl * 2,
	},
	inset: {
		paddingHorizontal: 0,
	},
	card: {
		marginTop: space.lg,
		padding: space.md,
		gap: space.xs,
		borderRadius: radius.card,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.panel,
	},
	cardHead: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	stateChip: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
		paddingHorizontal: space.sm,
		paddingVertical: 2,
		borderRadius: radius.pill,
		borderWidth: 1,
	},
	stateText: {
		fontSize: type.meta,
		fontWeight: '600',
	},
	number: {
		flex: 1,
		fontSize: type.body,
		fontWeight: '600',
		color: colors.textDim,
		fontFamily: monoFamily,
	},
	open: {
		width: HIT_SIZE - space.md,
		height: HIT_SIZE - space.md,
		alignItems: 'center',
		justifyContent: 'center',
		borderRadius: radius.row,
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	title: {
		fontSize: type.body,
		fontWeight: '600',
		color: colors.text,
	},
	branch: {
		fontSize: type.meta,
		color: colors.textMuted,
		fontFamily: monoFamily,
	},
	fix: {
		marginTop: space.md,
		gap: space.sm,
		padding: space.md,
		borderRadius: radius.card,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
	},
	fixText: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
	},
	done: {
		color: colors.green,
	},
	warn: {
		color: colors.amber,
	},
	buttons: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: space.sm,
	},
	grow: {
		flexGrow: 1,
	},
	empty: {
		fontSize: type.meta,
		color: colors.textMuted,
		paddingVertical: space.sm,
	},
	checkRow: {
		minHeight: 50,
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		paddingVertical: space.sm,
		borderBottomWidth: StyleSheet.hairlineWidth,
		borderBottomColor: colors.border,
	},
	checkCol: {
		flex: 1,
		minWidth: 0,
	},
	checkName: {
		fontSize: type.body,
		color: colors.text,
	},
	checkSub: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
	},
	merge: {
		marginTop: space.lg,
		gap: space.sm,
	},
	mergeReason: {
		fontSize: type.meta,
		color: colors.amber,
	},
});

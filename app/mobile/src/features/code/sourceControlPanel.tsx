// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState, type ReactNode } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CircleCheck, CircleAlert, CloudOff, GitCommitHorizontal, RefreshCw } from 'lucide-react-native';
import { haptic } from '../../haptics.js';
import { useKeyboardCoverage } from '../../hooks/useKeyboardVisible.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useAppStore } from '../../appState.js';
import { useParaToast } from '../../paraToast.js';
import { routes } from '../../routes.js';
import { colors, space } from '../../theme.js';
import { formatRelativeTime, useNow } from '../../time.js';
import { Button, ConfirmDrawer, EmptyState, HeaderButton, Screen, ScreenHeader, type LucideIcon } from '../../ui/index.js';
import { X } from 'lucide-react-native';
import { CenterSpinner, GroupHeading, InlineError, OfflineBanner, Segments, SpaceGateBody, useReadableColumn } from './codeParts.js';
import { BranchCard, CommitBar, CommitFailureCard, CommitWarning, HistoryList, ScmFileRow } from './scmParts.js';
import { ConfirmTarget } from './confirmTarget.js';
import { shouldTryReviewStage } from './diffReview.js';
import {
	groupScmEntries,
	listBodyState,
	scmCounts,
	scmEntries,
	scmSegments,
	type ListBodyState,
	type ScmEntry,
	type ScmSegment,
} from './scmModel.js';
import { branchSyncOf, commitFailureView, commitHint, commitScope, scmPrimaryAction, scmPushConfirm, scmSyncSummary, type ScmPushConfirm } from './scmSync.js';
import { mergeConfirmMessage, prMergeToastText, type PrDetail } from './pullRequest.js';
import { PullRequestPanel } from './pullRequestParts.js';
import { useCodeSpace, type CodeSpaceTarget } from './useCodeSpace.js';
import type { PanelDock } from './panelDock.js';
import { usePullRequest } from './usePullRequest.js';
import { useScmCommit, useScmHistory, useScmStatus } from './useScmData.js';
import { useAgentHandoff, useScmSync, useStageFile } from './useScmSync.js';
import { useReviewMarksController } from './useReviewMarks.js';
import { useReviewNotesController } from './useReviewNotes.js';

/**
 * ソース管理（`/pc/[pcId]/source-control/[spaceId]`）。Orca の MobileSourceControlPanel に合わせ、
 * 上に区分の切り替え（変更 / プルリクエスト / コミット）、その下にブランチのカードと変更の一覧、下端にコミットバーを置く。
 *
 * PC が扱えれば（Orca W2-15）、ブランチのカードに上流と先行・遅れ、フェッチ・取り込み・プッシュを出し、主ボタンは
 * 変更が無ければプッシュ・取り込み・公開に変わる（強制 push は出さない）。変更の行の右でファイルごとにステージでき、
 * ステージ済みがあればそれだけをコミットする。コミットが失敗したら、要約と「AI に直してもらう」を出す。
 * 扱えない PC では「すべての変更をまとめてコミット」だけで、その旨をコミットバーの下に書く。
 * PC が PR の詳細を返せれば（Orca W2-36）「プルリクエスト」の区分を出す。
 * 変更の行を押すと差分レビュー（`/pc/[pcId]/review/[spaceId]`）へ進む。
 *
 * ルート（`app/pc/[pcId]/source-control/[spaceId].tsx`）と、iPad のセッションの右のドック（`dock`）の両方で使う。
 * ドックでは見出しの左が戻るではなく閉じる（X）になり、差分へ進むときはドックを閉じて詳細の列で押し進める。
 */
export function SourceControlPanel({ target, dock }: { target?: CodeSpaceTarget; dock?: PanelDock } = {}) {
	const router = useRouter();
	const codeSpace = useCodeSpace(target);
	const statusState = useScmStatus(codeSpace);
	const history = useScmHistory(codeSpace);
	const commitState = useScmCommit(codeSpace);
	const sync = useScmSync(codeSpace);
	const [actionError, setActionError] = useState<string | undefined>(undefined);
	const stageFile = useStageFile(codeSpace, setActionError);
	// 確認済みのファイルを「+」でステージするときは、差分画面と同じく確認済みの印ごと付け替える。確認済みかは
	// PC の保存で決まる（手元の写しは差分画面を開くまで空のことがある）ので、ここでは印を読まずに PC に任せる。
	// 印の写しは応答で置き換えるだけで、前面へ戻るたびに PC へ読み直しは出さない。
	const review = useReviewMarksController(codeSpace, { reloadOnFocus: false });
	const reviewNotes = useReviewNotesController(codeSpace, review);
	const commitHandoff = useAgentHandoff(codeSpace);
	const prHandoff = useAgentHandoff(codeSpace);
	const [segment, setSegment] = useState<ScmSegment>('changes');
	const pullRequest = usePullRequest(codeSpace, segment === 'pr');
	// PC が PR の詳細を返せなくなったら（古い PC に切り替えたなど）変更の区分に戻す
	const shown: ScmSegment = segment === 'pr' && !pullRequest.enabled ? 'changes' : segment;
	const [message, setMessage] = useState('');
	// 確認のシートの見え隠れと、確認している PR は別に持つ（閉じた後に onConfirm が走るので、対象を閉じる時に消さない）
	const [confirmingMerge, setConfirmingMerge] = useState<PrDetail | undefined>(undefined);
	const mergeTarget = useRef(new ConfirmTarget<PrDetail>()).current;
	// プッシュ・公開の確かめ（Q143 A）。中身は閉じる動きの間も出したままにするので、見え隠れと別に持つ
	const [confirmingPush, setConfirmingPush] = useState(false);
	const [pushConfirm, setPushConfirm] = useState<ScmPushConfirm | undefined>(undefined);
	const [commitWarning, setCommitWarning] = useState<string | undefined>(undefined);
	const now = useNow();
	const insets = useStableInsets();
	// ドックではセッションの画面がキーボードの分を空けているので、ここでは足さない。
	const keyboardCover = useKeyboardCoverage();
	const ownKeyboardCover = dock !== undefined ? 0 : keyboardCover;
	const column = useReadableColumn();
	// PC が 5 分ごとに取っている PR（State の workspaces[].pr）。全体は購読せず、値だけを取る
	const prNumber = useAppStore(s => s.workspace?.workspaces.find(workspace => workspace.id === codeSpace.wsId)?.pr?.number);
	const prState = useAppStore(s => s.workspace?.workspaces.find(workspace => workspace.id === codeSpace.wsId)?.pr?.state);
	const prUrl = useAppStore(s => s.workspace?.workspaces.find(workspace => workspace.id === codeSpace.wsId)?.pr?.url);

	const entries = scmEntries(statusState.status);
	const counts = statusState.status !== undefined ? scmCounts(entries) : undefined;
	const branch = statusState.status?.branch ?? codeSpace.branch;
	const branchSync = sync.enabled && statusState.status !== undefined ? branchSyncOf(statusState.status) : undefined;
	const scope = commitScope(counts, stageFile.enabled);
	const action = scmPrimaryAction({ live: codeSpace.live, total: counts?.total, message, committing: commitState.committing, sync: branchSync, syncing: sync.syncing, branch });
	const latest = history.log?.commits[0];
	const syncText = latest === undefined ? undefined : `最新のコミット ${latest.at !== undefined ? formatRelativeTime(latest.at, now) : latest.when}`;
	const subtitle = [codeSpace.name, branch].filter(part => part !== undefined && part.length > 0).join(' · ');
	const webUrl = history.log?.webUrl;

	const refreshAll = () => {
		void statusState.refresh();
		void history.refresh();
		if (shown === 'pr') {
			void pullRequest.reload();
		}
	};

	const commit = async () => {
		commitHandoff.reset();
		setActionError(undefined);
		setCommitWarning(undefined);
		const outcome = await commitState.commit(message, scope);
		// フックの失敗・時間切れの一言があれば、コミットはできたが注意あり
		haptic(!outcome.ok ? 'error' : outcome.warning !== undefined ? 'warning' : 'success');
		if (!outcome.ok) {
			// 失敗でもステージを戻したので、一覧を読み直す
			void statusState.refresh();
			return;
		}
		setMessage('');
		// フックの失敗・時間切れの一言は長いので、トーストの1行ではなくコミットバーの上に全文を出す
		setCommitWarning(outcome.warning);
		useParaToast.getState().show({ key: 'scm-commit', text: 'コミットしました', sub: branch, icon: 'checkmark-circle-outline', tone: 'done' }, 1_900);
		void statusState.refresh();
		void history.refresh();
	};

	const runSync = async (operation: 'push' | 'pull' | 'fetch') => {
		setActionError(undefined);
		const done = await sync.run(operation);
		void statusState.refresh();
		if (done === undefined) {
			return;
		}
		useParaToast.getState().show({ key: 'scm-sync', text: done, sub: branch, icon: 'checkmark-circle-outline', tone: 'done' }, 1_900);
		if (operation !== 'fetch') {
			void history.refresh();
		}
	};

	/** 同期の操作。プッシュ（ブランチの公開を含む）は外へ出すので、確かめてから送る。 */
	const requestSync = (operation: 'push' | 'pull' | 'fetch') => {
		if (operation !== 'push') {
			void runSync(operation);
			return;
		}
		setPushConfirm(scmPushConfirm(branchSync, branch));
		setConfirmingPush(true);
	};

	const primary = () => {
		if (action.kind === 'commit') {
			void commit();
		} else {
			requestSync(action.kind === 'pull' ? 'pull' : 'push');
		}
	};

	/**
	 * ステージする・外す。確認済みで確認後に変わっていないファイルは、差分画面と同じく `reviewStage` で
	 * 確認済みの印ごとステージ後の中身へ付け替える（ただのステージだと「確認後に変更あり」に変わるため）。
	 * 確認済みかどうかは PC が保存している印で決めるので、PC が扱えればステージするときはいつも `reviewStage` を送る。
	 * 要求が失敗したら（理由はトーストで出る）ただのステージへは代えない。PC がステージしなかった（確認していない・
	 * 確認した後に変わっていた）ときだけ、ただのステージに代える。
	 */
	const toggleStage = async (entry: ScmEntry) => {
		setActionError(undefined);
		if (shouldTryReviewStage(entry, reviewNotes.canStage)) {
			const result = await reviewNotes.stage([entry]);
			if (result === undefined) {
				return;
			}
			if (result.staged > 0) {
				void statusState.refresh();
				return;
			}
		}
		if (await stageFile.toggle(entry)) {
			void statusState.refresh();
		}
	};

	const merge = async (pr: PrDetail) => {
		const outcome = await pullRequest.merge(pr);
		if (outcome !== undefined) {
			useParaToast.getState().show({ key: 'scm-pr-merged', text: prMergeToastText(pr.number, outcome), icon: 'git-merge', tone: 'done' }, 2_400);
			void history.refresh();
		}
	};

	const openReview = (path: string) => {
		if (codeSpace.pcId === undefined || codeSpace.spaceId === undefined) {
			return;
		}
		const href = routes.review(codeSpace.pcId, codeSpace.spaceId, path);
		if (dock !== undefined) {
			dock.navigate(href);
			return;
		}
		router.push(href);
	};

	const changesState = listBodyState({ data: statusState.status?.files, error: statusState.error, unavailable: codeSpace.unavailable });
	const historyState = listBodyState({ data: history.log?.commits, error: history.error, unavailable: codeSpace.unavailable });

	return (
		<Screen>
			<ScreenHeader
				title="ソース管理"
				subtitle={subtitle.length > 0 ? subtitle : undefined}
				surface="panel"
				{...(dock !== undefined ? { safeTop: false, backIcon: X, backLabel: 'ソース管理を閉じる', onBack: dock.close } : {})}
				right={<HeaderButton icon={RefreshCw} label="最新の状態に更新" onPress={() => { haptic('commit'); refreshAll(); }} disabled={!codeSpace.live} />}
			>
				<Segments items={scmSegments(pullRequest.enabled)} value={shown} onChange={setSegment} />
			</ScreenHeader>
			<SpaceGateBody gate={codeSpace.gate}>
				<View style={[styles.body, { paddingBottom: ownKeyboardCover }]}>
					<ScrollView
						style={styles.scroll}
						contentContainerStyle={[styles.content, column]}
						keyboardShouldPersistTaps="handled"
						keyboardDismissMode="interactive"
						refreshControl={(
							<RefreshControl
								refreshing={statusState.loading && statusState.status !== undefined}
								onRefresh={() => { haptic('edge'); refreshAll(); }}
								tintColor={colors.textDim}
							/>
						)}
					>
						<OfflineBanner reason={codeSpace.unavailable} style={styles.banner} />
						<BranchCard
							branch={branch}
							sync={syncText}
							counts={counts}
							{...(branchSync !== undefined ? { syncSummary: scmSyncSummary(branchSync), syncing: sync.syncing } : {})}
							{...(branchSync !== undefined && codeSpace.live ? { onSync: requestSync } : {})}
							{...(prNumber !== undefined && prState !== undefined
								// PR の区分を出せない PC では、これまでの札と同じくブラウザで開く
								? { pr: { number: prNumber, state: prState, onPress: () => pullRequest.enabled ? setSegment('pr') : prUrl !== undefined ? void Linking.openURL(prUrl).catch(() => undefined) : undefined } }
								: {})}
						/>
						<InlineError message={sync.error} style={styles.inset} />
						{shown === 'changes' ? (
							<>
								<InlineError message={statusState.status !== undefined && statusState.error !== undefined ? `読み直せませんでした: ${statusState.error}` : undefined} style={styles.inset} />
								<InlineError message={actionError} style={styles.inset} />
								<ListBody
									state={changesState}
									emptyTitle="ローカルの変更はありません"
									emptyBody="作業ツリーは最後のコミットと同じ状態です。"
									emptyIcon={CircleCheck}
									onRetry={codeSpace.live ? refreshAll : undefined}
								>
									{groupScmEntries(entries).map(section => (
										<View key={section.group}>
											<GroupHeading title={section.title} count={section.entries.length} />
											{section.entries.map(entry => (
												<ScmFileRow
													key={entry.path}
													entry={entry}
													disabled={codeSpace.pcId === undefined}
													onPress={() => openReview(entry.path)}
													{...(stageFile.enabled && entry.kind !== 'conflict' ? { stage: { busy: stageFile.pending.has(entry.path), disabled: !codeSpace.live, onPress: () => void toggleStage(entry) } } : {})}
												/>
											))}
										</View>
									))}
								</ListBody>
							</>
						) : shown === 'pr' ? (
							<PullRequestPanel
								view={pullRequest.view}
								loading={pullRequest.loading}
								error={pullRequest.error}
								offline={codeSpace.unavailable}
								canMerge={pullRequest.canMerge}
								merging={pullRequest.merging}
								mergeError={pullRequest.mergeError}
								queued={pullRequest.queued}
								handoff={prHandoff}
								onRetry={codeSpace.live ? () => void pullRequest.reload() : undefined}
								onFix={pr => void prHandoff.send({ t: 'prFixChecks', number: pr.number }, 'auto')}
								onFixWithNewAgent={pr => void prHandoff.send({ t: 'prFixChecks', number: pr.number }, 'new')}
								onMerge={pr => { mergeTarget.hold(pr); setConfirmingMerge(pr); }}
							/>
						) : (
							<>
								<InlineError message={history.log !== undefined && history.error !== undefined ? `続きを読み込めませんでした: ${history.error}` : undefined} style={styles.inset} />
								<ListBody
									state={historyState}
									emptyTitle="コミットはまだありません"
									emptyBody="このブランチにはコミットがありません。"
									emptyIcon={GitCommitHorizontal}
									onRetry={codeSpace.live ? refreshAll : undefined}
								>
									{history.log !== undefined ? (
										<HistoryList
											log={history.log}
											now={now}
											commitFiles={history.commitFiles}
											onExpand={history.loadCommitFiles}
											onOpenWeb={webUrl !== undefined ? hash => { void Linking.openURL(`${webUrl}/commit/${hash}`); } : undefined}
										/>
									) : null}
									{history.log?.hasMore === true ? (
										<Button
											label="さらに読み込む"
											variant="secondary"
											size="sm"
											onPress={() => { haptic('move'); void history.loadMore(); }}
											loading={history.loadingMore}
											disabled={!codeSpace.live}
											style={styles.more}
										/>
									) : null}
								</ListBody>
							</>
						)}
					</ScrollView>
					{shown === 'changes' ? (
						<>
							<InlineError message={commitState.error !== undefined ? `コミットに失敗しました: ${commitState.error}` : undefined} />
							{commitWarning !== undefined ? <CommitWarning text={commitWarning} onDismiss={() => setCommitWarning(undefined)} /> : null}
							{commitState.failure !== undefined ? (
								<CommitFailureCard
									view={commitFailureView(commitState.failure)}
									handoff={commitHandoff}
									onFix={codeSpace.live ? () => void commitHandoff.send({ t: 'commitFix', failureId: commitState.failure?.id }, 'auto') : undefined}
									onFixWithNewAgent={() => void commitHandoff.send({ t: 'commitFix', failureId: commitState.failure?.id }, 'new')}
									onDismiss={() => { commitHandoff.reset(); commitState.dismissFailure(); }}
								/>
							) : null}
							<CommitBar
								action={action}
								message={message}
								onChangeMessage={text => { setMessage(text); commitState.clearError(); }}
								onCommit={primary}
								onBlocked={reason => useParaToast.getState().show({ key: 'scm-commit-blocked', text: reason, icon: 'alert-circle-outline', tone: 'warn' }, 1_900)}
								bottomInset={keyboardCover > 0 ? 0 : insets.bottom}
								{...(branchSync !== undefined || stageFile.enabled ? { hint: commitHint(scope, counts, stageFile.enabled) } : {})}
							/>
						</>
					) : null}
				</View>
			</SpaceGateBody>
			<ConfirmDrawer
				visible={confirmingMerge !== undefined}
				title="プルリクエストをマージしますか？"
				message={confirmingMerge !== undefined ? mergeConfirmMessage(confirmingMerge) : undefined}
				confirmLabel="マージ"
				destructive={false}
				haptic="danger"
				onConfirm={() => {
					const pr = mergeTarget.take();
					if (pr !== undefined) {
						void merge(pr);
					}
				}}
				onClose={() => setConfirmingMerge(undefined)}
			/>
			<ConfirmDrawer
				visible={confirmingPush}
				title={pushConfirm?.title ?? 'プッシュしますか？'}
				message={pushConfirm?.message}
				confirmLabel={pushConfirm?.confirmLabel ?? 'プッシュ'}
				destructive={false}
				onConfirm={() => void runSync('push')}
				onClose={() => setConfirmingPush(false)}
			/>
		</Screen>
	);
}

/** 一覧の本文（読み込み中・切断・失敗・空・中身）。 */
function ListBody({ state, emptyTitle, emptyBody, emptyIcon, onRetry, children }: {
	state: ListBodyState;
	emptyTitle: string;
	emptyBody: string;
	emptyIcon: LucideIcon;
	onRetry: (() => void) | undefined;
	children: ReactNode;
}) {
	switch (state.kind) {
		case 'loading':
			return <CenterSpinner label="読み込み中…" />;
		case 'offline':
			return <EmptyState icon={CloudOff} title="読み込めません" body={`${state.reason}。つながると読み込みます。`} style={styles.state} />;
		case 'error':
			return <EmptyState icon={CircleAlert} title={state.title} body={state.message} action={onRetry !== undefined ? { label: state.retryLabel, onPress: onRetry } : undefined} style={styles.state} />;
		case 'empty':
			return <EmptyState icon={emptyIcon} title={emptyTitle} body={emptyBody} style={styles.state} />;
		case 'ready':
			return <>{children}</>;
	}
}

const styles = StyleSheet.create({
	body: {
		flex: 1,
	},
	scroll: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingBottom: space.xl,
	},
	banner: {
		marginHorizontal: 0,
	},
	inset: {
		paddingHorizontal: 0,
	},
	state: {
		flex: 0,
		paddingTop: space.xl * 2,
	},
	more: {
		marginTop: space.md,
	},
});

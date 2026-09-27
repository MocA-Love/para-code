// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState, type ReactNode } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CircleCheck, CircleAlert, CloudOff, GitCommitHorizontal, RefreshCw } from 'lucide-react-native';
import { hapticImpact } from '../../haptics.js';
import { useKeyboardCoverage } from '../../hooks/useKeyboardVisible.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import { useParaToast } from '../../paraToast.js';
import { routes } from '../../routes.js';
import { colors, space } from '../../theme.js';
import { formatRelativeTime, useNow } from '../../time.js';
import { Button, EmptyState, HeaderButton, Screen, ScreenHeader, type LucideIcon } from '../../ui/index.js';
import { X } from 'lucide-react-native';
import { CenterSpinner, GroupHeading, InlineError, OfflineBanner, Segments, SpaceGateBody, useReadableColumn } from './codeParts.js';
import { BranchCard, CommitBar, HistoryList, ScmFileRow } from './scmParts.js';
import {
	SCM_SEGMENTS,
	commitAction,
	groupScmEntries,
	listBodyState,
	scmCounts,
	scmEntries,
	type ListBodyState,
	type ScmSegment,
} from './scmModel.js';
import { useCodeSpace, type CodeSpaceTarget } from './useCodeSpace.js';
import type { PanelDock } from './panelDock.js';
import { useScmCommit, useScmHistory, useScmStatus } from './useScmData.js';

/**
 * ソース管理（`/pc/[pcId]/source-control/[spaceId]`）。Orca の MobileSourceControlPanel に合わせ、
 * 上に区分の切り替え（変更 / コミット）、その下にブランチのカードと変更の一覧、下端にコミットバーを置く。
 *
 * PC 側にあるのは「すべての変更をまとめてコミット」だけなので、ステージ・破棄・プッシュの操作は出さず、
 * コミットバーの下にその旨を書く。変更の行を押すと差分レビュー（`/pc/[pcId]/review/[spaceId]`）へ進む。
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
	const [segment, setSegment] = useState<ScmSegment>('changes');
	const [message, setMessage] = useState('');
	const now = useNow();
	const insets = useStableInsets();
	// ドックではセッションの画面がキーボードの分を空けているので、ここでは足さない。
	const keyboardCover = useKeyboardCoverage();
	const ownKeyboardCover = dock !== undefined ? 0 : keyboardCover;
	const column = useReadableColumn();

	const entries = scmEntries(statusState.status);
	const counts = statusState.status !== undefined ? scmCounts(entries) : undefined;
	const action = commitAction({ live: codeSpace.live, total: counts?.total, message, committing: commitState.committing });
	const latest = history.log?.commits[0];
	const sync = latest === undefined ? undefined : `最新のコミット ${latest.at !== undefined ? formatRelativeTime(latest.at, now) : latest.when}`;
	const branch = statusState.status?.branch ?? codeSpace.branch;
	const subtitle = [codeSpace.name, branch].filter(part => part !== undefined && part.length > 0).join(' · ');
	const webUrl = history.log?.webUrl;

	const refreshAll = () => {
		hapticImpact('light');
		void statusState.refresh();
		void history.refresh();
	};

	const commit = async () => {
		const ok = await commitState.commit(message);
		if (!ok) {
			return;
		}
		setMessage('');
		useParaToast.getState().show({ key: 'scm-commit', text: 'コミットしました', sub: branch, icon: 'checkmark-circle-outline', tone: 'done' }, 1_900);
		void statusState.refresh();
		void history.refresh();
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
				right={<HeaderButton icon={RefreshCw} label="最新の状態に更新" onPress={refreshAll} disabled={!codeSpace.live} />}
			>
				<Segments items={SCM_SEGMENTS} value={segment} onChange={setSegment} />
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
								onRefresh={refreshAll}
								tintColor={colors.textDim}
							/>
						)}
					>
						<OfflineBanner reason={codeSpace.unavailable} style={styles.banner} />
						<BranchCard branch={branch} sync={sync} counts={counts} />
						{segment === 'changes' ? (
							<>
								<InlineError message={statusState.status !== undefined && statusState.error !== undefined ? `読み直せませんでした: ${statusState.error}` : undefined} style={styles.inset} />
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
												<ScmFileRow key={entry.path} entry={entry} disabled={codeSpace.pcId === undefined} onPress={() => openReview(entry.path)} />
											))}
										</View>
									))}
								</ListBody>
							</>
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
											onPress={() => { hapticImpact('light'); void history.loadMore(); }}
											loading={history.loadingMore}
											disabled={!codeSpace.live}
											style={styles.more}
										/>
									) : null}
								</ListBody>
							</>
						)}
					</ScrollView>
					{segment === 'changes' ? (
						<>
							<InlineError message={commitState.error !== undefined ? `コミットに失敗しました: ${commitState.error}` : undefined} />
							<CommitBar
								action={action}
								message={message}
								onChangeMessage={text => { setMessage(text); commitState.clearError(); }}
								onCommit={() => { void commit(); }}
								onBlocked={reason => useParaToast.getState().show({ key: 'scm-commit-blocked', text: reason, icon: 'alert-circle-outline', tone: 'warn' }, 1_900)}
								bottomInset={keyboardCover > 0 ? 0 : insets.bottom}
							/>
						</>
					) : null}
				</View>
			</SpaceGateBody>
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
			return <EmptyState icon={CircleAlert} title="読み込めませんでした" body={state.message} action={onRetry !== undefined ? { label: '再読み込み', onPress: onRetry } : undefined} style={styles.state} />;
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

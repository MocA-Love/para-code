// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleAlert, CircleCheck, CircleDashed, RefreshCw } from 'lucide-react-native';
import { agentActivityAncestors, agentActivityChildren, agentActivityDescendants, agentActivityTasksForAgent } from '../../../../../../src/agentActivityTree.js';
import { activityStatusColor, activityStatusLabel } from '../../../../../../src/agentStatus.js';
import { detailToChatMessages } from '../../../../../../src/agentToolMeta.js';
import { useAppStore } from '../../../../../../src/appState.js';
import { hitSlopToMinimum } from '../../../../../../src/components/hitSlop.js';
import { MarkdownText } from '../../../../../../src/components/markdownText.js';
import { ChatTextScaleProvider } from '../../../../../../src/ui/chatTextScale.js';
import { haptic } from '../../../../../../src/haptics.js';
import { useStableInsets } from '../../../../../../src/hooks/useStableInsets.js';
import { firstParam, routes } from '../../../../../../src/routes.js';
import type { AgentActivityAgent, AgentActivityDetailMessage } from '../../../../../../src/store.js';
import { colors, space, type } from '../../../../../../src/theme.js';
import { useNow } from '../../../../../../src/time.js';
import { Card, EmptyState, Icon, iconSize, ListGroup, Screen, ScreenHeader, SectionHeader } from '../../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../../src/features/code/codeParts.js';
import { activityDetailRefreshDelay, activityEndAt, formatActivityDuration, shouldRefreshActivityDetail } from '../../../../../../src/features/activity/activityModel.js';
import { ActivityAgentRow, ActivityId, ActivityMetrics, chatProvider, providerLabel, useActivityRoute } from '../../../../../../src/features/activity/activityParts.js';
import { ChatRowView } from '../../../../../../src/features/session/chatItems.js';
import { buildChatRows, chatRowKey, type ChatRow } from '../../../../../../src/features/session/chatRows.js';

/** パンくずの1つの見た目の高さ（pt）。当たり判定は 44 に広げる。 */
const CRUMB_HEIGHT = 24;

/**
 * サブエージェント1つの詳細（`/pc/[pcId]/session/[spaceId]/activity/[agentId]?terminal=…&epoch=…`）。
 * 旧画面（`legacy-screens/agent-activity-detail.tsx`）の処理を移し、見た目を Orca の部品で作り直した。
 *
 * 上から: 親からの道筋（押すとその階層を開く）、数字（状態と経過・直接の子・配下全体・完了）、
 * 頼まれた内容、担当のタスク、会話とツールの履歴（セッション画面の会話表示と同じ行）、子のエージェント。
 * 履歴は開いたとき（と親の会話のセッションが替わったとき）に PC から取り寄せ、開いている間は一覧の更新時刻が
 * 進んだら取り直す（動いている子の会話が開いた時のまま止まらないように。行の購読に置き換えるまでの暫定）。
 */
export default function AgentActivityDetailScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useReadableColumn();
	const now = useNow();
	const params = useLocalSearchParams<{ agentId?: string | string[] }>();
	const agentId = firstParam(params.agentId);
	const route = useActivityRoute();
	const { chat, terminalKey } = route;
	const requestDetail = useAppStore(s => s.requestAgentActivityDetail);
	// 会話の文字サイズ（設定 → チャット UI）を、頼まれた内容と会話・ツールの履歴にもかける。
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const agents = !route.sessionChanged ? chat?.activity?.agents ?? [] : [];
	const agent = agentId !== undefined ? agents.find(item => item.id === agentId) : undefined;
	const parent = agent?.parentId !== undefined ? agents.find(item => item.id === agent.parentId) : undefined;
	const parentLabel = parent?.label ?? route.title ?? '親のエージェント';
	const provider = agent?.provider ?? chatProvider(chat);

	const [messages, setMessages] = useState<AgentActivityDetailMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const selectedId = agent?.id;
	const chatEpoch = chat?.epoch;
	const agentUpdatedAt = agent?.updatedAt;
	const agentUpdatedAtRef = useRef(agentUpdatedAt);
	agentUpdatedAtRef.current = agentUpdatedAt;
	// 取り直しの判断: 最後に取れた内容が一覧のどの更新時刻のものか、取得中か、最後に取り始めた時刻
	const [fetchedUpdatedAt, setFetchedUpdatedAt] = useState<number | undefined>(undefined);
	const [inFlight, setInFlight] = useState(false);
	const lastFetchAtRef = useRef(0);
	// 古い要求の応答を捨てる印（PC の要求は止められないので、届いても使わない）
	const generationRef = useRef(0);
	const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const clearRefreshTimer = useCallback(() => {
		if (refreshTimerRef.current !== undefined) {
			clearTimeout(refreshTimerRef.current);
			refreshTimerRef.current = undefined;
		}
	}, []);
	const fetchDetail = useCallback((initial: boolean) => {
		if (terminalKey === undefined || selectedId === undefined) {
			return;
		}
		const generation = ++generationRef.current;
		const updatedAt = agentUpdatedAtRef.current;
		lastFetchAtRef.current = Date.now();
		setInFlight(true);
		if (initial) {
			setLoading(true);
		}
		requestDetail(terminalKey, selectedId)
			.then(result => {
				if (generationRef.current === generation) {
					setMessages(result);
					setFailed(false);
					setFetchedUpdatedAt(updatedAt);
				}
			})
			.catch(() => {
				if (generationRef.current !== generation) {
					return;
				}
				if (initial) {
					setFailed(true);
				} else {
					// 取り直しに失敗したら前の内容のまま。同じ更新時刻で取り直しを繰り返さない
					setFetchedUpdatedAt(updatedAt);
				}
			})
			.finally(() => {
				if (generationRef.current === generation) {
					setLoading(false);
					setInFlight(false);
				}
			});
	}, [requestDetail, selectedId, terminalKey]);
	useEffect(() => {
		clearRefreshTimer();
		setMessages([]);
		setFailed(false);
		setFetchedUpdatedAt(undefined);
		if (terminalKey === undefined || selectedId === undefined) {
			generationRef.current++;
			setLoading(false);
			setInFlight(false);
			return undefined;
		}
		fetchDetail(true);
		return () => {
			generationRef.current++;
			clearRefreshTimer();
		};
	}, [chatEpoch, fetchDetail, clearRefreshTimer, selectedId, terminalKey]);
	// 一覧の更新時刻が進んだら取り直す。待っている間に届いた更新は同じ 1 回にまとめる（タイマーを張り直さない）
	useEffect(() => {
		if (inFlight || refreshTimerRef.current !== undefined || !shouldRefreshActivityDetail(fetchedUpdatedAt, agentUpdatedAt)) {
			return;
		}
		refreshTimerRef.current = setTimeout(() => {
			refreshTimerRef.current = undefined;
			fetchDetail(false);
		}, activityDetailRefreshDelay(lastFetchAtRef.current, Date.now()));
	}, [agentUpdatedAt, fetchedUpdatedAt, inFlight, fetchDetail]);

	// FlatList の data。毎回作り直すと全行の props が変わるので、元の値が変わったときだけ組み直す。
	const rows = useMemo<ChatRow[]>(() => buildChatRows(detailToChatMessages(messages)), [messages]);
	const children = useMemo(() => (agent !== undefined ? agentActivityChildren(agents, agent.id) : []), [agents, agent]);
	const descendants = useMemo(() => (agent !== undefined ? agentActivityDescendants(agents, agent.id) : []), [agents, agent]);
	const ancestors = agent !== undefined ? agentActivityAncestors(agents, agent.id) : [];
	const tasks = agent !== undefined ? agentActivityTasksForAgent(chat?.activity?.tasks ?? [], agent) : [];

	const openAgent = (target: AgentActivityAgent) => {
		if (route.pcId === undefined || route.spaceId === undefined || terminalKey === undefined) {
			return;
		}
		haptic('move');
		router.push(routes.activityAgent(route.pcId, route.spaceId, terminalKey, target.id, route.epoch));
	};

	const gate = (() => {
		if (route.loading) {
			return <CenterSpinner />;
		}
		if (route.parentMissing) {
			return <EmptyState icon={CircleAlert} title="エージェントが見つかりません" body="PC 側で閉じられたかもしれません。セッションへ戻って開き直してください。" />;
		}
		if (route.sessionChanged) {
			return <EmptyState icon={RefreshCw} title="会話が新しくなりました" body="エージェントの会話が切り替わりました。セッションへ戻って開き直してください。" />;
		}
		if (chat === undefined) {
			return <CenterSpinner label="会話を読み込んでいます…" />;
		}
		if (agent === undefined) {
			return <EmptyState icon={CircleAlert} title="このサブエージェントは見つかりません" body="記録が消えたか、別の会話のサブエージェントかもしれません。" />;
		}
		return undefined;
	})();

	const header = agent !== undefined ? (
		<View>
			<ActivityMetrics items={[
				{ label: formatActivityDuration(agent.startedAt, activityEndAt(agent, now)), value: activityStatusLabel(agent.status) },
				{ label: '直接の子', value: String(children.length) },
				{ label: '配下全体', value: String(descendants.length) },
				{ label: '完了', value: String(descendants.filter(item => item.status === 'completed').length) },
			]} />
			<SectionHeader title="頼まれた内容" style={styles.section} />
			<Card style={styles.prompt}>
				<MarkdownText text={agent.detail ?? agent.label} />
				<ActivityId id={agent.id} />
			</Card>
			{tasks.length > 0 ? (
				<>
					<SectionHeader title="担当のタスク" count={tasks.length} style={styles.section} />
					<Card style={styles.tasks}>
						{tasks.map(task => (
							<View key={task.id} style={styles.task}>
								<Icon icon={task.status === 'completed' ? CircleCheck : CircleDashed} size={iconSize.sm} color={activityStatusColor(task.status)} />
								<Text style={styles.taskLabel}>{task.label}</Text>
							</View>
						))}
					</Card>
				</>
			) : null}
			<SectionHeader title="会話とツールの履歴" style={styles.section} />
		</View>
	) : null;

	const footer = children.length > 0 && agent !== undefined ? (
		<View>
			<SectionHeader title="子のエージェント" count={children.length} style={styles.section} />
			<ListGroup>
				{children.map(child => (
					<ActivityAgentRow key={child.id} agent={child} depth={1} fallbackProvider={chatProvider(chat)} now={now} onOpen={openAgent} />
				))}
			</ListGroup>
		</View>
	) : null;

	const historyEmpty = loading
		? <CenterSpinner label="履歴を読み込んでいます…" />
		: <Text style={styles.muted}>{failed ? '履歴を読み込めませんでした。PC との接続を確かめてください。' : '保存された履歴はありません。'}</Text>;

	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<Screen>
				<ScreenHeader
					title={agent?.label ?? 'サブエージェント'}
					subtitle={`親: ${parentLabel} · ${providerLabel(provider)}`}
					backLabel="ひとつ上へ戻る"
				>
					{ancestors.length > 0 ? (
						<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs}>
							<Text style={styles.crumbRoot} numberOfLines={1}>{route.title ?? 'エージェント'}</Text>
							{ancestors.map(ancestor => (
								<Pressable
									key={ancestor.id}
									onPress={() => openAgent(ancestor)}
									hitSlop={hitSlopToMinimum(CRUMB_HEIGHT)}
									style={styles.crumb}
									accessibilityRole="button"
									accessibilityLabel={`${ancestor.label}を開く`}
								>
									<Text style={styles.crumbText} numberOfLines={1}>{`› ${ancestor.label}`}</Text>
								</Pressable>
							))}
						</ScrollView>
					) : null}
				</ScreenHeader>
				<View style={styles.fill}>
					{gate ?? (
						<FlatList
							data={rows}
							keyExtractor={row => chatRowKey(row, chatEpoch ?? '')}
							renderItem={({ item }) => <ChatRowView row={item} terminalKey={terminalKey ?? ''} allToolsOpen={false} />}
							ListHeaderComponent={header}
							ListEmptyComponent={historyEmpty}
							ListFooterComponent={footer}
							contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}
						/>
					)}
				</View>
			</Screen>
		</ChatTextScaleProvider>
	);
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
	},
	section: {
		marginTop: space.xl,
	},
	prompt: {
		padding: space.md,
		gap: space.sm,
	},
	tasks: {
		padding: space.md,
		gap: space.sm,
	},
	task: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	taskLabel: {
		flex: 1,
		fontSize: type.label,
		color: colors.text,
	},
	muted: {
		fontSize: type.label,
		color: colors.textMuted,
		paddingVertical: space.md,
	},
	crumbs: {
		alignItems: 'center',
		gap: space.xs,
		paddingHorizontal: space.lg,
		paddingBottom: space.sm,
	},
	crumbRoot: {
		fontSize: type.meta,
		color: colors.textMuted,
		maxWidth: 140,
	},
	crumb: {
		height: CRUMB_HEIGHT,
		justifyContent: 'center',
	},
	crumbText: {
		fontSize: type.meta,
		fontWeight: '600',
		color: colors.purple,
		maxWidth: 140,
	},
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { MarkdownText } from '../src/components/markdownText.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useNow } from '../src/time.js';
import { colors } from '../src/theme.js';
import { hapticSelection } from '../src/haptics.js';
import { agentActivityAncestors, agentActivityChildren, agentActivityDescendants, agentActivityTasksForAgent } from '../src/agentActivityTree.js';
import type { AgentActivityAgent, AgentActivityDetailMessage, AgentActivityStatus } from '../src/store.js';

type ConversationItem = { kind: 'message'; value: AgentActivityDetailMessage; index: number } | { kind: 'child'; value: AgentActivityAgent };

function statusLabel(status: AgentActivityStatus): string {
	return status === 'running' ? '実行中' : status === 'idle' ? '待機中' : status === 'completed' ? '完了' : status === 'failed' ? '失敗' : status === 'interrupted' ? '中断' : '状態不明';
}

function ActivityMessage({ message, parentLabel }: { message: AgentActivityDetailMessage; parentLabel: string }) {
	const [expanded, setExpanded] = useState(false);
	if (message.kind === 'tool') {
		return <View style={styles.leftLane}><Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.toolCard}>
			<View style={styles.toolHeader}><Ionicons name="construct-outline" size={12} color={colors.textDim} /><Text style={styles.toolLabel}>Tool</Text><Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={11} color={colors.textDim} /></View>
			<Text style={styles.toolText} selectable numberOfLines={expanded ? undefined : 5}>{message.text}</Text>
		</Pressable></View>;
	}
	if (message.kind === 'thinking') {
		return <View style={styles.leftLane}><Pressable accessibilityRole="button" accessibilityLabel="思考内容を展開" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.thinkingCard}><Text style={styles.thinkingLabel}>Thinking</Text><Text style={styles.thinkingText} selectable numberOfLines={expanded ? undefined : 4}>{message.text}</Text></Pressable></View>;
	}
	const fromParent = message.role === 'user';
	return <View style={fromParent ? styles.rightLane : styles.leftLane}>
		<Text style={[styles.speaker, fromParent && styles.speakerRight]}>{fromParent ? parentLabel : 'SubAgent'}</Text>
		<View style={[styles.chatBubble, fromParent ? styles.parentBubble : styles.agentBubble]}><MarkdownText text={message.text} /></View>
	</View>;
}

export default function AgentActivityDetailScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const now = useNow();
	const { terminalKey, agentId, epoch } = useLocalSearchParams<{ terminalKey?: string; agentId?: string; epoch?: string }>();
	const workspace = useAppStore(state => state.workspace);
	const chat = useAppStore(state => terminalKey !== undefined ? state.agentChats.get(terminalKey) : undefined);
	const requestDetail = useAppStore(state => state.requestAgentActivityDetail);
	const terminal = workspace?.terminals.find(item => item.terminalKey === terminalKey);
	const sessionChanged = chat !== undefined && typeof epoch === 'string' && chat.epoch !== epoch;
	const agents = !sessionChanged ? chat?.activity?.agents ?? [] : [];
	const agent = typeof agentId === 'string' ? agents.find(item => item.id === agentId) : undefined;
	const selectedAgentId = agent?.id;
	const parent = agent?.parentId !== undefined ? agents.find(item => item.id === agent.parentId) : undefined;
	const parentLabel = parent?.label ?? terminal?.title ?? '親Agent';
	const ancestors = agent !== undefined ? agentActivityAncestors(agents, agent.id) : [];
	const children = agent !== undefined ? agentActivityChildren(agents, agent.id) : [];
	const descendants = agent !== undefined ? agentActivityDescendants(agents, agent.id) : [];
	const tasks = agent === undefined ? [] : agentActivityTasksForAgent(chat?.activity?.tasks ?? [], agent);
	const [messages, setMessages] = useState<AgentActivityDetailMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		setMessages([]); setError(undefined);
		if (terminalKey === undefined || selectedAgentId === undefined) { setLoading(false); return; }
		let cancelled = false; setLoading(true);
		requestDetail(terminalKey, selectedAgentId).then(result => { if (!cancelled) { setMessages(result); } })
			.catch(reason => { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'SubAgent transcriptを取得できませんでした'); } })
			.finally(() => { if (!cancelled) { setLoading(false); } });
		return () => { cancelled = true; };
	}, [chat?.epoch, requestDetail, selectedAgentId, terminalKey]);

	const elapsedEnd = agent?.status === 'running' || agent?.status === 'idle' ? now : agent?.updatedAt;
	const elapsed = agent !== undefined && elapsedEnd !== undefined ? Math.max(0, Math.round((elapsedEnd - agent.startedAt) / 1000)) : 0;
	const conversation: ConversationItem[] = [
		...messages.map((value, index) => ({ kind: 'message' as const, value, index })),
		...children.map(value => ({ kind: 'child' as const, value })),
	];
	const navigateAgent = (target: AgentActivityAgent) => {
		hapticSelection();
		router.push({ pathname: '/agent-activity-detail', params: { terminalKey, agentId: target.id, epoch: epoch ?? '' } });
	};

	return <ConnectionGate><View style={styles.screen}>
		<View style={[styles.header, { paddingTop: insets.top + 4 }]}>
			<Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel="SubAgent一覧へ戻る" onPress={() => { hapticSelection(); router.back(); }}><GlassSurface style={styles.backBtn} interactive><Ionicons name="chevron-back" size={20} color={colors.text} /></GlassSurface></Pressable>
			<View style={styles.headerBody}>
				<View style={styles.breadcrumbs}><Text style={styles.crumb} numberOfLines={1}>{terminal?.title ?? 'Agent'}</Text>{ancestors.map(value => <Pressable key={value.id} accessibilityRole="button" accessibilityLabel={`${value.label}へ戻る`} onPress={() => navigateAgent(value)}><Text style={styles.crumb} numberOfLines={1}> › {value.label}</Text></Pressable>)}</View>
				<Text style={styles.headerTitle} numberOfLines={1}>{agent?.label ?? 'SubAgent detail'}</Text>
				<Text style={styles.headerSub}>親: {parentLabel} · {agent?.provider ?? chat?.agent ?? 'unknown'}</Text>
			</View>
		</View>
		<FlatList
			data={conversation}
			keyExtractor={item => item.kind === 'message' ? `message:${item.index}` : `child:${item.value.id}`}
			contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
			ListHeaderComponent={agent !== undefined ? <View>
				<View style={styles.summaryCard}>
					<View style={styles.metric}><Text style={styles.metricValue}>{statusLabel(agent.status)}</Text><Text style={styles.metricLabel}>{elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`}</Text></View>
					<View style={styles.metric}><Text style={styles.metricValue}>{children.length}</Text><Text style={styles.metricLabel}>直接の子</Text></View>
					<View style={styles.metric}><Text style={styles.metricValue}>{descendants.length}</Text><Text style={styles.metricLabel}>配下全体</Text></View>
					<View style={styles.metric}><Text style={styles.metricValue}>{descendants.filter(value => value.status === 'completed').length}</Text><Text style={styles.metricLabel}>完了</Text></View>
				</View>
				<View style={styles.promptCard}><Text style={styles.promptLabel}>Prompt / Description</Text><MarkdownText text={agent.detail ?? agent.label} /><Text style={styles.agentId} selectable>{agent.id}</Text></View>
				{tasks.length > 0 ? <View style={styles.taskCard}><Text style={styles.promptLabel}>担当Task</Text>{tasks.map(task => <View key={task.id} style={styles.task}><Ionicons name={task.status === 'completed' ? 'checkmark-circle' : 'ellipse-outline'} size={13} color={colors.accent} /><Text style={styles.taskTitle}>{task.label}</Text></View>)}</View> : null}
				<Text style={styles.section}>会話・ツール履歴</Text>
			</View> : null}
			ListEmptyComponent={<View style={styles.empty}>{sessionChanged ? <Text style={styles.error}>親セッションが切り替わりました。親エージェントから開き直してください。</Text> : loading ? <Text style={styles.emptyText}>SubAgent transcriptを読み込み中…</Text> : error !== undefined ? <Text style={styles.error}>{error}</Text> : <Text style={styles.emptyText}>保存済みの子セッション履歴はありません</Text>}</View>}
			renderItem={({ item }) => item.kind === 'message' ? <ActivityMessage message={item.value} parentLabel={parentLabel} /> : <View style={styles.leftLane}><Pressable accessibilityRole="button" accessibilityLabel={`${item.value.label}を開く`} onPress={() => navigateAgent(item.value)} style={styles.childCard}><View style={styles.childIcon}><Ionicons name="git-branch-outline" size={14} color={colors.purple} /></View><View style={styles.childBody}><Text style={styles.childCaption}>子Agentを起動</Text><Text style={styles.childTitle} numberOfLines={1}>{item.value.label}</Text><Text style={styles.childMeta}>{statusLabel(item.value.status)} · 配下 {agentActivityDescendants(agents, item.value.id).length}</Text></View><Ionicons name="chevron-forward" size={14} color={colors.textDim} /></Pressable></View>}
		/>
	</View></ConnectionGate>;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg }, header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, backBtn: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, headerBody: { flex: 1, minWidth: 0 }, breadcrumbs: { flexDirection: 'row', minWidth: 0, overflow: 'hidden' }, crumb: { color: colors.purple, fontSize: 8.5, fontWeight: '700', maxWidth: 105 }, headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' }, headerSub: { color: colors.textDim, fontSize: 9.5, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	content: { padding: 14, gap: 10 }, summaryCard: { flexDirection: 'row', backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 16, paddingVertical: 12, marginBottom: 10 }, metric: { flex: 1, alignItems: 'center', paddingHorizontal: 3 }, metricValue: { color: colors.text, fontSize: 12, fontWeight: '700' }, metricLabel: { color: colors.textDim, fontSize: 8, marginTop: 3 }, promptCard: { backgroundColor: 'rgba(193,147,217,.08)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(193,147,217,.28)', borderRadius: 16, padding: 13, gap: 7, marginBottom: 8 }, promptLabel: { color: colors.textDim, fontSize: 8.5, fontWeight: '700', textTransform: 'uppercase' }, agentId: { color: colors.purple, fontSize: 8.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }, taskCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 11, gap: 7, marginBottom: 8 }, task: { flexDirection: 'row', gap: 7, alignItems: 'center' }, taskTitle: { color: colors.text, fontSize: 10.5, flex: 1 }, section: { color: colors.textDim, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', marginTop: 6, marginBottom: 2 },
	leftLane: { alignSelf: 'flex-start', maxWidth: '92%', gap: 3 }, rightLane: { alignSelf: 'flex-end', maxWidth: '88%', gap: 3 }, speaker: { color: colors.textDim, fontSize: 8, fontWeight: '700', marginLeft: 5 }, speakerRight: { textAlign: 'right', marginRight: 5 }, chatBubble: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth }, parentBubble: { backgroundColor: colors.accentWash, borderColor: 'rgba(71,190,255,.28)', borderBottomRightRadius: 4 }, agentBubble: { backgroundColor: colors.surface, borderColor: colors.border, borderBottomLeftRadius: 4 },
	toolCard: { backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 12, padding: 10, gap: 6 }, toolHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 }, toolLabel: { color: colors.textDim, fontSize: 8.5, fontWeight: '700', textTransform: 'uppercase', flex: 1 }, toolText: { color: colors.text, fontSize: 9.5, lineHeight: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }, thinkingCard: { paddingHorizontal: 8, paddingVertical: 5, borderLeftWidth: 2, borderLeftColor: colors.border }, thinkingLabel: { color: colors.textDim, fontSize: 8, fontWeight: '700', textTransform: 'uppercase' }, thinkingText: { color: colors.textDim, fontSize: 9.5, lineHeight: 14, fontStyle: 'italic' },
	childCard: { minWidth: 245, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(193,147,217,.08)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(193,147,217,.30)', borderRadius: 14, padding: 11 }, childIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: 'rgba(193,147,217,.12)', alignItems: 'center', justifyContent: 'center' }, childBody: { flex: 1, minWidth: 0 }, childCaption: { color: colors.textDim, fontSize: 8 }, childTitle: { color: colors.text, fontSize: 11.5, fontWeight: '700' }, childMeta: { color: colors.purple, fontSize: 8.5, marginTop: 2 }, empty: { paddingVertical: 40, alignItems: 'center' }, emptyText: { color: colors.textDim, fontSize: 11 }, error: { color: colors.red, fontSize: 11, textAlign: 'center' },
});

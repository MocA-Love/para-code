// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useNow } from '../src/time.js';
import { colors } from '../src/theme.js';
import { hapticSelection } from '../src/haptics.js';
import type { AgentActivityDetailMessage, AgentActivityStatus } from '../src/store.js';

function statusLabel(status: AgentActivityStatus): string {
	return status === 'running' ? '実行中' : status === 'idle' ? '待機中' : status === 'completed' ? '完了' : status === 'failed' ? '失敗' : status === 'interrupted' ? '中断' : '状態不明';
}

export default function AgentActivityDetailScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const now = useNow();
	const { terminalId: terminalParam, agentId, epoch } = useLocalSearchParams<{ terminalId?: string; agentId?: string; epoch?: string }>();
	const terminalId = Number(terminalParam);
	const workspace = useAppStore(state => state.workspace);
	const chat = useAppStore(state => Number.isInteger(terminalId) ? state.agentChats.get(terminalId) : undefined);
	const requestDetail = useAppStore(state => state.requestAgentActivityDetail);
	const terminal = workspace?.terminals.find(item => item.id === terminalId);
	const sessionChanged = chat !== undefined && typeof epoch === 'string' && chat.epoch !== epoch;
	const agent = !sessionChanged && typeof agentId === 'string' ? chat?.activity?.agents.find(item => item.id === agentId) : undefined;
	const selectedAgentId = agent?.id;
	const tasks = agent === undefined ? [] : chat?.activity?.tasks.filter(task => task.assignee === agent.id || task.assignee === agent.label) ?? [];
	const [messages, setMessages] = useState<AgentActivityDetailMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		setMessages([]); setError(undefined);
		if (!Number.isInteger(terminalId) || selectedAgentId === undefined) { setLoading(false); return; }
		let cancelled = false;
		setLoading(true);
		requestDetail(terminalId, selectedAgentId).then(result => { if (!cancelled) { setMessages(result); } })
			.catch(reason => { if (!cancelled) { setError(reason instanceof Error ? reason.message : 'SubAgent transcriptを取得できませんでした'); } })
			.finally(() => { if (!cancelled) { setLoading(false); } });
		return () => { cancelled = true; };
	}, [chat?.epoch, requestDetail, selectedAgentId, terminalId]);

	const elapsedEnd = agent?.status === 'running' || agent?.status === 'idle' ? now : agent?.updatedAt;
	const elapsed = agent !== undefined && elapsedEnd !== undefined ? Math.max(0, Math.round((elapsedEnd - agent.startedAt) / 1000)) : 0;

	return <ConnectionGate><View style={styles.screen}>
		<View style={[styles.header, { paddingTop: insets.top + 4 }]}>
			<Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel="SubAgent一覧へ戻る" onPress={() => { hapticSelection(); router.back(); }}><GlassSurface style={styles.backBtn} interactive><Ionicons name="chevron-back" size={20} color={colors.text} /></GlassSurface></Pressable>
			<View style={styles.headerBody}><View style={styles.contextRow}><Ionicons name="git-branch-outline" size={11} color={colors.purple} /><Text style={styles.context}>親: {terminal?.title ?? 'Agent'}</Text></View><Text style={styles.headerTitle} numberOfLines={1}>{agent?.label ?? 'SubAgent detail'}</Text><Text style={styles.headerSub}>子Agent専用ビュー · {agent?.provider ?? chat?.agent ?? 'unknown'}</Text></View>
		</View>
		<FlatList
			data={messages}
			keyExtractor={(_, index) => String(index)}
			contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
			ListHeaderComponent={agent !== undefined ? <View style={styles.metaCard}><Text style={styles.label}>Prompt / Description</Text><Text style={styles.prompt} selectable>{agent.detail ?? agent.label}</Text><Text style={styles.label}>Agent ID</Text><Text style={styles.code} selectable>{agent.id}</Text><Text style={styles.label}>状態</Text><Text style={styles.prompt}>{statusLabel(agent.status)} · {elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`}</Text>{tasks.length > 0 ? <><Text style={styles.label}>担当Task</Text>{tasks.map(task => <View key={task.id} style={styles.task}><Ionicons name={task.status === 'completed' ? 'checkmark-circle' : 'ellipse-outline'} size={13} color={colors.accent} /><View style={styles.taskBody}><Text style={styles.taskTitle}>{task.label}</Text>{task.detail ? <Text style={styles.taskDetail}>{task.detail}</Text> : null}</View></View>)}</> : null}<Text style={styles.section}>会話・ツール履歴</Text></View> : null}
			ListEmptyComponent={<View style={styles.empty}>{sessionChanged ? <Text style={styles.error}>親セッションが切り替わりました。親エージェントから開き直してください。</Text> : loading ? <Text style={styles.emptyText}>SubAgent transcriptを読み込み中…</Text> : error !== undefined ? <Text style={styles.error}>{error}</Text> : <Text style={styles.emptyText}>保存済みの子セッション履歴はありません</Text>}</View>}
			renderItem={({ item }) => <View style={[styles.message, item.role === 'user' && styles.messageUser, item.kind === 'tool' && styles.messageTool]}><Text style={styles.messageRole}>{item.kind === 'tool' ? 'Tool' : item.role === 'user' ? 'User' : 'SubAgent'}</Text><Text style={styles.messageText} selectable>{item.text}</Text></View>}
		/>
	</View></ConnectionGate>;
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg }, header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }, backBtn: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }, headerBody: { flex: 1, minWidth: 0 }, contextRow: { flexDirection: 'row', alignItems: 'center', gap: 4 }, context: { color: colors.purple, fontSize: 9, fontWeight: '700' }, headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' }, headerSub: { color: colors.textDim, fontSize: 9.5, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	content: { padding: 14, gap: 8 }, metaCard: { backgroundColor: 'rgba(193,147,217,.08)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(193,147,217,.28)', borderRadius: 16, padding: 13, gap: 6, marginBottom: 8 }, label: { color: colors.textDim, fontSize: 8.5, fontWeight: '700', textTransform: 'uppercase', marginTop: 4 }, prompt: { color: colors.text, fontSize: 11.5, lineHeight: 17 }, code: { color: colors.purple, fontSize: 9.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }, section: { color: colors.textDim, fontSize: 9, fontWeight: '700', textTransform: 'uppercase', marginTop: 10 }, task: { flexDirection: 'row', gap: 7, alignItems: 'flex-start' }, taskBody: { flex: 1 }, taskTitle: { color: colors.text, fontSize: 10.5, fontWeight: '600' }, taskDetail: { color: colors.textDim, fontSize: 9.5, lineHeight: 14 },
	message: { padding: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 3 }, messageUser: { backgroundColor: colors.accentWash }, messageTool: { backgroundColor: colors.surface2 }, messageRole: { color: colors.textDim, fontSize: 8, fontWeight: '700', textTransform: 'uppercase' }, messageText: { color: colors.text, fontSize: 10.5, lineHeight: 15 }, empty: { paddingVertical: 40, alignItems: 'center' }, emptyText: { color: colors.textDim, fontSize: 11 }, error: { color: colors.red, fontSize: 11, textAlign: 'center' },
});

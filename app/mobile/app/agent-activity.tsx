// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../src/appState.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { hapticSelection } from '../src/haptics.js';
import { useNow } from '../src/time.js';
import type { AgentActivityAgent, AgentActivityStatus, AgentActivityTask } from '../src/store.js';
import { flattenAgentActivity, isRunningAgentActivity } from '../src/agentActivityTree.js';

type ActivityRow = { kind: 'section'; title: string; empty?: string } | { kind: 'agent'; value: AgentActivityAgent; depth: number } | { kind: 'task'; value: AgentActivityTask };

function statusLabel(status: AgentActivityStatus): string {
	switch (status) {
		case 'running': return '実行中';
		case 'idle': return '待機中';
		case 'completed': return '完了';
		case 'failed': return '失敗';
		case 'interrupted': return '中断';
		case 'unknown': return '状態不明';
	}
}

function statusColor(status: AgentActivityStatus): string {
	return status === 'failed' ? colors.red : status === 'running' ? colors.accent : status === 'idle' || status === 'unknown' || status === 'interrupted' ? colors.yellow : colors.green;
}

function duration(startedAt: number, updatedAt: number): string {
	const seconds = Math.max(0, Math.round((updatedAt - startedAt) / 1000));
	return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/** 親Agentとは別階層であることを常時表示するSubAgent / Task専用画面。 */
export default function AgentActivityScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const now = useNow();
	const params = useLocalSearchParams<{ terminalId?: string; epoch?: string }>();
	const terminalId = Number(params.terminalId);
	const workspace = useAppStore(s => s.workspace);
	const chat = useAppStore(s => Number.isInteger(terminalId) ? s.agentChats.get(terminalId) : undefined);
	const terminal = workspace?.terminals.find(item => item.id === terminalId);
	const parentMissing = !Number.isInteger(terminalId) || terminal === undefined;
	const chatLoading = !parentMissing && chat === undefined;
	const activity = chat?.activity;
	const sessionChanged = chat !== undefined && typeof params.epoch === 'string' && chat.epoch !== params.epoch;
	const activeAgents = activity?.agents.filter(agent => isRunningAgentActivity(agent.status)) ?? [];
	const rows: ActivityRow[] = activity === undefined ? [] : [
		{ kind: 'section', title: 'Agent tree', ...(activity.agents.length === 0 ? { empty: '検出されたSubAgentはありません' } : {}) },
		...flattenAgentActivity(activity.agents).map(({ agent: value, depth }) => ({ kind: 'agent' as const, value, depth })),
		{ kind: 'section', title: 'Tasks', ...(activity.tasks.length === 0 ? { empty: 'Task API / hook由来のTaskはありません' } : {}) },
		...activity.tasks.map(value => ({ kind: 'task' as const, value })),
	];

	const selectAgent = (agent: AgentActivityAgent) => {
		if (agent.role !== 'subagent') { return; }
		hapticSelection();
		router.push({ pathname: '/agent-activity-detail', params: { terminalId: String(terminalId), agentId: agent.id, epoch: params.epoch ?? '' } });
	};

	return (
		<ConnectionGate>
			<View style={styles.screen}>
				<View style={[styles.header, { paddingTop: insets.top + 4 }]}>
					<Pressable hitSlop={8} onPress={() => { hapticSelection(); router.back(); }} accessibilityRole="button" accessibilityLabel="親エージェントへ戻る">
						<GlassSurface style={styles.backBtn} interactive><Ionicons name="chevron-back" size={20} color={colors.text} /></GlassSurface>
					</Pressable>
					<View style={styles.headerBody}>
						<View style={styles.contextRow}><Ionicons name="git-branch-outline" size={11} color={colors.purple} /><Text style={styles.context}>親エージェント配下</Text></View>
						<Text style={styles.headerTitle}>Agent tree & Tasks</Text>
						<Text style={styles.headerSub} numberOfLines={1}>{terminal?.title ?? 'エージェント'} · {chat?.agent === 'codex' ? 'Codex' : chat?.agent === 'claude' ? 'Claude Code' : 'Agent session'}</Text>
					</View>
				</View>

				<View style={styles.listArea}>
					{parentMissing ? <View style={styles.empty}><Ionicons name="alert-circle-outline" size={24} color={colors.yellow} /><Text style={styles.emptyTitle}>親エージェントを確認できません</Text><Text style={styles.emptyText}>元のエージェント画面へ戻り、最新のセッションを開き直してください。</Text></View> : chatLoading ? <View style={styles.empty}><Ionicons name="sync-outline" size={24} color={colors.textDim} /><Text style={styles.emptyTitle}>Agent sessionを読み込み中</Text></View> : sessionChanged ? <View style={styles.empty}><Ionicons name="alert-circle-outline" size={24} color={colors.yellow} /><Text style={styles.emptyTitle}>親セッションが切り替わりました</Text><Text style={styles.emptyText}>親エージェントへ戻り、新しいセッションから開き直してください。</Text></View> : activity === undefined ? <View style={styles.empty}><Ionicons name="people-outline" size={24} color={colors.textDim} /><Text style={styles.emptyTitle}>SubAgentの活動はありません</Text><Text style={styles.emptyText}>親エージェントがSubAgentやTaskを開始すると、ここへ表示されます。</Text></View> : (
						<FlatList
							data={rows}
							keyExtractor={row => row.kind === 'section' ? `section:${row.title}` : `${row.kind}:${row.value.id}`}
							contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
							ListHeaderComponent={<View style={styles.overview}>
								<View><Text style={styles.metric}>{activeAgents.length}</Text><Text style={styles.metricLabel}>実行中</Text></View>
								<View style={styles.metricDivider} />
								<View><Text style={styles.metric}>{activity.agents.length}</Text><Text style={styles.metricLabel}>履歴</Text></View>
								<View style={styles.metricDivider} />
								<View><Text style={styles.metric}>{activity.tasks.length}</Text><Text style={styles.metricLabel}>Tasks</Text></View>
							</View>}
							renderItem={({ item }) => item.kind === 'section' ? <View><Text style={styles.sectionTitle}>{item.title}</Text>{item.empty ? <Text style={styles.muted}>{item.empty}</Text> : null}</View> : item.kind === 'agent' ? (() => { const agent = item.value; return (
								<Pressable key={agent.id} disabled={agent.role !== 'subagent'} accessibilityRole={agent.role === 'subagent' ? 'button' : undefined} accessibilityLabel={agent.role === 'subagent' ? `${agent.label}の詳細を開く` : `${agent.label} teammate`} onPress={() => selectAgent(agent)} style={[styles.agentRow, { marginLeft: Math.min(54, (item.depth - 1) * 18) }]}>
									{item.depth > 1 ? <Text style={styles.treeBranch}>└</Text> : null}
									<View style={[styles.avatar, { backgroundColor: agent.provider === 'claude' ? 'rgba(216,142,92,.16)' : colors.accentWash }]}><Text style={[styles.avatarText, { color: agent.provider === 'claude' ? colors.claude : colors.accent }]}>{agent.role === 'teammate' ? 'T' : 'A'}</Text></View>
									<View style={styles.agentBody}><Text style={styles.agentLabel} numberOfLines={1}>{agent.label}</Text><Text style={styles.agentMeta} numberOfLines={1}>{agent.provider ?? chat?.agent ?? 'agent'} · {duration(agent.startedAt, agent.status === 'running' || agent.status === 'idle' ? now : agent.updatedAt)}</Text></View>
									<View style={[styles.status, { backgroundColor: `${statusColor(agent.status)}1F` }]}><Text style={[styles.statusText, { color: statusColor(agent.status) }]}>{statusLabel(agent.status)}</Text></View>
									{agent.role === 'subagent' ? <Ionicons name="chevron-forward" size={14} color={colors.textDim} /> : null}
								</Pressable>
							); })() : (() => { const task = item.value; return (
								<View key={task.id} style={styles.taskRow}><Ionicons name={task.status === 'completed' ? 'checkmark-circle' : task.status === 'failed' ? 'close-circle' : 'ellipse-outline'} size={16} color={statusColor(task.status)} /><View style={styles.taskBody}><Text style={styles.taskLabel}>{task.label}</Text>{task.detail ? <Text style={styles.taskDetail}>{task.detail}</Text> : null}{task.assignee ? <Text style={styles.agentMeta}>担当: {task.assignee}</Text> : null}</View><Text style={[styles.taskStatus, { color: statusColor(task.status) }]}>{statusLabel(task.status)}</Text></View>
							); })()}
						/>
					)}
				</View>
			</View>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	listArea: { flex: 1 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	backBtn: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	headerBody: { flex: 1, minWidth: 0 }, contextRow: { flexDirection: 'row', alignItems: 'center', gap: 4 }, context: { color: colors.purple, fontSize: 9, fontWeight: '700' },
	headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' }, headerSub: { color: colors.textDim, fontSize: 10.5, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	content: { padding: 14, gap: 10 }, overview: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 16, paddingVertical: 14 },
	metric: { color: colors.text, fontSize: 20, fontWeight: '700', textAlign: 'center' }, metricLabel: { color: colors.textDim, fontSize: 9, marginTop: 2 }, metricDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: colors.border },
	sectionTitle: { color: colors.textDim, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7, marginTop: 10 }, muted: { color: colors.textDim, fontSize: 11, paddingVertical: 8 },
	agentRow: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 11, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface }, agentRowSelected: { borderColor: colors.purple, backgroundColor: 'rgba(193,147,217,.08)' },
	avatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, avatarText: { fontSize: 11, fontWeight: '800' }, agentBody: { flex: 1, minWidth: 0 }, agentLabel: { color: colors.text, fontSize: 12.5, fontWeight: '600' }, agentMeta: { color: colors.textDim, fontSize: 9.5, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	status: { borderRadius: 9, paddingHorizontal: 7, paddingVertical: 4 }, statusText: { fontSize: 8.5, fontWeight: '700' },
	treeBranch: { color: colors.textDim, fontSize: 13, marginRight: -3 },
	detailCard: { backgroundColor: 'rgba(193,147,217,.08)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(193,147,217,.30)', borderRadius: 16, padding: 13, gap: 6 }, detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }, detailTitle: { color: colors.text, fontSize: 12, fontWeight: '700' }, detailLabel: { color: colors.textDim, fontSize: 8.5, fontWeight: '700', textTransform: 'uppercase', marginTop: 5 }, detailText: { color: colors.text, fontSize: 11.5, lineHeight: 17 }, code: { color: colors.purple, fontSize: 9.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	message: { padding: 9, borderRadius: 11, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, gap: 3 }, messageUser: { backgroundColor: colors.accentWash }, messageTool: { backgroundColor: colors.surface2 }, messageRole: { color: colors.textDim, fontSize: 8, fontWeight: '700', textTransform: 'uppercase' }, messageText: { color: colors.text, fontSize: 10.5, lineHeight: 15 }, errorText: { color: colors.red, fontSize: 10.5, lineHeight: 15 },
	taskRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 11, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface }, taskBody: { flex: 1, minWidth: 0 }, taskLabel: { color: colors.text, fontSize: 12, fontWeight: '600' }, taskDetail: { color: colors.textDim, fontSize: 10.5, lineHeight: 15, marginTop: 3 }, taskStatus: { fontSize: 9, fontWeight: '700' },
	empty: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 30, gap: 8 }, emptyTitle: { color: colors.text, fontSize: 14, fontWeight: '700' }, emptyText: { color: colors.textDim, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});

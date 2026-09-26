// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentActivityState, AgentActivityStatus } from '../store.js';
import { isRunningAgentActivity, summarizeAgentActivity } from '../agentActivityTree.js';
import { GlassSurface } from './glassSurface.js';
import { alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { monoFamily } from '../monoFont.js';

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

function statusColor(status: AgentActivityStatus) {
	return status === 'failed' ? colors.red : status === 'interrupted' || status === 'unknown' ? colors.yellow : status === 'running' ? colors.accent : colors.green;
}

export function AgentActivityCard({ activity, onOpen }: { activity: AgentActivityState; onOpen?: (agentId?: string) => void }) {
	const activeAgents = activity.agents.filter(item => isRunningAgentActivity(item.status));
	const activeTasks = activity.tasks.filter(item => isRunningAgentActivity(item.status));
	const hasActive = activeAgents.length > 0 || activeTasks.length > 0;
	const latestCompaction = activity.compactions[activity.compactions.length - 1];
	if (!hasActive) {
		return (
			<View style={styles.wrap}>
				<Pressable accessibilityRole="button" disabled={onOpen === undefined} onPress={() => onOpen?.()} style={styles.summary}><Ionicons name="checkmark-circle-outline" size={12} color={colors.textDim} /><Text style={styles.summaryText} numberOfLines={2}>{summarizeAgentActivity(activity)}</Text>{onOpen !== undefined ? <Ionicons name="chevron-forward" size={12} color={colors.textDim} /> : null}</Pressable>
				{latestCompaction?.status === 'completed' ? <View style={styles.compaction}><Ionicons name="diamond-outline" size={11} color={colors.purple} /><Text style={styles.compactionText}>コンテキストを圧縮しました</Text></View> : null}
			</View>
		);
	}
	return (
		<View style={styles.wrap}>
			<View style={styles.card}>
				<Pressable accessibilityRole="button" disabled={onOpen === undefined} onPress={() => onOpen?.()} style={styles.header}><View style={styles.dot} /><Text style={styles.title}>実行中のエージェント</Text><Text style={styles.count}>{activeAgents.length}</Text>{onOpen !== undefined ? <Ionicons name="chevron-forward" size={12} color={colors.textDim} /> : null}</Pressable>
				{activeAgents.map(agent => (
					<Pressable key={agent.id} accessibilityRole="button" accessibilityLabel={`${agent.label}の詳細を開く`} disabled={onOpen === undefined} onPress={() => onOpen?.(agent.id)} style={styles.row}>
						<View style={styles.avatar}><Text style={styles.avatarText}>{agent.role === 'teammate' ? 'T' : 'A'}</Text></View>
						<View style={styles.body}><Text style={styles.label} numberOfLines={1}>{agent.label}</Text><Text style={styles.meta}>{agent.role === 'teammate' ? 'teammate' : 'SubAgent'}</Text></View>
						<View style={[styles.pill, { backgroundColor: tint(statusColor(agent.status), alpha.wash) }]}><Text style={[styles.pillText, { color: statusColor(agent.status) }]}>{statusLabel(agent.status)}</Text></View>
					</Pressable>
				))}
				{activeTasks.length > 0 ? <View style={styles.tasks}><Text style={styles.taskTitle}>実行中のTask {activeTasks.length}</Text>{activeTasks.map(task => <View key={task.id} style={styles.taskRow}><Ionicons name="ellipse-outline" size={12} color={statusColor(task.status)} /><Text style={styles.taskText} numberOfLines={1}>{task.label}</Text></View>)}</View> : null}
			</View>
			{latestCompaction?.status === 'completed' ? <View style={styles.compaction}><Ionicons name="diamond-outline" size={11} color={colors.purple} /><Text style={styles.compactionText}>コンテキストを圧縮しました</Text></View> : null}
		</View>
	);
}

/** 親Agentヘッダー直下へ固定するSubAgent活動・履歴のコンパクトストリップ。 */
export function AgentActivityStrip({ activity, onOpen }: { activity: AgentActivityState; onOpen: (agentId?: string) => void }) {
	const activeAgents = activity.agents.filter(item => isRunningAgentActivity(item.status));
	const activeTasks = activity.tasks.filter(item => isRunningAgentActivity(item.status));
	const allItems = [...activity.agents, ...activity.tasks];
	if (allItems.length === 0) { return null; }
	const hasActive = activeAgents.length > 0 || activeTasks.length > 0;
	const allCompleted = allItems.every(item => item.status === 'completed');
	const historyCount = activity.agents.length > 0 ? activity.agents.length : activity.tasks.length;
	const statusSummary = hasActive ? `${activeAgents.length} agents${activeTasks.length > 0 ? ` · ${activeTasks.length} tasks` : ''}` : allCompleted ? `${historyCount}件完了` : `履歴 ${historyCount}件`;
	return <Pressable accessibilityRole="button" accessibilityLabel={hasActive ? '実行中のSubAgentとTaskを開く' : 'SubAgent履歴を開く'} onPress={() => onOpen()}>
		<GlassSurface style={styles.strip} interactive>
			{hasActive ? <View style={styles.dot} /> : <Ionicons name={allCompleted ? 'checkmark-circle-outline' : 'time-outline'} size={15} color={allCompleted ? colors.green : colors.textDim} />}<Text style={styles.stripTitle}>SubAgents</Text>
			{hasActive ? <View style={styles.stripAvatars}>{activeAgents.slice(0, 3).map(agent => <View key={agent.id} style={styles.stripAvatar}><Text style={styles.stripAvatarText}>{agent.role === 'teammate' ? 'T' : 'A'}</Text></View>)}</View> : null}
			<Text style={styles.stripCount}>{statusSummary}</Text><Ionicons name="chevron-forward" size={13} color={colors.textDim} />
		</GlassSurface>
	</Pressable>;
}

const styles = StyleSheet.create({
	wrap: { gap: 7, paddingVertical: 4 },
	card: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control, ...squircle, padding: 10 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 7 },
	dot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.accent },
	title: { color: colors.text, fontSize: type.caption, fontWeight: '600', flex: 1 }, count: { color: colors.textDim, fontSize: type.badge },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 8, marginTop: 8 },
	// avatarText / stripAvatarText は固定サイズの頭文字枠の中の文字なので枠から決めた値のまま。
	avatar: { width: 23, height: 23, borderRadius: radius.key, ...squircle, backgroundColor: colors.accentWash, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: colors.accent, fontSize: 9, fontWeight: '700' },
	body: { flex: 1, minWidth: 0 }, label: { color: colors.text, fontSize: type.badge }, meta: { color: colors.textDim, fontSize: type.badge, fontFamily: monoFamily },
	pill: { borderRadius: radius.control, ...squircle, paddingHorizontal: 6, paddingVertical: 3 }, pillText: { fontSize: type.badge },
	tasks: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 8, paddingTop: 8, gap: 5 }, taskTitle: { color: colors.textDim, fontSize: type.badge }, taskRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, taskText: { color: colors.text, fontSize: type.badge, flex: 1 },
	compaction: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, paddingVertical: 7, borderRadius: radius.control, ...squircle, backgroundColor: tint(colors.purple, alpha.wash), borderWidth: StyleSheet.hairlineWidth, borderColor: tint(colors.purple, alpha.wash) }, compactionText: { color: colors.purple, fontSize: type.badge },
	summary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 4, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border }, summaryText: { color: colors.textDim, fontSize: type.badge, flex: 1 },
	strip: { height: 42, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, borderRadius: radius.card, ...squircle }, stripTitle: { color: colors.text, fontSize: type.badge, fontWeight: '700' }, stripAvatars: { flexDirection: 'row', paddingRight: 4 }, stripAvatar: { width: 20, height: 20, borderRadius: radius.key, ...squircle, backgroundColor: colors.accentWash, borderWidth: 1, borderColor: colors.bg, alignItems: 'center', justifyContent: 'center', marginRight: -5 }, stripAvatarText: { color: colors.accent, fontSize: 7.5, fontWeight: '800' }, stripCount: { flex: 1, color: colors.textDim, fontSize: type.badge },
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ChevronDown, ChevronRight, ChevronUp, CircleCheck, CircleDashed, CircleX, GitBranch } from 'lucide-react-native';
import { activityStatusColor, activityStatusKind, activityStatusLabel } from '../../agentStatus.js';
import { useAppStore } from '../../appState.js';
import { useRouteSpace } from '../../hooks/useRouteTargets.js';
import { monoFamily } from '../../monoFont.js';
import { firstParam } from '../../routes.js';
import type { AgentActivityAgent, AgentActivityTask, AgentChatState } from '../../store.js';
import { colors, radius, space, type } from '../../theme.js';
import { AgentStateDot, Card, Icon, iconSize } from '../../ui/index.js';
import { activityEndAt, formatActivityDuration } from './activityModel.js';

/**
 * サブエージェントとタスクの画面の部品と、ルートの読み取り（旧画面 `legacy-screens/agent-activity.tsx`・
 * `agent-activity-detail.tsx` を Orca の見た目で作り直したもの）。
 */

type SearchParam = string | string[] | undefined;

export interface ActivityRoute {
	readonly pcId: string | undefined;
	readonly spaceId: string | undefined;
	readonly terminalKey: string | undefined;
	/** 開いたときの会話のセッション。 */
	readonly epoch: string | undefined;
	/** 親のエージェントのターミナル（見つからなければ undefined）。 */
	readonly title: string | undefined;
	readonly chat: AgentChatState | undefined;
	/** 親のターミナルが見当たらない（閉じられた・別の PC）。 */
	readonly parentMissing: boolean;
	/** 開いた後で親の会話のセッションが替わった（`/clear` など）。 */
	readonly sessionChanged: boolean;
	/** PC の切り替え中・状態を読み込み中。 */
	readonly loading: boolean;
}

/**
 * `/pc/[pcId]/session/[spaceId]/activity…?terminal=…&epoch=…` を読む。PC の切り替えは `useRouteSpace` が行う。
 *
 * 会話（サブエージェントの記録を含む）は agent チャネルの購読が要るので、この画面でも購読する
 * （ストアが参照カウントで持つので、下のセッション画面の購読とは干渉しない）。セッション画面を
 * ターミナル表示で開いていると、会話は購読されていないため。
 */
export function useActivityRoute(): ActivityRoute {
	const params = useLocalSearchParams<{ pcId?: SearchParam; spaceId?: SearchParam; terminal?: SearchParam; epoch?: SearchParam }>();
	const route = useRouteSpace(params.pcId, params.spaceId);
	const terminalKey = firstParam(params.terminal);
	const epoch = firstParam(params.epoch);
	const active = route.status === 'active';
	// **workspace 本体は購読しない**（最大 10Hz で作り直される）。親のターミナルの名前だけを選ぶ。
	const title = useAppStore(s => (active ? s.workspace?.terminals.find(terminal => terminal.terminalKey === terminalKey)?.title : undefined));
	const workspaceLoaded = useAppStore(s => active && s.workspace !== undefined);
	const chat = useAppStore(s => (active && terminalKey !== undefined ? s.agentChats.get(terminalKey) : undefined));
	const attachAgent = useAppStore(s => s.attachAgent);
	const detachAgent = useAppStore(s => s.detachAgent);
	useEffect(() => {
		if (!active || terminalKey === undefined) {
			return undefined;
		}
		attachAgent(terminalKey);
		return () => detachAgent(terminalKey);
	}, [active, terminalKey, attachAgent, detachAgent]);
	const loading = route.status !== 'unknown' && (!active || !workspaceLoaded);
	return {
		pcId: route.pcId,
		spaceId: route.spaceId,
		terminalKey,
		epoch,
		title,
		chat,
		parentMissing: route.status === 'unknown' || (!loading && (terminalKey === undefined || title === undefined)),
		sessionChanged: chat !== undefined && epoch !== undefined && chat.epoch !== epoch,
		loading,
	};
}

/** 会話の CLI の種類（agent チャネルの `agent` は文字列で届く）。 */
export function chatProvider(chat: AgentChatState | undefined): 'claude' | 'codex' | undefined {
	return chat?.agent === 'codex' ? 'codex' : chat?.agent === 'claude' ? 'claude' : undefined;
}

/** 呼び名（Claude Code / Codex）。 */
export function providerLabel(provider: 'claude' | 'codex' | undefined): string {
	return provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'エージェント';
}

/** 数字の並び（モックの `.stats`）。 */
export function ActivityMetrics({ items }: { items: readonly { readonly label: string; readonly value: string }[] }) {
	return (
		<Card style={styles.metrics}>
			{items.map((item, index) => (
				<View key={item.label} style={[styles.metric, index > 0 ? styles.metricDivider : undefined]}>
					<Text style={styles.metricValue} numberOfLines={1}>{item.value}</Text>
					<Text style={styles.metricLabel} numberOfLines={1}>{item.label}</Text>
				</View>
			))}
		</Card>
	);
}

/** 字下げ1段の幅（pt）。深さ 5 までで止まる（`flattenAgentActivity`）。 */
const INDENT = 16;

/**
 * エージェントの行。サブエージェントは押すと詳細を開く（チームメイトは詳細の記録が無いので押せない）。
 * `depth` は木の深さ（1 始まり）で、深いほど字下げする。
 */
export function ActivityAgentRow({ agent, depth, fallbackProvider, now, onOpen }: {
	agent: AgentActivityAgent;
	depth: number;
	fallbackProvider: 'claude' | 'codex' | undefined;
	now: number;
	onOpen: (agent: AgentActivityAgent) => void;
}) {
	const openable = agent.role === 'subagent';
	const kind = activityStatusKind(agent.status);
	const meta = `${agent.role === 'teammate' ? 'チームメイト' : providerLabel(agent.provider ?? fallbackProvider)} · ${formatActivityDuration(agent.startedAt, activityEndAt(agent, now))}`;
	return (
		<Pressable
			onPress={() => onOpen(agent)}
			disabled={!openable}
			style={({ pressed }) => [styles.row, { paddingLeft: space.md + (depth - 1) * INDENT }, pressed && openable ? styles.pressed : undefined]}
			accessibilityRole={openable ? 'button' : undefined}
			accessibilityLabel={`${agent.label}、${activityStatusLabel(agent.status)}、${meta}`}
		>
			{depth > 1 ? <Icon icon={GitBranch} size={iconSize.xs} color={colors.textMuted} /> : null}
			<AgentStateDot kind={kind} />
			<View style={styles.body}>
				<Text style={styles.label} numberOfLines={1}>{agent.label}</Text>
				<Text style={styles.meta} numberOfLines={1}>{meta}</Text>
			</View>
			<Text style={[styles.status, { color: activityStatusColor(agent.status) }]}>{activityStatusLabel(agent.status)}</Text>
			{openable ? <Icon icon={ChevronRight} color={colors.textMuted} /> : null}
		</Pressable>
	);
}

/** タスクの行（押せない）。 */
export function ActivityTaskRow({ task }: { task: AgentActivityTask }) {
	const glyph = task.status === 'completed' ? CircleCheck : task.status === 'failed' ? CircleX : CircleDashed;
	return (
		<View style={[styles.row, styles.taskRow]} accessibilityLabel={`${task.label}、${activityStatusLabel(task.status)}`}>
			<Icon icon={glyph} size={iconSize.md} color={activityStatusColor(task.status)} />
			<View style={styles.body}>
				<Text style={styles.label}>{task.label}</Text>
				{task.detail !== undefined && task.detail.length > 0 ? <Text style={styles.detail}>{task.detail}</Text> : null}
				{task.assignee !== undefined ? <Text style={styles.meta} numberOfLines={1}>{`担当: ${task.assignee}`}</Text> : null}
			</View>
			<Text style={[styles.status, { color: activityStatusColor(task.status) }]}>{activityStatusLabel(task.status)}</Text>
		</View>
	);
}

/** 畳んだ過去の履歴を開く・閉じる行。 */
export function ActivityMoreRow({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
	const label = expanded ? '過去の履歴を隠す' : `過去の履歴を表示（${count}件）`;
	return (
		<Pressable
			onPress={onToggle}
			style={({ pressed }) => [styles.row, styles.moreRow, pressed ? styles.pressed : undefined]}
			accessibilityRole="button"
			accessibilityState={{ expanded }}
			accessibilityLabel={label}
		>
			<Icon icon={expanded ? ChevronUp : ChevronDown} size={iconSize.sm} color={colors.textMuted} />
			<Text style={styles.more}>{label}</Text>
		</Pressable>
	);
}

/** エージェントの ID（等幅・選択できる）。 */
export function ActivityId({ id }: { id: string }) {
	return <Text style={styles.id} selectable>{id}</Text>;
}

const styles = StyleSheet.create({
	metrics: {
		flexDirection: 'row',
		paddingVertical: space.md,
	},
	metric: {
		flex: 1,
		alignItems: 'center',
		paddingHorizontal: space.xs,
	},
	metricDivider: {
		borderLeftWidth: StyleSheet.hairlineWidth,
		borderLeftColor: colors.border,
	},
	metricValue: {
		fontSize: type.heading,
		fontWeight: '700',
		color: colors.text,
	},
	metricLabel: {
		fontSize: type.caption,
		color: colors.textMuted,
		marginTop: 2,
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm + 2,
		minHeight: 52,
		paddingRight: space.md,
		paddingLeft: space.md,
		paddingVertical: space.sm,
	},
	taskRow: {
		alignItems: 'flex-start',
	},
	pressed: {
		backgroundColor: colors.raised,
	},
	body: {
		flex: 1,
		minWidth: 0,
	},
	label: {
		fontSize: type.body,
		fontWeight: '500',
		color: colors.text,
	},
	meta: {
		fontSize: type.meta,
		color: colors.textMuted,
		marginTop: 2,
		fontFamily: monoFamily,
	},
	detail: {
		fontSize: type.meta,
		lineHeight: 17,
		color: colors.textDim,
		marginTop: 2,
	},
	status: {
		fontSize: type.meta,
		fontWeight: '600',
	},
	moreRow: {
		justifyContent: 'center',
		minHeight: 44,
		borderRadius: radius.row,
	},
	more: {
		fontSize: type.label,
		color: colors.textDim,
	},
	id: {
		fontSize: type.caption,
		fontFamily: monoFamily,
		color: colors.textMuted,
	},
});

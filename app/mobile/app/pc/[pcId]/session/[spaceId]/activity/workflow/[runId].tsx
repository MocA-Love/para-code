// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, CircleAlert, RefreshCw } from 'lucide-react-native';
import {
	WORKFLOW_AGENT_STATE_LABEL, WORKFLOW_TONE_LABEL, formatWorkflowDuration, formatWorkflowTokens, splitWorkflowAgents, workflowAgentMeta,
	workflowElapsedMs, workflowPhaseViews, workflowShellsByAgent, workflowTone,
	type AgentWorkflowAgent, type WorkflowPhaseView,
} from '../../../../../../../src/agentWorkflows.js';
import type { AgentShell } from '../../../../../../../src/agentShells.js';
import { useAppStore } from '../../../../../../../src/appState.js';
import { hitSlopToMinimum } from '../../../../../../../src/components/hitSlop.js';
import { haptic } from '../../../../../../../src/haptics.js';
import { useStableInsets } from '../../../../../../../src/hooks/useStableInsets.js';
import { firstParam, routes } from '../../../../../../../src/routes.js';
import { colors, space, type } from '../../../../../../../src/theme.js';
import { useNow } from '../../../../../../../src/time.js';
import { ChatTextScaleProvider } from '../../../../../../../src/ui/chatTextScale.js';
import { Card, EmptyState, Icon, iconSize, Screen, ScreenHeader, SectionHeader, useThemeColors } from '../../../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../../../src/features/code/codeParts.js';
import { ActivityId, ActivityMetrics, useActivityRoute } from '../../../../../../../src/features/activity/activityParts.js';
import { WorkflowDot, WorkflowPhaseBar, WorkflowPill, workflowToneColor } from '../../../../../../../src/features/session/workflowParts.js';

/** 段階の中で、畳まずに出す子の数（それより多い分は「ほか N 件」で開く）。 */
const OPEN_AGENTS_SHOWN = 8;

/**
 * Workflow の実行 1 つ（`/pc/[pcId]/session/[spaceId]/activity/workflow/[runId]?terminal=…&epoch=…`。モックの案 A の 2 枚目）。
 * 上から: 数字（状態と経過・子・トークン・ツール）、段階の帯、要約、段階ごとの子。段階の中は失敗・実行中を先に出し、
 * 完了した子は「完了 N 件を表示」に畳む（Q260 A）。子が起動したシェルは子の行に添える（Q259 A）。子を押すと、
 * サブエージェントの詳細（`activity/[agentId]`）を開く。iPad では詳細の列に積まれ、列の幅だけで組む。
 */
export default function WorkflowDetailScreen() {
	const insets = useStableInsets();
	const column = useReadableColumn();
	const router = useRouter();
	const params = useLocalSearchParams<{ runId?: string | string[]; pcId?: string | string[]; spaceId?: string | string[] }>();
	const runId = firstParam(params.runId);
	const pcId = firstParam(params.pcId);
	const spaceId = firstParam(params.spaceId);
	const route = useActivityRoute();
	const { chat, terminalKey } = route;
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const workflow = !route.sessionChanged && runId !== undefined ? chat?.workflows?.find(item => item.runId === runId) : undefined;
	const listedIds = useMemo(() => new Set((chat?.activity?.agents ?? []).map(agent => agent.id)), [chat?.activity?.agents]);
	const shellsByAgent = useMemo(() => workflow !== undefined ? workflowShellsByAgent(workflow, chat?.shells) : new Map<string, readonly AgentShell[]>(), [workflow, chat?.shells]);
	const now = useNow(undefined, workflow?.status === 'running');
	const openAgent = (agentId: string) => {
		if (pcId !== undefined && spaceId !== undefined && terminalKey !== undefined) {
			haptic('move');
			router.push(routes.activityAgent(pcId, spaceId, terminalKey, agentId, chat?.epoch));
		}
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
		if (workflow === undefined) {
			return <EmptyState icon={CircleAlert} title="この Workflow は見つかりません" body="PC が持つのは会話ごとに新しい 10 件までです。古い Workflow か、別の会話のものかもしれません。" />;
		}
		return undefined;
	})();

	const tone = workflow !== undefined ? workflowTone(workflow) : 'running';
	const { phases } = workflow !== undefined ? workflowPhaseViews(workflow) : { phases: [] as WorkflowPhaseView[] };
	const omitted = workflow !== undefined ? workflow.agentCount - workflow.agents.length : 0;
	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<Screen>
				<ScreenHeader
					title={workflow?.name ?? 'Workflow'}
					subtitle={runId !== undefined ? `Workflow · ${runId}` : 'Workflow'}
					backLabel="ひとつ上へ戻る"
				/>
				<View style={styles.fill}>
					{gate ?? (workflow !== undefined ? (
						<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
							<ActivityMetrics items={[
								{ label: `${WORKFLOW_TONE_LABEL[tone]}${workflow.estimated === true ? '（推定）' : ''}`, value: formatWorkflowDuration(workflowElapsedMs(workflow, now)) },
								{ label: '子', value: String(workflow.agentCount) },
								{ label: 'トークン', value: workflow.totalTokens !== undefined ? formatWorkflowTokens(workflow.totalTokens) : '—' },
								{ label: 'ツール', value: workflow.totalToolCalls !== undefined ? workflow.totalToolCalls.toLocaleString('en-US') : '—' },
							]} />
							{workflow.status === 'running' ? <Text style={styles.note}>トークンとツールの回数は、Workflow が終わってから出ます。</Text> : null}
							<View style={styles.bar}>
								<WorkflowPhaseBar workflow={workflow} withLabels />
							</View>
							{workflow.summary !== undefined || workflow.error !== undefined ? (
								<>
									<SectionHeader title="要約" style={styles.section} />
									<Card style={styles.card}>
										{workflow.summary !== undefined ? <Text style={styles.body} selectable>{workflow.summary}</Text> : null}
										{workflow.error !== undefined ? <Text style={styles.error} selectable>{workflow.error}</Text> : null}
									</Card>
								</>
							) : null}
							{phases.map(phase => (
								<PhaseSection
									key={phase.index}
									phase={phase}
									numbered={phase.index < workflow.phases.length}
									now={now}
									shellsByAgent={shellsByAgent}
									listedIds={listedIds}
									onOpen={openAgent}
								/>
							))}
							{omitted > 0 ? <Text style={styles.note}>{`ほか ${omitted} 体の子は表示を省きました（失敗と実行中の子を優先して出しています）。`}</Text> : null}
							<View style={styles.idRow}>
								<ActivityId id={workflow.runId} />
							</View>
						</ScrollView>
					) : null)}
				</View>
			</Screen>
		</ChatTextScaleProvider>
	);
}

function PhaseSection({ phase, numbered, now, shellsByAgent, listedIds, onOpen }: {
	phase: WorkflowPhaseView;
	numbered: boolean;
	now: number;
	shellsByAgent: ReadonlyMap<string, readonly AgentShell[]>;
	listedIds: ReadonlySet<string>;
	onOpen: (agentId: string) => void;
}) {
	const theme = useThemeColors();
	const [showMore, setShowMore] = useState(false);
	const [showDone, setShowDone] = useState(false);
	const { open, done } = splitWorkflowAgents(phase.agents);
	const shownOpen = showMore ? open : open.slice(0, OPEN_AGENTS_SHOWN);
	const title = `${numbered ? `${phase.index + 1}. ` : ''}${phase.title}${phase.detail !== undefined ? ` · ${phase.detail}` : ''}`;
	return (
		<>
			<SectionHeader
				title={title}
				style={styles.section}
				right={(
					<View style={styles.phaseRight}>
						{phase.agents.length > 0 ? <Text style={styles.phaseCount}>{`${phase.counts.done}/${phase.agents.length}`}</Text> : null}
						<WorkflowPill tone={phase.tone} />
					</View>
				)}
			/>
			{phase.agents.length === 0 ? (
				<Card style={styles.card}>
					<Text style={styles.caption}>まだ始まっていません</Text>
				</Card>
			) : (
				<Card style={styles.list}>
					{shownOpen.map((agent, index) => (
						<AgentRow key={agent.id} agent={agent} now={now} shells={shellsByAgent.get(agent.id)} listed={listedIds.has(agent.id)} onOpen={onOpen} first={index === 0} />
					))}
					{open.length > shownOpen.length ? (
						<MoreRow text={`ほか ${open.length - shownOpen.length} 件を表示`} color={theme.accent} onPress={() => setShowMore(true)} first={shownOpen.length === 0} />
					) : null}
					{done.length > 0 ? (
						showDone
							? done.map((agent, index) => (
								<AgentRow key={agent.id} agent={agent} now={now} shells={shellsByAgent.get(agent.id)} listed={listedIds.has(agent.id)} onOpen={onOpen} first={shownOpen.length === 0 && index === 0} />
							))
							: <MoreRow text={`完了 ${done.length} 件を表示`} color={theme.accent} onPress={() => setShowDone(true)} first={shownOpen.length === 0} />
					) : null}
				</Card>
			)}
		</>
	);
}

function AgentRow({ agent, now, shells, listed, onOpen, first }: {
	agent: AgentWorkflowAgent;
	now: number;
	shells: readonly AgentShell[] | undefined;
	listed: boolean;
	onOpen: (agentId: string) => void;
	first: boolean;
}) {
	const meta = workflowAgentMeta(agent, now, shells);
	const label = agent.label ?? agent.id;
	return (
		<Pressable
			style={({ pressed }) => [styles.agentRow, !first ? styles.divider : undefined, pressed && listed ? styles.pressed : undefined]}
			onPress={() => onOpen(agent.id)}
			disabled={!listed}
			hitSlop={hitSlopToMinimum(46)}
			accessibilityRole={listed ? 'button' : 'text'}
			accessibilityLabel={`${label}、${WORKFLOW_AGENT_STATE_LABEL[agent.state]}${meta.length > 0 ? `、${meta}` : ''}${listed ? '。詳細を開く' : ''}`}
		>
			<WorkflowDot tone={agent.state} />
			<View style={styles.agentBody}>
				<Text style={styles.agentLabel} numberOfLines={1}>{label}</Text>
				{meta.length > 0 ? <Text style={styles.agentMeta} numberOfLines={2}>{meta}</Text> : null}
			</View>
			<Text style={[styles.agentState, { color: workflowToneColor(agent.state) }]}>{WORKFLOW_AGENT_STATE_LABEL[agent.state]}</Text>
			{listed ? <Icon icon={ChevronRight} size={iconSize.sm} color={colors.textMuted} /> : <View style={styles.chevronSpace} />}
		</Pressable>
	);
}

function MoreRow({ text, color, onPress, first }: { text: string; color: string; onPress: () => void; first: boolean }) {
	return (
		<Pressable style={[styles.more, !first ? styles.divider : undefined]} onPress={() => { haptic('move'); onPress(); }} accessibilityRole="button">
			<Text style={[styles.moreText, { color }]}>{text}</Text>
		</Pressable>
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
	bar: {
		marginTop: space.md,
	},
	card: {
		padding: space.md,
		gap: space.sm,
	},
	list: {
		paddingHorizontal: 0,
		paddingVertical: 0,
		overflow: 'hidden',
	},
	body: {
		fontSize: type.label,
		color: colors.text,
	},
	error: {
		fontSize: type.label,
		color: colors.red,
	},
	caption: {
		fontSize: type.label,
		color: colors.textMuted,
	},
	note: {
		marginTop: space.sm,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	phaseRight: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	phaseCount: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	agentRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 46,
		paddingHorizontal: space.md,
		paddingVertical: 6,
	},
	divider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	pressed: {
		opacity: 0.6,
	},
	agentBody: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	agentLabel: {
		fontSize: type.label,
		color: colors.text,
	},
	agentMeta: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	agentState: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	chevronSpace: {
		width: iconSize.sm,
	},
	more: {
		minHeight: 44,
		justifyContent: 'center',
		paddingHorizontal: space.md,
	},
	moreText: {
		fontSize: type.meta,
		fontWeight: '600',
	},
	idRow: {
		marginTop: space.xl,
	},
});

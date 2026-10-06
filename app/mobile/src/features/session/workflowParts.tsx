// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import {
	WORKFLOW_AGENT_STATE_LABEL, WORKFLOW_TONE_LABEL, workflowPhaseViews,
	type AgentWorkflow, type AgentWorkflowAgentState, type AgentWorkflowTone, type WorkflowChip, type WorkflowPhaseTone,
} from '../../agentWorkflows.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatStyles } from '../../ui/chatTextScale.js';

/**
 * Workflow のカード（トーク）と Workflow の画面で共有する見た目（`workflow-card-mock.html` の案 A）。
 * 色は状態で決める: 完了は緑、実行中・一部失敗は黄、失敗は赤、中断・未開始は灰。
 */

type Tone = AgentWorkflowTone | WorkflowPhaseTone | AgentWorkflowAgentState;

export function workflowToneColor(tone: Tone): string {
	switch (tone) {
		case 'done': return colors.green;
		case 'running':
		case 'partial': return colors.yellow;
		case 'failed': return colors.red;
		default: return colors.textMuted;
	}
}

/** 段階の状態の言い方。 */
export const WORKFLOW_PHASE_TONE_LABEL: Record<WorkflowPhaseTone, string> = {
	pending: '未開始',
	running: '実行中',
	done: '完了',
	partial: '一部失敗',
	failed: '失敗',
};

/** 状態のピル（点と文字。背景は文字の色を薄く敷く）。 */
export function WorkflowPill({ tone, label }: { tone: Tone; label?: string }) {
	const styles = useChatStyles(baseStyles);
	const color = workflowToneColor(tone);
	const text = label ?? (tone in WORKFLOW_TONE_LABEL ? WORKFLOW_TONE_LABEL[tone as AgentWorkflowTone] : tone in WORKFLOW_PHASE_TONE_LABEL ? WORKFLOW_PHASE_TONE_LABEL[tone as WorkflowPhaseTone] : WORKFLOW_AGENT_STATE_LABEL[tone as AgentWorkflowAgentState]);
	return (
		<View style={[styles.pill, { backgroundColor: `${color}22` }]}>
			<View style={[styles.dot, { backgroundColor: color }]} />
			<Text style={[styles.pillText, { color }]} numberOfLines={1}>{text}</Text>
		</View>
	);
}

/** 状態の点（子の行の左）。 */
export function WorkflowDot({ tone }: { tone: Tone }) {
	return <View style={[baseStyles.dot, { backgroundColor: workflowToneColor(tone) }]} />;
}

/**
 * 段階ごとの進み具合の帯。幅は段階の子の数（4 未満は 4 とみなす）に比べ、中を完了・失敗・実行中・中断の順に塗る。
 * `withLabels` なら下に段階の名前を並べ、今の段階を強める（終わった Workflow では強めない）。
 */
export function WorkflowPhaseBar({ workflow, withLabels }: { workflow: AgentWorkflow; withLabels: boolean }) {
	const styles = useChatStyles(baseStyles);
	const { phases, current } = workflowPhaseViews(workflow);
	if (phases.length === 0) {
		return null;
	}
	const ended = workflow.status !== 'running';
	return (
		<View style={styles.barBlock} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
			<View style={styles.bar}>
				{phases.map(phase => {
					const total = phase.agents.length;
					return (
						<View key={phase.index} style={[styles.segment, { flex: Math.max(total, 4) }]}>
							{total > 0 ? (['done', 'failed', 'running', 'stopped'] as const).map(state => phase.counts[state] > 0 ? (
								<View key={state} style={{ width: `${phase.counts[state] / total * 100}%`, backgroundColor: workflowToneColor(state) }} />
							) : null) : null}
						</View>
					);
				})}
			</View>
			{withLabels ? (
				<View style={styles.barLabels}>
					{phases.map(phase => (
						<Text
							key={phase.index}
							style={[styles.barLabel, { flex: Math.max(phase.agents.length, 4) }, !ended && phase.index === current ? styles.barLabelCurrent : undefined]}
							numberOfLines={1}
						>
							{phase.title}
						</Text>
					))}
				</View>
			) : null}
		</View>
	);
}

/** 小さなチップの並び（折り返す）。 */
export function WorkflowChips({ chips }: { chips: readonly WorkflowChip[] }) {
	const styles = useChatStyles(baseStyles);
	return (
		<View style={styles.chips}>
			{chips.map(chip => {
				const color = chip.tone === 'red' ? colors.red : chip.tone === 'yellow' ? colors.yellow : undefined;
				return (
					<View key={chip.key} style={[styles.chip, color !== undefined ? { backgroundColor: `${color}1f`, borderColor: `${color}55` } : undefined]}>
						<Text style={[styles.chipText, color !== undefined ? { color } : undefined]} numberOfLines={1}>{chip.text}</Text>
					</View>
				);
			})}
		</View>
	);
}

/** 「WF」の札（カードと画面の見出しの左）。 */
export function WorkflowBadge() {
	const styles = useChatStyles(baseStyles);
	return (
		<View style={styles.badge}>
			<Text style={styles.badgeText}>WF</Text>
		</View>
	);
}

const baseStyles = StyleSheet.create({
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 5,
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderRadius: radius.pill,
		flexShrink: 0,
	},
	pillText: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	dot: {
		width: 7,
		height: 7,
		borderRadius: 4,
	},
	barBlock: {
		gap: 4,
	},
	bar: {
		flexDirection: 'row',
		gap: 3,
		height: 6,
	},
	segment: {
		flexDirection: 'row',
		overflow: 'hidden',
		borderRadius: 3,
		backgroundColor: colors.borderStrong,
	},
	barLabels: {
		flexDirection: 'row',
		gap: 3,
	},
	barLabel: {
		fontSize: type.badge,
		color: colors.textMuted,
		minWidth: 0,
	},
	barLabelCurrent: {
		color: colors.text,
		fontWeight: '700',
	},
	chips: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 6,
	},
	chip: {
		paddingHorizontal: 7,
		paddingVertical: 2,
		borderRadius: radius.control,
		...squircle,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.surface,
	},
	chipText: {
		fontSize: type.caption,
		color: colors.textDim,
	},
	badge: {
		width: 28,
		height: 28,
		borderRadius: radius.control,
		...squircle,
		alignItems: 'center',
		justifyContent: 'center',
		backgroundColor: `${colors.claude}26`,
	},
	badgeText: {
		fontSize: type.caption,
		fontWeight: '800',
		color: colors.claude,
	},
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';
import { WORKFLOW_TONE_LABEL, workflowChips, workflowForToolUse, workflowShellsByAgent, workflowTone } from '../../agentWorkflows.js';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { firstParam, routes } from '../../routes.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useNow } from '../../time.js';
import { useChatStyles } from '../../ui/chatTextScale.js';
import { useThemeColors } from '../../ui/index.js';
import type { WorkflowChatRow } from './chatRows.js';
import { WorkflowBadge, WorkflowChips, WorkflowPhaseBar, WorkflowPill } from './workflowParts.js';

/**
 * トークの Workflow のカード（案 A）。名前・状態・段階の進み具合の帯・子の数・終わった後のトークンとツール回数・経過・
 * 子のシェルの数を 1 枚に出し、押すと Workflow の画面（段階ごとの子）を開く。中身は会話の状態の `workflows` から引く
 * （会話の行は起動の位置を決めるだけ）。実行中は経過を 1 分刻みで進める。
 */
export const WorkflowCardRowView = memo(function WorkflowCardRowView({ row, terminalKey }: { row: WorkflowChatRow; terminalKey: string }) {
	const styles = useChatStyles(baseStyles);
	const theme = useThemeColors();
	const router = useRouter();
	const params = useLocalSearchParams<{ pcId?: string | string[]; spaceId?: string | string[] }>();
	const pcId = firstParam(params.pcId);
	const spaceId = firstParam(params.spaceId);
	const { workflow, shells } = useAppStore(useShallow(s => {
		const chat = s.agentChats.get(terminalKey);
		return { workflow: workflowForToolUse(chat?.workflows, row.toolUseId), shells: chat?.shells };
	}));
	const running = workflow?.status === 'running';
	const now = useNow(undefined, running);
	const shellCount = useMemo(() => workflow === undefined ? 0
		: [...workflowShellsByAgent(workflow, shells).values()].reduce((sum, list) => sum + list.filter(shell => shell.status === 'running').length, 0), [workflow, shells]);
	if (workflow === undefined) {
		return null;
	}
	const tone = workflowTone(workflow);
	const chips = workflowChips(workflow, now, shellCount);
	const open = () => {
		if (pcId !== undefined && spaceId !== undefined) {
			haptic('move');
			router.push(routes.activityWorkflow(pcId, spaceId, terminalKey, workflow.runId, useAppStore.getState().agentChats.get(terminalKey)?.epoch));
		}
	};
	const openable = pcId !== undefined && spaceId !== undefined;
	return (
		<View style={styles.row}>
			<Pressable
				style={({ pressed }) => [styles.card, pressed && openable ? styles.pressed : undefined]}
				onPress={open}
				disabled={!openable}
				accessibilityRole="button"
				accessibilityLabel={`Workflow ${workflow.name}、${WORKFLOW_TONE_LABEL[tone]}、${chips.map(chip => chip.text).join('、')}。Workflow を開く`}
			>
				<View style={styles.top}>
					<WorkflowBadge />
					<View style={styles.nameBlock}>
						<Text style={styles.name} numberOfLines={1}>{workflow.name}</Text>
						<Text style={styles.kind} numberOfLines={1}>{workflow.estimated === true ? 'Workflow · バックグラウンド · 推定' : 'Workflow · バックグラウンド'}</Text>
					</View>
					<WorkflowPill tone={tone} />
				</View>
				{workflow.summary !== undefined ? <Text style={styles.summary} numberOfLines={2}>{workflow.summary}</Text> : null}
				<WorkflowPhaseBar workflow={workflow} withLabels />
				<WorkflowChips chips={chips} />
				{workflow.error !== undefined ? <Text style={styles.error} numberOfLines={3}>{workflow.error}</Text> : null}
				{openable ? (
					<View style={styles.foot}>
						<Text style={[styles.footText, { color: theme.accent }]}>Workflow を開く ›</Text>
					</View>
				) : null}
			</Pressable>
		</View>
	);
});

const baseStyles = StyleSheet.create({
	row: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
	card: {
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.borderStrong,
		backgroundColor: colors.panel,
		borderRadius: radius.card,
		...squircle,
		overflow: 'hidden',
		paddingTop: space.md,
		paddingHorizontal: space.md,
		gap: space.sm,
	},
	pressed: {
		opacity: 0.7,
	},
	top: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	nameBlock: {
		flex: 1,
		minWidth: 0,
		gap: 1,
	},
	name: {
		fontSize: type.body,
		fontWeight: '700',
		color: colors.text,
	},
	kind: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	summary: {
		fontSize: type.meta,
		color: colors.textDim,
	},
	error: {
		fontSize: type.meta,
		color: colors.red,
	},
	foot: {
		alignItems: 'flex-end',
		justifyContent: 'center',
		minHeight: 44,
		marginHorizontal: -space.md,
		paddingHorizontal: space.md,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	footText: {
		fontSize: type.meta,
		fontWeight: '600',
	},
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CircleAlert, RefreshCw, Users } from 'lucide-react-native';
import { hapticSelection } from '../../../../../src/haptics.js';
import { useStableInsets } from '../../../../../src/hooks/useStableInsets.js';
import { routes } from '../../../../../src/routes.js';
import type { AgentActivityAgent } from '../../../../../src/store.js';
import { space } from '../../../../../src/theme.js';
import { useNow } from '../../../../../src/time.js';
import { EmptyState, ListGroup, Screen, ScreenHeader, SectionHeader } from '../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../src/features/code/codeParts.js';
import { activityOverview } from '../../../../../src/features/activity/activityModel.js';
import {
	ActivityAgentRow,
	ActivityMetrics,
	ActivityMoreRow,
	ActivityTaskRow,
	chatProvider,
	providerLabel,
	useActivityRoute,
} from '../../../../../src/features/activity/activityParts.js';

/**
 * エージェントのサブエージェントとタスク（`/pc/[pcId]/session/[spaceId]/activity?terminal=…&epoch=…`）。
 * 旧画面（`legacy-screens/agent-activity.tsx`）の処理を移し、Orca の部品で作り直した。
 *
 * 上に数字（実行中・履歴・タスク）、エージェントの木（24 時間より前の履歴は畳む）、タスクの一覧。
 * サブエージェントを押すと、その会話とツールの履歴を開く（`activity/[agentId]`）。
 */
export default function AgentActivityScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useReadableColumn();
	const now = useNow();
	const route = useActivityRoute();
	const { chat } = route;
	const activity = chat?.activity;
	const provider = chatProvider(chat);
	const [expanded, setExpanded] = useState(false);

	const openAgent = (agent: AgentActivityAgent) => {
		if (agent.role !== 'subagent' || route.pcId === undefined || route.spaceId === undefined || route.terminalKey === undefined) {
			return;
		}
		hapticSelection();
		router.push(routes.activityAgent(route.pcId, route.spaceId, route.terminalKey, agent.id, route.epoch));
	};

	const body = (() => {
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
		if (activity === undefined) {
			return <EmptyState icon={Users} title="サブエージェントの記録はありません" body="エージェントがサブエージェントやタスクを始めると、ここに出ます。" />;
		}
		const overview = activityOverview(activity, now, expanded);
		return (
			<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
				<ActivityMetrics items={[
					{ label: '実行中', value: String(overview.running) },
					{ label: '履歴', value: String(activity.agents.length) },
					{ label: 'タスク', value: String(activity.tasks.length) },
				]} />
				<SectionHeader title="エージェント" count={activity.agents.length} style={styles.section} />
				{activity.agents.length === 0 ? (
					<EmptyState style={styles.inlineEmpty} body="サブエージェントは見つかっていません。" />
				) : (
					<ListGroup>
						{[
							...overview.rows.map(row => (
								<ActivityAgentRow key={row.agent.id} agent={row.agent} depth={row.depth} fallbackProvider={provider} now={now} onOpen={openAgent} />
							)),
							...(overview.olderCount > 0 ? [
								<ActivityMoreRow key="more" count={overview.olderCount} expanded={expanded} onToggle={() => { hapticSelection(); setExpanded(value => !value); }} />,
							] : []),
						]}
					</ListGroup>
				)}
				<SectionHeader title="タスク" count={activity.tasks.length} style={styles.section} />
				{activity.tasks.length === 0 ? (
					<EmptyState style={styles.inlineEmpty} body="タスクはありません。" />
				) : (
					<ListGroup>
						{activity.tasks.map(task => <ActivityTaskRow key={task.id} task={task} />)}
					</ListGroup>
				)}
			</ScrollView>
		);
	})();

	return (
		<Screen>
			<ScreenHeader
				title="サブエージェント"
				subtitle={`${route.title ?? 'エージェント'} · ${providerLabel(provider)}`}
				backLabel="セッションへ戻る"
			/>
			<View style={styles.fill}>{body}</View>
		</Screen>
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
	inlineEmpty: {
		flex: 0,
		padding: space.lg,
	},
});

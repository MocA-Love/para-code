// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CircleAlert, RefreshCw, Users } from 'lucide-react-native';
import { haptic } from '../../../../../src/haptics.js';
import { useStableInsets } from '../../../../../src/hooks/useStableInsets.js';
import { routes } from '../../../../../src/routes.js';
import type { AgentActivityAdvisor, AgentActivityAgent } from '../../../../../src/store.js';
import { space } from '../../../../../src/theme.js';
import { useNow } from '../../../../../src/time.js';
import { EmptyState, ListGroup, Screen, ScreenHeader, SectionHeader } from '../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../src/features/code/codeParts.js';
import { activityOverview } from '../../../../../src/features/activity/activityModel.js';
import {
	ActivityAdvisorRow,
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
 * 上に数字（実行中・履歴・アドバイザー・タスク）、エージェントの木（24 時間より前の履歴は畳む）、Advisor への
 * 相談（あるときだけ）、タスクの一覧。サブエージェントを押すと、その会話とツールの履歴を開く（`activity/[agentId]`）。
 * 相談を押すと、その詳細を開く（`activity/advisor/[advisorId]`）。
 */
export default function AgentActivityScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	const column = useReadableColumn();
	const route = useActivityRoute();
	const { chat } = route;
	const activity = chat?.activity;
	// Advisor への相談は数十秒で終わるので、相談中は秒で刻む
	const now = useNow(activity?.advisors?.some(advisor => advisor.status === 'running') === true ? 1_000 : 60_000);
	const provider = chatProvider(chat);
	const [expanded, setExpanded] = useState(false);

	const openAgent = (agent: AgentActivityAgent) => {
		if (agent.role !== 'subagent' || route.pcId === undefined || route.spaceId === undefined || route.terminalKey === undefined) {
			return;
		}
		haptic('move');
		router.push(routes.activityAgent(route.pcId, route.spaceId, route.terminalKey, agent.id, route.epoch));
	};

	const openAdvisor = (advisor: AgentActivityAdvisor) => {
		if (route.pcId === undefined || route.spaceId === undefined || route.terminalKey === undefined) {
			return;
		}
		haptic('move');
		router.push(routes.activityAdvisor(route.pcId, route.spaceId, route.terminalKey, advisor.id, route.epoch));
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
		const advisors = activity.advisors ?? [];
		return (
			<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
				<ActivityMetrics items={[
					{ label: '実行中', value: String(overview.running) },
					{ label: '履歴', value: String(activity.agents.length) },
					...(advisors.length > 0 ? [{ label: 'アドバイザー', value: String(advisors.length) }] : []),
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
								<ActivityMoreRow key="more" count={overview.olderCount} expanded={expanded} onToggle={() => { haptic('move'); setExpanded(value => !value); }} />,
							] : []),
						]}
					</ListGroup>
				)}
				{advisors.length > 0 ? (
					<>
						<SectionHeader title="アドバイザー" count={advisors.length} style={styles.section} />
						<ListGroup>
							{advisors.map(advisor => (
								<ActivityAdvisorRow
									key={advisor.id}
									advisor={advisor}
									ownerLabel={advisor.ownerId !== undefined ? activity.agents.find(agent => agent.id === advisor.ownerId)?.label ?? 'サブエージェント' : undefined}
									now={now}
									onOpen={openAdvisor}
								/>
							))}
						</ListGroup>
					</>
				) : null}
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

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CircleAlert, RefreshCw } from 'lucide-react-native';
import { formatMonitorClock } from '../../../../../../../src/agentMonitors.js';
import { activityStatusColor } from '../../../../../../../src/agentStatus.js';
import { useAppStore } from '../../../../../../../src/appState.js';
import { MarkdownText } from '../../../../../../../src/components/markdownText.js';
import { useStableInsets } from '../../../../../../../src/hooks/useStableInsets.js';
import { monoFamily } from '../../../../../../../src/monoFont.js';
import { firstParam } from '../../../../../../../src/routes.js';
import type { AgentActivityAdvisor } from '../../../../../../../src/store.js';
import { colors, space, type } from '../../../../../../../src/theme.js';
import { useNow } from '../../../../../../../src/time.js';
import { ChatTextScaleProvider } from '../../../../../../../src/ui/chatTextScale.js';
import { Card, EmptyState, Screen, ScreenHeader, SectionHeader } from '../../../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../../../src/features/code/codeParts.js';
import { ActivityId, ActivityMetrics, useActivityRoute } from '../../../../../../../src/features/activity/activityParts.js';
import {
	ADVISOR_INPUT_NOTE, ADVISOR_REDACTED_NOTE, advisorModelLabel, advisorStatusLabel, formatAdvisorDuration,
} from '../../../../../../../src/features/session/advisor.js';

/**
 * Advisor への相談 1 回の詳細（`/pc/[pcId]/session/[spaceId]/activity/advisor/[advisorId]?terminal=…&epoch=…`。
 * モックの 1b）。状態・所要時間・開始の時刻、何を聞いたか（質問文は無く会話全体が渡る）、返答を出す。
 * 返答は、暗号化されたもの（Opus 5 系・Sonnet 5.5・Fable）は読めない旨（S1）、平文（旧世代）は本文、
 * 失敗は error_code をそのまま出す。記録は一覧（activity の advisors）から読み、平文の返答だけは開いたときに
 * PC から取り寄せる（サブエージェントの詳細と同じ要求。一覧には本文を載せない）。
 */
export default function AdvisorDetailScreen() {
	const insets = useStableInsets();
	const column = useReadableColumn();
	const params = useLocalSearchParams<{ advisorId?: string | string[] }>();
	const advisorId = firstParam(params.advisorId);
	const route = useActivityRoute();
	const { chat, terminalKey } = route;
	const requestDetail = useAppStore(s => s.requestAgentActivityDetail);
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const activity = !route.sessionChanged ? chat?.activity : undefined;
	const advisor = advisorId !== undefined ? activity?.advisors?.find(item => item.id === advisorId) : undefined;
	const owner = advisor?.ownerId !== undefined ? activity?.agents.find(agent => agent.id === advisor.ownerId) : undefined;
	const running = advisor?.status === 'running';
	const now = useNow(1_000, running);
	const model = advisorModelLabel(advisor?.model);
	const wantsReply = advisor?.status === 'completed' && advisor.outcome === 'text';
	const [reply, setReply] = useState<{ readonly text: string; readonly truncated: boolean } | 'loading' | 'failed' | undefined>(undefined);
	useEffect(() => {
		if (!wantsReply || terminalKey === undefined || advisorId === undefined) {
			return undefined;
		}
		let alive = true;
		setReply('loading');
		requestDetail(terminalKey, advisorId)
			.then(messages => {
				const message = messages.find(item => item.advisor?.outcome === 'text');
				if (alive) {
					setReply(message !== undefined ? { text: message.text, truncated: message.truncated === true } : 'failed');
				}
			})
			.catch(() => {
				if (alive) {
					setReply('failed');
				}
			});
		return () => {
			alive = false;
		};
	}, [wantsReply, terminalKey, advisorId, requestDetail]);

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
		if (advisor === undefined) {
			return <EmptyState icon={CircleAlert} title="この相談は見つかりません" body="記録が消えたか、別の会話の相談かもしれません。" />;
		}
		return undefined;
	})();

	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<Screen>
				<ScreenHeader
					title="Advisor"
					subtitle={[`親: ${owner?.label ?? (advisor?.ownerId !== undefined ? 'サブエージェント' : route.title ?? 'エージェント')}`, model].filter(Boolean).join(' · ')}
					backLabel="ひとつ上へ戻る"
				/>
				<View style={styles.fill}>
					{gate ?? (advisor !== undefined ? (
						<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
							<ActivityMetrics items={[
								{ label: '状態', value: advisorStatusLabel(advisor.status) },
								{ label: '所要時間', value: formatAdvisorDuration(advisor.startedAt, running ? now : advisor.updatedAt) },
								{ label: '開始', value: formatMonitorClock(advisor.startedAt) },
							]} />
							<SectionHeader title="何を聞いたか" style={styles.section} />
							<Card style={styles.card}>
								<Text style={styles.caption}>{ADVISOR_INPUT_NOTE}</Text>
							</Card>
							<SectionHeader title="返答" style={styles.section} />
							<Card style={styles.card}>
								<AdvisorReply advisor={advisor} reply={reply} />
								<ActivityId id={advisor.id} />
							</Card>
						</ScrollView>
					) : null)}
				</View>
			</Screen>
		</ChatTextScaleProvider>
	);
}

function AdvisorReply({ advisor, reply }: { advisor: AgentActivityAdvisor; reply: { readonly text: string; readonly truncated: boolean } | 'loading' | 'failed' | undefined }) {
	switch (advisor.status) {
		case 'running':
			return <Text style={styles.caption}>相談中です。返答が届くとここに出ます。</Text>;
		case 'interrupted':
			return <Text style={styles.caption}>返答は届きませんでした。</Text>;
		case 'failed':
			return <Text style={[styles.code, { color: activityStatusColor('failed') }]} selectable>{`error_code: ${advisor.errorCode ?? 'unknown_error'}`}</Text>;
		case 'completed':
			if (advisor.outcome !== 'text') {
				return <Text style={styles.caption}>{ADVISOR_REDACTED_NOTE}</Text>;
			}
			if (reply === 'loading' || reply === undefined) {
				return <Text style={styles.caption}>返答を読み込んでいます…</Text>;
			}
			if (reply === 'failed') {
				return <Text style={styles.caption}>返答を読み込めませんでした。PC との接続を確かめてください。</Text>;
			}
			return (
				<>
					<MarkdownText text={reply.text} />
					{reply.truncated ? <Text style={styles.caption}>長いため途中までを表示しています。全文は PC で確認できます。</Text> : null}
				</>
			);
	}
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
	card: {
		padding: space.md,
		gap: space.sm,
	},
	caption: {
		fontSize: type.label,
		color: colors.textMuted,
	},
	code: {
		fontFamily: monoFamily,
		fontSize: type.label,
	},
});

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight, CircleAlert, RefreshCw } from 'lucide-react-native';
import {
	TEAM_MEMBER_STATE_LABEL, isOtherPaneMember, sortTeamMembers, teamByName, teamMemberColor, teamMessageHeadline, teamTone, teamWaitingMembers,
	type AgentTeam, type AgentTeamMember, type AgentTeamMessage, type AgentTeamPlan,
} from '../../../../../../../src/agentTeams.js';
import { useAppStore } from '../../../../../../../src/appState.js';
import { hitSlopToMinimum } from '../../../../../../../src/components/hitSlop.js';
import { haptic } from '../../../../../../../src/haptics.js';
import { useStableInsets } from '../../../../../../../src/hooks/useStableInsets.js';
import { firstParam, routes } from '../../../../../../../src/routes.js';
import { colors, space, type } from '../../../../../../../src/theme.js';
import { formatRelativeTime, useNow } from '../../../../../../../src/time.js';
import { ChatTextScaleProvider } from '../../../../../../../src/ui/chatTextScale.js';
import { Card, EmptyState, Icon, iconSize, Screen, ScreenHeader, SectionHeader, useThemeColors } from '../../../../../../../src/ui/index.js';
import { CenterSpinner, useReadableColumn } from '../../../../../../../src/features/code/codeParts.js';
import { ActivityMetrics, useActivityRoute } from '../../../../../../../src/features/activity/activityParts.js';
import { TeamMemberDot, TeamMemberSummary, TeamPill, teamStateColor } from '../../../../../../../src/features/session/teamParts.js';

/** 畳まずに出すやりとりの数（新しい方から。それより古いものは「古いやりとりを表示」で開く）。 */
const MESSAGES_SHOWN = 20;
/** 計画を畳んだときに出す行数。 */
const PLAN_LINES = 8;

/**
 * エージェントチーム 1 つ（`/pc/[pcId]/session/[spaceId]/activity/team/[teamName]?terminal=…&epoch=…`。モックの案 T1 の 2 枚目）。
 * 上から: 数字、要対応（許可待ちはトークの許可カードへ戻る導線。Q261 A）、メンバー（in-process は押すとサブエージェントの
 * 詳細。別のペインのメンバーは「別のペインで動いています」とそのペインを開く導線。Q264 A）、計画（材料があるときだけ。読むだけ。
 * Q262 A）、やりとり（要約を並べ、押すと本文。Q263 A）。iPad では詳細の列に積まれ、列の幅だけで組む。
 */
export default function TeamDetailScreen() {
	const insets = useStableInsets();
	const column = useReadableColumn();
	const router = useRouter();
	const params = useLocalSearchParams<{ teamName?: string | string[]; pcId?: string | string[]; spaceId?: string | string[] }>();
	const teamName = firstParam(params.teamName);
	const pcId = firstParam(params.pcId);
	const spaceId = firstParam(params.spaceId);
	const route = useActivityRoute();
	const { chat, terminalKey } = route;
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const team = !route.sessionChanged ? teamByName(chat?.teams, teamName) : undefined;
	const listedIds = useMemo(() => new Set((chat?.activity?.agents ?? []).map(agent => agent.id)), [chat?.activity?.agents]);
	const openAgent = (agentId: string) => {
		if (pcId !== undefined && spaceId !== undefined && terminalKey !== undefined) {
			haptic('move');
			router.push(routes.activityAgent(pcId, spaceId, terminalKey, agentId, chat?.epoch));
		}
	};
	// 許可カードはトークにある（答える場所は 1 つ）。tmux のメンバーもリーダーのペイン（同じターミナル）の中で動く。
	// この画面はトークのカードから押し進めたものなので、戻ればそのトークに出る
	const openTalk = () => {
		haptic('move');
		if (router.canGoBack()) {
			router.back();
		} else if (pcId !== undefined && spaceId !== undefined && terminalKey !== undefined) {
			router.navigate(routes.session(pcId, spaceId, { tab: { kind: 'terminal', terminalKey } }));
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
		if (team === undefined) {
			return <EmptyState icon={CircleAlert} title="このチームは見つかりません" body="PC が持つのは会話ごとに新しい 5 チームまでです。古いチームか、別の会話のものかもしれません。" />;
		}
		return undefined;
	})();

	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<Screen>
				<ScreenHeader title="エージェントチーム" subtitle={teamName ?? 'チーム'} backLabel="ひとつ上へ戻る" />
				<View style={styles.fill}>
					{gate ?? (team !== undefined ? (
						<ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }, column]}>
							<TeamBody team={team} listedIds={listedIds} onOpenAgent={openAgent} onOpenTalk={openTalk} />
						</ScrollView>
					) : null)}
				</View>
			</Screen>
		</ChatTextScaleProvider>
	);
}

function TeamBody({ team, listedIds, onOpenAgent, onOpenTalk }: {
	team: AgentTeam;
	listedIds: ReadonlySet<string>;
	onOpenAgent: (agentId: string) => void;
	onOpenTalk: () => void;
}) {
	const theme = useThemeColors();
	const members = sortTeamMembers(team.members);
	const waiting = teamWaitingMembers(team);
	const planWaiting = members.filter(member => member.state === 'plan');
	const counts = (state: AgentTeamMember['state']) => team.members.filter(member => member.state === state).length;
	return (
		<>
			<View style={styles.toneRow}>
				<TeamPill tone={teamTone(team)} />
			</View>
			<ActivityMetrics items={[
				{ label: 'メンバー', value: String(team.members.length) },
				{ label: '作業中', value: String(counts('running')) },
				{ label: '待機', value: String(counts('idle')) },
				{ label: 'やりとり', value: String(team.messageCount) },
			]} />
			{waiting.length > 0 || planWaiting.length > 0 ? (
				<>
					<SectionHeader title="要対応" style={styles.section} />
					<Card style={styles.list}>
						{waiting.map((member, index) => (
							<Pressable
								key={member.name}
								style={({ pressed }) => [styles.row, index > 0 ? styles.divider : undefined, pressed ? styles.pressed : undefined]}
								onPress={onOpenTalk}
								hitSlop={hitSlopToMinimum(46)}
								accessibilityRole="button"
								accessibilityLabel={`${member.name}、許可待ち${member.approvalTool !== undefined ? `、${member.approvalTool}` : ''}。トークの許可カードで答える`}
							>
								<TeamMemberSummary member={member} />
								<Text style={[styles.action, { color: theme.accent }]}>許可カードへ ›</Text>
							</Pressable>
						))}
						{planWaiting.map((member, index) => (
							<View key={member.name} style={[styles.row, index + waiting.length > 0 ? styles.divider : undefined]}>
								<TeamMemberSummary member={member} />
								<Text style={styles.caption}>リーダーが判断します</Text>
							</View>
						))}
					</Card>
				</>
			) : null}
			<SectionHeader title="メンバー" style={styles.section} />
			<Card style={styles.list}>
				{members.map((member, index) => (
					<MemberRow key={member.name} member={member} first={index === 0} listed={member.agentId !== undefined && listedIds.has(member.agentId)} onOpenAgent={onOpenAgent} onOpenTalk={onOpenTalk} />
				))}
			</Card>
			{team.plans !== undefined && team.plans.length > 0 ? (
				<>
					<SectionHeader title="計画" style={styles.section} />
					{team.plans.map(plan => <PlanCard key={`${plan.from}:${plan.at}`} plan={plan} team={team} />)}
				</>
			) : null}
			<SectionHeader title="やりとり" style={styles.section} />
			<MessageList team={team} />
		</>
	);
}

function MemberRow({ member, first, listed, onOpenAgent, onOpenTalk }: {
	member: AgentTeamMember;
	first: boolean;
	listed: boolean;
	onOpenAgent: (agentId: string) => void;
	onOpenTalk: () => void;
}) {
	const theme = useThemeColors();
	const otherPane = isOtherPaneMember(member);
	const meta = [member.agentType, member.model].filter((part): part is string => part !== undefined).join(' · ');
	if (otherPane) {
		return (
			<Pressable
				style={({ pressed }) => [styles.row, !first ? styles.divider : undefined, pressed ? styles.pressed : undefined]}
				onPress={onOpenTalk}
				hitSlop={hitSlopToMinimum(46)}
				accessibilityRole="button"
				accessibilityLabel={`${member.name}、別のペインで動いています。ペインを開く`}
			>
				<View style={styles.memberBlock}>
					<TeamMemberSummary member={member} lines={2} />
					{meta.length > 0 ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
				</View>
				<Text style={[styles.action, { color: theme.accent }]}>ペインを開く ›</Text>
			</Pressable>
		);
	}
	return (
		<Pressable
			style={({ pressed }) => [styles.row, !first ? styles.divider : undefined, pressed && listed ? styles.pressed : undefined]}
			onPress={() => member.agentId !== undefined ? onOpenAgent(member.agentId) : undefined}
			disabled={!listed}
			hitSlop={hitSlopToMinimum(46)}
			accessibilityRole={listed ? 'button' : 'text'}
			accessibilityLabel={`${member.name}、${TEAM_MEMBER_STATE_LABEL[member.state]}${member.activity !== undefined ? `、${member.activity}` : ''}${listed ? '。詳細を開く' : ''}`}
		>
			<View style={styles.memberBlock}>
				<TeamMemberSummary member={member} lines={2} />
				{meta.length > 0 ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
			</View>
			{listed ? <Icon icon={ChevronRight} size={iconSize.sm} color={colors.textMuted} /> : <View style={styles.chevronSpace} />}
		</Pressable>
	);
}

function memberNameColor(team: AgentTeam, name: string): string | undefined {
	return teamMemberColor(team.members.find(member => member.name === name)?.color);
}

function PlanCard({ plan, team }: { plan: AgentTeamPlan; team: AgentTeam }) {
	const theme = useThemeColors();
	const [open, setOpen] = useState(false);
	const state = plan.approved === undefined ? '承認待ち' : plan.approved ? '承認済み' : '差し戻し';
	const stateColor = plan.approved === undefined ? teamStateColor('plan') : plan.approved ? teamStateColor('completed') : colors.red;
	return (
		<Card style={styles.card}>
			<View style={styles.planTop}>
				<TeamMemberDot color={team.members.find(member => member.name === plan.from)?.color} />
				<Text style={[styles.planFrom, memberNameColor(team, plan.from) !== undefined ? { color: memberNameColor(team, plan.from) } : undefined]} numberOfLines={1}>{plan.from}</Text>
				<Text style={[styles.planState, { color: stateColor }]}>{state}</Text>
			</View>
			<Text style={styles.body} selectable numberOfLines={open ? undefined : PLAN_LINES}>{plan.text}</Text>
			{plan.truncated === true && open ? <Text style={styles.caption}>長いので先頭だけを出しています。</Text> : null}
			{plan.feedback !== undefined ? <Text style={styles.caption} selectable>{`リーダーの返事: ${plan.feedback}`}</Text> : null}
			<Pressable onPress={() => { haptic('move'); setOpen(value => !value); }} hitSlop={hitSlopToMinimum(44)} accessibilityRole="button">
				<Text style={[styles.action, { color: theme.accent }]}>{open ? '畳む' : '全文を表示'}</Text>
			</Pressable>
		</Card>
	);
}

function MessageList({ team }: { team: AgentTeam }) {
	const theme = useThemeColors();
	const now = useNow();
	const [showAll, setShowAll] = useState(false);
	const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
	if (team.messages.length === 0) {
		return (
			<Card style={styles.card}>
				<Text style={styles.caption}>まだやりとりはありません</Text>
			</Card>
		);
	}
	const hidden = showAll ? 0 : Math.max(0, team.messages.length - MESSAGES_SHOWN);
	const shown = team.messages.slice(hidden);
	const omitted = team.messageCount - team.messages.length;
	const toggle = (id: string) => {
		haptic('move');
		setOpened(previous => {
			const next = new Set(previous);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});
	};
	return (
		<>
			<Card style={styles.list}>
				{hidden > 0 ? (
					<Pressable style={styles.more} onPress={() => { haptic('move'); setShowAll(true); }} accessibilityRole="button">
						<Text style={[styles.moreText, { color: theme.accent }]}>{`古いやりとり ${hidden} 件を表示`}</Text>
					</Pressable>
				) : null}
				{shown.map((message, index) => (
					<MessageRow key={message.id} message={message} team={team} now={now} open={opened.has(message.id)} first={index === 0 && hidden === 0} onToggle={toggle} />
				))}
			</Card>
			{omitted > 0 ? <Text style={styles.note}>{`これより古い ${omitted} 件は PC が持っていません。`}</Text> : null}
		</>
	);
}

const KIND_LABEL: Record<AgentTeamMessage['kind'], string | undefined> = {
	instruction: '指示',
	message: undefined,
	plan: '計画',
	shutdown: '終了',
};

function MessageRow({ message, team, now, open, first, onToggle }: {
	message: AgentTeamMessage;
	team: AgentTeam;
	now: number;
	open: boolean;
	first: boolean;
	onToggle: (id: string) => void;
}) {
	const headline = teamMessageHeadline(message);
	const hasBody = message.text.length > 0;
	const kind = KIND_LABEL[message.kind];
	const to = message.to === '*' ? '全員' : message.to;
	return (
		<Pressable
			style={({ pressed }) => [styles.message, !first ? styles.divider : undefined, pressed && hasBody ? styles.pressed : undefined]}
			onPress={() => onToggle(message.id)}
			disabled={!hasBody}
			accessibilityRole={hasBody ? 'button' : 'text'}
			accessibilityLabel={`${message.from} から ${to}、${kind !== undefined ? `${kind}、` : ''}${headline}${hasBody ? (open ? '。本文を畳む' : '。本文を開く') : ''}`}
		>
			<View style={styles.messageTop}>
				<Text style={[styles.messageName, memberNameColor(team, message.from) !== undefined ? { color: memberNameColor(team, message.from) } : undefined]} numberOfLines={1}>{message.from}</Text>
				<Text style={styles.arrow}>→</Text>
				<Text style={[styles.messageName, memberNameColor(team, message.to) !== undefined ? { color: memberNameColor(team, message.to) } : undefined]} numberOfLines={1}>{to}</Text>
				{kind !== undefined ? <Text style={styles.kind}>{kind}</Text> : null}
				<Text style={styles.time}>{formatRelativeTime(message.at, now)}</Text>
			</View>
			<Text style={styles.headline} numberOfLines={open ? undefined : 2}>{headline}</Text>
			{open && hasBody ? <Text style={styles.body} selectable>{message.text}</Text> : null}
			{open && message.truncated === true ? <Text style={styles.caption}>長いので先頭だけを出しています。</Text> : null}
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
	toneRow: {
		flexDirection: 'row',
		marginBottom: space.sm,
	},
	section: {
		marginTop: space.xl,
	},
	card: {
		padding: space.md,
		gap: space.sm,
		marginBottom: space.sm,
	},
	list: {
		paddingHorizontal: 0,
		paddingVertical: 0,
		overflow: 'hidden',
	},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
		minHeight: 52,
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
	},
	memberBlock: {
		flex: 1,
		minWidth: 0,
		gap: 2,
	},
	divider: {
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	pressed: {
		opacity: 0.6,
	},
	action: {
		fontSize: type.meta,
		fontWeight: '600',
	},
	meta: {
		fontSize: type.caption,
		color: colors.textMuted,
		paddingLeft: 18,
	},
	caption: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	body: {
		fontSize: type.label,
		color: colors.text,
	},
	note: {
		marginTop: space.sm,
		fontSize: type.meta,
		color: colors.textMuted,
	},
	chevronSpace: {
		width: iconSize.sm,
	},
	planTop: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	planFrom: {
		flexShrink: 1,
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	planState: {
		fontSize: type.caption,
		fontWeight: '600',
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
	message: {
		paddingHorizontal: space.md,
		paddingVertical: space.sm,
		gap: 4,
		minHeight: 52,
	},
	messageTop: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 6,
	},
	messageName: {
		flexShrink: 1,
		fontSize: type.caption,
		fontWeight: '600',
		color: colors.text,
	},
	arrow: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	kind: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
	time: {
		marginLeft: 'auto',
		fontSize: type.caption,
		color: colors.textMuted,
	},
	headline: {
		fontSize: type.label,
		color: colors.text,
	},
});

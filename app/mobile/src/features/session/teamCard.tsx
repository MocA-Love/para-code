// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { TEAM_TONE_LABEL, teamByName, teamCardMembers, teamStateSummary, teamTone, teamWaitingMembers } from '../../agentTeams.js';
import { useAppStore } from '../../appState.js';
import { haptic } from '../../haptics.js';
import { firstParam, routes } from '../../routes.js';
import { colors, radius, space, squircle, type } from '../../theme.js';
import { useChatStyles } from '../../ui/chatTextScale.js';
import { useThemeColors } from '../../ui/index.js';
import type { TeamChatRow } from './chatRows.js';
import { TeamMemberSummary, TeamPill } from './teamParts.js';

/**
 * トークのチームのカード（案 T1）。メンバーごとの状態と今やっていることを出し、6 人を超えたら要対応と作業中を先に 5 人、
 * 残りは「ほか N 人」。許可待ちはトークの許可カードで答える（Q261 A）ので、カードには案内だけを出す。押すとチームの画面を開く。
 * 中身は会話の状態の `teams` から引く（会話の行はカードの位置を決めるだけ）。
 */
export const TeamCardRowView = memo(function TeamCardRowView({ row, terminalKey }: { row: TeamChatRow; terminalKey: string }) {
	const styles = useChatStyles(baseStyles);
	const theme = useThemeColors();
	const router = useRouter();
	const params = useLocalSearchParams<{ pcId?: string | string[]; spaceId?: string | string[] }>();
	const pcId = firstParam(params.pcId);
	const spaceId = firstParam(params.spaceId);
	const team = useAppStore(s => teamByName(s.agentChats.get(terminalKey)?.teams, row.teamName));
	if (team === undefined) {
		return null;
	}
	const tone = teamTone(team);
	const { shown, hidden } = teamCardMembers(team);
	const waiting = teamWaitingMembers(team);
	const openable = pcId !== undefined && spaceId !== undefined;
	const open = () => {
		if (pcId !== undefined && spaceId !== undefined) {
			haptic('move');
			router.push(routes.activityTeam(pcId, spaceId, terminalKey, team.name, useAppStore.getState().agentChats.get(terminalKey)?.epoch));
		}
	};
	const summary = teamStateSummary(team);
	return (
		<View style={styles.row}>
			<Pressable
				style={({ pressed }) => [styles.card, pressed && openable ? styles.pressed : undefined]}
				onPress={open}
				disabled={!openable}
				accessibilityRole="button"
				accessibilityLabel={`エージェントチーム、${team.members.length} 人、${TEAM_TONE_LABEL[tone]}${summary.length > 0 ? `、${summary}` : ''}。チームを開く`}
			>
				<View style={styles.top}>
					<View style={styles.badge}>
						<Text style={styles.badgeText}>TM</Text>
					</View>
					<View style={styles.nameBlock}>
						<Text style={styles.name} numberOfLines={1}>エージェントチーム</Text>
						<Text style={styles.kind} numberOfLines={1}>{`${team.members.length} 人${summary.length > 0 ? ` · ${summary}` : ''}`}</Text>
					</View>
					<TeamPill tone={tone} />
				</View>
				<View style={styles.members}>
					{shown.map(member => <TeamMemberSummary key={member.name} member={member} />)}
					{hidden > 0 ? <Text style={styles.more}>{`ほか ${hidden} 人`}</Text> : null}
				</View>
				{waiting.length > 0 ? <Text style={[styles.hint, { color: theme.accent }]}>許可はトークの許可カードで答えます</Text> : null}
				{openable ? (
					<View style={styles.foot}>
						<Text style={[styles.footText, { color: theme.accent }]}>チームを開く ›</Text>
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
	members: {
		gap: space.sm,
	},
	more: {
		fontSize: type.caption,
		color: colors.textMuted,
		paddingLeft: 18,
	},
	hint: {
		fontSize: type.caption,
		fontWeight: '600',
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

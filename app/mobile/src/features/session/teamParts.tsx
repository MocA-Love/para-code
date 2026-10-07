// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { StyleSheet, Text, View } from 'react-native';
import { TEAM_MEMBER_STATE_LABEL, TEAM_TONE_LABEL, teamMemberColor, teamMemberLine, type AgentTeamMember, type AgentTeamMemberState, type AgentTeamTone } from '../../agentTeams.js';
import { colors, radius, space, type } from '../../theme.js';
import { useChatStyles } from '../../ui/chatTextScale.js';

/**
 * チームのカード（トーク）とチームの画面で共有する見た目（`team-card-mock.html` の案 T1）。
 * 状態の色: 作業中は黄、待機・停止は灰、許可待ち・計画の承認待ちは青、完了は緑、失敗は赤。メンバーの丸と名前の色は
 * Claude Code の `color`（知らない色は文字の色のまま）。
 */

export function teamStateColor(state: AgentTeamMemberState | AgentTeamTone): string {
	switch (state) {
		case 'running': return colors.yellow;
		case 'waiting':
		case 'plan':
		case 'attention': return colors.accent;
		case 'completed':
		case 'done': return colors.green;
		case 'failed': return colors.red;
		default: return colors.textMuted;
	}
}

/** チーム全体の状態のピル。 */
export function TeamPill({ tone }: { tone: AgentTeamTone }) {
	const styles = useChatStyles(baseStyles);
	const color = teamStateColor(tone);
	return (
		<View style={[styles.pill, { backgroundColor: `${color}22` }]}>
			<View style={[styles.dot, { backgroundColor: color }]} />
			<Text style={[styles.pillText, { color }]} numberOfLines={1}>{TEAM_TONE_LABEL[tone]}</Text>
		</View>
	);
}

/** メンバーの色の丸（色が分からなければ灰）。 */
export function TeamMemberDot({ color }: { color: string | undefined }) {
	return <View style={[baseStyles.memberDot, { backgroundColor: teamMemberColor(color) ?? colors.textMuted }]} />;
}

/** メンバーの 1 行（丸・名前・状態と、2 行目に今やっていること）。押せるかは呼び出し側が包んで決める。 */
export function TeamMemberSummary({ member, lines = 1 }: { member: AgentTeamMember; lines?: number }) {
	const styles = useChatStyles(baseStyles);
	const line = teamMemberLine(member);
	const stateColor = teamStateColor(member.state);
	return (
		<View style={styles.member}>
			<TeamMemberDot color={member.color} />
			<View style={styles.memberBody}>
				<View style={styles.memberTop}>
					<Text style={[styles.memberName, teamMemberColor(member.color) !== undefined ? { color: teamMemberColor(member.color) } : undefined]} numberOfLines={1}>{member.name}</Text>
					<Text style={[styles.memberState, { color: stateColor }]} numberOfLines={1}>{`${TEAM_MEMBER_STATE_LABEL[member.state]}${member.estimated === true ? '（推定）' : ''}`}</Text>
				</View>
				{line !== undefined ? <Text style={styles.memberLine} numberOfLines={lines}>{line}</Text> : null}
			</View>
		</View>
	);
}

const baseStyles = StyleSheet.create({
	pill: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 4,
		paddingHorizontal: space.sm,
		paddingVertical: 2,
		borderRadius: radius.pill,
	},
	dot: {
		width: 6,
		height: 6,
		borderRadius: 3,
	},
	pillText: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	member: {
		flexDirection: 'row',
		alignItems: 'flex-start',
		gap: space.sm,
		flex: 1,
		minWidth: 0,
	},
	memberDot: {
		width: 10,
		height: 10,
		borderRadius: 5,
		marginTop: 5,
	},
	memberBody: {
		flex: 1,
		minWidth: 0,
		gap: 1,
	},
	memberTop: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.sm,
	},
	memberName: {
		flexShrink: 1,
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
	},
	memberState: {
		fontSize: type.caption,
		fontWeight: '600',
	},
	memberLine: {
		fontSize: type.caption,
		color: colors.textMuted,
	},
});

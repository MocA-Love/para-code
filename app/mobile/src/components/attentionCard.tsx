// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage, AgentChatState } from '../store.js';
import type { AgentActions } from '../hooks/useAgentActions.js';
import { QuestionCard } from './questionCard.js';
import { ApprovalCard } from './approvalCard.js';
import { colors } from '../theme.js';
import { useAppIsActive } from '../hooks/useAppIsActive.js';

/** チャット履歴から最新の未回答質問(question)を探す（agent.tsxの回答済み判定と同じロジック）。 */
function findPendingQuestion(chat: AgentChatState | undefined): AgentChatMessage | undefined {
	if (!chat) {
		return undefined;
	}
	const answeredIds = new Set<string>();
	for (const m of chat.messages) {
		if (m.kind === 'tool_result' && m.toolUseId !== undefined) {
			answeredIds.add(m.toolUseId);
		}
	}
	for (let i = chat.messages.length - 1; i >= 0; i--) {
		const m = chat.messages[i];
		if (m !== undefined && m.kind === 'question' && !(m.toolUseId !== undefined && answeredIds.has(m.toolUseId))) {
			return m;
		}
	}
	return undefined;
}

/** チャット履歴から直近の承認要求内容（PermissionRequest hook由来の合成カード）を探す。 */
export function findLatestApprovalRequest(chat: AgentChatState | undefined): string | undefined {
	const messages = chat?.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m !== undefined && m.kind === 'tool_use' && m.tool === 'approval_request') {
			return m.text;
		}
	}
	return undefined;
}

/**
 * ホーム画面最上部のアテンションカード（mock-2.html準拠）。応答待ちのエージェントの
 * 質問・許可確認を、ターミナル画面へ遷移せずその場で回答できるようにする
 * （UX調査で見つかった「回答導線がターミナルに逃げる」問題への対応）。
 */
export function AttentionCard({ wsName, terminalTitle, agentStatus, chat, actions, onOpenAgent }: {
	wsName: string;
	terminalTitle: string;
	agentStatus: 'permission' | 'question';
	chat: AgentChatState | undefined;
	actions: AgentActions;
	onOpenAgent: () => void;
}) {
	const pulse = useRef(new Animated.Value(0)).current;
	const isAppActive = useAppIsActive();
	useEffect(() => {
		pulse.stopAnimation();
		pulse.setValue(0);
		if (!isAppActive) {
			return;
		}
		const loop = Animated.loop(Animated.sequence([
			Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
			Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
		]));
		loop.start();
		return () => {
			loop.stop();
			pulse.stopAnimation();
			pulse.setValue(0);
		};
	}, [isAppActive, pulse]);

	const question = agentStatus === 'question' ? findPendingQuestion(chat) : undefined;
	const agentLabel = chat?.agent === 'codex' ? 'Codex' : 'Claude Code';
	// 複数質問グループの一部なら、ホームの単発カードでは回答させない（1問だけの回答で
	// フォーム全体がSubmitされる事故を防ぐ）。エージェント画面のステップ式カードへ誘導する。
	const isGroupedQuestion = question !== undefined && question.questionGroup !== undefined && (question.questionCount ?? 1) > 1;

	return (
		<View style={styles.card}>
			<View style={styles.top}>
				<View style={styles.icon}>
					<Ionicons name="sparkles" size={16} color="#fff" />
				</View>
				<View style={styles.meta}>
					<Text style={styles.name}>{agentLabel} が応答待ち</Text>
					<Text style={styles.ctx} numberOfLines={1}>{wsName} · {terminalTitle}</Text>
				</View>
				<Animated.View style={[styles.pulseDot, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }) }]} />
			</View>
			{isGroupedQuestion && question ? (
				<Pressable style={styles.groupNotice} onPress={onOpenAgent}>
					<Text style={styles.groupNoticeTitle}>複数の質問（全{question.questionCount}問）が届いています</Text>
					<Text style={styles.groupNoticeBody}>エージェント画面ですべての質問に回答してから送信できます</Text>
				</Pressable>
			) : question ? (
				<QuestionCard
					key={question.questionGroup ?? question.toolUseId ?? question.rev}
					message={question}
					answered={false}
					onAnswer={actions.answerQuestion}
					onMulti={actions.answerQuestionMulti}
					onFreeText={actions.answerQuestionFreeText}
				/>
			) : (
				<ApprovalCard key={chat?.interaction?.kind === 'approval' ? chat.interaction.id : `legacy:${chat?.epoch ?? 'unknown'}`} interactionId={chat?.interaction?.kind === 'approval' ? chat.interaction.id : `legacy:${chat?.epoch ?? 'unknown'}`} onApprove={actions.approve} detail={findLatestApprovalRequest(chat)} />
			)}
			<Pressable style={styles.openLink} onPress={onOpenAgent}>
				<Text style={styles.openLinkText}>エージェント画面で詳しく見る ›</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	card: { backgroundColor: colors.attentionBg, borderWidth: 1, borderColor: 'rgba(244,114,114,.35)', borderRadius: 20, padding: 16, marginBottom: 16, gap: 10 },
	top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	icon: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.claude, alignItems: 'center', justifyContent: 'center' },
	meta: { flex: 1, minWidth: 0 },
	name: { color: colors.text, fontSize: 13.5, fontWeight: '700' },
	ctx: { color: colors.textDim, fontSize: 11, marginTop: 1 },
	pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
	openLink: { alignItems: 'center', paddingTop: 2 },
	openLinkText: { color: colors.textDim, fontSize: 11 },
	groupNotice: { backgroundColor: 'rgba(9,175,217,.10)', borderWidth: 1, borderColor: colors.accent2, borderRadius: 16, padding: 14, gap: 4 },
	groupNoticeTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
	groupNoticeBody: { color: colors.textDim, fontSize: 11.5, lineHeight: 16 },
});

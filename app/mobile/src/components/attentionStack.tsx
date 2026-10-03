// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentChatMessage, AgentChatState } from '../store.js';
import type { AgentActions } from '../hooks/useAgentActions.js';
import { questionHasPreview } from '../agentQuestionMod.js';
import { QuestionCard } from './questionCard.js';
import { ApprovalCard } from './approvalCard.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type, status } from '../theme.js';
import { agentStatusLabel } from '../agentStatus.js';

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

/** 応答待ちの1件（スタックのヘッダー行に出す情報。質問の中身は開いた行だけが持つ）。 */
export interface AttentionStackItem {
	readonly terminalKey: string;
	readonly title: string;
	readonly wsName: string;
	readonly wsColor: string;
	readonly branch?: string;
	readonly pinned: boolean;
	readonly agentStatus: AttentionStatus;
}

/** 応答待ちのステータス（isAgentWaiting を通ったものはこの2つに限られる）。 */
export type AttentionStatus = 'permission' | 'question';

/** 畳んだ行に出す待たせ方のラベル。中身を購読していなくてもステータスだけで書ける。 */
function waitingLabel(agentStatus: AttentionStatus): string {
	return agentStatusLabel(agentStatus);
}

/**
 * 開いた行の中身。質問・承認カードをその場に出して、ターミナル画面へ移らずに回答できるようにする
 * （UX調査で見つかった「回答導線がターミナルに逃げる」問題への対応）。
 */
function AttentionBody({ agentStatus, chat, actions, onOpenAgent }: {
	agentStatus: AttentionStatus;
	chat: AgentChatState | undefined;
	actions: AgentActions;
	onOpenAgent: () => void;
}) {
	// カード種別の正本は chat.interaction（PC側の currentInteraction）。agentStatus は
	// hook 由来の派生値で、解除され損ねた承認要求が1つ残っているだけで質問中でも
	// permission に化ける。interaction がまだ届いていない場合（attach直後・購読失敗）
	// だけ agentStatus をフォールバックに使う。なお store は PC が送る interaction:null を
	// キー削除へ正規化するため、ここでは「未受信」と「interaction 無し」を区別できない
	// （どちらもフォールバックさせたい現状の挙動とは一致している）。
	const interaction = chat?.interaction;
	const question = interaction?.kind === 'question' || (interaction === undefined && agentStatus === 'question')
		? findPendingQuestion(chat)
		: undefined;
	// 複数質問グループの一部なら、ホームの単発カードでは回答させない（1問だけの回答で
	// フォーム全体がSubmitされる事故を防ぐ）。エージェント画面のステップ式カードへ誘導する。
	const isGroupedQuestion = question !== undefined && question.questionGroup !== undefined && (question.questionCount ?? 1) > 1;
	// preview（選択肢の下書き）のある質問も、下書きを見てから答えられるエージェント画面へ誘導する
	// （ホームの単発カードには preview の枠もメモも無く、キー注入では「その他」も送れない）。
	const isPreviewQuestion = question !== undefined && !isGroupedQuestion && questionHasPreview(question);
	const approval = interaction?.kind === 'approval' ? interaction : undefined;
	// 再取得の応答待ち。表示中の要求が今もPC側の現在の要求である保証がないので操作を止める
	// （useAgentActions も同じ条件で送信を拒否する）。
	const refreshing = chat?.stale === true;

	return (
		<View style={styles.body}>
			{chat === undefined ? (
				// 開いた直後はまだPCへ繋ぎに行っている最中。ここで「回答できません」を出すと
				// 毎回それが一瞬見えてしまうため、届いていないことをそのまま書く。
				<View style={styles.notice}>
					<Text style={styles.noticeTitle}>内容を読み込んでいます…</Text>
				</View>
			) : isGroupedQuestion && question ? (
				<Pressable style={styles.groupNotice} onPress={onOpenAgent}>
					<Text style={styles.noticeTitle}>複数の質問（全{question.questionCount}問）が届いています</Text>
					<Text style={styles.noticeBody}>エージェント画面ですべての質問に回答してから送信できます</Text>
				</Pressable>
			) : isPreviewQuestion ? (
				<Pressable style={styles.groupNotice} onPress={onOpenAgent}>
					<Text style={styles.noticeTitle}>選択肢の下書き（プレビュー）付きの質問が届いています</Text>
					<Text style={styles.noticeBody}>エージェント画面で下書きを見てから回答できます</Text>
				</Pressable>
			) : question ? (
				<QuestionCard
					key={question.questionGroup ?? question.toolUseId ?? question.rev}
					message={question}
					answered={false}
					refreshing={refreshing}
					onAnswer={actions.answerQuestion}
					onMulti={actions.answerQuestionMulti}
					onFreeText={actions.answerQuestionFreeText}
				/>
			) : approval ? (
				<ApprovalCard
					key={approval.id}
					interactionId={approval.id}
					onApprove={actions.approve}
					title={approval.title}
					detail={approval.detail ?? findLatestApprovalRequest(chat)}
					choices={approval.choices}
					refreshing={refreshing}
				/>
			) : (
				// 質問も承認も特定できないときに許可/拒否カードを出さない。以前は合成の
				// `legacy:<epoch>` を interactionId にしていたためPC側の実IDと決して一致せず、
				// 押しても必ず無反応な二択カードが出ていた（「許可しか出ない・回答が効かない」の実体）。
				// interaction が届かないまま終わる経路もあるため「同期中」とは書かない。
				<View style={styles.notice}>
					<Text style={styles.noticeTitle}>PCで内容を確認してください</Text>
					<Text style={styles.noticeBody}>回答の種類を取得できていないため、ここからは回答できません</Text>
				</View>
			)}
			<Pressable style={styles.openLink} onPress={onOpenAgent} accessibilityRole="button">
				<Text style={styles.openLinkText}>エージェント画面で詳しく見る ›</Text>
			</Pressable>
		</View>
	);
}

/**
 * ホーム最上部の要対応スタック。要対応のエージェントを1行ずつ積み、
 * タップした1件だけを開いてその場で回答できるようにする。
 *
 * **見出しはここでは描かない。** 見出し（「要対応」と件数）はホームの一覧が他の段と同じ
 * `SectionHeader` で付ける（件数の数え方をタブのバッジと揃えるため、数は画面側が
 * `attentionCount.ts` から出す）。ここにも見出しを持つと、同じ見出しが二重に並ぶ。
 *
 * 中身（質問・承認）を購読するのは開いている1件だけで、畳んだ行はターミナルの
 * ステータスだけで描く。開閉と並び順の決まりは {@link ./attentionStackBehavior.ts} が持つ。
 */
export function AttentionStack({ items, openKey, onToggle, onLongPress, hiddenCount, onShowAll, chat, actions, onOpenAgent, style }: {
	/** 実際に描く行（件数制限を適用済み）。 */
	items: readonly AttentionStackItem[];
	openKey: string | undefined;
	onToggle: (terminalKey: string) => void;
	/** 長押しでターミナルの操作メニュー（名前を変更/ピン留め/削除）を開く。 */
	onLongPress: (item: AttentionStackItem, anchor: { x: number; y: number }) => void;
	/** 「他N件を表示」に畳んである数。0なら出さない。 */
	hiddenCount: number;
	onShowAll: () => void;
	/** 開いている行のチャット。閉じているときは undefined。 */
	chat: AgentChatState | undefined;
	actions: AgentActions;
	onOpenAgent: (terminalKey: string) => void;
	/** 下の余白の調整（見出しで区切る一覧では次の見出しが余白を持つので詰める）。 */
	style?: StyleProp<ViewStyle>;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<View style={[styles.stack, style]}>
			{items.map(item => {
				const open = item.terminalKey === openKey;
				return (
					<View key={item.terminalKey} style={[styles.item, open && styles.itemOpen]}>
						<Pressable
							style={styles.head}
							onPress={() => onToggle(item.terminalKey)}
							// 既定の500msは一覧の行と同じく待たされ過ぎるので半分にする。
							delayLongPress={250}
							onLongPress={e => onLongPress(item, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
							accessibilityRole="button"
							accessibilityState={{ expanded: open }}
							accessibilityLabel={`${item.title} の${waitingLabel(item.agentStatus)}`}
						>
							{item.pinned ? <Ionicons name="bookmark" size={11} color={colors.accent} style={styles.pin} /> : null}
							<View style={styles.orb} />
							<View style={styles.headBody}>
								<Text style={styles.title} numberOfLines={1}>{item.title}</Text>
								<Text style={styles.sub} numberOfLines={1}>
									<Text style={{ color: item.wsColor }}>{item.wsName}</Text>
									{item.branch ? ` · ${item.branch}` : ''}
									{' · '}
									<Text style={styles.subKind}>{waitingLabel(item.agentStatus)}</Text>
								</Text>
							</View>
							<Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
						</Pressable>
						{open ? (
							<AttentionBody
								agentStatus={item.agentStatus}
								chat={chat}
								actions={actions}
								onOpenAgent={() => onOpenAgent(item.terminalKey)}
							/>
						) : null}
					</View>
				);
			})}
			{hiddenCount > 0 ? (
				<Pressable
					style={styles.more}
					onPress={onShowAll}
					accessibilityRole="button"
					accessibilityLabel={`${status.attention.label}の残り ${hiddenCount}件を表示`}
				>
					<Text style={styles.moreText}>他 {hiddenCount} 件を表示</Text>
				</Pressable>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	stack: { marginBottom: 8 },
	item: { backgroundColor: colors.attentionBg, borderWidth: 1, borderColor: tint(colors.red, alpha.line), borderRadius: radius.card, ...squircle, marginBottom: 8, overflow: 'hidden' },
	itemOpen: { borderColor: tint(colors.red, alpha.strong) },
	head: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 12, paddingHorizontal: 14 },
	pin: { marginRight: -2 },
	orb: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: colors.red },
	headBody: { flex: 1, minWidth: 0 },
	title: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	sub: { color: colors.textDim, fontSize: type.caption, marginTop: 2 },
	subKind: { color: colors.red, fontWeight: '700' },
	body: { paddingHorizontal: 14, paddingBottom: 12, gap: 8 },
	notice: { backgroundColor: 'rgba(255,255,255,.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,.10)', borderRadius: radius.card, ...squircle, padding: 14, gap: 4 },
	groupNotice: { backgroundColor: colors.accentWash, borderWidth: 1, borderColor: colors.accent2, borderRadius: radius.card, ...squircle, padding: 14, gap: 4 },
	noticeTitle: { color: colors.text, fontSize: type.body, fontWeight: '600' },
	noticeBody: { color: colors.textDim, fontSize: type.meta, lineHeight: 17 },
	// 文字は小さいが、当たり判定は44ptにする（カードの下で押し損ねやすい位置にある）。
	openLink: { alignItems: 'center', justifyContent: 'center', minHeight: HIT_SIZE, marginVertical: -8 },
	openLinkText: { color: colors.textDim, fontSize: type.caption },
	more: { alignItems: 'center', justifyContent: 'center', minHeight: HIT_SIZE, borderRadius: radius.card, ...squircle, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
	moreText: { color: colors.textDim, fontSize: type.meta, fontWeight: '600' },
});

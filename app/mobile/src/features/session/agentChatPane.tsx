// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { RotateCw } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { shouldShowQuickReplies } from '../../agentConversationUx.js';
import { useAppStore } from '../../appState.js';
import { useAppLocked } from '../../appLock.js';
import { AGENT_RESUME_CAPABILITY } from '../../agentSessions.js';
import { AGENT_QUESTION_CHAT_CAPABILITY, AGENT_QUESTION_NOTES_CAPABILITY, askQuestionFeatures, questionHasPreview } from '../../agentQuestionMod.js';
import { agentSendIds } from '../../agentSendIds.js';
import { enqueueAgentSend, useAgentSendLive } from '../../agentSendQueue.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { PcCapability } from '../../pcCompat.js';
import { findLatestApprovalRequest } from '../../components/attentionStack.js';
import type { QuestionFreeTextRequest } from '../../components/questionCard.js';
import { haptic } from '../../haptics.js';
import { useAgentActions } from '../../hooks/useAgentActions.js';
import { useKeyboardCoverage } from '../../hooks/useKeyboardVisible.js';
import { useContentColumnStyle } from '../../ipad/useContentColumn.js';
import type { SpaceTerminal } from '../../navigationTargets.js';
import { NO_PENDING_MESSAGES, usePendingAgentMessages } from '../../pendingAgentMessages.js';
import { routes } from '../../routes.js';
import { pinKeyForTerminal, type AgentChatMessage, type AgentMessageSendResult } from '../../store.js';
import { colors, space, type } from '../../theme.js';
import { EmptyState } from '../../ui/index.js';
import { ChatTextScaleProvider, useChatStyles } from '../../ui/chatTextScale.js';
import { cardStyles as baseCardStyles } from './answerCardStyles.js';
import { AskCard, AskGroupCard } from './askCard.js';
import { pinnedCardMaxHeight, PinnedCardScrollContext, type PinnedCardScroll } from './pinnedCard.js';
import { withQuestionOutcomes } from './questionOutcomes.js';
import { ChatChromeRow, CompactingRow, PendingMessagesDrawer, QuickReplies } from './chatChrome.js';
import { ChatList, type ChatListHandle } from './chatList.js';
import { buildChatRows, questionRowId, splitPinnedQuestion } from './chatRows.js';
import { paneShells } from '../../agentWorkflows.js';
import { PermissionCard } from './permissionCard.js';
import { QueuedSendsBanner } from './queuedSends.js';
import { SessionComposer, type SessionComposerHandle } from './sessionComposer.js';
import { useAgentHistory } from './useAgentHistory.js';
import { useApprovalOptions } from './useApprovalOptions.js';
import { useSessionView } from './useSessionView.js';

/** 回答カードの高さの上限。選択肢が多いと会話が見えなくなるので、超えたぶんはカードの中でスクロールする。 */
const PINNED_CARD_MAX_HEIGHT = 380;
/** preview のある質問のカードの高さの上限（選んだ選択肢の下に preview の枠が開くぶん高くする）。 */
const PINNED_PREVIEW_CARD_MAX_HEIGHT = 480;

/**
 * エージェントのタブの会話表示（Orca の MobileNativeChatView）。
 *
 * 会話は PC のターミナルで動いている Claude Code / Codex の記録を写したもの（agent チャネル）で、
 * 入力・承認・質問への回答は既存の `useAgentActions`（term チャネル）で送る。送る内容・順序・
 * 対象のターミナルは旧画面（legacy-screens/agent.tsx）と同じ。
 *
 * 並びは上から: 会話 → 回答カード（許可・質問。1枚だけ）→ クイック返信 → 作業中の行 → コンポーザー。
 */
export function AgentChatPane({ terminal, latest, active, bottomInset }: {
	terminal: SpaceTerminal;
	latest: string | undefined;
	/** この画面が前面にあり、このタブを見ているか。 */
	active: boolean;
	/** 下端に空ける余白（キーボードが出ていないときのセーフエリア）。 */
	bottomInset: number;
}) {
	const terminalKey = terminal.terminalKey;
	const chat = useAppStore(s => s.agentChats.get(terminalKey));
	const { attachAgent, detachAgent, refreshAgent, setViewingTerminalKey, markAgentNotificationsSeen, fsUpload, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings } = useAppStore(useShallow(s => ({
		attachAgent: s.attachAgent,
		detachAgent: s.detachAgent,
		refreshAgent: s.refreshAgent,
		setViewingTerminalKey: s.setViewingTerminalKey,
		markAgentNotificationsSeen: s.markAgentNotificationsSeen,
		fsUpload: s.fsUpload,
		requestAgentModelCatalog: s.requestAgentModelCatalog,
		requestAgentCommandCatalog: s.requestAgentCommandCatalog,
		updateAgentSettings: s.updateAgentSettings,
	})));
	const clearAgentSlashRejection = useAppStore(s => s.clearAgentSlashRejection);
	const closeAgentPanel = useAppStore(s => s.closeAgentPanel);
	// PC で開いている画面の帯と「閉じる」（agent.panel.v1）
	const panelSupported = usePcCapability(PcCapability.AgentPanel);
	const closePanel = useCallback(() => closeAgentPanel(terminalKey), [closeAgentPanel, terminalKey]);
	// `/usage` は送らずにアプリの「使用量」へ移る
	const router = useRouter();
	const openUsage = useCallback(() => router.push(routes.settings('usage')), [router]);
	const handleSlashRejection = useCallback((requestId: string) => clearAgentSlashRejection(terminalKey, requestId), [clearAgentSlashRejection, terminalKey]);
	// 断りの「端末を開く」: このタブをターミナル表示に切り替える（PC で開いた画面を Esc で閉じる・入力欄の文字を消す）
	const viewPcId = useAppStore(s => s.activePcId);
	const { setView } = useSessionView(viewPcId, terminalKey);
	const openTerminal = useCallback(() => setView('terminal'), [setView]);
	// 会話の文字サイズ（設定 → チャット UI）。変えたらその場で描き直す。
	const chatFontSize = useAppStore(s => s.chatFontSize);
	const actions = useAgentActions(terminalKey, chat?.agent);
	const column = useContentColumnStyle();

	useEffect(() => {
		attachAgent(terminalKey);
		return () => detachAgent(terminalKey);
	}, [terminalKey, attachAgent, detachAgent]);
	// 見ている間は同じエージェントの通知バナーを出さない（目の前に出ている内容を被せないため）。
	useFocusEffect(useCallback(() => {
		if (!active) {
			return undefined;
		}
		setViewingTerminalKey(terminalKey);
		return () => setViewingTerminalKey(undefined);
	}, [active, terminalKey, setViewingTerminalKey]));
	// トークを開いたら、このエージェントの完了・エラーの通知を見たことにし、ほかの端末からも消す（Q241 A）。
	// 見ている間に届いた分も同じ。許可・質問は回答で消えるので触らない。ロック画面の下では数えない。
	const locked = useAppLocked();
	const hasUnseenSettled = useAppStore(s => s.notifications.some(n => n.terminalKey === terminalKey && (n.kind === 'agent-done' || n.kind === 'agent-error')));
	useFocusEffect(useCallback(() => {
		if (active && !locked) {
			markAgentNotificationsSeen(terminalKey);
		}
		return undefined;
	}, [active, locked, terminalKey, hasUnseenSettled, markAgentNotificationsSeen]));

	const chatReady = chat !== undefined && chat.none !== true;
	const approval = chat?.interaction?.kind === 'approval' ? chat.interaction : undefined;
	// interaction が届いていないのに許可待ちと言われている（実 ID が無く回答を送れない）。
	const approvalUnavailable = chat?.interaction === undefined && terminal.agentStatus === 'permission';
	const refreshing = chat?.stale === true;
	const working = terminal.agentStatus === 'working' || chat?.live !== undefined;
	// PC の画面と同じ番号付きの選択肢（読めた PC だけ。W2-21）
	const approvalOptions = useApprovalOptions(terminalKey, chat?.epoch, approval, actions.approve);

	// 送ったがまだ読まれていないメッセージの控え（作業中に送ったものだけ）。
	const pendingMessages = usePendingAgentMessages(s => s.byTerminal[terminalKey]) ?? NO_PENDING_MESSAGES;
	const [pendingOpen, setPendingOpen] = useState(false);
	const messagesRef = useRef<readonly AgentChatMessage[] | undefined>(undefined);
	messagesRef.current = chat?.messages;
	const workingRef = useRef(false);
	workingRef.current = working;
	const chatEpoch = chat?.epoch;
	const sendTextAction = actions.sendText;
	// PC に届かない間の送信は、この端末に預かってつながったら送る（W2-29。対応した PC だけ）。
	const live = useAgentSendLive();
	const canQueue = usePcCapability(AGENT_RESUME_CAPABILITY);
	const activePcId = useAppStore(s => s.activePcId);
	const spaceInfo = useAppStore(useShallow(s => {
		const found = s.workspace?.workspaces.find(candidate => candidate.id === terminal.ws);
		return { sourceId: found?.sourceId, name: found?.name, branch: found?.branch };
	}));
	const sourceId = spaceInfo.sourceId;
	const resumeKey = chat?.info?.resumeKey;
	const sendText = useCallback((text: string) => {
		const afterRev = (messagesRef.current ?? []).reduce((max, message) => Math.max(max, message.rev), 0);
		const wasWorking = workingRef.current;
		// 1 回の送信に 1 つの id。届いたか分からないまま戻した同じ文の送り直しなら前の id（PC が二重に送らない）
		const sendId = agentSendIds.idFor(terminalKey, text);
		if (!live && canQueue && activePcId !== undefined) {
			return enqueueAgentSend(activePcId, text, {
				kind: 'live', terminalKey, ...(sourceId !== undefined ? { ws: sourceId } : {}), ...(resumeKey !== undefined ? { resumeKey } : {}), title: terminal.title,
			}, sendId).then(
				(): AgentMessageSendResult => {
					// 預けたので、この id は預かりの送信が使う（同じ文をもう一度送っても別の送信）
					agentSendIds.settle(terminalKey, text, sendId, { status: 'accepted' });
					return { status: 'accepted' };
				},
				(error: unknown): AgentMessageSendResult => ({ status: 'rejected', message: error instanceof Error ? error.message : '送信を預かれませんでした' }),
			);
		}
		return sendTextAction(text, sendId).then(result => {
			agentSendIds.settle(terminalKey, text, sendId, result);
			if (wasWorking && result.status === 'accepted' && chatEpoch !== undefined) {
				usePendingAgentMessages.getState().add(terminalKey, text, afterRev, chatEpoch);
			}
			return result;
		});
	}, [sendTextAction, terminalKey, chatEpoch, live, canQueue, activePcId, sourceId, resumeKey, terminal.title]);
	const messages = chat?.messages;
	useEffect(() => {
		usePendingAgentMessages.getState().reconcile(
			terminalKey,
			chatEpoch,
			(messages ?? []).filter(message => message.role === 'user' && message.kind === 'text'),
		);
	}, [terminalKey, chatEpoch, messages]);
	useEffect(() => {
		if (pendingMessages.length === 0) {
			setPendingOpen(false);
		}
	}, [pendingMessages.length]);

	// 古い発言（上へさかのぼって読んだぶん。W2-30）を会話の前につなぐ。
	const history = useAgentHistory(terminalKey, chat);
	const olderMessages = history.messages;
	// 「質問に答えずに話す」で取り下げた質問は、その結果を質問の行へまとめる（questionOutcomes.ts）
	// Workflow のカード（agent.workflows.v1）。PC が実行を追っている起動の行だけをカードにする（古い PC なら今の行のまま）
	const workflowsSupported = usePcCapability(PcCapability.AgentWorkflows);
	const workflows = workflowsSupported && chatReady ? chat?.workflows : undefined;
	const workflowIdsKey = (workflows ?? []).map(workflow => workflow.toolUseId ?? '').join('\n');
	const workflowToolUseIds = useMemo(() => new Set(workflowIdsKey.split('\n').filter(id => id.length > 0)), [workflowIdsKey]);
	const rows = useMemo(() => withQuestionOutcomes(buildChatRows(olderMessages.length > 0 ? [...olderMessages, ...(messages ?? [])] : messages ?? [], workflowToolUseIds)), [olderMessages, messages, workflowToolUseIds]);
	// Workflow の子が起動したシェルはカードへ寄せる（Q259 A）。ピルとシートには親と普通の子のものだけを出す
	const chatShells = chatReady ? chat?.shells : undefined;
	const shownShells = useMemo(() => paneShells(chatShells, workflows), [chatShells, workflows]);
	const interactionKind = chat?.interaction?.kind;
	const interactionId = chat?.interaction?.id;
	const { pinned, listRows } = useMemo(
		() => splitPinnedQuestion(rows, interactionKind !== undefined && interactionId !== undefined ? { kind: interactionKind, id: interactionId } : undefined, terminal.agentStatus),
		[rows, interactionKind, interactionId, terminal.agentStatus],
	);
	const pinnedId = pinned !== undefined ? questionRowId(pinned) : undefined;
	const questionWithoutRow = interactionKind === 'question' && pinned === undefined;

	// 「その他（入力して回答）」でコンポーザーを回答入力に切り替える依頼。固定している質問のときだけ有効。
	const composerRef = useRef<SessionComposerHandle>(null);
	const listRef = useRef<ChatListHandle>(null);
	const [answerRequest, setAnswerRequest] = useState<QuestionFreeTextRequest | undefined>(undefined);
	const requestFreeText = useCallback((request: QuestionFreeTextRequest | undefined) => {
		if (request === undefined) {
			setAnswerRequest(undefined);
			return;
		}
		setAnswerRequest({
			...request,
			submit: text => request.submit(text).then(result => {
				if (result.status !== 'rejected') {
					setAnswerRequest(current => current?.id === request.id ? undefined : current);
				}
				return result;
			}),
		});
		composerRef.current?.focus();
	}, []);
	const cancelAnswer = useCallback(() => setAnswerRequest(undefined), []);
	// 許可のカードの「拒否して指示を書く」は、その承認が表に出ている間だけ有効
	const activeAnswerRequest = answerRequest !== undefined && (answerRequest.mode === 'deny'
		? approval !== undefined && answerRequest.id === approval.id
		: pinnedId !== undefined && (answerRequest.id === pinnedId || answerRequest.id.startsWith(`${pinnedId}:`)))
		? answerRequest
		: undefined;
	const clarifying = activeAnswerRequest?.mode === 'clarify';
	// メモと「質問に答えずに話す」は、PC の mod が待っている質問だけ（agentQuestionMod.ts）
	const hasQuestionNotes = usePcCapability(AGENT_QUESTION_NOTES_CAPABILITY);
	const hasQuestionChat = usePcCapability(AGENT_QUESTION_CHAT_CAPABILITY);
	// 指示を添えた拒否は、PC の mod が待っている承認だけ（agent.approval.detail.v1）
	const hasApprovalDetail = usePcCapability(PcCapability.AgentApprovalDetail);
	const canDenyWithMessage = hasApprovalDetail && approval?.answerVia === 'mod';
	const questionFeatures = useMemo(() => askQuestionFeatures(chat?.interaction, hasQuestionNotes, hasQuestionChat), [chat?.interaction, hasQuestionNotes, hasQuestionChat]);
	const pinnedHasPreview = pinned !== undefined && (pinned.type === 'question' ? [pinned.m] : pinned.msgs).some(questionHasPreview);
	// キーボードが出ているとき（質問へのメモの入力など）はカードの上限を下げ、入力欄をカードの中で見える位置へ送る
	const keyboardCoverage = useKeyboardCoverage();
	const { height: windowHeight } = useWindowDimensions();
	const cardMaxHeight = pinnedCardMaxHeight(pinnedHasPreview ? PINNED_PREVIEW_CARD_MAX_HEIGHT : PINNED_CARD_MAX_HEIGHT, windowHeight, keyboardCoverage);
	const cardScrollRef = useRef<ScrollView>(null);
	const cardContentRef = useRef<View>(null);
	const cardScroll = useMemo<PinnedCardScroll>(() => ({
		reveal: node => {
			const content = cardContentRef.current;
			const target = node as View | null;
			if (content === null || target === null || typeof target.measureLayout !== 'function') {
				return;
			}
			target.measureLayout(content, (_x, y) => cardScrollRef.current?.scrollTo({ y: Math.max(0, y - space.sm), animated: true }), () => { });
		},
	}), []);
	const insertQuickReply = useCallback((text: string) => composerRef.current?.insertText(text), []);
	const scrollToLatest = useCallback(() => listRef.current?.scrollToLatest(), []);
	const [allToolsOpen, setAllToolsOpen] = useState(false);

	const card = approval !== undefined ? (
		<PermissionCard
			key={approval.id}
			interactionId={approval.id}
			onApprove={approvalOptions?.approve ?? actions.approve}
			title={approval.title}
			detail={approval.detail ?? findLatestApprovalRequest(chat)}
			choices={approvalOptions?.choices ?? approval.choices}
			{...(approvalOptions !== undefined ? { screenLabels: approvalOptions.labels } : {})}
			{...(approval.request !== undefined ? { request: approval.request } : {})}
			{...(approvalOptions?.warning !== undefined ? { warning: approvalOptions.warning } : {})}
			{...(approval.suggestions !== undefined ? { suggestions: approval.suggestions } : {})}
			{...(approval.suggestionScope !== undefined ? { suggestionScope: approval.suggestionScope } : {})}
			{...(canDenyWithMessage ? { onDenyWithMessage: actions.denyWithMessage, onRequestDenyMessage: requestFreeText } : {})}
			denyMessageActive={activeAnswerRequest?.mode === 'deny'}
			refreshing={refreshing}
		/>
	) : approvalUnavailable ? (
		<Notice title="PC で内容を確認してください" body="許可の内容を取得できていないため、ここからは回答できません" />
	) : pinned?.type === 'question' ? (
		<AskCard
			key={pinnedId ?? pinned.m.rev}
			message={pinned.m}
			refreshing={refreshing}
			features={questionFeatures}
			onSubmit={actions.answerQuestionGroup}
			onClarify={actions.clarifyQuestion}
			onRequestFreeText={requestFreeText}
			freeTextActive={activeAnswerRequest !== undefined && !clarifying}
			clarifying={clarifying}
		/>
	) : pinned?.type === 'questionGroup' ? (
		<AskGroupCard
			key={pinned.key}
			messages={pinned.msgs}
			refreshing={refreshing}
			features={questionFeatures}
			onSubmit={actions.answerQuestionGroup}
			onClarify={actions.clarifyQuestion}
			onRequestFreeText={requestFreeText}
			freeTextActiveId={activeAnswerRequest?.id}
			clarifying={clarifying}
		/>
	) : questionWithoutRow ? (
		<Notice title="質問の内容を読み込んでいます…" body="表示されない場合は、ターミナル表示で回答してください" />
	) : undefined;
	const showQuickReplies = shouldShowQuickReplies({
		agentStatus: terminal.agentStatus,
		working,
		hasPinnedCard: card !== undefined,
		chatReady,
		answering: activeAnswerRequest !== undefined,
	});

	return (
		<ChatTextScaleProvider size={chatFontSize}>
			<View style={[styles.root, { paddingBottom: bottomInset }]}>
				{chat === undefined ? (
					<View style={styles.center}><ActivityIndicator color={colors.textDim} /><Text style={styles.loading}>会話を読み込んでいます…</Text></View>
				) : chat.none === true ? (
					<EmptyState
						icon={RotateCw}
						title="エージェントのセッションが見つかりません"
						body={'このターミナルで claude / codex を起動する（または一度発言する）と表示されます。\n画面はターミナル表示で確認できます。'}
						action={{ label: '再試行', onPress: () => { haptic('commit'); refreshAgent(terminalKey); } }}
					/>
				) : (
					<ChatList
						ref={listRef}
						rows={listRows}
						epoch={chat.epoch}
						terminalKey={terminalKey}
						latest={latest}
						history={history.header}
						onLoadOlder={history.loadOlder}
						allToolsOpen={allToolsOpen}
					/>
				)}
				<View style={[styles.bottom, column]}>
					{card !== undefined ? (
						<ScrollView ref={cardScrollRef} style={[styles.cardScroll, { maxHeight: cardMaxHeight }]} contentContainerStyle={styles.cardContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
							<View ref={cardContentRef} collapsable={false}>
								<PinnedCardScrollContext.Provider value={cardScroll}>
									{card}
								</PinnedCardScrollContext.Provider>
							</View>
						</ScrollView>
					) : null}
					{showQuickReplies ? <QuickReplies onPick={insertQuickReply} /> : null}
					<QueuedSendsBanner pcId={activePcId} terminalKey={terminalKey} />
					{/* コンテキストを圧縮している最中（PreCompact から区切りの行が届くまで。モックの A6-2）。圧縮していなければ何も描かない */}
					{chatReady ? <CompactingRow activity={chat?.activity} messages={messages} /> : null}
					{chatReady ? (
						<ChatChromeRow
							working={working}
							live={chat?.live}
							allToolsOpen={allToolsOpen}
							onToggleTools={() => setAllToolsOpen(value => !value)}
							pendingCount={pendingMessages.length}
							onOpenPending={() => setPendingOpen(true)}
						/>
					) : null}
					<SessionComposer
						ref={composerRef}
						draftKey={pinKeyForTerminal(terminal)}
						terminalKey={terminalKey}
						sessionEpoch={chat?.epoch}
						agent={chatReady ? chat?.agent : undefined}
						model={chat?.info?.model}
						effort={chat?.info?.effort}
						modelControl={chat?.modelControl}
						modelLocked={chat?.info?.modelControl === 'none'}
						commandCatalog={chat?.commandCatalog}
						monitors={chatReady ? chat?.monitors : undefined}
						shells={shownShells}
						shellsAccess={chatReady ? chat?.shellsAccess : undefined}
						sendText={sendText}
						updateClaudeSetting={actions.updateClaudeSetting}
						onAfterSubmit={scrollToLatest}
						fsUpload={fsUpload}
						ws={terminal.ws}
						requestAgentModelCatalog={requestAgentModelCatalog}
						requestAgentCommandCatalog={requestAgentCommandCatalog}
						updateAgentSettings={updateAgentSettings}
						slashRejection={chat?.slashRejection}
						onSlashRejectionHandled={handleSlashRejection}
						onOpenTerminal={openTerminal}
						panel={chatReady ? chat?.panel : undefined}
						panelSupported={panelSupported}
						{...(panelSupported ? { onClosePanel: closePanel } : {})}
						onOpenUsage={openUsage}
						spaceName={spaceInfo.name}
						branch={spaceInfo.branch}
						answerTarget={activeAnswerRequest}
						onCancelAnswer={cancelAnswer}
						answerRefreshing={refreshing}
					/>
				</View>
				<PendingMessagesDrawer visible={pendingOpen} messages={pendingMessages} onClose={() => setPendingOpen(false)} />
			</View>
		</ChatTextScaleProvider>
	);
}

/** 回答カードの代わりに出す案内（内容がまだ届いていないとき）。 */
function Notice({ title, body }: { title: string; body: string }) {
	const cardStyles = useChatStyles(baseCardStyles);
	return (
		<View style={cardStyles.card}>
			<Text style={cardStyles.title}>{title}</Text>
			<Text style={cardStyles.detail}>{body}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		minHeight: 0,
		backgroundColor: colors.bg,
	},
	center: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: space.sm,
	},
	loading: {
		fontSize: type.meta,
		color: colors.textMuted,
	},
	bottom: {
		flexShrink: 1,
	},
	cardScroll: {
		flexGrow: 0,
		flexShrink: 1,
	},
	cardContent: {
		paddingHorizontal: space.lg,
		paddingVertical: space.sm,
	},
});

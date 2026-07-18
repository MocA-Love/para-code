// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { isAgentWaiting, pinKeyForTerminal, type AgentChatMessage, type AgentLiveState } from '../src/store.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { MarkdownText } from '../src/components/markdownText.js';
import { GlassSurface, liquidGlass } from '../src/components/glassSurface.js';
import { QuestionCard, QuestionGroupCard } from '../src/components/questionCard.js';
import { ApprovalCard } from '../src/components/approvalCard.js';
import { AgentActivityCard, AgentActivityStrip } from '../src/components/agentActivityCard.js';
import { findLatestApprovalRequest } from '../src/components/attentionCard.js';
import { AgentComposer } from '../src/components/agentComposer.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useAgentActions } from '../src/hooks/useAgentActions.js';
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useAppIsActive } from '../src/hooks/useAppIsActive.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { isRunningAgentActivity } from '../src/agentActivityTree.js';
import { resolveExplicitTerminalSelection, shouldHandleLatestEntry } from '../src/agentNavigation.js';

/**
 * エージェント詳細画面。ホームの一覧（または通知）から1エージェントを選んで開く
 * スタック画面（旧: (tabs)/agent.tsx のタブ。ホーム＝一覧、ここ＝詳細に再編し、
 * タブ内のターミナル切り替えチップ・モデル表示行を廃止した。モデル/Effortは
 * コンポーザーのModelPillで確認できる）。ルートパスは旧タブと同じ /agent のため、
 * 通知ディープリンク等の既存遷移はそのまま動く。
 *
 * PCのターミナルでTUIとして動いているClaude Code / Codexの会話を、
 * transcriptミラー（agentチャネル）でチャット表示する。PC側のTUIはそのまま。
 * 入力・承認応答は既存のtermチャネル（PTY stdin注入）で行う:
 *  - テキスト送信: そのままTUIの入力欄に入り、Enterで確定
 *  - 承認（Claude）: 選択肢番号を送って250ms後にCR（TUIが番号を処理してから確定する必要がある）
 *  - 承認（Codex）: y / d / a のショートカット1文字（Enter不要）
 * 詳細は memory/mobile-agent-gui-research.md の調査結果を参照。
 */
export default function AgentDetailScreen() {
	const router = useRouter();
	const { latest: latestEntry } = useLocalSearchParams<{ latest?: string }>();
	const { workspace, agentChats, selectedWs, selectedTerminalKey, connection, pcOnline, sessionProtocolReady, attachAgent, detachAgent, refreshAgent, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings, fsUpload, browserTargets } = useAppStore(useShallow(s => ({
		workspace: s.workspace, agentChats: s.agentChats, selectedWs: s.selectedWs,
		selectedTerminalKey: s.selectedTerminalKey, connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
		attachAgent: s.attachAgent, detachAgent: s.detachAgent, refreshAgent: s.refreshAgent,
		requestAgentModelCatalog: s.requestAgentModelCatalog, requestAgentCommandCatalog: s.requestAgentCommandCatalog, updateAgentSettings: s.updateAgentSettings, fsUpload: s.fsUpload,
		browserTargets: s.browserTargets,
	})));
	const listRef = useRef<FlatList<ChatRow>>(null);
	const insets = useStableInsets();
	const keyboardVisible = useKeyboardVisible();
	// ヘッダーはブラーのオーバーレイとしてチャットの上に重ねる（純正メール風。
	// コンテンツがヘッダーの下を通ってボケて見える）。実高さは onLayout で測る。
	const [headerHeight, setHeaderHeight] = useState(insets.top + 52);

	// 表示対象: selectedTerminalKey（ホーム/通知が遷移前に設定する）。無ければ選択中ws
	// のターミナルへフォールバック（旧タブと同じ規則: 未タグはactiveWs所属扱い）。
	const allTerminals = workspace?.terminals ?? [];
	const wsList = workspace?.workspaces ?? [];
	const effectiveWsId = (selectedWs !== undefined && wsList.some(w => w.id === selectedWs) ? selectedWs : wsList[0]?.id);
	const activeTerminal = resolveExplicitTerminalSelection(
		allTerminals,
		selectedTerminalKey,
		terminal => (terminal.ws ?? workspace?.activeWs) === effectiveWsId,
	);
	const activeKey = activeTerminal?.terminalKey;
	const chat = activeKey !== undefined ? agentChats.get(activeKey) : undefined;
	const hasActivityHistory = chat?.activity !== undefined && (chat.activity.agents.length > 0 || chat.activity.tasks.length > 0);
	const hasActiveActivity = chat?.activity !== undefined && (chat.activity.agents.some(item => isRunningAgentActivity(item.status)) || chat.activity.tasks.some(item => isRunningAgentActivity(item.status)));
	const permissionPending = activeTerminal?.agentStatus === 'permission' || chat?.interaction?.kind === 'approval';
	const approval = chat?.interaction?.kind === 'approval' ? chat.interaction : undefined;
	const actions = useAgentActions(activeKey, chat?.agent);

	// 入力中テキストは画面を離れても消えないよう、エージェント（ターミナル）単位の
	// 一意キーでメモリ上に退避する。キーが分離されるので別エージェントの入力欄には混ざらない。
	// 入力中の文字列はAgentComposer内のネイティブTextInputが保持し、Reactからvalueを
	// 書き戻さない構造にしている（IME変換の意図しない確定・濁点分離を防止）。
	const draftKey = activeTerminal !== undefined ? pinKeyForTerminal(activeTerminal) : undefined;

	// ヘッダー表示用: このターミナルの所属ワークスペース
	const agentWs = activeTerminal !== undefined
		? wsList.find(w => w.id === (activeTerminal.ws ?? workspace?.activeWs))
		: undefined;

	// コンポーザーのPRピル用。workspace state はpushごとに丸ごと差し替わり pr も毎回新規
	// オブジェクトになるため、値が同じ間は参照を安定させて AgentComposer の memo を保つ
	// （入力中の無関係な再レンダーを避ける設計をPRピルで崩さないため）。
	const prNumber = agentWs?.pr?.number;
	const prState = agentWs?.pr?.state;
	const prUrl = agentWs?.pr?.url;
	const agentWsPr = useMemo(
		() => prNumber !== undefined && prState !== undefined && prUrl !== undefined ? { number: prNumber, state: prState, url: prUrl } : undefined,
		[prNumber, prState, prUrl]);

	// ヘッダーのブラウザボタン用: このエージェントと共有中のブラウザページがあるか
	// （あればボタンに緑ドットを出す）。表示補助なので取得失敗は無視してバッジ無しにする。
	const agentToken = activeTerminal?.agentToken;
	const [hasSharedPage, setHasSharedPage] = useState(false);
	useEffect(() => {
		setHasSharedPage(false);
		if (agentToken === undefined || connection !== 'online' || !pcOnline || !sessionProtocolReady) {
			return;
		}
		let cancelled = false;
		browserTargets()
			.then(result => {
				if (!cancelled) {
					setHasSharedPage(result.targets.some(t => t.sharedToken === agentToken));
				}
			})
			.catch(() => undefined);
		return () => { cancelled = true; };
	}, [agentToken, connection, pcOnline, sessionProtocolReady, browserTargets]);
	const openBrowser = () => {
		hapticSelection();
		router.push(agentToken !== undefined ? `/browser?token=${encodeURIComponent(agentToken)}` : '/browser');
	};
	const openAgentActivity = (agentId?: string) => {
		if (activeKey === undefined) { return; }
		hapticSelection();
		router.push(agentId !== undefined
			? { pathname: '/agent-activity-detail', params: { terminalKey: activeKey, agentId, epoch: chat?.epoch ?? '' } }
			: { pathname: '/agent-activity', params: { terminalKey: activeKey, epoch: chat?.epoch ?? '' } });
	};

	// CLI版のUXに合わせ、本文(text)以外の連続する thinking / tool_use / tool_result を
	// 1つの「アクティビティ」行へ集約する（デフォルト折りたたみ、タップで展開）。
	// 質問(question)は集約せず独立行にする（気づけないと会話が止まるため）。
	const rows = useMemo<ChatRow[]>(() => {
		// 質問の「回答済み」判定: 同じ toolUseId の tool_result が後続に存在するか。
		const answeredIds = new Set<string>();
		for (const m of chat?.messages ?? []) {
			if (m.kind === 'tool_result' && m.toolUseId !== undefined) {
				answeredIds.add(m.toolUseId);
			}
		}
		const result: ChatRow[] = [];
		const webSearches = new Map<string, AgentChatMessage>();
		const completedWebSearches = new Set((chat?.messages ?? []).filter(message => message.kind === 'tool_result' && message.toolUseId !== undefined).map(message => message.toolUseId!));
		let buffer: AgentChatMessage[] = [];
		const flush = () => {
			const first = buffer[0];
			if (first !== undefined) {
				result.push({ type: 'group', key: `g:${first.rev}`, msgs: buffer });
				buffer = [];
			}
		};
		for (const m of chat?.messages ?? []) {
			if (m.kind === 'text') {
				flush();
				result.push({ type: 'msg', m });
			} else if (m.kind === 'question') {
				flush();
				// 同一 AskUserQuestion 由来の複数質問（questionGroup が同じ連続行）は
				// 1枚のステップ式カードへ集約する（1問ずつの即時送信を防ぐ）。
				const last = result[result.length - 1];
				const answered = m.toolUseId !== undefined && answeredIds.has(m.toolUseId);
				if (m.questionGroup !== undefined && (m.questionCount ?? 1) > 1) {
					if (last !== undefined && last.type === 'questionGroup' && last.key === m.questionGroup) {
						last.msgs.push(m);
						last.answered = last.answered || answered;
					} else {
						result.push({ type: 'questionGroup', key: m.questionGroup, msgs: [m], answered });
					}
				} else {
					result.push({ type: 'question', m, answered });
				}
			} else if (m.kind === 'tool_use' && m.tool === 'web_search') {
				flush();
				if (m.toolUseId === undefined || !completedWebSearches.has(m.toolUseId)) { result.push({ type: 'web', key: m.toolUseId ?? `web:${m.rev}`, msgs: [m] }); }
				if (m.toolUseId !== undefined) { webSearches.set(m.toolUseId, m); }
			} else if (m.kind === 'tool_result' && m.toolUseId !== undefined && webSearches.has(m.toolUseId)) {
				flush();
				// 完了結果は実際に届いた位置へ置く。開始行へ後付けすると、その間の本文や
				// ツールより前に検索結果が見えるため、時系列が壊れる。
				result.push({ type: 'web', key: `web-result:${m.rev}`, msgs: [webSearches.get(m.toolUseId)!, m] });
			} else {
				buffer.push(m);
			}
		}
		flush();
		return result;
	}, [chat?.messages]);

	useEffect(() => {
		if (activeKey === undefined) {
			return;
		}
		attachAgent(activeKey);
		return () => detachAgent(activeKey);
	}, [activeKey, attachAgent, detachAgent]);

	// 自動スクロールは「sticky（最下部追従）モード」の状態ベースで制御する。
	// 開いた直後・対象切替直後は sticky で、onContentSizeChange のたびに末尾へ
	// 即時ジャンプする（FlatListは長い履歴を分割レンダリングして contentSize が
	// 段階的に伸びるため、初回表示もこれで最新まで張り付く）。確定メッセージの追加
	// だけでなく、実行中インジケータ（live/activity のフッター）の伸縮にも追従する。
	// ユーザーが上へスクロールして下端から離れたら解除し、以後は何が届いても位置を
	// 動かさない（遡り読みを妨げない）。下端付近まで手で戻ると自動で復帰する。
	const [sticky, setStickyState] = useState(true);
	const stickyRef = useRef(true);
	const userScrollGestureRef = useRef(false);
	const userDraggingRef = useRef(false);
	const userMomentumRef = useRef(false);
	const handledLatestEntryRef = useRef<string | undefined>(undefined);
	// FlatListは初回に分割レンダリングされるため、最新位置へ到達するまでcontentSize更新ごとに
	// scrollToEndを繰り返す。到達後またはユーザー操作開始時に解除する。
	const latestEntryPendingRef = useRef(false);
	// sticky解除中に届いた新着（確定メッセージ）の件数。ジャンプボタンのバッジに出す。
	const [newCount, setNewCount] = useState(0);
	const setSticky = useCallback((value: boolean) => {
		stickyRef.current = value;
		setStickyState(value);
		if (value) {
			setNewCount(0);
		}
	}, []);
	const prevCountRef = useRef(0);
	useEffect(() => {
		userScrollGestureRef.current = false;
		userDraggingRef.current = false;
		userMomentumRef.current = false;
		setSticky(true);
		prevCountRef.current = 0;
	}, [activeKey, setSticky]);
	useEffect(() => {
		if (activeKey === undefined || !shouldHandleLatestEntry(handledLatestEntryRef.current, latestEntry)) {
			return;
		}
		handledLatestEntryRef.current = latestEntry;
		latestEntryPendingRef.current = true;
		userScrollGestureRef.current = false;
		userDraggingRef.current = false;
		userMomentumRef.current = false;
		setSticky(true);
		const frame = requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
		return () => cancelAnimationFrame(frame);
	}, [activeKey, latestEntry, setSticky]);
	const messageCount = chat?.messages.length ?? 0;
	useEffect(() => {
		const delta = messageCount - prevCountRef.current;
		prevCountRef.current = messageCount;
		if (delta > 0 && !stickyRef.current) {
			setNewCount(c => c + delta);
		}
	}, [messageCount]);
	const onContentSizeChange = () => {
		if (stickyRef.current || latestEntryPendingRef.current) {
			listRef.current?.scrollToEnd({ animated: false });
		}
	};
	// stickyを解除するのは、ユーザーが指で動かしている間（慣性スクロールを含む）だけ。
	// 新着やfooter伸長によるcontentSize更新でもonScrollは発火するため、位置だけで
	// ユーザー操作と判定すると、旧offsetを見た瞬間に追従が誤解除される。
	const onScrollBeginDrag = () => {
		latestEntryPendingRef.current = false;
		userScrollGestureRef.current = true;
		userDraggingRef.current = true;
		userMomentumRef.current = false;
	};
	const onScrollEndDrag = () => {
		userDraggingRef.current = false;
	};
	const onMomentumScrollBegin = () => {
		userMomentumRef.current = userScrollGestureRef.current;
	};
	const onMomentumScrollEnd = () => {
		userMomentumRef.current = false;
		userScrollGestureRef.current = false;
	};
	// AgentComposer へ安定参照で渡すため useCallback 化（ref と安定な setState のみ参照）。
	const scrollToEndSticky = useCallback(() => {
		userScrollGestureRef.current = false;
		userDraggingRef.current = false;
		userMomentumRef.current = false;
		setSticky(true);
		listRef.current?.scrollToEnd({ animated: true });
	}, [setSticky]);
	// sticky判定のしきい値: 下端から80px以内なら「最下部にいる」とみなす。
	const onListScroll = (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
		const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
		const nearBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
		if (nearBottom) {
			latestEntryPendingRef.current = false;
		}
		if (nearBottom && !stickyRef.current) {
			setSticky(true);
		} else if (!nearBottom && stickyRef.current && (userDraggingRef.current || userMomentumRef.current)) {
			setSticky(false);
		}
	};
	const jumpToLatest = () => {
		hapticSelection();
		scrollToEndSticky();
	};

	// キーボード開閉でリストの高さが変わったとき、最下部追従中なら張り付き直す。
	// KeyboardAvoidingView は高さを縮めるだけでスクロール位置を保持するため、
	// これが無いと最新メッセージがキーボードの裏に隠れる。
	// 履歴を遡って読んでいる最中（sticky解除中）は位置を動かさない。
	const listHeightRef = useRef(0);
	const onListLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
		const height = e.nativeEvent.layout.height;
		const shrank = height < listHeightRef.current;
		listHeightRef.current = height;
		if (shrank && stickyRef.current) {
			listRef.current?.scrollToEnd({ animated: false });
		}
	};

	return (
		<ConnectionGate>
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
			{/* minHeight: スラッシュメニュー等でinputBarが伸びても、チャット領域が
			    ヘッダー（＋Subagentストリップ表示中はその帯）より上まで潰れないようにする下限。
			    これによりinputBar側（flexShrink: 1）が縮み、メニューはヘッダー/ストリップの下に収まる */}
			<View style={[styles.chatArea, { minHeight: headerHeight + (hasActivityHistory ? 54 : 8) }]}>
				{activeKey === undefined ? (
					<Text style={[styles.placeholder, { marginTop: headerHeight }]}>ターミナルがありません。ターミナルタブから作成し、claude / codex を起動してください。</Text>
				) : chat === undefined ? (
					<Text style={[styles.placeholder, { marginTop: headerHeight }]}>読み込み中…</Text>
				) : chat.none ? (
					<View style={[styles.noneBox, { marginTop: headerHeight }]}>
						<Text style={styles.placeholder}>
							このターミナルのエージェントセッションが見つかりません。{'\n\n'}
							claude / codex をこのターミナルで起動（または一度発言）すると表示されます。
							生の画面はターミナルタブで確認できます。
						</Text>
						<Pressable style={styles.retryBtn} onPress={() => { hapticImpact('light'); refreshAgent(activeKey); }}>
							<Ionicons name="refresh" size={14} color={colors.text} />
							<Text style={styles.retryText}>再試行</Text>
						</Pressable>
					</View>
				) : (
					<FlatList
						ref={listRef}
						data={rows}
						keyExtractor={row => row.type === 'group' || row.type === 'questionGroup' || row.type === 'web' ? `${chat.epoch}:${row.key}` : `${chat.epoch}:${row.m.rev}`}
						ListHeaderComponent={<>{chat.activity !== undefined && !hasActiveActivity ? <AgentActivityCard activity={chat.activity} onOpen={openAgentActivity} /> : null}{chat.truncated ? <Text style={styles.truncatedNote}>（古い履歴は省略されています）</Text> : null}</>}
						ListFooterComponent={activeTerminal?.agentStatus === 'working' || chat?.live !== undefined ? <WorkingIndicator live={chat?.live} /> : null}
						renderItem={({ item }) =>
							item.type === 'msg' ? <MessageBubble message={item.m} />
								: item.type === 'question' ? <QuestionCard message={item.m} answered={item.answered} onAnswer={actions.answerQuestion} onMulti={actions.answerQuestionMulti} onFreeText={actions.answerQuestionFreeText} />
								: item.type === 'questionGroup' ? <QuestionGroupCard messages={item.msgs} answered={item.answered} onSubmit={actions.answerQuestionGroup} />
									: item.type === 'web' ? <WebSearchActivity msgs={item.msgs} />
									: <ActivityGroup msgs={item.msgs} />}
						contentContainerStyle={[styles.listContent, { paddingTop: headerHeight + (hasActivityHistory ? 52 : 6) }]}
						scrollIndicatorInsets={{ top: headerHeight - insets.top }}
						onContentSizeChange={onContentSizeChange}
						onScroll={onListScroll}
						onScrollBeginDrag={onScrollBeginDrag}
						onScrollEndDrag={onScrollEndDrag}
						onMomentumScrollBegin={onMomentumScrollBegin}
						onMomentumScrollEnd={onMomentumScrollEnd}
						scrollEventThrottle={32}
						onLayout={onListLayout}
					/>
				)}
				{/* sticky解除中（遡り読み中）の「最新へジャンプ」ボタン（Liquid Glass）。
				    新着が届いたら件数バッジを添える。タップで最下部へ戻り追従を再開する */}
				{!sticky && chat !== undefined && !chat.none ? (
					<View style={styles.jumpWrap} pointerEvents="box-none">
						<Pressable onPress={jumpToLatest} accessibilityLabel="最新のメッセージへ移動">
							<GlassSurface style={[styles.jumpBtn, !liquidGlass && styles.jumpFallbackBorder]} interactive>
								<Ionicons name="chevron-down" size={16} color={colors.text} />
								{newCount > 0 ? <Text style={styles.jumpText}>{newCount > 99 ? '99+' : String(newCount)}</Text> : null}
							</GlassSurface>
						</Pressable>
					</View>
				) : null}
			</View>

			{/* 独自ヘッダー: チャットの上に重ねるブラーバー（純正メール風にコンテンツが
			    下を通ってボケる）＋戻る（Liquid Glass）＋ターミナルタイトル＋ワークスペース */}
			<View style={styles.headerOverlay} onLayout={e => setHeaderHeight(e.nativeEvent.layout.height)}>
				<BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} />
				<View style={[styles.header, { paddingTop: insets.top + 4 }]}>
					<Pressable onPress={() => { hapticSelection(); router.back(); }} accessibilityLabel="戻る">
						<GlassSurface style={styles.backBtn} interactive>
							<Ionicons name="chevron-back" size={20} color={colors.text} />
						</GlassSurface>
					</Pressable>
					<View style={styles.headerBody}>
						<Text style={styles.headerTitle} numberOfLines={1}>{activeTerminal?.title ?? 'エージェント'}</Text>
						{agentWs !== undefined ? (
							<Text style={styles.headerSub} numberOfLines={1}>
								<Text style={{ color: wsColor(agentWs) }}>{agentWs.name}</Text>
								{agentWs.branch ? ` · ${agentWs.branch}` : ''}
							</Text>
						) : null}
					</View>
					{/* ブラウザボタン（旧ブラウザタブの後継）。共有中ページがあれば緑ドットで示す */}
					<Pressable onPress={openBrowser} accessibilityLabel="ブラウザを開く">
						<GlassSurface style={styles.browserBtn} interactive>
							<Ionicons name="globe-outline" size={18} color={colors.text} />
						</GlassSurface>
						{hasSharedPage ? <View style={styles.browserBtnBadge} /> : null}
					</Pressable>
				</View>
			</View>
			{hasActivityHistory && chat?.activity !== undefined ? <View style={[styles.activityStripOverlay, { top: headerHeight + 4 }]}><AgentActivityStrip activity={chat.activity} onOpen={openAgentActivity} /></View> : null}

			{permissionPending && activeKey !== undefined ? (
				<View style={styles.approvalBarWrap}>
					<ApprovalCard
						key={approval?.id ?? `legacy:${chat?.epoch ?? activeKey}`}
						interactionId={approval?.id ?? `legacy:${chat?.epoch ?? activeKey}`}
						onApprove={actions.approve}
						title={approval?.title}
						detail={approval?.detail ?? findLatestApprovalRequest(chat)}
						choices={approval?.choices}
					/>
				</View>
			) : null}

			<View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 8 : insets.bottom + 12 }]}>
				<AgentComposer
					draftKey={draftKey}
					activeTerminalKey={activeKey}
					sessionEpoch={chat?.epoch}
					agent={chat !== undefined && !chat.none ? chat.agent : undefined}
					model={chat?.info?.model}
					effort={chat?.info?.effort}
					modelControl={chat?.modelControl}
					commandCatalog={chat?.commandCatalog}
					pr={agentWsPr}
					sendText={actions.sendText}
					updateClaudeSetting={actions.updateClaudeSetting}
					onAfterSubmit={scrollToEndSticky}
					fsUpload={fsUpload}
					requestAgentModelCatalog={requestAgentModelCatalog}
					requestAgentCommandCatalog={requestAgentCommandCatalog}
					updateAgentSettings={updateAgentSettings}
				/>
			</View>
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

/** FlatList の1行。本文はそのまま、アクティビティ（thinking/tool群）は集約行、質問は独立行。 */
type ChatRow =
	| { type: 'msg'; m: AgentChatMessage }
	| { type: 'question'; m: AgentChatMessage; answered: boolean }
	| { type: 'questionGroup'; key: string; msgs: AgentChatMessage[]; answered: boolean }
	| { type: 'web'; key: string; msgs: AgentChatMessage[] }
	| { type: 'group'; key: string; msgs: AgentChatMessage[] };

/**
 * ツール名の表示整形。MCPツールの内部名（mcp__sentry__search_issues）は読みにくいため、
 * 「search_issues · sentry MCP」の形に直す。それ以外はそのまま。
 */
function formatToolName(tool: string): string {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
	// allow-any-unicode-next-line
	return mcp ? `${mcp[2]} · ${mcp[1]} MCP` : tool;
}

/** アクティビティ群の要約文（例: `思考 ×2 ・ ツール5件 (Bash, Read) ・ 48秒`）。 */
function summarizeActivity(msgs: readonly AgentChatMessage[]): string {
	const thinking = msgs.filter(m => m.kind === 'thinking').length;
	const tools = msgs.filter(m => m.kind === 'tool_use');
	const names: string[] = [];
	for (const t of tools) {
		const name = t.tool !== undefined ? formatToolName(t.tool) : undefined;
		if (name !== undefined && !names.includes(name)) {
			names.push(name);
		}
	}
	const parts: string[] = [];
	if (thinking > 0) {
		parts.push(thinking === 1 ? '思考' : `思考 ×${thinking}`);
	}
	if (tools.length > 0) {
		const shown = names.slice(0, 3).join(', ');
		parts.push(`ツール${tools.length}件${shown ? ` (${shown}${names.length > 3 ? '…' : ''})` : ''}`);
	}
	if (parts.length === 0) {
		parts.push(`${msgs.length}件のアクティビティ`);
	}
	const stamps = msgs.map(m => m.ts).filter((t): t is number => typeof t === 'number');
	if (stamps.length >= 2) {
		const sec = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000);
		if (sec >= 1) {
			parts.push(sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`);
		}
	}
	return parts.join(' ・ ');
}

/** thinking / tool 群の集約行。デフォルト折りたたみ、タップで展開。 */
function ActivityGroup({ msgs }: { msgs: AgentChatMessage[] }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<View>
			<Pressable style={styles.activityRow} onPress={() => { hapticSelection(); setExpanded(e => !e); }} accessibilityLabel={expanded ? 'アクティビティを折りたたむ' : 'アクティビティを展開'}>
				<Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={12} color={colors.textDim} />
				<Text style={styles.activityText} numberOfLines={1}>{summarizeActivity(msgs)}</Text>
			</Pressable>
			{expanded ? (
				<View style={styles.activityBody}>
					{msgs.map(m => <MessageBubble key={m.rev} message={m} />)}
				</View>
			) : null}
		</View>
	);
}

interface WebSite { readonly domain: string; readonly url: string }

function webSites(msgs: readonly { text: string }[]): WebSite[] {
	const sites = new Map<string, string>();
	for (const message of msgs) {
		for (const match of message.text.matchAll(/https?:\/\/([^\s/)>\]}"']+)(\/(?:(?!https?:\/\/)[^\s)>\]}"'])*)?/gi)) {
			const domain = match[1]?.toLowerCase().replace(/^www\./, '').replace(/[.,;:]$/, '');
			if (domain !== undefined && /^[a-z0-9.-]+$/.test(domain) && domain.includes('.') && !/^\d+(?:\.\d+){3}$/.test(domain) && !domain.endsWith('.local') && !domain.endsWith('.internal') && domain !== 'localhost' && !sites.has(domain)) { sites.set(domain, match[0].replace(/[.,;:]+$/, '')); }
			if (sites.size >= 6) { return [...sites].map(([domain, url]) => ({ domain, url })); }
		}
	}
	return [...sites].map(([domain, url]) => ({ domain, url }));
}

function Favicon({ domain }: { domain: string }) {
	const [failed, setFailed] = useState(false);
	return <View style={styles.favicon} accessible={false}>{failed ? <Text style={styles.faviconLetter}>{domain.slice(0, 1).toUpperCase()}</Text> : <Image accessible={false} source={{ uri: `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(`https://${domain}`)}` }} style={styles.faviconImage} onError={() => setFailed(true)} />}</View>;
}

/** ChatGPTの検索中表示に近い、クエリ＋発見サイトfaviconの専用アクティビティ。 */
function WebSearchActivity({ msgs }: { msgs: AgentChatMessage[] }) {
	const [expanded, setExpanded] = useState(false);
	const query = msgs.find(message => message.kind === 'tool_use' && message.tool === 'web_search')?.text ?? 'Web検索';
	const sites = webSites(msgs);
	const completed = msgs.some(message => message.kind === 'tool_result');
	const failed = msgs.some(message => message.kind === 'tool_result' && message.text.startsWith('Web検索に失敗しました'));
	return <View style={styles.webWrap}>
		<Pressable style={styles.webRow} onPress={() => { hapticSelection(); setExpanded(value => !value); }} accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={expanded ? 'Web検索アクティビティを折りたたむ' : 'Web検索アクティビティを展開'}>
			<View style={styles.faviconStack}>{sites.length > 0 ? sites.slice(0, 4).map(site => <Favicon key={site.domain} domain={site.domain} />) : <View style={styles.favicon}><Ionicons name="search" size={12} color={colors.accent2} /></View>}</View>
			<View style={styles.webBody}><Text style={[styles.webLabel, failed && { color: colors.red }]}>{failed ? 'Web検索失敗' : sites.length > 0 ? `${sites.length}サイトを参照` : completed ? 'Web検索完了' : 'Webを検索中'}</Text><Text style={styles.webQuery} numberOfLines={1}>{query}</Text></View>
			<Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={12} color={colors.textDim} />
		</Pressable>
		{expanded ? <View style={styles.activityBody}>{msgs.map(message => <MessageBubble key={message.rev} message={message} />)}{sites.map(site => <Pressable key={site.domain} style={styles.domainRow} onPress={() => { hapticSelection(); void Linking.openURL(site.url).catch(() => { /* 開けないURLは無視 */ }); }} accessibilityRole="link" accessibilityLabel={`${site.domain} をブラウザで開く`}><Favicon domain={site.domain} /><Text style={styles.domainText}>{site.domain}</Text><Ionicons name="open-outline" size={11} color={colors.textDim} /></Pressable>)}</View> : null}
	</View>;
}

function MessageBubble({ message }: { message: AgentChatMessage }) {
	if (message.kind === 'peer_message') {
		return (
			<View style={styles.peerMessageCard}>
				<View style={styles.peerMessageHeader}>
					<Ionicons name="people-outline" size={13} color={colors.accent2} />
					<Text style={styles.peerMessageLabel}>Claude teammate{message.peerName ? ` · ${message.peerName}` : ''}</Text>
				</View>
				{message.peerSummary ? <Text style={styles.peerMessageSummary}>{message.peerSummary}</Text> : null}
				<MarkdownText text={message.text} />
			</View>
		);
	}
	if (message.kind === 'tool_use') {
		return (
			<View style={styles.toolRow}>
				<Ionicons name="construct-outline" size={12} color={colors.textDim} />
				<Text style={styles.toolText} numberOfLines={3}>{message.tool === 'approval_request' ? '許可要求' : formatToolName(message.tool ?? 'tool')}: {message.text}</Text>
			</View>
		);
	}
	if (message.kind === 'tool_result') {
		return (
			<View style={styles.toolRow}>
				<Ionicons name="return-down-forward-outline" size={12} color={colors.textDim} />
				<Text style={styles.toolText} numberOfLines={4}>{message.text}</Text>
			</View>
		);
	}
	if (message.kind === 'thinking') {
		return <Text style={styles.thinkingText} numberOfLines={6}>{message.text}</Text>;
	}
	const isUser = message.role === 'user';
	return (
		<View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
			{isUser
				? <Text style={styles.bubbleText} selectable>{message.text}</Text>
				: <MarkdownText text={message.text} />}
		</View>
	);
}

/** エージェントがターン実行中に出す「考え中」インジケータ（ドットの脈動アニメーション）。 */
function WorkingIndicator({ live }: { live?: AgentLiveState }) {
	const pulse = useRef(new Animated.Value(0)).current;
	const [, setClock] = useState(0);
	const isAppActive = useAppIsActive();
	useEffect(() => {
		pulse.stopAnimation();
		pulse.setValue(0);
		if (!isAppActive) {
			return;
		}
		const loop = Animated.loop(Animated.sequence([
			Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
			Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: true }),
		]));
		loop.start();
		return () => {
			loop.stop();
			pulse.stopAnimation();
			pulse.setValue(0);
		};
	}, [isAppActive, pulse]);
	useEffect(() => {
		if (live === undefined || !isAppActive) {
			return;
		}
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [isAppActive, live]);
	const dot = (delay: number) => (
		<Animated.View
			style={[styles.workingDot, {
				opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: delay === 0 ? [0.9, 0.25] : delay === 1 ? [0.6, 0.5] : [0.25, 0.9] }),
			}]}
		/>
	);
	const elapsedSeconds = live !== undefined
		? Math.max(live.elapsedSeconds ?? 0, Math.max(0, Math.floor((Date.now() - live.startedAt) / 1000)))
		: undefined;
	const elapsed = elapsedSeconds !== undefined ? (elapsedSeconds < 60 ? `${elapsedSeconds}秒` : `${Math.floor(elapsedSeconds / 60)}分${String(elapsedSeconds % 60).padStart(2, '0')}秒`) : undefined;
	const tokens = live?.tokenCount !== undefined ? `${live.tokenCount.toLocaleString()} tokens` : undefined;
	const metrics = [elapsed, tokens].filter((value): value is string => value !== undefined).join(' · ');
	const label = live?.phase === 'tool'
		? `実行中: ${formatToolName(live.tool ?? 'tool')}`
		: live?.phase === 'message' ? '応答を生成中'
			: live?.phase === 'permission' ? '確認待ち' : '考え中';
	const preview = live?.phase === 'message' ? live.text?.trim() : live?.detail;
	const isWebSearch = live?.phase === 'tool' && (live.tool === 'web_search' || live.tool === 'webSearch');
	const liveSites = preview !== undefined ? webSites([{ text: preview }]) : [];
	if (isWebSearch) {
		return <View style={styles.webWrap} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Webを検索中"><View style={styles.webRow}><View style={styles.faviconStack}>{liveSites.length > 0 ? liveSites.map(site => <Favicon key={site.domain} domain={site.domain} />) : <View style={styles.favicon}><Ionicons name="search" size={12} color={colors.accent2} /></View>}</View><View style={styles.webBody}><Text style={styles.webLabel}>Webを検索中{metrics.length > 0 ? ` · ${metrics}` : ''}</Text><Text style={styles.webQuery} numberOfLines={2}>{preview ?? '検索結果を確認しています'}</Text></View></View></View>;
	}
	return (
		<View style={styles.workingRow}>
			<View style={styles.workingHeader}>
				{dot(0)}{dot(1)}{dot(2)}
				<Text style={styles.workingText}>{label}{metrics.length > 0 ? `（${metrics}）` : '…'}</Text>
			</View>
			{preview !== undefined && preview.length > 0 ? <Text style={styles.workingPreview} numberOfLines={4}>{preview}</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, overflow: 'hidden' },
	activityStripOverlay: { position: 'absolute', left: 12, right: 12, zIndex: 9 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
	backBtn: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	browserBtn: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	browserBtnBadge: { position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.green, borderWidth: 2, borderColor: colors.bg },
	headerBody: { flex: 1, minWidth: 0 },
	headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
	headerSub: { color: colors.textDim, fontSize: 11, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	peerMessageCard: { alignSelf: 'stretch', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, gap: 6 },
	peerMessageHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	peerMessageLabel: { color: colors.accent2, fontSize: 11, fontWeight: '700' },
	peerMessageSummary: { color: colors.text, fontSize: 12, fontWeight: '600' },
	// 案A「フルフラット」: チャット領域の外枠カードを廃止し、背景に直接描画する
	// （Claude公式アプリ風。コードブロックや長文が画面幅を最大限使える）。
	chatArea: { flex: 1 },
	listContent: { paddingHorizontal: 14, paddingVertical: 10, gap: 9 },
	placeholder: { color: colors.textDim, fontSize: 13, lineHeight: 20, padding: 16 },
	noneBox: { alignItems: 'flex-start' },
	retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
	retryText: { color: colors.text, fontSize: 12 },
	truncatedNote: { color: colors.textDim, fontSize: 11, textAlign: 'center', paddingBottom: 8 },
	bubble: {},
	// ユーザー発言のみ控えめなグレーバブル（右寄せ・送信側の角だけ詰める）。
	// エージェント側はバブルを使わず背景に直接テキストを流す（案Aフルフラット）。
	bubbleUser: { alignSelf: 'flex-end', backgroundColor: colors.surface2, borderRadius: 16, borderBottomRightRadius: 5, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '86%' },
	bubbleAssistant: { alignSelf: 'stretch', paddingHorizontal: 2 },
	bubbleText: { color: colors.text, fontSize: 13, lineHeight: 19 },
	thinkingText: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', lineHeight: 16, paddingHorizontal: 4 },
	activityRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 3 },
	activityText: { color: colors.textDim, fontSize: 11, flex: 1 },
	activityBody: { gap: 6, paddingLeft: 14, paddingTop: 4, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border, marginLeft: 8 },
	webWrap: { marginVertical: 2 }, webRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 13, backgroundColor: 'rgba(9,175,217,.07)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(9,175,217,.18)' },
	faviconStack: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 }, favicon: { width: 22, height: 22, borderRadius: 7, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: -5, overflow: 'hidden' }, faviconImage: { width: 14, height: 14, borderRadius: 3 }, faviconLetter: { color: colors.textDim, fontSize: 9, fontWeight: '800' },
	webBody: { flex: 1, minWidth: 0 }, webLabel: { color: colors.accent2, fontSize: 9.5, fontWeight: '700' }, webQuery: { color: colors.text, fontSize: 11, marginTop: 1 }, domainRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }, domainText: { color: colors.textDim, fontSize: 10.5 },
	toolRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4 },
	toolText: { color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1, lineHeight: 15 },
	approvalBarWrap: { marginHorizontal: 12, marginTop: 8 },
	workingRow: { gap: 5, paddingHorizontal: 4, paddingVertical: 10 },
	workingHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	workingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
	workingText: { color: colors.textDim, fontSize: 12, marginLeft: 4 },
	workingPreview: { color: colors.text, fontSize: 12, lineHeight: 18, marginLeft: 4, opacity: 0.82 },
	jumpWrap: { position: 'absolute', bottom: 12, right: 14 },
	// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く（他のglassボタンと同じ流儀）
	jumpBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, minWidth: 40, height: 40, borderRadius: 20, paddingHorizontal: 12, overflow: 'hidden' },
	jumpFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	jumpText: { color: colors.text, fontSize: 12, fontWeight: '600' },
	inputBar: { paddingHorizontal: 12, paddingTop: 10, flexShrink: 1 },
});

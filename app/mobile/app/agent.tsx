// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import { AgentTimeline } from '../src/components/agentTimeline.js';
import { ToolImageCards } from '../src/components/agentToolBodies.js';
import { IOBlock } from '../src/components/agentIoBlock.js';
import { formatToolName } from '../src/agentToolMeta.js';
import { findLatestApprovalRequest } from '../src/components/attentionStack.js';
import { AgentComposer } from '../src/components/agentComposer.js';
import { AgentInfoSheet } from '../src/components/agentInfoSheet.js';
import { PendingMessagesChip, PendingMessagesSheet } from '../src/components/pendingMessages.js';
import { NO_PENDING_MESSAGES, usePendingAgentMessages } from '../src/pendingAgentMessages.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useAgentActions } from '../src/hooks/useAgentActions.js';
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { useAppIsActive } from '../src/hooks/useAppIsActive.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';
import { isRunningAgentActivity } from '../src/agentActivityTree.js';
import { resolveExplicitTerminalSelection, shouldHandleLatestEntry } from '../src/agentNavigation.js';
import { AgentInitialRevealGate } from '../src/agentInitialReveal.js';
import { AgentStickyScroll } from '../src/agentStickyScroll.js';

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
	const { workspace, agentChats, selectedWs, selectedTerminalKey, connection, pcOnline, sessionProtocolReady, attachAgent, detachAgent, refreshAgent, requestAgentModelCatalog, requestAgentCommandCatalog, updateAgentSettings, fsUpload, browserTargets, setViewingTerminalKey } = useAppStore(useShallow(s => ({
		workspace: s.workspace, agentChats: s.agentChats, selectedWs: s.selectedWs,
		selectedTerminalKey: s.selectedTerminalKey, connection: s.connection, pcOnline: s.pcOnline, sessionProtocolReady: s.sessionProtocolReady,
		attachAgent: s.attachAgent, detachAgent: s.detachAgent, refreshAgent: s.refreshAgent,
		requestAgentModelCatalog: s.requestAgentModelCatalog, requestAgentCommandCatalog: s.requestAgentCommandCatalog, updateAgentSettings: s.updateAgentSettings, fsUpload: s.fsUpload,
		browserTargets: s.browserTargets, setViewingTerminalKey: s.setViewingTerminalKey,
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
	const chatReady = chat !== undefined && !chat.none;
	const hasActivityHistory = chat?.activity !== undefined && (chat.activity.agents.length > 0 || chat.activity.tasks.length > 0);
	const hasActiveActivity = chat?.activity !== undefined && (chat.activity.agents.some(item => isRunningAgentActivity(item.status)) || chat.activity.tasks.some(item => isRunningAgentActivity(item.status)));
	// 承認バーの出現条件も chat.interaction（PC側の currentInteraction）を正本にする。
	// agentStatus は hook 由来の派生値で、解除され損ねた承認要求が残っていると質問中でも
	// permission に化けるため、以前は質問カードの下に押しても効かない許可/拒否バーが併存していた。
	const approval = chat?.interaction?.kind === 'approval' ? chat.interaction : undefined;
	// interaction が届いていないのに permission と言われている状態。実IDが無く回答を送れない
	// （PC側の hasPendingInteraction と一致しない）ので、押せない二択ではなく誘導だけを出す。
	const approvalUnavailable = chat?.interaction === undefined && activeTerminal?.agentStatus === 'permission';
	const actions = useAgentActions(activeKey, chat?.agent);

	// 送ったがまだ読まれていないメッセージの控え。エージェントが作業中に送ると、読まれるまで
	// 会話に現れない（＝画面から本文が消える）ため、ここで預かって件数を見せる。
	const pendingMessages = usePendingAgentMessages(s => activeKey !== undefined ? s.byTerminal[activeKey] : undefined) ?? NO_PENDING_MESSAGES;
	const [pendingSheetOpen, setPendingSheetOpen] = useState(false);
	// 送信時点までの最大 rev。これより後に現れた発言だけを「読まれた」の照合に使う
	// （同じ指示を送り直したとき、過去の同じ発言で控えが消えないようにする）。
	const messagesRef = useRef<readonly AgentChatMessage[] | undefined>(undefined);
	messagesRef.current = chat?.messages;
	const chatEpoch = chat?.epoch;
	// 送信予定のチップは実行中インジケータに同居させる。動いていないのに控えが残っている
	// 場合（読まれないまま終わった等）だけ、単独の行として入力欄の上に出す。
	const workingVisible = activeTerminal?.agentStatus === 'working' || chat?.live !== undefined;
	// 控えは「動作中に送ったとき」だけ持つ。手が空いているときに送ったぶんは1秒ほどで
	// 会話に現れるので、預かると毎回チップが一瞬光るだけになる。
	const workingRef = useRef(false);
	workingRef.current = workingVisible;
	// AgentComposer は memo 化されているので、依存は actions ではなく actions.sendText
	// （hook内で安定）にする。actions は毎レンダー新しい object になり、入力中の無関係な
	// 再レンダーを招く。
	const sendTextAction = actions.sendText;
	const sendText = useCallback((text: string) => {
		const afterRev = (messagesRef.current ?? []).reduce((max, message) => Math.max(max, message.rev), 0);
		const wasWorking = workingRef.current;
		return sendTextAction(text).then(result => {
			if (wasWorking && result.status === 'accepted' && activeKey !== undefined && chatEpoch !== undefined) {
				usePendingAgentMessages.getState().add(activeKey, text, afterRev, chatEpoch);
			}
			return result;
		});
	}, [sendTextAction, activeKey, chatEpoch]);
	const messages = chat?.messages;
	useEffect(() => {
		if (activeKey === undefined) {
			return;
		}
		usePendingAgentMessages.getState().reconcile(
			activeKey,
			chatEpoch,
			(messages ?? []).filter(message => message.role === 'user' && message.kind === 'text'),
		);
	}, [activeKey, chatEpoch, messages]);
	// 全部読まれたらシートを閉じる（開けたまま空になると「送信予定 0件」が残る）。
	useEffect(() => {
		if (pendingMessages.length === 0) {
			setPendingSheetOpen(false);
		}
	}, [pendingMessages.length]);

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

	// ヘッダーのタイトルから開く情報シート（名前の変更・スペースのメモ・ピン/アーカイブ/削除）。
	// それまで名前はホーム長押し、メモはドロワーからしか触れず、会話を読みながらでは手が届かなかった。
	const [infoOpen, setInfoOpen] = useState(false);
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

	// この画面を見ている間は、同じエージェントの通知バナーを出さない（目の前に出ている内容を
	// バナーで被せないため）。マウントではなくフォーカスで判定する: 設定などへ遷移しても
	// この画面はスタックに残り続けるので、マウントだと「見ていない」を検出できない。
	useFocusEffect(useCallback(() => {
		setViewingTerminalKey(activeKey);
		return () => setViewingTerminalKey(undefined);
	}, [activeKey, setViewingTerminalKey]));

	// 自動スクロールは「sticky（最下部追従）モード」で制御する。判断そのものは
	// agentStickyScroll.ts の状態機械が持つ（画面を動かさずに検証できるようにするため）。
	// ここはイベントを渡し、返ってきた指示どおりにリストを動かすだけにする。
	const scrollState = useRef(new AgentStickyScroll()).current;
	const [sticky, setStickyState] = useState(true);
	// 初回表示は最下部へ到達してから見せる（分割描画の追いかけ過程を見せると、開いた直後に
	// 履歴が上から流れ落ちて最新へ飛ぶように映る）。判定は agentInitialReveal.ts 側。
	// タイマーを持つのでキャッシュ破棄が許される useMemo ではなく ref で保持する。
	const [listRevealed, setListRevealed] = useState(false);
	const revealGate = useRef(new AgentInitialRevealGate(() => {
		// 上限時間で表示に転じたときは追いかけの途中なので、見せる直前に一度寄せ直す
		// （遡り読みを始めていたら動かさない）。
		if (scrollState.sticky) {
			listRef.current?.scrollToEnd({ animated: false });
		}
		setListRevealed(true);
	})).current;
	const handledLatestEntryRef = useRef<string | undefined>(undefined);
	// sticky解除中に届いた新着（確定メッセージ）の件数。ジャンプボタンのバッジに出す。
	const [newCount, setNewCount] = useState(0);
	// 状態機械の sticky を画面へ映す。追従へ戻ったところで新着バッジは用済みになる
	// （バッジは sticky でない間しか増えないので、無条件に 0 でよい）。
	const syncSticky = useCallback(() => {
		const next = scrollState.sticky;
		setStickyState(next);
		if (next) {
			setNewCount(0);
		}
	}, [scrollState]);
	const prevCountRef = useRef(0);
	useEffect(() => {
		scrollState.reset();
		syncSticky();
		prevCountRef.current = 0;
	}, [activeKey, scrollState, syncSticky]);
	// リストが実際にマウントされた（＝チャットが手元に届いた）ところから隠し始める。
	// 条件は FlatList の描画条件（chat があって none でない）と必ず同値にすること。ずれると
	// 「隠したのに描画されない＝戻せない」空白が生まれる。epoch が変わると keyExtractor 経由で
	// 全行が作り直され追いかけが再発するため、そこでも隠し直す。
	// 到達前にアンマウントされても保留中のタイマーを残さない。
	useEffect(() => {
		if (activeKey === undefined || !chatReady) {
			return;
		}
		setListRevealed(false);
		revealGate.begin();
		return () => revealGate.dispose();
	}, [activeKey, chatReady, chat?.epoch, revealGate]);
	useEffect(() => {
		if (activeKey === undefined || !shouldHandleLatestEntry(handledLatestEntryRef.current, latestEntry)) {
			return;
		}
		handledLatestEntryRef.current = latestEntry;
		scrollState.followFromNavigation();
		syncSticky();
		const frame = requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
		return () => cancelAnimationFrame(frame);
	}, [activeKey, latestEntry, scrollState, syncSticky]);
	const messageCount = chat?.messages.length ?? 0;
	useEffect(() => {
		const delta = messageCount - prevCountRef.current;
		prevCountRef.current = messageCount;
		if (delta > 0 && !scrollState.sticky) {
			setNewCount(c => c + delta);
		}
	}, [messageCount, scrollState]);
	const onContentSizeChange = (_width: number, height: number) => {
		if (scrollState.handleContentSize(height)) {
			listRef.current?.scrollToEnd({ animated: false });
			revealGate.noteGrowth();
		}
	};
	const onScrollBeginDrag = () => {
		// 隠している間は触れないので通常ここは表示済み。隠したまま指が届く経路が
		// できたときに取り残されないための保険として呼ぶ。
		revealGate.revealNow();
		scrollState.beginDrag();
	};
	const onScrollEndDrag = () => scrollState.endDrag();
	const onMomentumScrollBegin = () => scrollState.beginMomentum();
	const onMomentumScrollEnd = () => scrollState.endMomentum();
	// AgentComposer へ安定参照で渡すため useCallback 化（ref と安定な setState のみ参照）。
	const scrollToEndSticky = useCallback(() => {
		scrollState.followNow();
		syncSticky();
		listRef.current?.scrollToEnd({ animated: true });
	}, [scrollState, syncSticky]);
	const onListScroll = (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
		const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
		if (scrollState.handleScroll({ offsetY: contentOffset.y, layoutHeight: layoutMeasurement.height, contentHeight: contentSize.height })) {
			syncSticky();
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
		if (shrank && scrollState.shouldPinOnViewportShrink()) {
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
						// 最下部へ到達するまでは見せない。見えないものに触れると誤タップになるので、
						// この間の操作は受け取らずに捨てる（隠すのは長くても上限時間まで）。
						// 参照が変わるとFlatListごと再描画されるためStyleSheetの定数を出し分ける。
						style={listRevealed ? styles.listShown : styles.listHidden}
						pointerEvents={listRevealed ? 'auto' : 'none'}
						data={rows}
						keyExtractor={row => row.type === 'group' || row.type === 'questionGroup' || row.type === 'web' ? `${chat.epoch}:${row.key}` : `${chat.epoch}:${row.m.rev}`}
						ListHeaderComponent={<>{chat.activity !== undefined && !hasActiveActivity ? <AgentActivityCard activity={chat.activity} onOpen={openAgentActivity} /> : null}{chat.truncated ? <Text style={styles.truncatedNote}>（古い履歴は省略されています）</Text> : null}</>}
						ListFooterComponent={workingVisible
							? <WorkingIndicator live={chat?.live} pendingCount={pendingMessages.length} onOpenPending={() => setPendingSheetOpen(true)} />
							: null}
						renderItem={({ item }) =>
							item.type === 'msg' ? <MessageBubble message={item.m} terminalKey={activeKey} />
								: item.type === 'question' ? <QuestionCard message={item.m} answered={item.answered} onAnswer={actions.answerQuestion} onMulti={actions.answerQuestionMulti} onFreeText={actions.answerQuestionFreeText} />
								: item.type === 'questionGroup' ? <QuestionGroupCard messages={item.msgs} answered={item.answered} onSubmit={actions.answerQuestionGroup} />
									: item.type === 'web' ? <WebSearchActivity msgs={item.msgs} terminalKey={activeKey} />
									: <AgentTimeline msgs={item.msgs} terminalKey={activeKey} />}
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
					{/* タイトルは情報シート（名前の変更・スペースのメモ・ピン/アーカイブ/削除）の入口。
					    既にブラーの上に載っているので、glassの上にglassを重ねないようボタン面は描かず、
					    押せることは末尾のシェブロンで示す */}
					<Pressable
						style={styles.headerBody}
						disabled={activeTerminal === undefined}
						onPress={() => { hapticSelection(); setInfoOpen(true); }}
						accessibilityRole="button"
						// Pressable は子のTextを個別に読み上げなくなるため、見えている情報をラベルに畳む
						accessibilityLabel={`${activeTerminal?.title ?? 'エージェント'}${agentWs !== undefined ? `、${agentWs.name}${agentWs.branch ? `、${agentWs.branch}` : ''}` : ''}`}
						accessibilityHint="情報と設定を開きます"
					>
						<View style={styles.headerTitleRow}>
							<Text style={styles.headerTitle} numberOfLines={1}>{activeTerminal?.title ?? 'エージェント'}</Text>
							{activeTerminal !== undefined ? <Ionicons name="chevron-down" size={12} color={colors.textDim} /> : null}
						</View>
						{agentWs !== undefined ? (
							<Text style={styles.headerSub} numberOfLines={1}>
								<Text style={{ color: wsColor(agentWs) }}>{agentWs.name}</Text>
								{agentWs.branch ? ` · ${agentWs.branch}` : ''}
							</Text>
						) : null}
					</Pressable>
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

			{approval !== undefined && activeKey !== undefined ? (
				<View style={styles.approvalBarWrap}>
					<ApprovalCard
						key={approval.id}
						interactionId={approval.id}
						onApprove={actions.approve}
						title={approval.title}
						detail={approval.detail ?? findLatestApprovalRequest(chat)}
						choices={approval.choices}
					/>
				</View>
			) : approvalUnavailable && activeKey !== undefined ? (
				<View style={styles.approvalBarWrap}>
					<View style={styles.approvalSyncing}>
						<Text style={styles.approvalSyncingText}>PCで内容を確認してください</Text>
						<Text style={styles.approvalSyncingHint}>許可の内容を取得できていないため、ここからは回答できません</Text>
					</View>
				</View>
			) : null}

			{pendingMessages.length > 0 && !workingVisible ? (
				<View style={styles.pendingRow}>
					<PendingMessagesChip count={pendingMessages.length} onPress={() => setPendingSheetOpen(true)} />
				</View>
			) : null}

			<PendingMessagesSheet visible={pendingSheetOpen} messages={pendingMessages} onClose={() => setPendingSheetOpen(false)} />

			{activeTerminal !== undefined ? (
				<AgentInfoSheet
					visible={infoOpen}
					onClose={() => setInfoOpen(false)}
					terminalKey={activeTerminal.terminalKey}
					title={activeTerminal.title}
					agentStatus={activeTerminal.agentStatus}
					ws={agentWs !== undefined ? { id: agentWs.id, name: agentWs.name, branch: agentWs.branch, color: wsColor(agentWs) } : undefined}
					model={chat?.info?.model}
					effort={chat?.info?.effort}
					onOpenBrowser={openBrowser}
					onLeaveScreen={() => router.back()}
				/>
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
					sendText={sendText}
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
function WebSearchActivity({ msgs, terminalKey }: { msgs: AgentChatMessage[]; terminalKey?: string }) {
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
		{/* 展開時は結果を IOBlock（横スクロール・全文取得つき）に載せる。旧実装は
		    numberOfLines で切っていたため、開いても続きが読めなかった */}
		{expanded ? <View style={styles.activityBody}>{msgs.filter(message => message.kind === 'tool_result').map(message => <IOBlock key={message.rev} label="検索結果" message={message} terminalKey={terminalKey} lines />)}{sites.map(site => <Pressable key={site.domain} style={styles.domainRow} onPress={() => { hapticSelection(); void Linking.openURL(site.url).catch(() => { /* 開けないURLは無視 */ }); }} accessibilityRole="link" accessibilityLabel={`${site.domain} をブラウザで開く`}><Favicon domain={site.domain} /><Text style={styles.domainText}>{site.domain}</Text><Ionicons name="open-outline" size={11} color={colors.textDim} /></Pressable>)}</View> : null}
	</View>;
}

function MessageBubble({ message, terminalKey }: { message: AgentChatMessage; terminalKey?: string }) {
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
	const isUser = message.role === 'user';
	// ユーザーが貼った画像は発言と一緒に届く。本文の下にプレビューを添える
	// （タップで全画面。取り寄せの仕組みはツール結果の画像と共通）。
	const hasImages = (message.images?.length ?? 0) > 0;
	return (
		<View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
			{message.text.trim().length > 0 ? (
				isUser
					? <Text style={styles.bubbleText} selectable>{message.text}</Text>
					: <MarkdownText text={message.text} />
			) : null}
			{hasImages ? <ToolImageCards result={message} terminalKey={terminalKey} /> : null}
		</View>
	);
}

/** エージェントがターン実行中に出す「考え中」インジケータ（ドットの脈動アニメーション）。 */
function WorkingIndicator({ live, pendingCount = 0, onOpenPending }: {
	live?: AgentLiveState;
	/** 送ったがまだ読まれていないメッセージの件数（0なら何も出さない）。 */
	pendingCount?: number;
	onOpenPending?: () => void;
}) {
	const pulse = useRef(new Animated.Value(0)).current;
	const [, setClock] = useState(0);
	const isAppActive = useAppIsActive();
	const isLive = live !== undefined;
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
	// 依存を live オブジェクトにすると delta のたび（最大8Hz）に interval を張り直し、
	// そのつど setClock で余分な再レンダーが走る。必要なのは「live があるか」だけ。
	useEffect(() => {
		if (!isLive || !isAppActive) {
			return;
		}
		setClock(Date.now());
		const timer = setInterval(() => setClock(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [isAppActive, isLive]);
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
	// preview はツールの開始で現れ、終了（phase='thinking'）で消えるため、そのままだと
	// フッターの高さがツール1回ごとに 0〜4行ぶん振れる。下端に張り付いている以上、
	// その伸縮がそのまま会話本文の上下動になる（ツール連打時は毎秒数回＝「高速にガクガク」）。
	// 直前の内容を保持し、かつ下の workingPreview で高さを固定して振動源を断つ。
	const rawPreview = live?.phase === 'message' ? live.text?.trim() : live?.detail;
	const hasRawPreview = rawPreview !== undefined && rawPreview.length > 0;
	// レンダー中に ref を読む形（effect で書いて render で読む）は並行レンダーで壊れうるので、
	// 保持は state で行う。live が消えた時点で忘れる。
	const [retainedPreview, setRetainedPreview] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (hasRawPreview) {
			setRetainedPreview(rawPreview);
		} else if (!isLive) {
			setRetainedPreview(undefined);
		}
	}, [hasRawPreview, rawPreview, isLive]);
	const preview = hasRawPreview ? rawPreview : (isLive ? retainedPreview : undefined);
	const isWebSearch = live?.phase === 'tool' && (live.tool === 'web_search' || live.tool === 'webSearch');
	const liveSites = preview !== undefined ? webSites([{ text: preview }]) : [];
	if (isWebSearch) {
		return <View style={styles.webWrap} accessibilityRole="progressbar" accessibilityLiveRegion="polite" accessibilityLabel="Webを検索中"><View style={styles.webRow}><View style={styles.faviconStack}>{liveSites.length > 0 ? liveSites.map(site => <Favicon key={site.domain} domain={site.domain} />) : <View style={styles.favicon}><Ionicons name="search" size={12} color={colors.accent2} /></View>}</View><View style={styles.webBody}><Text style={styles.webLabel}>Webを検索中{metrics.length > 0 ? ` · ${metrics}` : ''}</Text><Text style={styles.webQuery} numberOfLines={2}>{preview ?? '検索結果を確認しています'}</Text></View></View></View>;
	}
	return (
		<View style={styles.workingRow}>
			<View style={styles.workingHeader}>
				{dot(0)}{dot(1)}{dot(2)}
				<Text style={styles.workingText} numberOfLines={1}>{label}{metrics.length > 0 ? `（${metrics}）` : '…'}</Text>
				{onOpenPending !== undefined ? <PendingMessagesChip count={pendingCount} onPress={onOpenPending} /> : null}
			</View>
			{/* preview は常時マウントして高さを固定する。条件付きレンダーだと行ごと消えて
			    フッターの高さが跳ね、下端固定のぶん本文が上下に振動する。 */}
			<Text style={styles.workingPreview} numberOfLines={2}>{preview ?? ''}</Text>
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
	headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	// flexShrink: シェブロンを押し出さずにタイトル側で省略させる
	headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700', flexShrink: 1 },
	headerSub: { color: colors.textDim, fontSize: 11, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	peerMessageCard: { alignSelf: 'stretch', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, gap: 6 },
	peerMessageHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	peerMessageLabel: { color: colors.accent2, fontSize: 11, fontWeight: '700' },
	peerMessageSummary: { color: colors.text, fontSize: 12, fontWeight: '600' },
	// 案A「フルフラット」: チャット領域の外枠カードを廃止し、背景に直接描画する
	// （Claude公式アプリ風。コードブロックや長文が画面幅を最大限使える）。
	chatArea: { flex: 1 },
	listShown: { opacity: 1 },
	listHidden: { opacity: 0 },
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
	activityBody:{ gap: 6, paddingLeft: 14, paddingTop: 4, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border, marginLeft: 8 },
	webWrap: { marginVertical: 2 }, webRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 13, backgroundColor: 'rgba(9,175,217,.07)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(9,175,217,.18)' },
	faviconStack: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 }, favicon: { width: 22, height: 22, borderRadius: 7, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: -5, overflow: 'hidden' }, faviconImage: { width: 14, height: 14, borderRadius: 3 }, faviconLetter: { color: colors.textDim, fontSize: 9, fontWeight: '800' },
	webBody: { flex: 1, minWidth: 0 }, webLabel: { color: colors.accent2, fontSize: 9.5, fontWeight: '700' }, webQuery: { color: colors.text, fontSize: 11, marginTop: 1 }, domainRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }, domainText: { color: colors.textDim, fontSize: 10.5 },
	approvalBarWrap: { marginHorizontal: 12, marginTop: 8 },
	approvalSyncing: { backgroundColor: 'rgba(255,255,255,.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,.10)', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, gap: 4 },
	approvalSyncingText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	approvalSyncingHint: { color: colors.textDim, fontSize: 11.5, lineHeight: 16 },
	workingRow: { gap: 5, paddingHorizontal: 4, paddingVertical: 10 },
	workingHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	workingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
	// flexShrink が無いと row 内で折り返さず右へはみ出す。長いMCPツール名でも1行に収める。
	workingText: { color: colors.textDim, fontSize: 12, marginLeft: 4, flexShrink: 1 },
	// minHeight 固定（lineHeight 18 × 2行）。preview の有無・行数でフッターの高さを動かさない。
	// height ではなく minHeight なのは、Dynamic Type で文字を大きくしたときに2行目が切れないようにするため。
	workingPreview: { color: colors.text, fontSize: 12, lineHeight: 18, minHeight: 36, marginLeft: 4, opacity: 0.82 },
	jumpWrap: { position: 'absolute', bottom: 12, right: 14 },
	// ネイティブglassは素材自体が縁の光を持つため、フォールバック時のみ枠線を描く（他のglassボタンと同じ流儀）
	jumpBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, minWidth: 40, height: 40, borderRadius: 20, paddingHorizontal: 12, overflow: 'hidden' },
	jumpFallbackBorder: { borderWidth: 1, borderColor: colors.glassBorder },
	jumpText: { color: colors.text, fontSize: 12, fontWeight: '600' },
	inputBar: { paddingHorizontal: 12, paddingTop: 10, flexShrink: 1 },
	// 実行中インジケータが出ていないときの送信予定チップ（右寄せで入力欄の上）
	pendingRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 6 },
});

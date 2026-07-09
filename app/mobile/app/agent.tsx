// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { isAgentWaiting, type AgentChatMessage } from '../src/store.js';
import { ConnectionGate } from '../src/components/connectionGate.js';
import { MarkdownText } from '../src/components/markdownText.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { QuestionCard, QuestionGroupCard } from '../src/components/questionCard.js';
import { ApprovalCard } from '../src/components/approvalCard.js';
import { findLatestApprovalRequest } from '../src/components/attentionCard.js';
import { GlassComposer } from '../src/components/glassComposer.js';
import { ModelPill } from '../src/components/modelPill.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useAgentActions } from '../src/hooks/useAgentActions.js';
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { colors } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

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
	const { workspace, agentChats, selectedWs, selectedTerminalId, attachAgent, detachAgent, refreshAgent, fsUpload } = useAppStore(useShallow(s => ({
		workspace: s.workspace, agentChats: s.agentChats, selectedWs: s.selectedWs,
		selectedTerminalId: s.selectedTerminalId,
		attachAgent: s.attachAgent, detachAgent: s.detachAgent, refreshAgent: s.refreshAgent, fsUpload: s.fsUpload,
	})));
	const [input, setInput] = useState('');
	const listRef = useRef<FlatList<ChatRow>>(null);
	const insets = useStableInsets();
	const keyboardVisible = useKeyboardVisible();

	// 表示対象: selectedTerminalId（ホーム/通知が遷移前に設定する）。無ければ選択中ws
	// のターミナルへフォールバック（旧タブと同じ規則: 未タグはactiveWs所属扱い）。
	const allTerminals = workspace?.terminals ?? [];
	const wsList = workspace?.workspaces ?? [];
	const effectiveWsId = (selectedWs !== undefined && wsList.some(w => w.id === selectedWs) ? selectedWs : wsList[0]?.id);
	const activeTerminal = (selectedTerminalId !== undefined ? allTerminals.find(t => t.id === selectedTerminalId) : undefined)
		?? allTerminals.find(t => (t.ws ?? workspace?.activeWs) === effectiveWsId);
	const activeId = activeTerminal?.id;
	const chat = activeId !== undefined ? agentChats.get(activeId) : undefined;
	const permissionPending = activeTerminal?.agentStatus === 'permission';
	const actions = useAgentActions(activeId, chat?.agent);

	// ヘッダー表示用: このターミナルの所属ワークスペース
	const agentWs = activeTerminal !== undefined
		? wsList.find(w => w.id === (activeTerminal.ws ?? workspace?.activeWs))
		: undefined;

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
			} else {
				buffer.push(m);
			}
		}
		flush();
		return result;
	}, [chat?.messages]);

	useEffect(() => {
		if (activeId === undefined) {
			return;
		}
		attachAgent(activeId);
		return () => detachAgent(activeId);
	}, [activeId, attachAgent, detachAgent]);

	// 新着で末尾へスクロール。画面を開いた直後（対象切替直後）は、上から下まで流れる
	// アニメーションを見せず最新メッセージへ即時ジャンプする。FlatListは長い履歴を
	// 分割レンダリングして contentSize が段階的に伸びるため、開いてからしばらくは
	// onContentSizeChange のたびに末尾へ張り付かせる（pinUntil方式）。
	const pinUntilRef = useRef(0);
	const pinArmedRef = useRef(true);
	useEffect(() => {
		pinArmedRef.current = true;
	}, [activeId]);
	const messagesArrived = (chat?.messages.length ?? 0) > 0;
	useEffect(() => {
		// pinの起点は「最初のメッセージが実際に届いた時」。attach（activeId変更）起点だと
		// 低速リレーでデータ到着が800msを超えたとき初回ジャンプが効かなくなる。
		if (messagesArrived && pinArmedRef.current) {
			pinArmedRef.current = false;
			pinUntilRef.current = Date.now() + 800;
			listRef.current?.scrollToEnd({ animated: false });
		}
	}, [messagesArrived, activeId]);
	const onContentSizeChange = () => {
		if (Date.now() < pinUntilRef.current) {
			listRef.current?.scrollToEnd({ animated: false });
		}
	};

	// キーボード開閉でリストの高さが変わったとき、直前に最下部（最新）を見ていたなら
	// 最下部へ張り付き直す。KeyboardAvoidingView は高さを縮めるだけでスクロール位置を
	// 保持するため、これが無いと最新メッセージがキーボードの裏に隠れる。
	// 履歴を遡って読んでいる最中（最下部にいない）は位置を動かさない。
	const atBottomRef = useRef(true);
	const listHeightRef = useRef(0);
	const onListScroll = (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
		const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
		atBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
	};
	const onListLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
		const height = e.nativeEvent.layout.height;
		const shrank = height < listHeightRef.current;
		listHeightRef.current = height;
		if (shrank && atBottomRef.current) {
			listRef.current?.scrollToEnd({ animated: false });
		}
	};
	const messageCount = chat?.messages.length ?? 0;
	useEffect(() => {
		if (messageCount > 0 && Date.now() >= pinUntilRef.current) {
			const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [messageCount, activeId]);

	const submit = () => {
		const text = input;
		setInput('');
		actions.sendText(text);
	};

	/**
	 * 画像添付（+ボタン）。フォトライブラリから選び、PCへアップロードして保存先の
	 * フルパスを入力欄へ挿入する（エージェントCLIはプロンプト内のパスから画像を読める）。
	 */
	const [uploading, setUploading] = useState(false);
	const attachImage = async () => {
		if (uploading) {
			return;
		}
		const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 });
		const asset = result.assets?.[0];
		if (result.canceled || !asset?.base64) {
			return;
		}
		setUploading(true);
		try {
			const name = asset.fileName ?? 'photo.jpg';
			const { path } = await fsUpload(name, asset.base64);
			setInput(prev => prev.length > 0 ? prev + ' ' + path + ' ' : path + ' ');
		} catch (err) {
			console.warn('[agent] image upload failed', err);
		} finally {
			setUploading(false);
		}
	};

	return (
		<ConnectionGate>
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
			{/* 独自ヘッダー: 戻る（Liquid Glass）＋ターミナルタイトル＋ワークスペース */}
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
			</View>

			<View style={styles.chatArea}>
				{activeId === undefined ? (
					<Text style={styles.placeholder}>ターミナルがありません。ターミナルタブから作成し、claude / codex を起動してください。</Text>
				) : chat === undefined ? (
					<Text style={styles.placeholder}>読み込み中…</Text>
				) : chat.none ? (
					<View style={styles.noneBox}>
						<Text style={styles.placeholder}>
							このターミナルのエージェントセッションが見つかりません。{'\n\n'}
							claude / codex をこのターミナルで起動（または一度発言）すると表示されます。
							生の画面はターミナルタブで確認できます。
						</Text>
						<Pressable style={styles.retryBtn} onPress={() => { hapticImpact('light'); refreshAgent(activeId); }}>
							<Ionicons name="refresh" size={14} color={colors.text} />
							<Text style={styles.retryText}>再試行</Text>
						</Pressable>
					</View>
				) : (
					<FlatList
						ref={listRef}
						data={rows}
						keyExtractor={row => row.type === 'group' || row.type === 'questionGroup' ? `${chat.epoch}:${row.key}` : `${chat.epoch}:${row.m.rev}`}
						ListHeaderComponent={chat.truncated ? <Text style={styles.truncatedNote}>（古い履歴は省略されています）</Text> : null}
						ListFooterComponent={activeTerminal?.agentStatus === 'working' ? <WorkingIndicator /> : null}
						renderItem={({ item }) =>
							item.type === 'msg' ? <MessageBubble message={item.m} />
								: item.type === 'question' ? <QuestionCard message={item.m} answered={item.answered} onAnswer={actions.answerQuestion} onToggle={actions.toggleQuestionOption} onConfirm={actions.confirmQuestion} onFreeText={actions.answerQuestionFreeText} />
									: item.type === 'questionGroup' ? <QuestionGroupCard messages={item.msgs} answered={item.answered} onSubmit={actions.answerQuestionGroup} />
										: <ActivityGroup msgs={item.msgs} />}
						contentContainerStyle={styles.listContent}
						onContentSizeChange={onContentSizeChange}
						onScroll={onListScroll}
						scrollEventThrottle={32}
						onLayout={onListLayout}
					/>
				)}
			</View>

			{permissionPending && activeId !== undefined ? (
				<View style={styles.approvalBarWrap}>
					<ApprovalCard onApprove={actions.approve} detail={findLatestApprovalRequest(chat)} />
				</View>
			) : null}

			<View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 8 : insets.bottom + 12 }]}>
				<GlassComposer
					value={input}
					onChangeText={setInput}
					onSubmit={submit}
					placeholder="エージェントへメッセージ…"
					sendDisabled={input.trim().length === 0}
					tools={
						<>
							<Pressable style={styles.attachBtn} onPress={() => { hapticImpact('light'); void attachImage(); }} disabled={uploading} accessibilityLabel="画像を添付">
								<Ionicons name={uploading ? 'hourglass-outline' : 'add'} size={20} color={colors.text} />
							</Pressable>
							<ModelPill
								agent={chat !== undefined && !chat.none ? chat.agent : undefined}
								model={chat?.info?.model}
								effort={chat?.info?.effort}
								onCommand={actions.sendText}
							/>
						</>
					}
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
	| { type: 'group'; key: string; msgs: AgentChatMessage[] };

/** アクティビティ群の要約文（例: `思考 ×2 ・ ツール5件 (Bash, Read) ・ 48秒`）。 */
function summarizeActivity(msgs: readonly AgentChatMessage[]): string {
	const thinking = msgs.filter(m => m.kind === 'thinking').length;
	const tools = msgs.filter(m => m.kind === 'tool_use');
	const names: string[] = [];
	for (const t of tools) {
		if (t.tool && !names.includes(t.tool)) {
			names.push(t.tool);
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

function MessageBubble({ message }: { message: AgentChatMessage }) {
	if (message.kind === 'tool_use') {
		return (
			<View style={styles.toolRow}>
				<Ionicons name="construct-outline" size={12} color={colors.textDim} />
				<Text style={styles.toolText} numberOfLines={3}>{message.tool === 'approval_request' ? '許可要求' : message.tool}: {message.text}</Text>
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
function WorkingIndicator() {
	const pulse = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const loop = Animated.loop(Animated.sequence([
			Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
			Animated.timing(pulse, { toValue: 0, duration: 600, useNativeDriver: true }),
		]));
		loop.start();
		return () => loop.stop();
	}, [pulse]);
	const dot = (delay: number) => (
		<Animated.View
			style={[styles.workingDot, {
				opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: delay === 0 ? [0.9, 0.25] : delay === 1 ? [0.6, 0.5] : [0.25, 0.9] }),
			}]}
		/>
	);
	return (
		<View style={styles.workingRow}>
			{dot(0)}{dot(1)}{dot(2)}
			<Text style={styles.workingText}>考え中…</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 },
	backBtn: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
	headerBody: { flex: 1, minWidth: 0 },
	headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
	headerSub: { color: colors.textDim, fontSize: 11, marginTop: 1, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
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
	toolRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4 },
	toolText: { color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1, lineHeight: 15 },
	approvalBarWrap: { marginHorizontal: 12, marginTop: 8 },
	workingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, paddingVertical: 10 },
	workingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
	workingText: { color: colors.textDim, fontSize: 12, marginLeft: 4 },
	inputBar: { paddingHorizontal: 12, paddingTop: 10 },
	attachBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
});

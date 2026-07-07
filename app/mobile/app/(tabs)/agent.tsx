// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting, type AgentChatMessage } from '../../src/store.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { MarkdownText } from '../../src/components/markdownText.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';

/**
 * エージェント画面。PCのターミナルでTUIとして動いているClaude Code / Codexの会話を、
 * transcriptミラー（agentチャネル）でチャット表示する。PC側のTUIはそのまま。
 *
 * 入力・承認応答は既存のtermチャネル（PTY stdin注入）で行う:
 *  - テキスト送信: そのままTUIの入力欄に入り、Enterで確定
 *  - 承認（Claude）: 選択肢番号を送って250ms後にCR（TUIが番号を処理してから確定する必要がある）
 *  - 承認（Codex）: y / d / a のショートカット1文字（Enter不要）
 * 詳細は memory/mobile-agent-gui-research.md の調査結果を参照。
 */
export default function AgentScreen() {
	const ws = useEffectiveWs();
	const { workspace, agentChats, selectedTerminalId, setSelectedTerminalId, attachAgent, detachAgent, refreshAgent, sendInput } = useAppStore(useShallow(s => ({
		workspace: s.workspace, agentChats: s.agentChats,
		selectedTerminalId: s.selectedTerminalId, setSelectedTerminalId: s.setSelectedTerminalId,
		attachAgent: s.attachAgent, detachAgent: s.detachAgent, refreshAgent: s.refreshAgent, sendInput: s.sendInput,
	})));
	const [input, setInput] = useState('');
	const listRef = useRef<FlatList<ChatRow>>(null);

	const terminals = (workspace?.terminals ?? []).filter(t =>
		!ws || t.ws === ws.id || (!t.ws && ws.id === workspace?.activeWs));
	const activeTerminal = (selectedTerminalId !== undefined ? terminals.find(t => t.id === selectedTerminalId) : undefined) ?? terminals[0];
	const activeId = activeTerminal?.id;
	const chat = activeId !== undefined ? agentChats.get(activeId) : undefined;
	const permissionPending = activeTerminal?.agentStatus === 'permission';

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
				result.push({ type: 'question', m, answered: m.toolUseId !== undefined && answeredIds.has(m.toolUseId) });
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

	// 新着で末尾へスクロール
	const messageCount = chat?.messages.length ?? 0;
	useEffect(() => {
		if (messageCount > 0) {
			const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [messageCount, activeId]);

	const send = (data: string) => {
		if (activeId !== undefined) {
			sendInput(activeId, data);
		}
	};
	const submit = () => {
		const text = input;
		setInput('');
		// TUIの入力欄へテキストを入れ、少し置いてからCRで確定する（貼り付け直後の
		// 確定はTUI側の取りこぼしがあるため。承認番号注入と同じ250ms方式）。
		send(text);
		setTimeout(() => send('\r'), 250);
	};

	/**
	 * 質問(AskUserQuestion)への回答。TUIの選択プロンプトは番号キーで選択肢へジャンプするため、
	 * 承認注入と同じ「番号 → 250ms → CR」方式で選んで確定する（複数質問タブは回答すると
	 * 自動で次のタブへ進むので、順に回答すれば最後に Submit される）。
	 */
	const answerQuestion = (optionIndex: number) => {
		if (activeId === undefined) {
			return;
		}
		send(String(optionIndex + 1));
		setTimeout(() => send('\r'), 250);
	};

	/** 承認クイックアクション。Claudeは番号+250ms+CR、Codexはショートカット1文字。 */
	const approve = (choice: 'yes' | 'no') => {
		if (activeId === undefined) {
			return;
		}
		if (chat?.agent === 'codex') {
			send(choice === 'yes' ? 'y' : 'd');
		} else {
			send(choice === 'yes' ? '1' : '3');
			setTimeout(() => send('\r'), 250);
		}
	};

	return (
		<ConnectionGate>
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
			<WsBar />
			<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabContent}>
				{terminals.map((t, i) => {
					const active = t.id === activeId;
					return (
						<Pressable key={t.id} style={[styles.tabChip, active && styles.tabChipActive]} onPress={() => setSelectedTerminalId(t.id)}>
							{isAgentWaiting(t.agentStatus)
								? <View style={styles.dotRed} />
								: t.agentStatus === 'working' ? <View style={styles.dotGreen} /> : null}
							<Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>{i + 1}: {t.title}</Text>
						</Pressable>
					);
				})}
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>

			{chat !== undefined && !chat.none && (chat.agent || chat.info) ? (
				<View style={styles.metaRow}>
					<Ionicons name="hardware-chip-outline" size={11} color={colors.textDim} />
					<Text style={styles.metaText} numberOfLines={1}>
						{[chat.info?.model ?? chat.agent, chat.info?.effort ? `effort: ${chat.info.effort}` : undefined].filter(Boolean).join(' ・ ')}
					</Text>
				</View>
			) : null}

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
						<Pressable style={styles.retryBtn} onPress={() => refreshAgent(activeId)}>
							<Ionicons name="refresh" size={14} color={colors.text} />
							<Text style={styles.retryText}>再試行</Text>
						</Pressable>
					</View>
				) : (
					<FlatList
						ref={listRef}
						data={rows}
						keyExtractor={row => row.type === 'group' ? `${chat.epoch}:${row.key}` : `${chat.epoch}:${row.m.rev}`}
						ListHeaderComponent={chat.truncated ? <Text style={styles.truncatedNote}>（古い履歴は省略されています）</Text> : null}
						ListFooterComponent={activeTerminal?.agentStatus === 'working' ? <WorkingIndicator /> : null}
						renderItem={({ item }) =>
							item.type === 'msg' ? <MessageBubble message={item.m} />
								: item.type === 'question' ? <QuestionCard message={item.m} answered={item.answered} onAnswer={answerQuestion} />
									: <ActivityGroup msgs={item.msgs} />}
						contentContainerStyle={styles.listContent}
					/>
				)}
			</View>

			{permissionPending && activeId !== undefined ? (
				<View style={styles.approvalBar}>
					<Text style={styles.approvalText}>エージェントが確認を求めています</Text>
					<View style={styles.approvalButtons}>
						<Pressable style={[styles.approvalBtn, styles.approveBtn]} onPress={() => approve('yes')}>
							<Text style={styles.approvalBtnText}>許可</Text>
						</Pressable>
						<Pressable style={[styles.approvalBtn, styles.denyBtn]} onPress={() => approve('no')}>
							<Text style={styles.approvalBtnText}>拒否</Text>
						</Pressable>
					</View>
					<Text style={styles.approvalHint}>選択肢が複数ある場合はターミナルタブで確認できます</Text>
				</View>
			) : null}

			<View style={styles.inputBar}>
				<TextInput
					style={styles.input}
					value={input}
					onChangeText={setInput}
					placeholder="エージェントへメッセージ…"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					multiline
				/>
				<Pressable style={[styles.sendBtn, input.trim().length === 0 && styles.sendBtnDisabled]} onPress={submit} disabled={input.trim().length === 0} accessibilityLabel="送信">
					<Ionicons name="arrow-up" size={20} color="#fff" />
				</Pressable>
			</View>
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

/** FlatList の1行。本文はそのまま、アクティビティ（thinking/tool群）は集約行、質問は独立行。 */
type ChatRow =
	| { type: 'msg'; m: AgentChatMessage }
	| { type: 'question'; m: AgentChatMessage; answered: boolean }
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
			<Pressable style={styles.activityRow} onPress={() => setExpanded(e => !e)} accessibilityLabel={expanded ? 'アクティビティを折りたたむ' : 'アクティビティを展開'}>
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

/**
 * 質問カード（Claude Code の AskUserQuestion 等）。選択肢をタップすると番号+Enterを
 * PTYへ注入して回答する。同じ toolUseId の tool_result が届いたら回答済み表示になる。
 */
function QuestionCard({ message, answered, onAnswer }: { message: AgentChatMessage; answered: boolean; onAnswer: (optionIndex: number) => void }) {
	// 二度押し防止のローカル状態（tool_result が届くまでの間）
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const disabled = answered || selected !== undefined;
	return (
		<View style={[styles.questionCard, answered && styles.questionCardAnswered]}>
			<View style={styles.questionHeader}>
				<Ionicons name="help-circle" size={16} color={answered ? colors.textDim : colors.accent2} />
				{message.header ? <Text style={styles.questionChip}>{message.header}</Text> : null}
				{answered ? <Text style={styles.questionAnswered}>回答済み</Text> : null}
			</View>
			<Text style={styles.questionText} selectable>{message.text}</Text>
			{(message.options ?? []).map((option, i) => (
				<Pressable
					key={i}
					style={[styles.questionOption, selected === i && styles.questionOptionSelected, disabled && styles.questionOptionDisabled]}
					disabled={disabled}
					onPress={() => { setSelected(i); onAnswer(i); }}
				>
					<Text style={styles.questionOptionLabel}>{i + 1}. {option.label}</Text>
					{option.description ? <Text style={styles.questionOptionDesc} numberOfLines={3}>{option.description}</Text> : null}
				</Pressable>
			))}
			{!answered && (message.options ?? []).length === 0 ? (
				<Text style={styles.approvalHint}>選択肢を取得できませんでした。ターミナルタブで回答してください</Text>
			) : null}
			{!disabled ? <Text style={styles.approvalHint}>タップで回答（自由入力は下の入力欄から送れます）</Text> : null}
		</View>
	);
}

function MessageBubble({ message }: { message: AgentChatMessage }) {
	if (message.kind === 'tool_use') {
		return (
			<View style={styles.toolRow}>
				<Ionicons name="construct-outline" size={12} color={colors.textDim} />
				<Text style={styles.toolText} numberOfLines={3}>{message.tool}: {message.text}</Text>
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
	tabBar: { flexGrow: 0, flexShrink: 0 },
	tabContent: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' },
	tabChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 200 },
	tabChipActive: { borderColor: colors.accent2, backgroundColor: 'rgba(0,122,204,.16)' },
	tabText: { color: colors.textDim, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	tabTextActive: { color: colors.text },
	dotRed: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
	dotGreen: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
	dim: { color: colors.textDim, fontSize: 12 },
	metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 16, paddingBottom: 6 },
	metaText: { color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	chatArea: { flex: 1, marginHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, overflow: 'hidden' },
	listContent: { padding: 12, gap: 8 },
	placeholder: { color: colors.textDim, fontSize: 13, lineHeight: 20, padding: 16 },
	noneBox: { alignItems: 'flex-start' },
	retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
	retryText: { color: colors.text, fontSize: 12 },
	truncatedNote: { color: colors.textDim, fontSize: 11, textAlign: 'center', paddingBottom: 8 },
	bubble: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, maxWidth: '88%' },
	bubbleUser: { alignSelf: 'flex-end', backgroundColor: 'rgba(0,122,204,.28)' },
	bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: colors.surface },
	bubbleText: { color: colors.text, fontSize: 13, lineHeight: 19 },
	thinkingText: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', lineHeight: 16, paddingHorizontal: 4 },
	activityRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 3 },
	activityText: { color: colors.textDim, fontSize: 11, flex: 1 },
	activityBody: { gap: 6, paddingLeft: 14, paddingTop: 4, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border, marginLeft: 8 },
	toolRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4 },
	toolText: { color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', flex: 1, lineHeight: 15 },
	approvalBar: { marginHorizontal: 12, marginTop: 8, backgroundColor: 'rgba(220,80,80,.12)', borderWidth: 1, borderColor: colors.red, borderRadius: 10, padding: 10, gap: 8 },
	approvalText: { color: colors.text, fontSize: 13, fontWeight: '600' },
	approvalButtons: { flexDirection: 'row', gap: 10 },
	approvalBtn: { flex: 1, borderRadius: 8, paddingVertical: 9, alignItems: 'center' },
	approveBtn: { backgroundColor: colors.accent2 },
	denyBtn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
	approvalBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
	approvalHint: { color: colors.textDim, fontSize: 10 },
	questionCard: { backgroundColor: 'rgba(0,122,204,.10)', borderWidth: 1, borderColor: colors.accent2, borderRadius: 12, padding: 12, gap: 8 },
	questionCardAnswered: { borderColor: colors.border, backgroundColor: colors.surface, opacity: 0.75 },
	questionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
	questionChip: { color: colors.text, fontSize: 11, fontWeight: '600', backgroundColor: colors.panel, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
	questionAnswered: { color: colors.textDim, fontSize: 11, marginLeft: 'auto' },
	questionText: { color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: '600' },
	questionOption: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, gap: 3 },
	questionOptionSelected: { borderColor: colors.accent2, backgroundColor: 'rgba(0,122,204,.20)' },
	questionOptionDisabled: { opacity: 0.6 },
	questionOptionLabel: { color: colors.text, fontSize: 13, fontWeight: '500' },
	questionOptionDesc: { color: colors.textDim, fontSize: 11, lineHeight: 15 },
	workingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, paddingVertical: 10 },
	workingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
	workingText: { color: colors.textDim, fontSize: 12, marginLeft: 4 },
	inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12 },
	input: { flex: 1, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, maxHeight: 120 },
	sendBtn: { backgroundColor: colors.accent2, borderRadius: 10, width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
	sendBtnDisabled: { opacity: 0.4 },
});

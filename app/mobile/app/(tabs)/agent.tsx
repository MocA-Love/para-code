// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import type { AgentChatMessage } from '../../src/store.js';
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
	const listRef = useRef<FlatList<AgentChatMessage>>(null);

	const terminals = (workspace?.terminals ?? []).filter(t =>
		!ws || t.ws === ws.id || (!t.ws && ws.id === workspace?.activeWs));
	const activeTerminal = (selectedTerminalId !== undefined ? terminals.find(t => t.id === selectedTerminalId) : undefined) ?? terminals[0];
	const activeId = activeTerminal?.id;
	const chat = activeId !== undefined ? agentChats.get(activeId) : undefined;
	const permissionPending = activeTerminal?.agentStatus === 'permission';

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
							{t.agentStatus === 'permission'
								? <View style={styles.dotRed} />
								: t.agentStatus === 'working' ? <View style={styles.dotGreen} /> : null}
							<Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>{i + 1}: {t.title}</Text>
						</Pressable>
					);
				})}
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>

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
						data={chat.messages}
						keyExtractor={m => `${chat.epoch}:${m.rev}`}
						ListHeaderComponent={chat.truncated ? <Text style={styles.truncatedNote}>（古い履歴は省略されています）</Text> : null}
						ListFooterComponent={activeTerminal?.agentStatus === 'working' ? <WorkingIndicator /> : null}
						renderItem={({ item }) => <MessageBubble message={item} />}
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
	workingRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4, paddingVertical: 10 },
	workingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent2 },
	workingText: { color: colors.textDim, fontSize: 12, marginLeft: 4 },
	inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12 },
	input: { flex: 1, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, maxHeight: 120 },
	sendBtn: { backgroundColor: colors.accent2, borderRadius: 10, width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
	sendBtnDisabled: { opacity: 0.4 },
});

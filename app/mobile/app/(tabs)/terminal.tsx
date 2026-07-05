// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { stripAnsi } from '../../src/ansi.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { colors } from '../../src/theme.js';

/**
 * ターミナル画面（モックアップ準拠）。選択中ワークスペースのターミナルタブを
 * チップで切り替え、PCの実ターミナルをミラー表示・入力する。応答待ちのタブは
 * 赤ドットで示す。修飾キー行から Esc/Tab/^C/矢印も送れる。
 *
 * 注: 現状は ANSI エスケープを除去したプレーンテキスト表示。カーソル制御や色などの
 * 完全な再現は xterm.js を WebView に載せる対応で置き換える予定（設計書 §5.1）。
 */
export default function TerminalScreen() {
	const ws = useEffectiveWs();
	const { workspace, terminalOutput, selectedTerminalId, setSelectedTerminalId, attachTerminal, detachTerminal, sendInput, createTerminal } = useAppStore(useShallow(s => ({
		workspace: s.workspace, terminalOutput: s.terminalOutput,
		selectedTerminalId: s.selectedTerminalId, setSelectedTerminalId: s.setSelectedTerminalId,
		attachTerminal: s.attachTerminal, detachTerminal: s.detachTerminal, sendInput: s.sendInput, createTerminal: s.createTerminal,
	})));
	const [input, setInput] = useState('');
	const scrollRef = useRef<ScrollView>(null);

	const terminals = (workspace?.terminals ?? []).filter(t => !ws || t.ws === ws.id || !t.ws);
	const activeId = selectedTerminalId !== undefined && terminals.some(t => t.id === selectedTerminalId)
		? selectedTerminalId
		: terminals[0]?.id;
	const output = activeId !== undefined ? stripAnsi(terminalOutput.get(activeId) ?? '') : '';

	useEffect(() => {
		if (activeId === undefined) {
			return;
		}
		attachTerminal(activeId);
		// タブ/ワークスペース切り替え時にPC側の購読を解放する（放置するとPCが全て
		// のターミナルへ出力を送り続けてしまう）。
		return () => detachTerminal(activeId);
	}, [activeId, attachTerminal, detachTerminal]);

	useEffect(() => {
		scrollRef.current?.scrollToEnd({ animated: false });
	}, [output]);

	const send = (data: string) => {
		if (activeId !== undefined) {
			sendInput(activeId, data);
		}
	};
	const submit = () => {
		if (!input) {
			return;
		}
		send(input + '\r');
		setInput('');
	};

	return (
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
				<Pressable style={styles.tabChip} onPress={() => createTerminal(ws?.id)} accessibilityLabel="新しいターミナル">
					<Ionicons name="add" size={16} color={colors.textDim} />
				</Pressable>
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>
			<ScrollView ref={scrollRef} style={styles.output} contentContainerStyle={styles.outputContent}>
				<Text style={styles.outputText} selectable>{output || '(出力なし — PCのターミナルで操作すると内容がミラーされます)'}</Text>
			</ScrollView>
			<View style={styles.keyRow}>
				<Pressable style={styles.key} onPress={() => send('\u001b')}><Text style={styles.keyText}>Esc</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\t')}><Text style={styles.keyText}>Tab</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u0003')}><Text style={styles.keyText}>^C</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[A')}><Text style={styles.keyText}>↑</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[B')}><Text style={styles.keyText}>↓</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('/')}><Text style={styles.keyText}>/</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('|')}><Text style={styles.keyText}>|</Text></Pressable>
			</View>
			<View style={styles.inputBar}>
				<TextInput
					style={styles.input}
					value={input}
					onChangeText={setInput}
					placeholder="コマンドまたは回答を入力…"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					onSubmitEditing={submit}
					blurOnSubmit={false}
				/>
				<Pressable style={styles.sendBtn} onPress={submit} accessibilityLabel="送信">
					<Ionicons name="arrow-up" size={20} color="#fff" />
				</Pressable>
			</View>
		</KeyboardAvoidingView>
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
	output: { flex: 1, backgroundColor: '#1e1e1e', marginHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
	outputContent: { padding: 10 },
	outputText: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 16 },
	keyRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
	key: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
	keyText: { color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	inputBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
	input: { flex: 1, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10 },
	sendBtn: { backgroundColor: colors.accent2, borderRadius: 10, width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
	sendBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

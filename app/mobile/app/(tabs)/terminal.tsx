// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { TermView } from '../../src/components/termView.js';
import { WsBar, useEffectiveWs } from '../../src/components/wsBar.js';
import { ScreenTitle } from '../../src/components/screenTitle.js';
import { useTabBarSpacer } from '../../src/hooks/useTabBarSpacer.js';
import { colors } from '../../src/theme.js';

/**
 * ターミナル画面（モックアップ準拠）。選択中ワークスペースのターミナルタブを
 * チップで切り替え、PCの実ターミナルをミラー表示・入力する。応答待ちのタブは
 * 赤ドットで示す。修飾キー行から Esc/Tab/^C/矢印も送れる。
 *
 * 表示は xterm.js（WebView、termView.tsx）で行い、claude / codex などの TUI も
 * PC と同じ描画になる。cols/rows は PC 側ターミナルと同一に保つ。
 */
export default function TerminalScreen() {
	const ws = useEffectiveWs();
	const { workspace, terminalOutput, selectedTerminalId, setSelectedTerminalId, attachTerminal, detachTerminal, sendInput, createTerminal } = useAppStore(useShallow(s => ({
		workspace: s.workspace, terminalOutput: s.terminalOutput,
		selectedTerminalId: s.selectedTerminalId, setSelectedTerminalId: s.setSelectedTerminalId,
		attachTerminal: s.attachTerminal, detachTerminal: s.detachTerminal, sendInput: s.sendInput, createTerminal: s.createTerminal,
	})));
	const [input, setInput] = useState('');
	const tabBarSpacer = useTabBarSpacer();

	// ws 未タグのターミナルはPC側でアクティブなワークスペース所属として扱う
	// （全ワークスペースに重複表示しない）。
	const terminals = (workspace?.terminals ?? []).filter(t =>
		!ws || t.ws === ws.id || (!t.ws && ws.id === workspace?.activeWs));
	const activeTerminal = (selectedTerminalId !== undefined ? terminals.find(t => t.id === selectedTerminalId) : undefined) ?? terminals[0];
	const activeId = activeTerminal?.id;
	const output = activeId !== undefined ? terminalOutput.get(activeId) ?? '' : '';

	useEffect(() => {
		if (activeId === undefined) {
			return;
		}
		attachTerminal(activeId);
		// タブ/ワークスペース切り替え時にPC側の購読を解放する（放置するとPCが全て
		// のターミナルへ出力を送り続けてしまう）。
		return () => detachTerminal(activeId);
	}, [activeId, attachTerminal, detachTerminal]);

	const send = (data: string) => {
		if (activeId !== undefined) {
			sendInput(activeId, data);
		}
	};
	const submit = () => {
		// 空のまま送信 = Enter 単独（TUIの確認プロンプト等に必要）
		send(input + '\r');
		setInput('');
	};

	return (
		<ConnectionGate>
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
			<ScreenTitle title="ターミナル" />
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
				<Pressable style={styles.tabChip} onPress={() => createTerminal(ws?.id)} accessibilityLabel="新しいターミナル">
					<Ionicons name="add" size={16} color={colors.textDim} />
				</Pressable>
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>
			<View style={styles.output}>
				{activeId !== undefined ? (
					<TermView key={activeId} output={output} cols={activeTerminal?.cols} rows={activeTerminal?.rows} />
				) : (
					<Text style={styles.placeholder}>(ターミナルなし — 右上の + で作成できます)</Text>
				)}
			</View>
			<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.keyBar} contentContainerStyle={styles.keyRow}>
				<Pressable style={styles.key} onPress={() => send('\u001b')}><Text style={styles.keyText}>Esc</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\t')}><Text style={styles.keyText}>Tab</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u0003')}><Text style={styles.keyText}>^C</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[A')}><Text style={styles.keyText}>↑</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[B')}><Text style={styles.keyText}>↓</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[D')}><Text style={styles.keyText}>←</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('\u001b[C')}><Text style={styles.keyText}>→</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('/')}><Text style={styles.keyText}>/</Text></Pressable>
				<Pressable style={styles.key} onPress={() => send('|')}><Text style={styles.keyText}>|</Text></Pressable>
			</ScrollView>
			<View style={[styles.inputBar, { paddingBottom: tabBarSpacer }]}>
				<TextInput
					style={styles.input}
					value={input}
					onChangeText={setInput}
					placeholder="コマンドまたは回答を入力…（空でEnter送信）"
					placeholderTextColor={colors.textDim}
					autoCapitalize="none"
					autoCorrect={false}
					onSubmitEditing={submit}
					blurOnSubmit={false}
				/>
				<Pressable style={styles.sendBtn} onPress={submit} accessibilityLabel="送信">
					<Ionicons name={input ? 'arrow-up' : 'return-down-back'} size={20} color="#fff" />
				</Pressable>
			</View>
		</KeyboardAvoidingView>
		</ConnectionGate>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	tabBar: { flexGrow: 0, flexShrink: 0 },
	tabContent: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' },
	tabChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 200 },
	tabChipActive: { borderColor: colors.accent2, backgroundColor: 'rgba(9,175,217,.16)' },
	tabText: { color: colors.textDim, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	tabTextActive: { color: colors.text },
	dotRed: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
	dotGreen: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
	dim: { color: colors.textDim, fontSize: 12 },
	output: { flex: 1, backgroundColor: '#1e1e1e', marginHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
	placeholder: { color: colors.textDim, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, padding: 10 },
	keyBar: { flexGrow: 0, flexShrink: 0 },
	keyRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
	key: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
	keyText: { color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	inputBar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
	input: { flex: 1, backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10 },
	sendBtn: { backgroundColor: colors.accent2, borderRadius: 10, width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
	sendBtnText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});

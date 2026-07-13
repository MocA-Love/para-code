// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../src/appState.js';
import { isAgentWaiting } from '../../src/store.js';
import { ConnectionGate } from '../../src/components/connectionGate.js';
import { TermView } from '../../src/components/termView.js';
import { WsHeader, useEffectiveWs } from '../../src/components/wsDrawer.js';
import { GlassComposer } from '../../src/components/glassComposer.js';
import { useKeyboardVisible } from '../../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../../src/hooks/useStableInsets.js';
import { colors } from '../../src/theme.js';
import { hapticImpact, hapticSelection, hapticWarning } from '../../src/haptics.js';

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
	const { workspace, terminalOutput, selectedTerminalId, setSelectedTerminalId, attachTerminal, detachTerminal, subscribeTerminal, sendInput, sendArrowKey, sendTextInput, createTerminal } = useAppStore(useShallow(s => ({
		workspace: s.workspace, terminalOutput: s.terminalOutput,
		selectedTerminalId: s.selectedTerminalId, setSelectedTerminalId: s.setSelectedTerminalId,
		attachTerminal: s.attachTerminal, detachTerminal: s.detachTerminal, subscribeTerminal: s.subscribeTerminal, sendInput: s.sendInput,
		sendArrowKey: s.sendArrowKey, sendTextInput: s.sendTextInput, createTerminal: s.createTerminal,
	})));
	const [input, setInput] = useState('');
	const insets = useStableInsets();
	const keyboardVisible = useKeyboardVisible();
	const isFocused = useIsFocused();

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

	// TermView への同期ストリーム購読口（端末ごとに安定した関数を渡す）。
	const subscribeActive = useMemo(() => {
		if (activeId === undefined) {
			return undefined;
		}
		return (listener: Parameters<typeof subscribeTerminal>[1]) => subscribeTerminal(activeId, listener);
	}, [activeId, subscribeTerminal]);
	// WebViewプロセス死・inject欠落時の再同期: 再attach（新epoch）でsnapshotを取り直す。
	const resyncActive = useMemo(() => {
		if (activeId === undefined) {
			return undefined;
		}
		return () => attachTerminal(activeId);
	}, [activeId, attachTerminal]);

	const send = (data: string) => {
		if (activeId !== undefined) {
			sendInput(activeId, data);
		}
	};
	const sendArrow = (key: 'up' | 'down' | 'right' | 'left') => {
		if (activeId !== undefined) {
			sendArrowKey(activeId, key);
		}
	};
	const submit = () => {
		if (activeId === undefined) {
			return;
		}
		if (input === '') {
			// 空のまま送信 = Enter 単独（TUIの確認プロンプト等に必要）。bracketed paste で
			// 包むと空ペーストになってしまうため生のEnterを送る。
			sendInput(activeId, '\r');
		} else {
			// テキストはPC側でbracketed paste対応の上で実行される（複数行対応）。
			sendTextInput(activeId, input, true);
		}
		setInput('');
	};

	return (
		<ConnectionGate>
		{/* enabled={isFocused}: NativeTabsの画面凍結中に keyboardWillHide を取り逃すと
		    下パディングが張り付き、復帰時にUIが上へ潰れる（非フォーカスで無効化→復帰時に
		    クリーンな状態から再計算させる） */}
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90} enabled={isFocused}>
			<WsHeader title="ターミナル" />
			<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar} contentContainerStyle={styles.tabContent}>
				{terminals.map((t, i) => {
					const active = t.id === activeId;
					return (
						<Pressable key={t.id} style={({ pressed }) => [styles.tabChip, active && styles.tabChipActive, pressed && styles.keyPressed]} onPress={() => { hapticSelection(); setSelectedTerminalId(t.id); }}>
							{isAgentWaiting(t.agentStatus)
								? <View style={styles.dotRed} />
								: t.agentStatus === 'working' ? <View style={styles.dotGreen} /> : null}
							<Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>{i + 1}: {t.title}</Text>
						</Pressable>
					);
				})}
				<Pressable style={({ pressed }) => [styles.tabChip, pressed && styles.keyPressed]} onPress={() => { hapticSelection(); createTerminal(ws?.id); }} accessibilityLabel="新しいターミナル">
					<Ionicons name="add" size={16} color={colors.textDim} />
				</Pressable>
				{terminals.length === 0 ? <Text style={styles.dim}>このワークスペースにターミナルはありません</Text> : null}
			</ScrollView>
			<View style={styles.output}>
				{activeId !== undefined ? (
					<TermView key={activeId} output={output} cols={activeTerminal?.cols} rows={activeTerminal?.rows} subscribe={subscribeActive} onNeedResync={resyncActive} />
				) : (
					<Text style={styles.placeholder}>(ターミナルなし — 右上の + で作成できます)</Text>
				)}
			</View>
			<View style={[styles.inputBar, { paddingBottom: keyboardVisible ? 8 : insets.bottom + 30 }]}>
				<GlassComposer
					value={input}
					onChangeText={setInput}
					onSubmit={submit}
					placeholder="コマンドまたは回答を入力…"
					sendIcon={input ? 'arrow-up' : 'return-down-back'}
					monospace
					tools={
						<ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.keyRowScroll} contentContainerStyle={styles.keyRow} keyboardShouldPersistTaps="always">
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\u001b'); }}><Text style={styles.keyText}>Esc</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('\t'); }}><Text style={styles.keyText}>Tab</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticWarning(); send('\u0003'); }}><Text style={[styles.keyText, styles.keyDanger]}>^C</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('up'); }}><Text style={styles.keyText}>↑</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('down'); }}><Text style={styles.keyText}>↓</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('left'); }}><Text style={styles.keyText}>←</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); sendArrow('right'); }}><Text style={styles.keyText}>→</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('/'); }}><Text style={styles.keyText}>/</Text></Pressable>
							<Pressable style={({ pressed }) => [styles.key, pressed && styles.keyPressed]} onPress={() => { hapticImpact('light'); send('|'); }}><Text style={styles.keyText}>|</Text></Pressable>
						</ScrollView>
					}
				/>
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
	keyRowScroll: { flex: 1, minWidth: 0 },
	keyRow: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingRight: 8 },
	key: { backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 8 },
	keyPressed: { backgroundColor: colors.accentWash, borderColor: colors.accent },
	keyText: { color: colors.text, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	keyDanger: { color: colors.red },
	inputBar: { paddingHorizontal: 12, paddingTop: 10 },
});

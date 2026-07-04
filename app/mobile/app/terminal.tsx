// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppStore } from '../src/appState.js';
import { stripAnsi } from '../src/ansi.js';

/**
 * ターミナル画面。PCの実ターミナルにアタッチして出力をミラー表示し、入力を送る。
 *
 * 注: 現状は ANSI エスケープを除去したプレーンテキスト表示。カーソル制御や色などの
 * 完全な再現は xterm.js を WebView に載せる対応で置き換える予定（設計書 §5.1）。
 */
export default function TerminalScreen() {
	const params = useLocalSearchParams<{ id: string; title?: string }>();
	const id = Number(params.id);
	const { attachTerminal, sendInput, output } = useAppStore(s => ({
		attachTerminal: s.attachTerminal,
		sendInput: s.sendInput,
		output: s.terminalOutput.get(id) ?? '',
	}));
	const [input, setInput] = useState('');
	const scrollRef = useRef<ScrollView>(null);

	useEffect(() => {
		attachTerminal(id);
	}, [attachTerminal, id]);

	const submit = () => {
		// 改行付きで実行（入力＋Enter）。
		sendInput(id, input + '\r');
		setInput('');
	};

	const sendKey = (data: string) => sendInput(id, data);

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
			<ScrollView
				ref={scrollRef}
				style={styles.term}
				contentContainerStyle={styles.termContent}
				onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
			>
				<Text style={styles.termText} selectable>{stripAnsi(output)}</Text>
			</ScrollView>

			<View style={styles.keysRow}>
				{(['Esc', 'Tab', '^C', '↑', '↓'] as const).map(k => (
					<Pressable key={k} style={styles.key} onPress={() => sendKey(keyToBytes(k))}><Text style={styles.keyText}>{k}</Text></Pressable>
				))}
			</View>

			<View style={styles.inputRow}>
				<TextInput
					style={styles.input}
					value={input}
					onChangeText={setInput}
					onSubmitEditing={submit}
					placeholder="コマンドを入力…"
					placeholderTextColor="#8b8b8b"
					autoCapitalize="none"
					autoCorrect={false}
					returnKeyType="send"
				/>
				<Pressable style={styles.sendBtn} onPress={submit}><Text style={styles.sendBtnText}>↑</Text></Pressable>
			</View>
		</KeyboardAvoidingView>
	);
}

function keyToBytes(key: string): string {
	switch (key) {
		case 'Esc': return '\x1b';
		case 'Tab': return '\t';
		case '^C': return '\x03';
		case '↑': return '\x1b[A';
		case '↓': return '\x1b[B';
		default: return '';
	}
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#181818' },
	term: { flex: 1 },
	termContent: { padding: 12 },
	termText: { color: '#cccccc', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 },
	keysRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
	key: { backgroundColor: '#2d2d30', borderRadius: 7, borderWidth: 1, borderColor: '#3c3c3c', paddingHorizontal: 11, paddingVertical: 6 },
	keyText: { color: '#cccccc', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
	inputRow: { flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 24, backgroundColor: '#1e1e1e' },
	input: { flex: 1, backgroundColor: '#252526', borderRadius: 10, borderWidth: 1, borderColor: '#3c3c3c', color: '#cccccc', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 14, paddingHorizontal: 12, paddingVertical: 10 },
	sendBtn: { width: 44, backgroundColor: '#007acc', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	sendBtnText: { color: '#fff', fontSize: 16 },
});

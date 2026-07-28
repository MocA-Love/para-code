// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useAppStore } from '../appState.js';
import type { AgentChatMessage } from '../store.js';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * タイムラインのステップを開いたときに出す「入力／結果」の枠。
 *
 * - 既定は折り返さず横スクロール（表・スタックトレース・ログの桁を保つ）
 * - 縦は上限を決めて枠内スクロール（会話本文の流れを押し流さない）
 * - PC側で切り詰められている場合だけ、下端から全文をオンデマンド取得する
 */

/**
 * PC側で切り詰められた本文の全文取り寄せ。展開したときだけ通信するので、
 * 常時全文を送るより転送量が小さい（PC側は rev 単位で全文を退避している）。
 */
export function useFullText(message: AgentChatMessage, terminalKey: string | undefined) {
	const requestFull = useAppStore(state => state.requestAgentToolFullText);
	const [full, setFull] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const load = () => {
		if (terminalKey === undefined || loading || full !== undefined) {
			return;
		}
		hapticSelection();
		setLoading(true);
		setError(undefined);
		requestFull(terminalKey, message.rev)
			.then(text => setFull(text))
			.catch((err: Error) => setError(err.message))
			.finally(() => setLoading(false));
	};
	return { full, loading, error, load, available: terminalKey !== undefined };
}

/**
 * 枠を持たない本文（thinking など）。切り詰められていれば下に「全文を表示」を出し、
 * 取得できたら本文をそのまま差し替える。
 */
export function ExpandableText({ message, terminalKey, style }: { message: AgentChatMessage; terminalKey?: string; style?: StyleProp<TextStyle> }) {
	const { full, loading, error, load, available } = useFullText(message, terminalKey);
	return (
		<View>
			<Text style={style} selectable>{full ?? message.text}</Text>
			{message.truncated === true && full === undefined ? (
				<Pressable onPress={load} disabled={!available || loading} accessibilityRole="button" accessibilityLabel="全文を表示">
					<Text style={styles.plainNote}>
						{loading ? '全文を取得しています…' : error ?? (available ? '全文を表示' : 'PCに接続すると全文を表示できます')}
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}

export function IOBlock({ label, message, terminalKey, lines, text }: { label: string; message: AgentChatMessage; terminalKey?: string; lines?: boolean; text?: string }) {
	const [wrap, setWrap] = useState(false);
	const [copied, setCopied] = useState(false);
	const { full, loading, error, load, available } = useFullText(message, terminalKey);
	// text 指定は「入力JSONから抜き出したコマンド本文」など、表示だけ差し替えたい場合に使う。
	// 全文取得後は取得結果（＝元の生テキスト）へ切り替える。
	const body = (full ?? text ?? message.text).replace(/\n+$/, '');
	const lineCount = body.length === 0 ? 0 : body.split('\n').length;
	const copy = () => {
		hapticSelection();
		void Clipboard.setStringAsync(body).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}).catch(() => { /* コピー不可の環境では黙って何もしない */ });
	};
	return (
		<View style={styles.io}>
			<View style={styles.ioBar}>
				<Text style={styles.ioLabel} numberOfLines={1}>{lines === true && lineCount > 0 ? `${label} · ${lineCount}行` : label}</Text>
				<Pressable
					onPress={() => { hapticSelection(); setWrap(value => !value); }}
					accessibilityRole="button"
					accessibilityLabel={wrap ? '折り返しを解除' : '折り返して表示'}
					style={styles.ioAction}
				>
					<Text style={[styles.ioActionText, wrap ? styles.ioActionOn : null]}>折り返し</Text>
				</Pressable>
				<Pressable onPress={copy} accessibilityRole="button" accessibilityLabel="内容をコピー" style={styles.ioAction}>
					<Text style={[styles.ioActionText, copied ? styles.ioActionDone : null]}>{copied ? 'コピー済' : 'コピー'}</Text>
				</Pressable>
			</View>
			<ScrollView style={styles.ioScroll} nestedScrollEnabled contentContainerStyle={styles.ioScrollContent}>
				{wrap
					? <Text style={[styles.ioText, styles.ioWrapText]} selectable>{body}</Text>
					: (
						<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ioWide}>
							<Text style={styles.ioText} selectable>{body}</Text>
						</ScrollView>
					)}
			</ScrollView>
			{message.truncated === true && full === undefined ? (
				<Pressable style={styles.ioFoot} onPress={load} disabled={!available || loading} accessibilityRole="button" accessibilityLabel="全文を表示">
					<Text style={styles.ioFootText}>{loading ? '全文を取得しています…' : error ?? 'PC側で切り詰め済み'}</Text>
					{error === undefined && !loading ? <Text style={styles.fullLink}>{available ? '全文を表示' : 'PCに接続が必要'}</Text> : null}
				</Pressable>
			) : null}
		</View>
	);
}

export const ioStyles = StyleSheet.create({
	/** ツール別ボディで共有する余白・区切りの基本形。 */
	body: { paddingBottom: 11, gap: 7 },
	card: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 8 },
	cardIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: colors.accentWash, alignItems: 'center', justifyContent: 'center' },
	cardBody: { flex: 1, minWidth: 0 },
	cardTitle: { color: colors.text, fontSize: 12, fontWeight: '600' },
	cardSub: { color: colors.textDim, fontSize: 9.5, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	statRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	stat: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface2, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, color: colors.textDim, fontSize: 9.5, fontWeight: '700', overflow: 'hidden' },
	statAdd: { color: colors.green, borderColor: 'rgba(79,209,165,0.30)', backgroundColor: 'rgba(79,209,165,0.10)' },
	statDel: { color: colors.red, borderColor: 'rgba(244,114,114,0.30)', backgroundColor: 'rgba(244,114,114,0.10)' },
	list: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface, overflow: 'hidden' },
	listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	listRowFirst: { borderTopWidth: 0 },
	listText: { flex: 1, minWidth: 0, color: '#c9d1d9', fontSize: 10, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	listMeta: { color: colors.textDim, fontSize: 9.5 },
	listMore: { paddingHorizontal: 9, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, color: colors.textDim, fontSize: 10.5, textAlign: 'center' },
});

const styles = StyleSheet.create({
	io: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 10, overflow: 'hidden', backgroundColor: '#161b22' },
	ioBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.035)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	ioLabel: { flex: 1, color: colors.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase' },
	ioAction: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
	ioActionText: { color: colors.textDim, fontSize: 10 },
	ioActionOn: { color: colors.accent },
	ioActionDone: { color: colors.green },
	ioScroll: { maxHeight: 200 },
	ioScrollContent: { paddingVertical: 8 },
	ioWide: { paddingHorizontal: 10 },
	ioText: { color: '#c9d1d9', fontSize: 11, lineHeight: 16, fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },
	ioWrapText: { paddingHorizontal: 10 },
	ioFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 9, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: 'rgba(255,255,255,0.02)' },
	ioFootText: { color: colors.textDim, fontSize: 9.5 },
	fullLink: { color: colors.accent, fontSize: 9.5, fontWeight: '700' },
	plainNote: { color: colors.accent, fontSize: 11, fontStyle: 'italic', paddingLeft: 12, paddingTop: 4 },
});

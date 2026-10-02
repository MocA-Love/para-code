// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { useAppStore } from '../appState.js';
import type { AgentChatMessage } from '../store.js';
import { HIT_SIZE, alpha, colors, radius, squircle, tint, type } from '../theme.js';
import { hitSlopToMinimum } from './hitSlop.js';
import { monoFamily } from '../monoFont.js';
import { haptic } from '../haptics.js';
import { clipForDisplay } from './agentIoClip.js';
import { scaleChatSize } from '../chatTextScale.js';
import { useChatStyles, useChatTextScale } from '../ui/chatTextScale.js';
import { useThemeColors } from '../ui/themeColorsStore.js';
import { isClipboardAvailable, writeClipboardText } from '../nativeClipboard.js';

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
		haptic('move');
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
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	// 文字を小さくしても当たり判定が 44pt を割らないよう、見た目の高さにも同じ割合をかけて広げる。
	const plainNoteHitSlop = hitSlopToMinimum(scaleChatSize(PLAIN_NOTE_HEIGHT, useChatTextScale()));
	const plainNote = [styles.plainNote, { color: theme.accent }];
	const clipped = clipForDisplay(full ?? message.text);
	return (
		<View>
			<Text style={style} selectable>{clipped.text}</Text>
			{clipped.omittedLines > 0 ? <Text style={plainNote}>ほか {clipped.omittedLines} 行を省略しています</Text> : null}
			{message.truncated === true && full === undefined ? (
				<Pressable onPress={load} disabled={!available || loading} hitSlop={plainNoteHitSlop} accessibilityRole="button" accessibilityLabel="全文を表示">
					<Text style={plainNote}>
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
	const theme = useThemeColors();
	const styles = useChatStyles(baseStyles);
	// text 指定は「入力JSONから抜き出したコマンド本文」など、表示だけ差し替えたい場合に使う。
	// 全文取得後は取得結果（＝元の生テキスト）へ切り替える。
	const body = (full ?? text ?? message.text).replace(/\n+$/, '');
	const lineCount = body.length === 0 ? 0 : body.split('\n').length;
	// クリップボードのネイティブ部品が無いビルドではコピーのボタンを出さない（nativeClipboard.ts）。
	const canCopy = isClipboardAvailable();
	const copy = () => {
		void writeClipboardText(body).then(copied => {
			haptic(copied ? 'success' : 'error');
			if (copied) {
				setCopied(true);
				setTimeout(() => setCopied(false), 1200);
			}
		});
	};
	// 表示は上限ぶんだけ測らせる（Yogaの測定コストは全文サイズに比例する）。コピーは全文。
	const { text: displayBody, omittedLines } = clipForDisplay(body);
	return (
		<View style={styles.io}>
			<View style={styles.ioBar}>
				<Text style={styles.ioLabel} numberOfLines={1}>{lines === true && lineCount > 0 ? `${label} · ${lineCount}行` : label}</Text>
				<Pressable
					onPress={() => { haptic('tick'); setWrap(value => !value); }}
					accessibilityRole="button"
					accessibilityLabel={wrap ? '折り返しを解除' : '折り返して表示'}
					style={styles.ioAction}
					hitSlop={IO_ACTION_HIT_SLOP}
				>
					<Text style={[styles.ioActionText, wrap ? { color: theme.accent } : null]}>折り返し</Text>
				</Pressable>
				{canCopy ? (
					<Pressable onPress={copy} accessibilityRole="button" accessibilityLabel="内容をコピー" style={styles.ioAction} hitSlop={IO_ACTION_HIT_SLOP}>
						<Text style={[styles.ioActionText, copied ? styles.ioActionDone : null]}>{copied ? 'コピー済' : 'コピー'}</Text>
					</Pressable>
				) : null}
			</View>
			<ScrollView style={styles.ioScroll} nestedScrollEnabled contentContainerStyle={styles.ioScrollContent}>
				{wrap
					? <Text style={[styles.ioText, styles.ioWrapText]} selectable>{displayBody}</Text>
					: (
						<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.ioWide}>
							<Text style={styles.ioText} selectable>{displayBody}</Text>
						</ScrollView>
					)}
			</ScrollView>
			{omittedLines > 0 ? <Text style={styles.ioFootText}>ほか {omittedLines} 行を省略しています（コピーは全体が対象）</Text> : null}
			{message.truncated === true && full === undefined ? (
				<Pressable style={styles.ioFoot} onPress={load} disabled={!available || loading} accessibilityRole="button" accessibilityLabel="全文を表示">
					<Text style={styles.ioFootText}>{loading ? '全文を取得しています…' : error ?? 'PC側で切り詰め済み'}</Text>
					{error === undefined && !loading ? <Text style={[styles.fullLink, { color: theme.accent }]}>{available ? '全文を表示' : 'PCに接続が必要'}</Text> : null}
				</Pressable>
			) : null}
		</View>
	);
}

/**
 * 枠の見出し行の小さな操作（「折り返し」「コピー」）の見た目の高さ。見出し行の高さを変えずに、
 * 当たり判定だけを広げる（横に並ぶ操作どうしで判定が重ならないよう、左右は広げない）。
 * 下へは広げない。すぐ下は本文（コードや出力）で、そこを選択・スクロールしようとした指を
 * 「コピー」「折り返し」が拾ってしまうため。
 */
const IO_ACTION_HEIGHT = 20;
const IO_ACTION_HIT_SLOP = { ...hitSlopToMinimum(IO_ACTION_HEIGHT), bottom: 0 };
/** 枠を持たない本文の「全文を表示」の見た目の高さ（文字1行＋上余白。会話の文字サイズが 100% のとき）。 */
const PLAIN_NOTE_HEIGHT = 20;

/** ツール別ボディの共通の見た目。会話の中では `useChatStyles(ioStyles)` で文字サイズの設定をかけて使う。 */
export const ioStyles = StyleSheet.create({
	/** ツール別ボディで共有する余白・区切りの基本形。 */
	body: { paddingBottom: 11, gap: 7 },
	card: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control, ...squircle, paddingHorizontal: 10, paddingVertical: 8 },
	cardIcon: { width: 28, height: 28, borderRadius: radius.control, ...squircle, backgroundColor: colors.accentWash, alignItems: 'center', justifyContent: 'center' },
	cardBody: { flex: 1, minWidth: 0 },
	cardTitle: { color: colors.text, fontSize: type.meta, fontWeight: '600' },
	cardSub: { color: colors.textDim, fontSize: type.badge, fontFamily: monoFamily },
	statRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	stat: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface2, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2, color: colors.textDim, fontSize: type.badge, fontWeight: '700', overflow: 'hidden' },
	statAdd: { color: colors.green, borderColor: tint(colors.green, alpha.line), backgroundColor: tint(colors.green, alpha.wash) },
	statDel: { color: colors.red, borderColor: tint(colors.red, alpha.line), backgroundColor: tint(colors.red, alpha.wash) },
	list: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control, ...squircle, backgroundColor: colors.surface, overflow: 'hidden' },
	listRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
	listRowFirst: { borderTopWidth: 0 },
	listText: { flex: 1, minWidth: 0, color: colors.textSoft, fontSize: type.badge, fontFamily: monoFamily },
	listMeta: { color: colors.textDim, fontSize: type.badge },
	listMore: { paddingHorizontal: 9, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, color: colors.textDim, fontSize: type.badge, textAlign: 'center' },
});

const baseStyles = StyleSheet.create({
	io: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.control, ...squircle, overflow: 'hidden', backgroundColor: colors.codeBg },
	ioBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.035)', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
	ioLabel: { flex: 1, color: colors.textDim, fontSize: type.badge, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase' },
	ioAction: { minHeight: IO_ACTION_HEIGHT, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.key, ...squircle, paddingHorizontal: 7, paddingVertical: 2 },
	ioActionText: { color: colors.textDim, fontSize: type.badge },
	ioActionDone: { color: colors.green },
	ioScroll: { maxHeight: 200 },
	ioScrollContent: { paddingVertical: 8 },
	ioWide: { paddingHorizontal: 10 },
	ioText: { color: colors.textSoft, fontSize: type.caption, lineHeight: 16, fontFamily: monoFamily },
	ioWrapText: { paddingHorizontal: 10 },
	ioFoot: { minHeight: HIT_SIZE, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 9, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: 'rgba(255,255,255,0.02)' },
	ioFootText: { color: colors.textDim, fontSize: type.badge },
	fullLink: { color: colors.accent, fontSize: type.badge, fontWeight: '700' },
	plainNote: { color: colors.accent, fontSize: type.caption, fontStyle: 'italic', paddingLeft: 12, paddingTop: 4 },
});

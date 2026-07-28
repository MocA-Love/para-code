// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../src/appState.js';
import { GlassSurface } from '../src/components/glassSurface.js';
import { wsColor } from '../src/components/wsDrawer.js';
import { useKeyboardVisible } from '../src/hooks/useKeyboardVisible.js';
import { useStableInsets } from '../src/hooks/useStableInsets.js';
import { SPACE_NOTE_MAX_LENGTH, parseSpaceNote, spaceNoteSummary, toggleSpaceNoteTask } from '../src/spaceNote.js';
import { colors, mono } from '../src/theme.js';
import { hapticImpact, hapticSelection } from '../src/haptics.js';

/**
 * スペースのメモ（PC版 Workspaces ビュー下部のメモ欄と同じ本文）を読み書きする画面。
 * ドロワーのスペース行のメモボタンから Link.AppleZoom で開く独立ルート
 * （旧spaceNoteSheet.tsxのボトムシートを置き換え。ズーム遷移はヘッダー付き画面と
 * 相性が悪いため、通知一覧と同じく独自ヘッダーを描画する）。
 *
 * - 表示中は `- [ ]` / `- [x]` をチェックボックスとして描き、タップで完了をトグルする
 *   （楽観更新してから noteSet を送り、失敗したら元に戻す）
 * - 「編集」で本文全体を書き換えられる。保存はPC側の storage へ反映され、PCの表示・
 *   一覧の未完了バッジ・他のモバイル端末にも波及する
 * - 確定操作（キャンセル／保存）はヘッダーに置く。キーボードのすぐ上に置くと
 *   フリック入力の指と重なって誤タップするため
 */
export default function SpaceNoteScreen() {
	const router = useRouter();
	const insets = useStableInsets();
	// キーボードが出ている間は KeyboardAvoidingView が下端を押し上げるため、
	// SafeArea ぶんの余白を足すと二重になる（入力欄がキーボードから浮く）。
	const keyboardVisible = useKeyboardVisible();
	const { ws } = useLocalSearchParams<{ ws?: string }>();
	const { workspace, noteGet, noteSet } = useAppStore(useShallow(s => ({ workspace: s.workspace, noteGet: s.noteGet, noteSet: s.noteSet })));
	const entry = (workspace?.workspaces ?? []).find(w => w.id === ws);
	// グループ表示ではPCが旧アプリ互換のために付ける「✦ 」接頭辞を取り除く
	const name = (entry?.name ?? '').replace(/^✦ /, '');
	const color = entry ? wsColor(entry) : colors.accent;

	const [text, setText] = useState('');
	const [draft, setDraft] = useState('');
	const [editing, setEditing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	/** 応答が返る前に画面を離れた場合に、古い応答を捨てるための世代。 */
	const requestGeneration = useRef(0);
	/** 保存の送信順。連打時に先行応答が新しいローカル状態を巻き戻さないよう、最後の送信だけ反映する。 */
	const saveSequence = useRef(0);
	/** 編集中の下書き。戻る／スワイプバックで離脱したときに保存するため ref でも保持する（PC側の blur 保存と揃える）。 */
	const pendingDraft = useRef<string | undefined>(undefined);
	/** アンマウント時の保存判定で最新の本文を読むための控え。 */
	const textRef = useRef('');
	textRef.current = text;

	useEffect(() => {
		if (ws === undefined) {
			setLoading(false);
			return;
		}
		const generation = ++requestGeneration.current;
		setLoading(true);
		noteGet(ws)
			.then(result => {
				if (generation === requestGeneration.current) {
					setText(result.text ?? '');
				}
			})
			.catch(err => {
				if (generation === requestGeneration.current) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (generation === requestGeneration.current) {
					setLoading(false);
				}
			});
	}, [ws, noteGet]);

	// 戻るボタン・スワイプバックのどちらで離れても書きかけを捨てない。
	// 画面が消えた後の送信になるため、store から直接呼ぶ（この時点でこの画面の state は触らない）。
	useEffect(() => () => {
		const draftText = pendingDraft.current;
		if (draftText !== undefined && ws !== undefined && draftText !== textRef.current) {
			void useAppStore.getState().noteSet(ws, draftText).catch(() => undefined);
		}
	}, [ws]);

	const save = useCallback(async (next: string, previous: string) => {
		if (ws === undefined) {
			return;
		}
		const generation = requestGeneration.current;
		const sequence = ++saveSequence.current;
		setBusy(true);
		setError(undefined);
		try {
			const result = await noteSet(ws, next);
			// 後から送った保存が既にあるなら、その結果を待つ（先行応答で巻き戻さない）
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setText(result.text ?? next);
			}
		} catch (err) {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				// 保存できなかったので楽観更新を巻き戻す（チェックが付いたまま残らないように）
				setText(previous);
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setBusy(false);
			}
		}
	}, [ws, noteSet]);

	const toggle = useCallback((lineIndex: number) => {
		const next = toggleSpaceNoteTask(text, lineIndex);
		if (next === undefined) {
			return;
		}
		hapticSelection();
		const previous = text;
		setText(next);
		void save(next, previous);
	}, [text, save]);

	const summary = spaceNoteSummary(text);
	const lines = parseSpaceNote(text);

	const startEditing = () => {
		hapticImpact('light');
		setDraft(text);
		pendingDraft.current = text;
		setEditing(true);
	};

	const cancelEditing = () => {
		hapticImpact('light');
		pendingDraft.current = undefined;
		setEditing(false);
	};

	const commitEditing = () => {
		hapticImpact('light');
		const previous = text;
		pendingDraft.current = undefined;
		setText(draft);
		setEditing(false);
		void save(draft, previous);
	};

	return (
		<View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
			<View style={styles.header}>
				{editing ? (
					<GlassButton label="キャンセル" onPress={cancelEditing} disabled={busy} />
				) : (
					<GlassButton icon="chevron-back" onPress={() => { hapticImpact('light'); router.back(); }} accessibilityLabel="戻る" />
				)}
				<Text style={styles.title}>メモ</Text>
				{editing ? (
					<GlassButton label="保存" onPress={commitEditing} disabled={busy} tint={colors.accent} strong />
				) : (
					<GlassButton label="編集" onPress={startEditing} disabled={loading || ws === undefined} />
				)}
			</View>

			<View style={styles.spaceRow}>
				<View style={[styles.avatar, { backgroundColor: color + '22' }]}>
					<Text style={[styles.avatarText, { color }]}>✦</Text>
				</View>
				<View style={styles.spaceBody}>
					<Text style={styles.spaceName} numberOfLines={1}>{name || 'スペース'}</Text>
					{entry?.branch ? <Text style={styles.spaceBranch} numberOfLines={1}>{entry.branch}</Text> : null}
				</View>
				{summary.open + summary.done > 0 ? (
					<View style={styles.summaryChip}>
						<Ionicons name="checkbox-outline" size={12} color={summary.open > 0 ? colors.accent : colors.textDim} />
						<Text style={[styles.summaryText, summary.open > 0 && styles.summaryTextOpen]}>{summary.open}/{summary.open + summary.done}</Text>
					</View>
				) : null}
			</View>

			{error ? <Text style={styles.error}>{error}</Text> : null}

			<KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
				{loading ? (
					<View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
				) : editing ? (
					<TextInput
						style={[styles.editor, { marginBottom: keyboardVisible ? 14 : insets.bottom + 14 }]}
						value={draft}
						onChangeText={next => { setDraft(next); pendingDraft.current = next; }}
						multiline
						autoFocus
						spellCheck={false}
						autoCorrect={false}
						// PC側と同じ上限。超過分はPC側で切り詰められるため、入力段階で止める
						maxLength={SPACE_NOTE_MAX_LENGTH}
						placeholder={'やることを書けます\n- [ ] のように書くとチェックリストになります'}
						placeholderTextColor={colors.textDim}
					/>
				) : (
					<ScrollView style={styles.flex} contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
						{lines.length === 0 ? (
							<Text style={styles.placeholder}>このスペースのメモはまだありません。「編集」から書き始められます。</Text>
						) : lines.map(line => {
							if (line.kind === 'blank') {
								return <View key={line.index} style={styles.blank} />;
							}
							if (line.kind === 'heading') {
								return <Text key={line.index} style={styles.heading}>{line.text}</Text>;
							}
							if (line.kind === 'text') {
								return <Text key={line.index} style={styles.text}>{line.text}</Text>;
							}
							return (
								<Pressable key={line.index} style={styles.task} onPress={() => toggle(line.index)} accessibilityRole="checkbox" accessibilityState={{ checked: line.done }}>
									<View style={[styles.check, line.done && styles.checkDone]}>
										{line.done ? <Ionicons name="checkmark" size={13} color="#04252c" /> : null}
									</View>
									<Text style={[styles.taskLabel, line.done && styles.taskLabelDone]}>{line.text}</Text>
								</Pressable>
							);
						})}
					</ScrollView>
				)}
			</KeyboardAvoidingView>
		</View>
	);
}

/**
 * ヘッダーの操作ボタン。面はLiquid Glass（非対応環境ではBlurViewへ自動フォールバック）。
 * glassの上にglassを重ねないため（Apple HIG）、この画面ではここ以外にglass面を置かない。
 */
function GlassButton({ label, icon, onPress, disabled, tint, strong, accessibilityLabel }: {
	label?: string;
	icon?: keyof typeof Ionicons.glyphMap;
	onPress: () => void;
	disabled?: boolean;
	/** glassへの色被せ。主要アクション（保存）をアクセント色に染めるために使う。 */
	tint?: string;
	/** 主要アクション。文字を強め、押せることを一目で分かるようにする。 */
	strong?: boolean;
	accessibilityLabel?: string;
}) {
	return (
		<Pressable
			style={[icon !== undefined ? styles.iconBtn : styles.pillBtn, disabled && styles.btnDisabled]}
			onPress={onPress}
			disabled={disabled}
			hitSlop={6}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel ?? label}
		>
			{/* 角丸はガラス面自体に渡す（ネイティブglassが正しい丸形状で描画される） */}
			<GlassSurface style={icon !== undefined ? styles.iconGlass : styles.pillGlass} interactive tintColor={tint} />
			{icon !== undefined
				? <Ionicons name={icon} size={18} color={colors.text} />
				: <Text style={[styles.btnText, strong === true && styles.btnTextStrong]}>{label}</Text>}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	flex: { flex: 1 },
	header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 12 },
	title: { flex: 1, color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
	iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
	iconGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 18, overflow: 'hidden' },
	pillBtn: { height: 36, borderRadius: 18, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center' },
	pillGlass: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 18, overflow: 'hidden' },
	btnText: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
	btnTextStrong: { fontWeight: '800' },
	btnDisabled: { opacity: 0.45 },
	spaceRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 18, paddingBottom: 12 },
	avatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	avatarText: { fontSize: 13, fontWeight: '800', fontFamily: mono.default },
	spaceBody: { flex: 1, minWidth: 0 },
	spaceName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
	spaceBranch: { color: colors.textDim, fontSize: 11, fontFamily: mono.default, marginTop: 2 },
	summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface3, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
	summaryText: { color: colors.textDim, fontSize: 11, fontFamily: mono.default },
	summaryTextOpen: { color: colors.accent },
	error: { color: colors.red, fontSize: 12, paddingHorizontal: 18, paddingBottom: 6 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	bodyContent: { paddingHorizontal: 18 },
	placeholder: { color: colors.textDim, fontSize: 13.5, fontStyle: 'italic', lineHeight: 22 },
	blank: { height: 10 },
	heading: { color: colors.text, fontSize: 14.5, fontWeight: '700', marginTop: 12, marginBottom: 2 },
	text: { color: colors.textDim, fontSize: 13.5, lineHeight: 23 },
	task: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 3 },
	// 未チェックが空白に見えないよう、枠と面のコントラストをPC側と揃える
	check: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginTop: 2 },
	checkDone: { backgroundColor: colors.accent, borderColor: colors.accent },
	taskLabel: { flex: 1, color: colors.text, fontSize: 13.5, lineHeight: 23 },
	taskLabelDone: { color: colors.textDim, textDecorationLine: 'line-through' },
	editor: { flex: 1, marginHorizontal: 14, padding: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, color: colors.text, fontSize: 14, lineHeight: 23, textAlignVertical: 'top' },
});

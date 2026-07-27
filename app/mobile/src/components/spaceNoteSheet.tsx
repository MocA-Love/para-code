// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppStore } from '../appState.js';
import { SPACE_NOTE_MAX_LENGTH, parseSpaceNote, spaceNoteSummary, toggleSpaceNoteTask } from '../spaceNote.js';
import { BottomSheet } from './bottomSheet.js';
import { colors, mono } from '../theme.js';
import { hapticSelection } from '../haptics.js';

/**
 * スペースのメモ（PC版 Workspaces ビュー下部のメモ欄と同じ本文）を読み書きするシート。
 * ドロワーのスペース行のメモボタンから開く。
 *
 * - 表示中は `- [ ]` / `- [x]` をチェックボックスとして描き、タップで完了をトグルする
 *   （楽観更新してから noteSet を送り、失敗したら元に戻す）
 * - 「編集」で本文全体を書き換えられる。保存はPC側の storage へ反映され、PCの表示・
 *   一覧の未完了バッジ・他のモバイル端末にも波及する
 */
export function SpaceNoteSheet({ visible, ws, name, branch, color, onClose }: {
	visible: boolean;
	/** 対象スペースの状態キー（ws.id）。未選択なら undefined。 */
	ws: string | undefined;
	name: string;
	branch?: string;
	color: string;
	onClose: () => void;
}) {
	const noteGet = useAppStore(s => s.noteGet);
	const noteSet = useAppStore(s => s.noteSet);

	const [text, setText] = useState('');
	const [draft, setDraft] = useState('');
	const [editing, setEditing] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	/** 応答が返る前にシートを閉じた／別スペースへ切り替えた場合に、古い応答を捨てるための世代。 */
	const requestGeneration = useRef(0);
	/** 保存の送信順。連打時に先行応答が新しいローカル状態を巻き戻さないよう、最後の送信だけ反映する。 */
	const saveSequence = useRef(0);
	/** 編集中の下書き。シートを閉じるときに保存するため ref でも保持する（PC側の blur 保存と揃える）。 */
	const pendingDraft = useRef<string | undefined>(undefined);

	useEffect(() => {
		if (!visible || ws === undefined) {
			return;
		}
		const generation = ++requestGeneration.current;
		setEditing(false);
		setError(undefined);
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
	}, [visible, ws, noteGet]);

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

	// 背景タップ・戻る・✕のどれで閉じても、書きかけを捨てない（PC側は blur で保存される）。
	const close = () => {
		const draftText = pendingDraft.current;
		if (draftText !== undefined && ws !== undefined && draftText !== text) {
			void save(draftText, text);
		}
		pendingDraft.current = undefined;
		// 閉じた後に届いた応答で state を触らない（保存の送信自体は上で済んでいる）
		requestGeneration.current++;
		setEditing(false);
		onClose();
	};

	return (
		<BottomSheet
			visible={visible}
			onClose={close}
			title="メモ"
			fullHeight
		>
			<View style={styles.head}>
				<View style={[styles.avatar, { backgroundColor: color + '22' }]}>
					<Text style={[styles.avatarText, { color }]}>✦</Text>
				</View>
				<View style={styles.headBody}>
					<Text style={styles.headName} numberOfLines={1}>{name}</Text>
					{branch ? <Text style={styles.headBranch} numberOfLines={1}>{branch}</Text> : null}
				</View>
				{summary.open + summary.done > 0 ? (
					<View style={styles.summaryChip}>
						<Ionicons name="checkbox-outline" size={12} color={summary.open > 0 ? colors.accent : colors.textDim} />
						<Text style={[styles.summaryText, summary.open > 0 && styles.summaryTextOpen]}>{summary.open}/{summary.open + summary.done}</Text>
					</View>
				) : null}
			</View>

			{error ? <Text style={styles.error}>{error}</Text> : null}

			{loading ? (
				<View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
			) : editing ? (
				<TextInput
					style={styles.editor}
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
				<ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
					{lines.length === 0 ? (
						<Text style={styles.placeholder}>このスペースのメモはまだありません。「メモを編集」から書き始められます。</Text>
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

			<View style={styles.bar}>
				{editing ? (
					<>
						<Pressable style={styles.btn} onPress={() => { pendingDraft.current = undefined; setEditing(false); }} disabled={busy}>
							<Text style={styles.btnText}>キャンセル</Text>
						</Pressable>
						<Pressable
							style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
							disabled={busy}
							onPress={() => {
								const previous = text;
								pendingDraft.current = undefined;
								setText(draft);
								setEditing(false);
								void save(draft, previous);
							}}
						>
							<Text style={[styles.btnText, styles.btnPrimaryText]}>保存</Text>
						</Pressable>
					</>
				) : (
					<Pressable
						style={[styles.btn, styles.btnPrimary, (loading || ws === undefined) && styles.btnDisabled]}
						disabled={loading || ws === undefined}
						onPress={() => { setDraft(text); pendingDraft.current = text; setEditing(true); }}
					>
						<Text style={[styles.btnText, styles.btnPrimaryText]}>メモを編集</Text>
					</Pressable>
				)}
			</View>
		</BottomSheet>
	);
}

const styles = StyleSheet.create({
	head: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 18, paddingBottom: 10 },
	avatar: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	avatarText: { fontSize: 13, fontWeight: '800', fontFamily: mono.default },
	headBody: { flex: 1, minWidth: 0 },
	headName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
	headBranch: { color: colors.textDim, fontSize: 11, fontFamily: mono.default, marginTop: 2 },
	summaryChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surface3, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
	summaryText: { color: colors.textDim, fontSize: 11, fontFamily: mono.default },
	summaryTextOpen: { color: colors.accent },
	error: { color: colors.red, fontSize: 12, paddingHorizontal: 18, paddingBottom: 6 },
	center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	body: { flex: 1 },
	bodyContent: { paddingHorizontal: 18, paddingBottom: 16 },
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
	editor: { flex: 1, marginHorizontal: 14, marginBottom: 12, padding: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, color: colors.text, fontSize: 14, lineHeight: 23, textAlignVertical: 'top' },
	bar: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
	btn: { flex: 1, height: 44, borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
	btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
	btnDisabled: { opacity: 0.5 },
	btnText: { color: colors.text, fontSize: 14, fontWeight: '600' },
	btnPrimaryText: { color: '#04252c', fontWeight: '700' },
});

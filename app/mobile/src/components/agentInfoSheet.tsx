// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../appState.js';
import { pinKeyForTerminal } from '../store.js';
import { BottomSheet } from './bottomSheet.js';
import { AgentBadge } from './agentRow.js';
import { appendSpaceNoteEntry, parseSpaceNote, spaceNoteSummary, SPACE_NOTE_MAX_LENGTH, toggleSpaceNoteTask } from '../spaceNote.js';
import { useStableInsets } from '../hooks/useStableInsets.js';
import { colors, mono } from '../theme.js';
import { hapticImpact, hapticSelection, hapticWarning } from '../haptics.js';

/**
 * エージェント詳細画面のヘッダータイトルから開く「エージェント情報」シート（abc.html 案A）。
 * それまで名前の変更はホーム一覧の長押し、メモはドロワーのスペース行からしか到達できず、
 * 会話を読みながらでは手が届かなかった。この1枚に集約する:
 *
 *  - ターミナル名の変更（PCのタブ名にも反映される。ホーム長押しと同じ renameTerminal）
 *  - スペースのメモ（チェックのトグル・項目の追加まで。全文の編集は /space-note へ渡す）
 *  - ピン留め / ターミナル（生画面）/ ブラウザ / アーカイブ / 削除
 *
 * Liquid Glass について: 面は {@link BottomSheet} の `glass` に任せる（iOS 26+ は
 * expo-glass-effect の本物のLiquid Glass、それ未満・Androidは BlurView フォールバック）。
 * Apple HIG の「glassの上にglassを重ねない」に従い、**シート内部の操作要素には
 * GlassSurface を使わない**（不透明な surface2/surface3 で描く）。呼び出し側のヘッダー
 * タイトルも既にブラーの上に載っているため、glassボタンにはしていない。
 *
 * 日本語IME: 名前変更・項目追加の入力欄はどちらも uncontrolled（`value` を渡さない）。
 * PCからの同期pushで再レンダしても未確定文字列へ書き戻さないため、変換途中で確定される
 * 事故が起きない（space-note.tsx / glassComposer.tsx と同じ流儀）。
 */

/** メモのプレビューに出す最大行数（超えたぶんは「ほかN行」にまとめる）。 */
const NOTE_PREVIEW_LINES = 5;

/** シートの閉じアニメーション（bottomSheet.tsx）が終わるまでの待ち時間。 */
const SHEET_CLOSE_MS = 200;

/** ターミナル名の入力上限。PC側のタブ名へそのまま流れるため、常識的な長さで止める。 */
const TERMINAL_NAME_MAX_LENGTH = 120;

export function AgentInfoSheet({ visible, onClose, terminalKey, title, agentStatus, ws, model, effort, onOpenBrowser, onLeaveScreen }: {
	visible: boolean;
	onClose: () => void;
	terminalKey: string;
	title: string;
	agentStatus: string | undefined;
	/** このターミナルが属するスペース（メモの読み書き先）。未解決なら省略。 */
	ws?: { id: string; name: string; branch?: string; color: string };
	model?: string;
	effort?: string;
	onOpenBrowser: () => void;
	/** 削除のように、この画面に留まる意味が無くなったときに呼ばれる。 */
	onLeaveScreen: () => void;
}) {
	const router = useRouter();
	const insets = useStableInsets();
	const { pinnedKeys, archivedKeys, renameTerminal, togglePin, closeTerminal, setArchived, setSelectedWs, setSelectedTerminalKey, noteGet, noteSet } = useAppStore(useShallow(s => ({
		pinnedKeys: s.pinnedKeys, archivedKeys: s.archivedKeys,
		renameTerminal: s.renameTerminal, togglePin: s.togglePin, closeTerminal: s.closeTerminal, setArchived: s.setArchived,
		setSelectedWs: s.setSelectedWs, setSelectedTerminalKey: s.setSelectedTerminalKey, noteGet: s.noteGet, noteSet: s.noteSet,
	})));
	const pinKey = pinKeyForTerminal({ terminalKey });
	const pinned = pinnedKeys.has(pinKey);
	const archived = archivedKeys.has(pinKey);

	// 'main' 以外は同じシートの中身を差し替える（Modalの上にModalを重ねないため）。
	const [mode, setMode] = useState<'main' | 'rename' | 'confirm-delete'>('main');
	const nameDraft = useRef(title);
	useEffect(() => {
		if (visible) {
			setMode('main');
			nameDraft.current = title;
		}
		// title の変化で編集モードを畳まない（PC側からの改名で入力中の下書きが消えないように）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	const wsId = ws?.id;
	const [note, setNote] = useState('');
	const [noteLoading, setNoteLoading] = useState(false);
	/** 保存の応答待ち。飛んでいる保存の上から全文編集へ渡すと、遷移先が古い本文を読むため止める。 */
	const [noteBusy, setNoteBusy] = useState(false);
	const [noteError, setNoteError] = useState<string | undefined>(undefined);
	const [adding, setAdding] = useState(false);
	/** 追記後、閉じるまでプレビューを末尾側に寄せておく（足した項目が視界から消えないように）。 */
	const [tailPreview, setTailPreview] = useState(false);
	const addDraft = useRef('');
	const addInputRef = useRef<TextInput>(null);
	/** シートを閉じた後に届いた応答を捨てるための世代。 */
	const requestGeneration = useRef(0);
	/** 保存の送信順。連打時に先行応答が新しいローカル状態を巻き戻さないよう、最後の送信だけ反映する。 */
	const saveSequence = useRef(0);
	/** 画面から離れた後の保存（下書きの取りこぼし回収）で最新の本文を読むための控え。 */
	const noteRef = useRef(note);
	noteRef.current = note;

	// 開いている間だけ取りに行く（閉じたシートのために毎回同期しない）。
	// 閉じるときに世代を進め、在庫の応答が後から state を触らないようにする。
	useEffect(() => {
		if (!visible || wsId === undefined) {
			return;
		}
		const generation = ++requestGeneration.current;
		setNoteLoading(true);
		// 保存中に閉じると世代がずれて finally が noteBusy を戻せないため、開き直しで必ず戻す
		setNoteBusy(false);
		setNoteError(undefined);
		setAdding(false);
		setTailPreview(false);
		noteGet(wsId)
			.then(result => {
				if (generation === requestGeneration.current) {
					setNote(result.text ?? '');
				}
			})
			.catch(err => {
				if (generation === requestGeneration.current) {
					setNoteError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (generation === requestGeneration.current) {
					setNoteLoading(false);
				}
			});
		return () => { requestGeneration.current++; };
	}, [visible, wsId, noteGet]);

	const saveNote = useCallback(async (next: string, previous: string) => {
		if (wsId === undefined) {
			return;
		}
		const generation = requestGeneration.current;
		const sequence = ++saveSequence.current;
		setNoteBusy(true);
		try {
			const result = await noteSet(wsId, next);
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setNote(result.text ?? next);
			}
		} catch (err) {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				// 保存できなかったので楽観更新を巻き戻す（チェックが付いたまま残らないように）
				setNote(previous);
				setNoteError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (generation === requestGeneration.current && sequence === saveSequence.current) {
				setNoteBusy(false);
			}
		}
	}, [wsId, noteSet]);

	const toggleTask = (lineIndex: number) => {
		const next = toggleSpaceNoteTask(note, lineIndex);
		if (next === undefined) {
			return;
		}
		hapticSelection();
		const previous = note;
		setNote(next);
		void saveNote(next, previous);
	};

	/**
	 * 追加行の内容を1件として確定する。入力欄は空にして残すので、続けて何件でも書ける
	 * （space-note.tsx の一覧末尾の追加行と同じ挙動）。
	 */
	const commitAdd = useCallback((close = false) => {
		const next = appendSpaceNoteEntry(note, addDraft.current, 'task');
		if (next === undefined) {
			setAdding(false);
			return;
		}
		if (next.length > SPACE_NOTE_MAX_LENGTH) {
			setNoteError('メモが上限に達しているため追加できません。');
			return;
		}
		hapticSelection();
		setNoteError(undefined);
		const previous = note;
		setNote(next);
		// 追記は末尾に入る。入力欄を閉じた後もプレビューを末尾側に保ち、足した項目を見せ続ける
		setTailPreview(true);
		addDraft.current = '';
		addInputRef.current?.clear();
		if (close) {
			setAdding(false);
		}
		void saveNote(next, previous);
	}, [note, saveNote]);

	/**
	 * 入力欄の書きかけを1件として保存する、画面が無くなる経路用の回収口。
	 * 暗幕タップ・✕・Androidの戻るでシートの中身は即アンマウントされ、そのとき TextInput の
	 * onBlur が発火する保証は無い（＝打った内容が黙って消える）。space-note.tsx が離脱時に
	 * ストアから直接保存しているのと同じ非対称の無い作りにするため、state ではなく ref と
	 * ストアの現在値だけで完結させる。
	 */
	const flushPendingAdd = useCallback(() => {
		const draft = addDraft.current;
		if (draft.trim().length === 0 || wsId === undefined) {
			return;
		}
		const next = appendSpaceNoteEntry(noteRef.current, draft, 'task');
		// 保存できない形（上限超過など）のときは下書きを残す。ここで捨てると、次に開いたときに
		// 打った内容が黙って消えている状態になる（commitAdd 側はエラーを出して入力欄に残す）。
		// ただし復元するUIは無く、次に保存できる状態になったときへ持ち越されるだけである点に注意
		if (next === undefined || next.length > SPACE_NOTE_MAX_LENGTH) {
			return;
		}
		addDraft.current = '';
		// 飛んでいる saveNote の応答がこの追記より後に届いても、本文を巻き戻さないよう順番を進める
		saveSequence.current++;
		void useAppStore.getState().noteSet(wsId, next).catch(() => undefined);
	}, [wsId]);
	// 依存が wsId なので、スペースが切り替わる瞬間にも cleanup が走って「切り替え前のスペースへ」
	// 回収される（意図した動作。依存を増やすときはこの性質を壊さないこと）。
	useEffect(() => {
		if (!visible) {
			flushPendingAdd();
		}
	}, [visible, flushPendingAdd]);
	useEffect(() => () => flushPendingAdd(), [flushPendingAdd]);

	/** 入力欄からフォーカスが外れたときの通常経路（書きかけがあれば1件として確定する）。 */
	const handleAddBlur = () => {
		if (addDraft.current.trim().length === 0) {
			setAdding(false);
			return;
		}
		commitAdd(true);
	};

	// 改名の下書きは、メモと違って ✕・暗幕で閉じると破棄する（アラートの作法に合わせた明示保存のみ）。
	const submitRename = () => {
		const next = nameDraft.current.trim();
		if (next.length > 0 && next !== title) {
			hapticImpact('light');
			renameTerminal(terminalKey, next);
		}
		setMode('main');
	};

	/**
	 * シートを閉じ切ってから遷移する。Modalの暗幕は閉じアニメーションのあいだ画面全体を
	 * 覆ったままなので、同じtickで遷移すると遷移先の最初のタップが暗幕に吸われる。
	 *
	 * 使うのは**この画面が残る遷移**（メモ・ターミナル・ブラウザ）だけにすること。削除のように
	 * このシート自体が消える操作で使うと、待っている間にアンマウントされてタイマーが解放され、
	 * 遷移が実行されないまま「ターミナルがありません」の画面に取り残される。
	 */
	const navigationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => {
		if (navigationTimer.current !== undefined) {
			clearTimeout(navigationTimer.current);
		}
	}, []);
	const closeThen = (go: () => void) => {
		onClose();
		if (navigationTimer.current !== undefined) {
			clearTimeout(navigationTimer.current);
		}
		navigationTimer.current = setTimeout(() => { navigationTimer.current = undefined; go(); }, SHEET_CLOSE_MS);
	};

	const summary = spaceNoteSummary(note);
	const lines = parseSpaceNote(note).filter(line => line.kind !== 'blank');
	// 追記は本文の末尾に入る。書き足している間と書き足した後は末尾側を見せて、確定した項目が
	// 必ず視界に入るようにする（space-note.tsx が追加後に scrollToEnd するのと同じ意図）。
	const showTail = adding || tailPreview;
	const shownLines = showTail ? lines.slice(-NOTE_PREVIEW_LINES) : lines.slice(0, NOTE_PREVIEW_LINES);
	const hiddenLineCount = lines.length - shownLines.length;
	const hiddenNote = hiddenLineCount > 0 ? <Text style={styles.noteMore}>ほか {hiddenLineCount} 行</Text> : null;

	const sheetTitle = mode === 'rename' ? 'ターミナル名を変更' : mode === 'confirm-delete' ? 'ターミナルを削除' : 'エージェント';

	return (
		<BottomSheet visible={visible} onClose={onClose} title={sheetTitle} glass>
			<ScrollView
				contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 20 }]}
				keyboardShouldPersistTaps="handled"
			>
				{mode === 'rename' ? (
					<>
						<Text style={styles.fieldLabel}>ターミナル名</Text>
						<TextInput
							style={styles.nameInput}
							// value は渡さない（IMEの未確定文字列へ書き戻さないため）
							defaultValue={title}
							onChangeText={text => { nameDraft.current = text; }}
							selectTextOnFocus
							autoFocus
							returnKeyType="done"
							maxLength={TERMINAL_NAME_MAX_LENGTH}
							onSubmitEditing={submitRename}
							accessibilityLabel="ターミナル名"
						/>
						<Text style={styles.fieldHint}>PCのターミナルタブ名にも反映されます</Text>
						<View style={styles.dialogBtns}>
							<Pressable style={styles.dialogBtn} onPress={() => { hapticImpact('light'); setMode('main'); }} accessibilityRole="button">
								<Text style={styles.dialogBtnText}>キャンセル</Text>
							</Pressable>
							<Pressable style={[styles.dialogBtn, styles.dialogBtnPrimary]} onPress={submitRename} accessibilityRole="button">
								<Text style={[styles.dialogBtnText, styles.dialogBtnTextPrimary]}>保存</Text>
							</Pressable>
						</View>
					</>
				) : mode === 'confirm-delete' ? (
					<>
						<View style={styles.dangerIconWrap}>
							<View style={styles.dangerIcon}><Ionicons name="trash-outline" size={20} color={colors.red} /></View>
						</View>
						{/* 文言はホーム長押しの確認ダイアログ（terminalActionsMenu.tsx）と揃える */}
						<Text style={styles.confirmTitle}>ターミナルを削除しますか？</Text>
						<Text style={styles.confirmBody}>「{title}」とPCの実ターミナルも閉じられます。この操作は取り消せません。</Text>
						<View style={styles.dialogBtns}>
							<Pressable style={styles.dialogBtn} onPress={() => { hapticImpact('light'); setMode('main'); }} accessibilityRole="button">
								<Text style={styles.dialogBtnText}>キャンセル</Text>
							</Pressable>
							<Pressable
								style={[styles.dialogBtn, styles.dialogBtnDanger]}
								// 戻る側は遅延させない。router.back() は画面ごと畳むので暗幕は残らないうえ、
								// 削除が即座にPCへ反映されるとこのシートはアンマウントされ、予約は破棄される
								onPress={() => { hapticWarning(); closeTerminal(terminalKey); onClose(); onLeaveScreen(); }}
								accessibilityRole="button"
							>
								<Text style={[styles.dialogBtnText, styles.dialogBtnTextDanger]}>削除</Text>
							</Pressable>
						</View>
					</>
				) : (
					<>
						<View style={styles.nameRow}>
							<Text style={styles.name} numberOfLines={2}>{title}</Text>
							<Pressable
								style={styles.iconBtn}
								onPress={() => { hapticSelection(); nameDraft.current = title; setMode('rename'); }}
								accessibilityRole="button"
								accessibilityLabel="ターミナル名を変更"
							>
								<Ionicons name="pencil" size={15} color={colors.text} />
							</Pressable>
						</View>

						<View style={styles.chips}>
							<AgentBadge status={agentStatus} />
							{ws !== undefined ? (
								<View style={styles.chip}>
									<View style={[styles.chipSwatch, { backgroundColor: ws.color }]} />
									<Text style={styles.chipText} numberOfLines={1}>{ws.name}</Text>
								</View>
							) : null}
							{ws?.branch ? (
								<View style={styles.chip}>
									<Text style={[styles.chipText, styles.chipMono]} numberOfLines={1}>{ws.branch}</Text>
								</View>
							) : null}
							{model !== undefined ? (
								<View style={styles.chip}>
									<Text style={styles.chipText} numberOfLines={1}>{[model, effort].filter(Boolean).join(' · ')}</Text>
								</View>
							) : null}
						</View>

						{ws !== undefined ? (
							<View style={styles.noteCard}>
								<View style={styles.noteHead}>
									<View style={styles.noteHeadLeft}>
										<Ionicons name="reader-outline" size={13} color={colors.textDim} />
										<Text style={styles.noteTitle}>スペースのメモ</Text>
										{summary.open > 0 ? <Text style={styles.noteCount}>未完了 {summary.open}件</Text> : null}
									</View>
									{/* 保存の応答待ちの間は渡さない（遷移先が保存前の本文を読み込んでしまう） */}
									<Pressable
										hitSlop={8}
										disabled={noteBusy || noteLoading}
										onPress={() => { hapticSelection(); closeThen(() => router.push({ pathname: '/space-note', params: { ws: ws.id } })); }}
										accessibilityRole="button"
										accessibilityLabel="メモを全文で開く"
									>
										<Text style={[styles.noteOpen, (noteBusy || noteLoading) && styles.noteOpenDisabled]}>全文を開く ›</Text>
									</Pressable>
								</View>

								{noteLoading ? (
									<View style={styles.noteLoading}><ActivityIndicator color={colors.accent} /></View>
								) : (
									<>
										{/* 末尾側を見せている間は、省略されているのは「上」なので先頭に置く */}
										{showTail ? hiddenNote : null}
										{shownLines.length === 0 && !adding ? (
											<Text style={styles.notePlaceholder}>まだメモはありません。下の「項目を追加」から書き始められます。</Text>
										) : shownLines.map(line => (
											line.kind === 'task' ? (
												<Pressable
													key={line.index}
													style={styles.task}
													hitSlop={{ top: 6, bottom: 6 }}
													onPress={() => toggleTask(line.index)}
													accessibilityRole="checkbox"
													accessibilityState={{ checked: line.done }}
												>
													<View style={[styles.check, line.done && styles.checkDone]}>
														{line.done ? <Ionicons name="checkmark" size={12} color="#04252c" /> : null}
													</View>
													<Text style={[styles.taskLabel, line.done && styles.taskLabelDone]} numberOfLines={2}>{line.text}</Text>
												</Pressable>
											) : (
												<Text key={line.index} style={[styles.noteLine, line.kind === 'heading' && styles.noteHeading]} numberOfLines={2}>{line.text}</Text>
											)
										))}

										{adding ? (
											<View style={styles.task}>
												<View style={[styles.check, styles.checkGhost]} importantForAccessibility="no" accessibilityElementsHidden />
												<TextInput
													ref={addInputRef}
													style={styles.addInput}
													// ここも uncontrolled。確定後のクリアだけ命令APIで行う
													onChangeText={text => { addDraft.current = text; }}
													onSubmitEditing={() => commitAdd()}
													onBlur={handleAddBlur}
													autoFocus
													spellCheck={false}
													autoCorrect={false}
													returnKeyType="done"
													submitBehavior="submit"
													maxLength={SPACE_NOTE_MAX_LENGTH}
													placeholder="項目を書いて確定"
													placeholderTextColor={colors.textDim}
													accessibilityLabel="チェック項目を追加"
												/>
											</View>
										) : (
											<Pressable
												style={styles.addRow}
												onPress={() => { hapticImpact('light'); addDraft.current = ''; setNoteError(undefined); setAdding(true); }}
												accessibilityRole="button"
												accessibilityLabel="項目を追加"
											>
												<View style={styles.addPlus}><Ionicons name="add" size={13} color={colors.textDim} /></View>
												<Text style={styles.addLabel}>項目を追加</Text>
											</Pressable>
										)}
										{showTail ? null : hiddenNote}
									</>
								)}
								{noteError !== undefined ? <Text style={styles.noteErrorText}>{noteError}</Text> : null}
							</View>
						) : null}

						<View style={styles.actions}>
							<ActionButton
								icon={pinned ? 'bookmark' : 'bookmark-outline'}
								label={pinned ? 'ピン留め中' : 'ピン留め'}
								active={pinned}
								onPress={() => { hapticImpact('light'); togglePin(pinKey); }}
							/>
							<ActionButton
								icon="terminal-outline"
								label="ターミナル"
								onPress={() => {
									hapticSelection();
									// ターミナルタブは selectedWs で絞ってから selectedTerminalKey を引くので、
									// 両方を合わせる。setSelectedWs は selectedTerminalKey をリセットするため、
									// 他の遷移元（ホーム・通知・アーカイブ）と同じくこの順序を厳守する
									if (ws !== undefined) {
										setSelectedWs(ws.id);
									}
									setSelectedTerminalKey(terminalKey);
									closeThen(() => router.navigate('/terminal'));
								}}
							/>
							<ActionButton
								icon="globe-outline"
								label="ブラウザ"
								onPress={() => { hapticSelection(); closeThen(onOpenBrowser); }}
							/>
							{/* アーカイブはこの場でトグルする（シートは閉じない）。ホーム一覧のスワイプは
							    「元に戻す」を出すが、ここは同じボタンがそのまま「戻す」に変わるので取り消せる */}
							<ActionButton
								icon={archived ? 'arrow-undo-outline' : 'file-tray-full-outline'}
								label={archived ? '戻す' : 'アーカイブ'}
								active={archived}
								onPress={() => { hapticImpact('light'); setArchived(pinKey, !archived); }}
							/>
						</View>

						<Pressable
							style={styles.deleteRow}
							onPress={() => { hapticWarning(); setMode('confirm-delete'); }}
							accessibilityRole="button"
							accessibilityLabel="このターミナルを削除"
						>
							<Ionicons name="trash-outline" size={15} color={colors.red} />
							<Text style={styles.deleteText}>このターミナルを削除</Text>
						</Pressable>
					</>
				)}
			</ScrollView>
		</BottomSheet>
	);
}

function ActionButton({ icon, label, active = false, onPress }: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	active?: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable style={[styles.action, active && styles.actionActive]} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
			<Ionicons name={icon} size={17} color={active ? colors.accent : colors.text} />
			<Text style={[styles.actionLabel, active && styles.actionLabelActive]} numberOfLines={1}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	bodyContent: { paddingHorizontal: 20, paddingTop: 2 },

	nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
	name: { flex: 1, color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.2 },
	// glassの上にglassを重ねないため、シート内のボタンは不透明な面で描く（HIG準拠）
	iconBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },

	chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
	chip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: colors.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
	chipSwatch: { width: 7, height: 7, borderRadius: 2 },
	chipText: { color: '#b6b6be', fontSize: 10.5 },
	chipMono: { fontFamily: Platform.OS === 'ios' ? mono.ios : mono.default },

	noteCard: { marginTop: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.028)', padding: 12 },
	noteHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
	noteHeadLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
	noteTitle: { color: '#c9c9d2', fontSize: 11.5, fontWeight: '700' },
	noteCount: { color: colors.textDim, fontSize: 10.5 },
	noteOpen: { color: colors.accent, fontSize: 11, fontWeight: '600' },
	noteOpenDisabled: { color: colors.textDim },
	noteLoading: { paddingVertical: 14, alignItems: 'center' },
	notePlaceholder: { color: colors.textDim, fontSize: 12, lineHeight: 18, paddingVertical: 4 },
	noteLine: { color: '#c4c4cc', fontSize: 12.5, lineHeight: 19, paddingVertical: 2 },
	noteHeading: { color: colors.text, fontWeight: '700' },
	noteMore: { color: colors.textDim, fontSize: 11, paddingVertical: 4 },
	noteErrorText: { color: colors.red, fontSize: 11, paddingTop: 8, lineHeight: 16 },

	task: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 5 },
	// 未チェックが空白に見えないよう、枠と面のコントラストを space-note 画面・PC側と揃える
	check: { width: 17, height: 17, borderRadius: 5, borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)', backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
	checkDone: { backgroundColor: colors.accent, borderColor: colors.accent },
	// 追加中の行。まだ存在しない項目なので、枠を弱めて「これから増える1件」に見せる
	checkGhost: { borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.3)', backgroundColor: 'transparent' },
	taskLabel: { flex: 1, color: colors.text, fontSize: 12.5, lineHeight: 18 },
	taskLabelDone: { color: colors.textDim, textDecorationLine: 'line-through' },
	addInput: { flex: 1, color: colors.text, fontSize: 12.5, padding: 0, minHeight: 20 },
	addRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 6 },
	addPlus: { width: 17, height: 17, borderRadius: 5, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
	addLabel: { color: colors.textDim, fontSize: 12.5 },

	actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
	action: { flex: 1, alignItems: 'center', gap: 5, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, paddingVertical: 11, paddingHorizontal: 4 },
	actionActive: { borderColor: 'rgba(9,175,217,0.45)', backgroundColor: colors.accentWash },
	actionLabel: { color: '#b8b8c0', fontSize: 10 },
	actionLabelActive: { color: colors.accent },

	deleteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 12, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(244,114,114,0.28)', paddingVertical: 11 },
	deleteText: { color: colors.red, fontSize: 12.5, fontWeight: '600' },

	fieldLabel: { color: colors.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 7 },
	nameInput: { backgroundColor: 'rgba(0,0,0,0.35)', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 14 },
	fieldHint: { color: colors.textDim, fontSize: 11.5, lineHeight: 17, marginTop: 8 },
	dangerIconWrap: { alignItems: 'center', paddingTop: 2 },
	dangerIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(244,114,114,0.14)', alignItems: 'center', justifyContent: 'center' },
	confirmTitle: { color: colors.text, fontSize: 15, fontWeight: '700', textAlign: 'center', marginTop: 12 },
	confirmBody: { color: colors.textDim, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 6 },
	dialogBtns: { flexDirection: 'row', gap: 8, marginTop: 16 },
	dialogBtn: { flex: 1, alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2, paddingVertical: 12 },
	dialogBtnPrimary: { borderColor: 'rgba(9,175,217,0.45)', backgroundColor: colors.accentWash },
	dialogBtnDanger: { borderColor: 'rgba(244,114,114,0.35)', backgroundColor: 'rgba(244,114,114,0.12)' },
	dialogBtnText: { color: colors.text, fontSize: 14 },
	dialogBtnTextPrimary: { color: colors.accent, fontWeight: '700' },
	dialogBtnTextDanger: { color: colors.red, fontWeight: '700' },
});

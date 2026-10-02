// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from 'react-native';
import { Check, ChevronDown, CircleCheck, Circle, Copy, Heading, List, ListChecks, Minus, Pencil, Trash2, Type, X } from 'lucide-react-native';
import { haptic } from '../../haptics.js';
import { usePcCapability } from '../../hooks/usePcCapability.js';
import { useShortcutSlot } from '../../ipad/shortcutRegistry.js';
import { writeClipboardText } from '../../nativeClipboard.js';
import { useParaToast } from '../../paraToast.js';
import { useKeyboardCoverage } from '../../hooks/useKeyboardVisible.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import {
	SPACE_NOTE_MAX_LENGTH,
	applySpaceNotePrefix,
	continueSpaceNoteChecklist,
	parseSpaceNote,
	spaceNoteSummary,
	trimSpaceNoteTrailingEmptyTask,
	type SpaceNoteLine,
	type SpaceNotePrefix,
} from '../../spaceNote.js';
import { colors, space, type } from '../../theme.js';
import { ActionSheet, Button, EmptyState, HeaderButton, Screen, ScreenHeader, SectionHeader, type ActionSheetAction } from '../../ui/index.js';
import { CenterSpinner, InlineError, OfflineBanner, SpaceGateBody, useReadableColumn } from '../code/codeParts.js';
import type { PanelDock } from '../code/panelDock.js';
import { useCodeSpace, type CodeSpaceTarget } from '../code/useCodeSpace.js';
import { NoteAddButton, NoteAddInput, NoteLines, NoteToolbar, type NoteToolbarAction } from './noteParts.js';
import { NOTE_TASK_OPS_CAPABILITY, appendNoteChange, editNoteChange, removeNoteChange, replaceNoteChange, restoreLineIndex, restoreNoteChange, toggleNoteChange } from './spaceNoteSave.js';
import { spaceNoteErrorMessage, useSpaceNote } from './useSpaceNote.js';

/**
 * スペースのメモ（`/pc/[pcId]/note/[spaceId]`。PC 版のスペース一覧の下のメモ欄と同じ本文）。
 * 旧画面（`legacy-screens/space-note.tsx`）の処理を移し、見た目を Orca の部品で作り直した。
 *
 *  - `- [ ]` / `- [x]` の行はチェック項目として描き、押すと完了を切り替えて保存する（楽観更新・失敗したら戻す）
 *  - 末尾の「項目を追加」で、編集に入らずにチェック項目を足せる（確定しても入力欄は残り、続けて書ける）
 *  - チェック項目を長押しすると、PC の右クリックと同じ操作（完了の切り替え・この項目を編集・テキストをコピー・削除）を
 *    下のシートに出す。編集はその行の中の入力欄で行い、削除は確かめずに消して「元に戻す」をトーストに出す。
 *    PC が `note.task-ops.v1` を持たなければ「編集」「削除」は出さない
 *  - 右上の「編集」で本文全体を書き換える。キーボードの上の記号のバーで行頭の記号を付け替える
 *  - 編集の途中で戻っても書きかけは捨てずに保存する（`useSpaceNote`）
 *
 * 入力欄はどちらも uncontrolled（`value` を渡さない）。PC や他の端末からの同期で描き直しても、
 * 日本語の変換途中の文字へ書き戻さないため（旧画面と同じ扱い）。
 *
 * ルート（`app/pc/[pcId]/note/[spaceId].tsx`）と、iPad のセッションの右のドック（`dock`）の両方で使う。
 * ドックでは見出しの左が閉じる（X）になり、キーボードの分はセッションの画面が空ける。
 */
export function SpaceNotePanel({ target, dock }: { target?: CodeSpaceTarget; dock?: PanelDock } = {}) {
	const codeSpace = useCodeSpace(target);
	const insets = useStableInsets();
	const keyboardCover = useKeyboardCoverage();
	const keyboardVisible = keyboardCover > 0;
	const column = useReadableColumn();
	const note = useSpaceNote(codeSpace.wsId);
	const { text, loading, busy, error } = note;

	const [editing, setEditing] = useState(false);
	const [adding, setAdding] = useState(false);
	const scrollRef = useRef<ScrollView>(null);

	// 編集欄（uncontrolled）。こちらから書き換えるのは改行の直後と記号のバーだけ。
	const editorRef = useRef<TextInput>(null);
	const editorInitial = useRef('');
	const [editorKey, setEditorKey] = useState(0);
	/** 自動継続の差分検出に使う1つ前の本文。こちらから書き換えたときもここへ反映する。 */
	const editorBaseline = useRef('');
	const editorSelection = useRef(0);

	// 項目を足す入力欄（uncontrolled）。
	const addRef = useRef<TextInput>(null);
	const addDraft = useRef('');

	// 長押しのメニュー。対象の行はシートを閉じる途中も見出しが変わらないように、閉じても持ち続ける。
	const taskOps = usePcCapability(NOTE_TASK_OPS_CAPABILITY);
	const [menuTarget, setMenuTarget] = useState<{ readonly line: SpaceNoteLine; readonly raw: string } | undefined>(undefined);
	const [menuOpen, setMenuOpen] = useState(false);
	// その行の中で書き換えている項目（行番号と、書き換え始めたときのその行の中身）。
	const [lineEdit, setLineEdit] = useState<{ readonly index: number; readonly raw: string } | undefined>(undefined);
	const lineEditRef = useRef(lineEdit);
	lineEditRef.current = lineEdit;
	const lineInputRef = useRef<TextInput>(null);
	const lineDraft = useRef('');

	const summary = spaceNoteSummary(text);
	const lines = parseSpaceNote(text);
	const subtitle = [codeSpace.name, codeSpace.branch].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');

	/** 長押しした行がまだ同じ中身でそこにあるか（シートを開いている間に本文が変わっていたら何もしない）。 */
	const sameLine = (index: number, raw: string) => text.split('\n')[index] === raw;

	const openMenu = (line: SpaceNoteLine) => {
		const raw = text.split('\n')[line.index];
		if (raw === undefined || lineEdit !== undefined) {
			return;
		}
		haptic('lift');
		setMenuTarget({ line, raw });
		setMenuOpen(true);
	};

	const copyLine = async (line: SpaceNoteLine) => {
		const copied = await writeClipboardText(line.text);
		useParaToast.getState().show(copied
			? { key: 'space-note-copied', text: 'テキストをコピーしました', icon: 'copy-outline', tone: 'done' }
			: { key: 'space-note-copied', text: 'コピーできませんでした', icon: 'alert-circle', tone: 'warn' }, 1_500);
	};

	const startLineEdit = (line: SpaceNoteLine, raw: string) => {
		if (!sameLine(line.index, raw)) {
			return;
		}
		lineDraft.current = line.text;
		setAdding(false);
		setLineEdit({ index: line.index, raw });
	};
	/** 行の中の編集を確定する（Return・フォーカスが外れた・保存）。空・変わらないなら書かずに閉じる（PC と同じ）。 */
	const commitLineEdit = () => {
		const current = lineEditRef.current;
		if (current === undefined) {
			return;
		}
		lineEditRef.current = undefined;
		setLineEdit(undefined);
		const draft = lineDraft.current;
		if (!sameLine(current.index, current.raw)) {
			// 編集している間に本文が変わった（PC やエージェントが書き換えた）。書かずに閉じるので、書いた文は逃がす
			void keepDiscardedEdit(draft);
			return;
		}
		const change = editNoteChange(text, current.index, draft);
		if (change !== undefined) {
			haptic('commit');
			void note.commit(change).then(result => {
				if (result.outcome === 'conflict' || result.outcome === 'failed') {
					void keepDiscardedEdit(draft);
				}
			});
		}
	};
	/** 書かれなかった行の中の編集を、クリップボードへ逃がして知らせる（黙って消さない）。 */
	const keepDiscardedEdit = async (draft: string) => {
		const copied = draft.trim().length > 0 && await writeClipboardText(draft);
		useParaToast.getState().show({
			key: 'space-note-edit-discarded',
			text: '編集を保存できませんでした',
			sub: copied ? '書いた文はクリップボードにコピーしました。' : 'メモが PC で変わっていました。',
			icon: 'alert-circle',
			tone: 'warn',
		}, 5_000);
	};
	const cancelLineEdit = () => {
		lineEditRef.current = undefined;
		setLineEdit(undefined);
	};
	// iPad の外付けキーボードの Esc で取り消す（後から置いた受け口が勝つので、ドックを閉じる Esc より先に効く）
	useShortcutSlot('escape', lineEdit !== undefined ? { escape: cancelLineEdit } : undefined);

	/** 確かめずに消し、「元に戻す」を 5 秒出す（PC の「削除」も確かめない）。 */
	const removeLine = (line: SpaceNoteLine, raw: string) => {
		const change = removeNoteChange(text, line.index);
		if (change === undefined || !sameLine(line.index, raw)) {
			return;
		}
		haptic('commit');
		const removedIn = note.wsId;
		void note.commit(change).then(result => {
			// 消せたときだけ「元に戻す」を出す（失敗・PC で変わっていて書かれなかったときに出すと、残っている項目を二重に挿す）
			if (result.outcome === 'saved' && removedIn !== undefined) {
				// 挿し直す位置は PC が実際に消した位置（応答の opLine。無い PC では手元の行）と、消した直後の本文で決める
				showUndo(line, change.removed, { wsId: removedIn, text: result.text ?? change.next, at: result.opLine ?? line.index });
			}
		});
	};
	/** 「元に戻す」付きのトースト。二重に押しても一度だけ挿し直す。 */
	const showUndo = (line: SpaceNoteLine, removed: readonly string[], removal: { readonly wsId: string; readonly text: string; readonly at: number }) => {
		let used = false;
		const undo = async () => {
			if (used) {
				return;
			}
			used = true;
			useParaToast.getState().hide();
			// 消した保存の応答（PC が当てた後の本文）を待ってから、その本文に挿し直す。全文はその本文を読んだ時点の版を
			// base に付けて送る（間に別の操作が版を進めていれば書かれず、その操作を消さない）
			const latest = await note.settledSnapshot();
			if (latest.wsId !== removal.wsId) {
				// 別のスペースへ移った後に押された。別のスペースのメモに挿さない
				return;
			}
			void note.commit(restoreNoteChange(latest.text, restoreLineIndex(removal.text, removal.at, latest.text), removed, latest.version));
		};
		useParaToast.getState().show({
			key: 'space-note-removed',
			text: '項目を削除しました',
			sub: line.text,
			icon: 'trash-outline',
			tone: 'info',
			action: { label: '元に戻す', onPress: () => void undo() },
		}, 5_000);
	};

	const toggle = (lineIndex: number) => {
		const change = toggleNoteChange(text, lineIndex);
		if (change === undefined) {
			return;
		}
		haptic('tick');
		void note.commit(change);
	};

	const menuActions: ActionSheetAction[] = menuTarget === undefined ? [] : [
		{ label: menuTarget.line.done ? '未完了に戻す' : '完了にする', icon: menuTarget.line.done ? Circle : CircleCheck, onPress: () => { if (sameLine(menuTarget.line.index, menuTarget.raw)) { toggle(menuTarget.line.index); } } },
		...(taskOps ? [{ label: 'この項目を編集', icon: Pencil, onPress: () => startLineEdit(menuTarget.line, menuTarget.raw) }] : []),
		{ label: 'テキストをコピー', icon: Copy, onPress: () => void copyLine(menuTarget.line) },
		...(taskOps ? [{ label: '削除', icon: Trash2, destructive: true, onPress: () => removeLine(menuTarget.line, menuTarget.raw) }] : []),
	];

	/**
	 * 編集欄の中身をこちらから書き換える。テキストと選択範囲で API を分けているのは、`selection` を
	 * setNativeProps に混ぜても New Architecture では反映されないため（旧画面と同じ）。
	 */
	const writeEditor = (next: string, selection: number) => {
		// maxLength は打鍵にしか効かないので、こちらの書き換えでも上限を守る。
		if (next.length > SPACE_NOTE_MAX_LENGTH) {
			return;
		}
		editorBaseline.current = next;
		editorSelection.current = selection;
		note.holdDraft(next);
		editorRef.current?.setNativeProps({ text: next });
		editorRef.current?.setSelection(selection, selection);
	};
	const onEditorChange = (next: string) => {
		const previous = editorBaseline.current;
		editorBaseline.current = next;
		note.holdDraft(next);
		// 改行は変換の確定より後にしか起きないので、ここで書き換えても変換途中の文字を壊さない。
		const continued = continueSpaceNoteChecklist(previous, next);
		if (continued !== undefined) {
			writeEditor(continued.text, continued.selection);
		}
	};
	const applyPrefix = (prefix: SpaceNotePrefix) => {
		haptic('tick');
		const result = applySpaceNotePrefix(editorBaseline.current, editorSelection.current, prefix);
		writeEditor(result.text, result.selection);
	};

	const startEditing = () => {
		editorInitial.current = text;
		editorBaseline.current = text;
		editorSelection.current = text.length;
		note.holdDraft(text);
		setEditorKey(key => key + 1);
		setAdding(false);
		cancelLineEdit();
		setEditing(true);
	};
	const cancelEditing = () => {
		note.holdDraft(undefined);
		setEditing(false);
	};
	const commitEditing = () => {
		haptic('commit');
		// 自動継続が置いた末尾の空項目は未完了1件として数えられるので、保存の前に落とす。
		const next = trimSpaceNoteTrailingEmptyTask(editorBaseline.current);
		note.holdDraft(undefined);
		setEditing(false);
		if (next !== text) {
			void note.commit(replaceNoteChange(next));
		}
	};

	const startAdding = () => {
		addDraft.current = '';
		note.setError(undefined);
		setAdding(true);
	};
	const stopAdding = () => {
		addDraft.current = '';
		setAdding(false);
	};
	/** 足す欄の中身を1件として確定する。既定では欄を空にして残す（`close` なら閉じる）。 */
	const commitAdding = (kind: 'task' | 'text', close = false) => {
		const change = appendNoteChange(text, addDraft.current, kind);
		if (change === undefined) {
			stopAdding();
			return;
		}
		if (change.next.length > SPACE_NOTE_MAX_LENGTH) {
			note.setError('full');
			return;
		}
		haptic('commit');
		addDraft.current = '';
		addRef.current?.clear();
		if (close) {
			setAdding(false);
		} else {
			requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
		}
		void note.commit(change);
	};
	/** フォーカスが外れたら、書きかけを捨てずに1件として確定する（黙って消さない）。 */
	const onAddBlur = () => {
		if (addDraft.current.trim().length === 0) {
			stopAdding();
			return;
		}
		commitAdding('task', true);
	};

	const toolbarActions: NoteToolbarAction[] = lineEdit !== undefined ? [
		// 行の中の編集（iPhone はキーボードの上のここで確定・取り消す。iPad は Return / Esc でも）
		{ key: 'cancel', icon: X, label: 'キャンセル', onPress: cancelLineEdit },
		{ key: 'save', icon: Check, label: '保存', onPress: commitLineEdit },
	] : editing ? [
		{ key: 'task', icon: ListChecks, label: 'チェック', onPress: () => applyPrefix('task') },
		{ key: 'heading', icon: Heading, label: '見出し', onPress: () => applyPrefix('heading') },
		{ key: 'bullet', icon: List, label: '箇条書き', onPress: () => applyPrefix('bullet') },
		{ key: 'none', icon: Minus, label: '記号なし', onPress: () => applyPrefix('none') },
	] : [
		{ key: 'task', icon: ListChecks, label: 'チェック', onPress: () => commitAdding('task') },
		{ key: 'text', icon: Type, label: 'ふつうの行', onPress: () => commitAdding('text') },
		{ key: 'close', icon: ChevronDown, label: '閉じる', onPress: stopAdding },
	];

	const ready = codeSpace.gate === 'ready';
	const right = !ready ? undefined : editing ? (
		<>
			<Button label="キャンセル" variant="ghost" size="sm" onPress={cancelEditing} disabled={busy} />
			<Button label="保存" size="sm" onPress={commitEditing} disabled={busy} />
		</>
	) : (
		<HeaderButton icon={Pencil} label="編集" onPress={startEditing} disabled={loading || error === 'load'} />
	);

	const body = (() => {
		if (loading) {
			return <CenterSpinner label="メモを読み込んでいます…" />;
		}
		if (error === 'load') {
			return <EmptyState title="メモを読み込めませんでした" body="PC との接続を確かめてください。" action={{ label: 'もう一度読み込む', onPress: note.reload }} />;
		}
		if (editing) {
			return (
				<TextInput
					key={editorKey}
					ref={editorRef}
					style={[styles.editor, column]}
					// value は渡さない（描き直しのたびに変換途中の文字へ書き戻さないように）。
					defaultValue={editorInitial.current}
					onChangeText={onEditorChange}
					onSelectionChange={(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => { editorSelection.current = event.nativeEvent.selection.start; }}
					multiline
					autoFocus
					spellCheck={false}
					autoCorrect={false}
					keyboardAppearance="dark"
					// PC 側と同じ上限。超えたぶんは PC 側で切り詰められるので、入力の段階で止める。
					maxLength={SPACE_NOTE_MAX_LENGTH}
					placeholder={'やることを書けます\n下のボタンでチェックリストにできます'}
					placeholderTextColor={colors.textMuted}
					accessibilityLabel="メモの本文"
				/>
			);
		}
		const total = summary.open + summary.done;
		return (
			<ScrollView
				ref={scrollRef}
				style={styles.fill}
				contentContainerStyle={[styles.content, { paddingBottom: adding ? space.lg : insets.bottom + space.xl }, column]}
				keyboardShouldPersistTaps="handled"
			>
				{total > 0 ? <SectionHeader title={`未完了 ${summary.open} / ${total}`} style={styles.summary} /> : null}
				{lines.length === 0 && !adding ? (
					<EmptyState style={styles.empty} title="メモはまだありません" body="下の「項目を追加」からすぐ書き始められます。PC のメモ欄と同じ内容です。" />
				) : (
					<NoteLines
						lines={lines}
						onToggle={toggle}
						onLongPress={openMenu}
						selected={menuOpen ? menuTarget?.line.index : undefined}
						editor={lineEdit !== undefined ? { index: lineEdit.index, inputRef: lineInputRef, onChange: value => { lineDraft.current = value; }, onCommit: commitLineEdit, onCancel: cancelLineEdit } : undefined}
						disabled={busy}
					/>
				)}
				{adding ? (
					<NoteAddInput inputRef={addRef} onChange={value => { addDraft.current = value; }} onSubmit={() => commitAdding('task')} onBlur={onAddBlur} />
				) : (
					<NoteAddButton onPress={startAdding} disabled={busy} />
				)}
			</ScrollView>
		);
	})();

	return (
		<Screen style={{ paddingBottom: dock !== undefined ? 0 : keyboardCover }}>
			<ScreenHeader
				title="メモ"
				{...(subtitle.length > 0 ? { subtitle } : {})}
				right={right}
				backLabel="セッションへ戻る"
				{...(dock !== undefined ? { safeTop: false, surface: 'panel' as const, backIcon: X, backLabel: 'メモを閉じる', onBack: dock.close } : {})}
			/>
			<OfflineBanner reason={ready ? codeSpace.unavailable : undefined} />
			<InlineError message={error !== undefined && error !== 'load' ? spaceNoteErrorMessage(error) : undefined} style={styles.error} />
			<View style={styles.fill}>
				<SpaceGateBody gate={codeSpace.gate}>{body}</SpaceGateBody>
			</View>
			{ready && (editing || adding || lineEdit !== undefined) ? <NoteToolbar actions={toolbarActions} bottomInset={keyboardVisible ? 0 : insets.bottom} /> : null}
			<ActionSheet
				visible={menuOpen}
				title={menuTarget?.line.text}
				actions={menuActions}
				onClose={() => setMenuOpen(false)}
			/>
		</Screen>
	);
}

const styles = StyleSheet.create({
	fill: {
		flex: 1,
	},
	content: {
		paddingHorizontal: space.lg,
		paddingTop: space.sm,
	},
	summary: {
		marginTop: space.sm,
	},
	empty: {
		flex: 0,
		paddingVertical: space.xl,
	},
	editor: {
		flex: 1,
		paddingHorizontal: space.lg,
		paddingTop: space.md,
		paddingBottom: space.md,
		fontSize: type.body,
		lineHeight: 22,
		color: colors.text,
		textAlignVertical: 'top',
	},
	error: {
		marginHorizontal: space.lg,
		marginBottom: space.sm,
	},
});

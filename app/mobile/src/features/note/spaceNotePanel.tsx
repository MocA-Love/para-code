// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from 'react-native';
import { ChevronDown, Heading, List, ListChecks, Minus, Pencil, Type, X } from 'lucide-react-native';
import { hapticImpact, hapticSelection } from '../../haptics.js';
import { useKeyboardCoverage } from '../../hooks/useKeyboardVisible.js';
import { useStableInsets } from '../../hooks/useStableInsets.js';
import {
	SPACE_NOTE_MAX_LENGTH,
	appendSpaceNoteEntry,
	applySpaceNotePrefix,
	continueSpaceNoteChecklist,
	parseSpaceNote,
	spaceNoteSummary,
	toggleSpaceNoteTask,
	trimSpaceNoteTrailingEmptyTask,
	type SpaceNotePrefix,
} from '../../spaceNote.js';
import { colors, space, type } from '../../theme.js';
import { Button, EmptyState, HeaderButton, Screen, ScreenHeader, SectionHeader } from '../../ui/index.js';
import { CenterSpinner, InlineError, OfflineBanner, SpaceGateBody, useReadableColumn } from '../code/codeParts.js';
import type { PanelDock } from '../code/panelDock.js';
import { useCodeSpace, type CodeSpaceTarget } from '../code/useCodeSpace.js';
import { NoteAddButton, NoteAddInput, NoteLines, NoteToolbar, type NoteToolbarAction } from './noteParts.js';
import { spaceNoteErrorMessage, useSpaceNote } from './useSpaceNote.js';

/**
 * スペースのメモ（`/pc/[pcId]/note/[spaceId]`。PC 版のスペース一覧の下のメモ欄と同じ本文）。
 * 旧画面（`legacy-screens/space-note.tsx`）の処理を移し、見た目を Orca の部品で作り直した。
 *
 *  - `- [ ]` / `- [x]` の行はチェック項目として描き、押すと完了を切り替えて保存する（楽観更新・失敗したら戻す）
 *  - 末尾の「項目を追加」で、編集に入らずにチェック項目を足せる（確定しても入力欄は残り、続けて書ける）
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

	const summary = spaceNoteSummary(text);
	const lines = parseSpaceNote(text);
	const subtitle = [codeSpace.name, codeSpace.branch].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');

	const toggle = (lineIndex: number) => {
		const next = toggleSpaceNoteTask(text, lineIndex);
		if (next === undefined) {
			return;
		}
		hapticSelection();
		note.commit(next);
	};

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
		hapticSelection();
		const result = applySpaceNotePrefix(editorBaseline.current, editorSelection.current, prefix);
		writeEditor(result.text, result.selection);
	};

	const startEditing = () => {
		hapticImpact('light');
		editorInitial.current = text;
		editorBaseline.current = text;
		editorSelection.current = text.length;
		note.holdDraft(text);
		setEditorKey(key => key + 1);
		setAdding(false);
		setEditing(true);
	};
	const cancelEditing = () => {
		hapticImpact('light');
		note.holdDraft(undefined);
		setEditing(false);
	};
	const commitEditing = () => {
		hapticImpact('light');
		// 自動継続が置いた末尾の空項目は未完了1件として数えられるので、保存の前に落とす。
		const next = trimSpaceNoteTrailingEmptyTask(editorBaseline.current);
		note.holdDraft(undefined);
		setEditing(false);
		if (next !== text) {
			note.commit(next);
		}
	};

	const startAdding = () => {
		hapticImpact('light');
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
		const next = appendSpaceNoteEntry(text, addDraft.current, kind);
		if (next === undefined) {
			stopAdding();
			return;
		}
		if (next.length > SPACE_NOTE_MAX_LENGTH) {
			note.setError('full');
			return;
		}
		hapticSelection();
		addDraft.current = '';
		addRef.current?.clear();
		if (close) {
			setAdding(false);
		} else {
			requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
		}
		note.commit(next);
	};
	/** フォーカスが外れたら、書きかけを捨てずに1件として確定する（黙って消さない）。 */
	const onAddBlur = () => {
		if (addDraft.current.trim().length === 0) {
			stopAdding();
			return;
		}
		commitAdding('task', true);
	};

	const toolbarActions: NoteToolbarAction[] = editing ? [
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
					<NoteLines lines={lines} onToggle={toggle} disabled={busy} />
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
			{ready && (editing || adding) ? <NoteToolbar actions={toolbarActions} bottomInset={keyboardVisible ? 0 : insets.bottom} /> : null}
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

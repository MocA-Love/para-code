// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react-native';
import { hapticSelection } from '../../src/haptics.js';
import { useParaToast } from '../../src/paraToast.js';
import { colors, space } from '../../src/theme.js';
import { ActionSheet, ConfirmDrawer, Icon, ListGroup, ListRow, TextInputDrawer } from '../../src/ui/index.js';
import {
	DEFAULT_QUICK_REPLIES,
	QUICK_REPLY_MAX_COUNT,
	QUICK_REPLY_MAX_LENGTH,
	addQuickReply,
	canAddQuickReply,
	moveQuickReply,
	quickReplyProblem,
	quickReplyProblemMessage,
	removeQuickReply,
	updateQuickReply,
} from '../../src/features/settings/quickReplies.js';
import { useQuickReplies, useQuickReplyList } from '../../src/features/settings/quickRepliesStore.js';
import { GroupGap, GroupHeader, GroupNote, SettingsScreen } from '../../src/features/settings/settingsScaffold.js';

type EditorMode = 'add' | 'edit';

function showSaveFailed(): void {
	useParaToast.getState().show({ key: 'quick-replies-save', text: '保存できませんでした', icon: 'alert-circle-outline', tone: 'warn' }, 2_500);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * クイック返信（`/settings/quick-replies`。モックには無い）。会話画面の入力欄の上に出る短い返信の
 * 一覧を、追加・編集・削除・並び替えできる。この端末の中だけの設定で、PC へは送らない。
 *
 * 行を押すと操作のシート（編集・上へ・下へ・削除）が出る。上限は `quickReplies.ts`（8件・1件40文字）。
 */
export default function QuickRepliesSettingsScreen() {
	const replies = useQuickReplyList();
	const save = useQuickReplies(s => s.save);
	const reset = useQuickReplies(s => s.reset);

	/** 操作の対象の行（シートを閉じる途中も見出しが変わらないように、閉じても残す）。 */
	const [target, setTarget] = useState(0);
	const [menuOpen, setMenuOpen] = useState(false);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editorMode, setEditorMode] = useState<EditorMode>('add');
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [resetOpen, setResetOpen] = useState(false);

	const list = replies ?? [];
	const targetText = list[target] ?? '';
	const canAdd = canAddQuickReply(list);
	const isDefault = sameList(list, DEFAULT_QUICK_REPLIES);

	const persist = (next: readonly string[]) => {
		if (next === list) {
			return;
		}
		save(next).catch(showSaveFailed);
	};
	const openMenu = (index: number) => {
		hapticSelection();
		setTarget(index);
		setMenuOpen(true);
	};
	const openAdd = () => {
		hapticSelection();
		setEditorMode('add');
		setEditorOpen(true);
	};

	return (
		<SettingsScreen
			title="クイック返信"
			footer={(
				<>
					<ActionSheet
						visible={menuOpen}
						title={targetText}
						actions={[
							{ label: '編集', icon: Pencil, onPress: () => { setEditorMode('edit'); setEditorOpen(true); } },
							{ label: '上へ', icon: ArrowUp, disabled: target === 0, immediate: true, onPress: () => persist(moveQuickReply(list, target, -1)) },
							{ label: '下へ', icon: ArrowDown, disabled: target >= list.length - 1, immediate: true, onPress: () => persist(moveQuickReply(list, target, 1)) },
							{ label: '削除', icon: Trash2, destructive: true, onPress: () => setDeleteOpen(true) },
						]}
						onClose={() => setMenuOpen(false)}
					/>
					<TextInputDrawer
						visible={editorOpen}
						title={editorMode === 'add' ? '返信を追加' : '返信を編集'}
						message={`${QUICK_REPLY_MAX_LENGTH} 文字まで。押すと入力欄に入ります（送信はしません）。`}
						defaultValue={editorMode === 'edit' ? targetText : ''}
						placeholder="例: 続けて"
						submitLabel={editorMode === 'add' ? '追加' : '保存'}
						maxLength={QUICK_REPLY_MAX_LENGTH}
						validate={value => {
							const problem = quickReplyProblem(list, value, editorMode === 'edit' ? target : undefined);
							// 空欄は保存のボタンを押せなくするだけで、理由は出さない（入れる前から注意を出さない）。
							return problem === undefined || problem === 'empty' ? undefined : quickReplyProblemMessage(problem);
						}}
						onSubmit={value => persist(editorMode === 'add' ? addQuickReply(list, value) : updateQuickReply(list, target, value))}
						onClose={() => setEditorOpen(false)}
					/>
					<ConfirmDrawer
						visible={deleteOpen}
						title={`「${targetText}」を削除しますか？`}
						message="会話画面のチップから消えます。"
						confirmLabel="削除"
						onConfirm={() => persist(removeQuickReply(list, target))}
						onClose={() => setDeleteOpen(false)}
					/>
					<ConfirmDrawer
						visible={resetOpen}
						title="既定に戻しますか？"
						message={`いまの一覧を消して、${DEFAULT_QUICK_REPLIES.map(reply => `「${reply}」`).join('')}に戻します。`}
						confirmLabel="戻す"
						onConfirm={() => { reset().catch(showSaveFailed); }}
						onClose={() => setResetOpen(false)}
					/>
				</>
			)}
		>
			<GroupHeader title="返信" first />
			<GroupNote>会話画面の入力欄の上に出る短い返信です。押すと入力欄に入り、送信はしません。書きかけがあれば後ろに足します。</GroupNote>
			{replies === undefined ? (
				<View style={styles.loading}><ActivityIndicator color={colors.textDim} /></View>
			) : (
				<ListGroup>
					{list.map((reply, index) => (
						<ListRow
							key={reply}
							label={reply}
							trailing={<Icon icon={Ellipsis} color={colors.textMuted} />}
							onPress={() => openMenu(index)}
							onLongPress={() => openMenu(index)}
							accessibilityLabel={`${reply}、操作を開く`}
						/>
					))}
					<ListRow
						icon={Plus}
						label="返信を追加"
						hint={canAdd ? undefined : quickReplyProblemMessage('full')}
						disabled={!canAdd}
						onPress={openAdd}
					/>
				</ListGroup>
			)}
			<GroupNote after>
				{`${QUICK_REPLY_MAX_COUNT} 件まで、1件 ${QUICK_REPLY_MAX_LENGTH} 文字まで登録できます。すべて削除すると、会話画面に返信の行を出しません。この端末の中だけの設定です。`}
			</GroupNote>
			<GroupGap />
			<ListGroup>
				<ListRow
					icon={RotateCcw}
					label="既定に戻す"
					hint={DEFAULT_QUICK_REPLIES.join('・')}
					disabled={replies === undefined || isDefault}
					onPress={() => { hapticSelection(); setResetOpen(true); }}
				/>
			</ListGroup>
		</SettingsScreen>
	);
}

const styles = StyleSheet.create({
	loading: {
		paddingVertical: space.xl,
		alignItems: 'center',
	},
});

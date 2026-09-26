// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { GitCompare, Globe, MessageSquare, Monitor, NotebookPen, Pencil, Siren, Smartphone, SquareTerminal, Users, X } from 'lucide-react-native';
import type { ActionSheetAction } from '../../ui/index.js';
import type { SessionTabItem } from './sessionTabs.js';
import type { SessionView } from './sessionViewMode.js';

/**
 * セッション画面のシートに並べる操作（Orca の長押しメニュー・⋯・＋）。
 * 並べる順と出す条件だけをここで決め、実際の処理は呼び出し側が渡す（どれも既存の処理）。
 */

/** タブの長押しメニュー。先頭は会話表示とターミナル表示の切り替え（エージェントのタブだけ）。 */
export function tabMenuActions(item: SessionTabItem, options: {
	readonly view: SessionView | undefined;
	readonly phoneWidth: boolean;
	readonly onToggleView: () => void;
	readonly onToggleWidth: () => void;
	readonly onRename: () => void;
	readonly onClose: () => void;
}): ActionSheetAction[] {
	if (item.kind === 'browser') {
		return [];
	}
	const actions: ActionSheetAction[] = [];
	if (item.agent && options.view !== undefined) {
		actions.push(options.view === 'chat'
			? { label: 'ターミナル表示に切り替え', icon: SquareTerminal, onPress: options.onToggleView, immediate: true }
			: { label: 'チャット表示に切り替え', icon: MessageSquare, onPress: options.onToggleView, immediate: true });
	}
	actions.push(options.phoneWidth
		? { label: 'デスクトップ表示に切り替え', hint: 'PC 側のターミナルの幅を元に戻します', icon: Monitor, onPress: options.onToggleWidth, immediate: true }
		: { label: 'スマホ表示に切り替え', hint: 'PC 側のターミナルをこの画面の幅に合わせます', icon: Smartphone, onPress: options.onToggleWidth, immediate: true });
	actions.push({ label: '名前を変更', icon: Pencil, onPress: options.onRename });
	actions.push({ label: '閉じる', icon: X, destructive: true, onPress: options.onClose });
	return actions;
}

/** タブの長押しメニューの見出しの補足。 */
export function tabMenuMessage(item: SessionTabItem, view: SessionView | undefined): string {
	if (item.kind === 'browser') {
		return 'ブラウザ';
	}
	if (!item.agent) {
		return 'ターミナル';
	}
	return view === 'terminal' ? 'ターミナル表示' : 'チャット表示';
}

/** ＋（新しいタブ）。 */
export function newTabActions(options: {
	readonly onTerminal: () => void;
	readonly onAgent: (agent: 'claude' | 'codex') => void;
	readonly onBrowser: () => void;
	readonly claudeLeading?: ActionSheetAction['leading'];
	readonly codexLeading?: ActionSheetAction['leading'];
}): ActionSheetAction[] {
	return [
		{ label: 'Claude', hint: 'このスペースで Claude Code を起動します', leading: options.claudeLeading, onPress: () => options.onAgent('claude') },
		{ label: 'Codex', hint: 'このスペースで Codex を起動します', leading: options.codexLeading, onPress: () => options.onAgent('codex') },
		{ label: 'ターミナル', icon: SquareTerminal, onPress: options.onTerminal },
		{ label: 'ブラウザ', hint: 'PC のブラウザを写します', icon: Globe, onPress: options.onBrowser },
	];
}

/**
 * ⋯（その他の操作）。他の要対応があれば先頭に出す。
 * 「サブエージェント」は、開いているエージェントのタブにサブエージェントかタスクの記録があるときだけ
 * （旧画面も記録があるときだけ入口の帯を出していた）。`activityHint` を渡すと出す。
 */
export function moreActions(options: {
	readonly attentionCount: number;
	readonly onNextAttention: () => void;
	readonly onReview: () => void;
	/** スペースのメモの未完了の数（0 なら補足を出さない）。 */
	readonly noteOpen: number;
	readonly onNote: () => void;
	/** サブエージェントの補足（`activityMenuHint`）。undefined なら「サブエージェント」を出さない。 */
	readonly activityHint?: string;
	readonly onActivity?: () => void;
}): ActionSheetAction[] {
	const actions: ActionSheetAction[] = [];
	if (options.attentionCount > 0) {
		actions.push({ label: `要対応 あと ${options.attentionCount} 件`, hint: '次のエージェントを開きます', icon: Siren, onPress: options.onNextAttention });
	}
	actions.push({ label: '差分レビュー', icon: GitCompare, onPress: options.onReview });
	actions.push({ label: 'メモ', hint: options.noteOpen > 0 ? `未完了 ${options.noteOpen} 件` : 'このスペースのメモ', icon: NotebookPen, onPress: options.onNote });
	if (options.activityHint !== undefined && options.onActivity !== undefined) {
		actions.push({ label: 'サブエージェント', hint: options.activityHint, icon: Users, onPress: options.onActivity });
	}
	return actions;
}

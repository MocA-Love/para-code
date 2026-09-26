// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Ionicons } from '@expo/vector-icons';

/** ホームのエージェント行の操作メニューで選べるもの。 */
export type HomeAgentMenuAction = 'rename' | 'pin' | 'ack' | 'archive' | 'delete';

/** メニューを開いた対象。 */
export interface HomeAgentMenuTarget {
	readonly terminalKey: string;
	readonly title: string;
	readonly pinned: boolean;
	/**
	 * どこから開いたか。`list` は一覧の行（スワイプで出す「確認済み」「アーカイブ」もメニューに出す）、
	 * `attention` は要対応スタックの行（回答して解消するもので、アーカイブしても自動で戻ってくるため
	 * 片付ける操作は出さない。スタックの行にはスワイプも付いていない）。
	 */
	readonly origin: 'list' | 'attention';
}

export interface HomeAgentMenuItem {
	readonly action: HomeAgentMenuAction;
	readonly label: string;
	readonly icon: keyof typeof Ionicons.glyphMap;
	readonly destructive?: boolean;
}

/**
 * メニューに出す項目と並び。削除は取り消せないので必ず最後に置く。
 *
 * 「確認済みにする」は一覧のスワイプと同じく状態を問わず出す（スワイプ側の決定D:
 * 行によって項目が変わると、手が覚えられない）。
 */
export function homeAgentMenuItems(target: Pick<HomeAgentMenuTarget, 'pinned' | 'origin'>): HomeAgentMenuItem[] {
	const items: HomeAgentMenuItem[] = [
		{ action: 'rename', label: '名前を変更', icon: 'pencil' },
		{ action: 'pin', label: target.pinned ? 'ピン留めを解除' : 'ピン留め', icon: target.pinned ? 'bookmark' : 'bookmark-outline' },
	];
	if (target.origin === 'list') {
		items.push(
			{ action: 'ack', label: '確認済みにする', icon: 'eye-outline' },
			{ action: 'archive', label: 'アーカイブ', icon: 'file-tray-full-outline' },
		);
	}
	items.push({ action: 'delete', label: '削除', icon: 'trash-outline', destructive: true });
	return items;
}

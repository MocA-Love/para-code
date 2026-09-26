// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useRef, type ReactNode } from 'react';
import { BottomDrawer } from './bottomDrawer.js';
import { DrawerCaption } from './drawerHeader.js';
import { ListGroup, ListRow } from './listRow.js';
import type { LucideIcon } from './icon.js';

export interface ActionSheetAction {
	/** 行の識別子（省略時はラベル）。同じラベルの行を並べるときだけ渡す。 */
	readonly key?: string;
	readonly label: string;
	/** ラベルの下の補足（12pt）。 */
	readonly hint?: string;
	/** 行の頭のアイコン（16pt）。 */
	readonly icon?: LucideIcon;
	/** アイコンの代わりに置くもの（エージェントのロゴなど）。 */
	readonly leading?: ReactNode;
	/** 削除など取り消しにくい操作（赤くする）。 */
	readonly destructive?: boolean;
	readonly disabled?: boolean;
	/** いま選ばれている印（右端のチェック）。 */
	readonly selected?: boolean;
	/**
	 * 押したときの処理。**既定ではシートが閉じ切ってから呼ぶ**（別のシートを開く・画面を移る
	 * 操作が、閉じる途中のモーダルに邪魔されないように）。すぐ呼びたいときは `immediate` を付ける。
	 */
	readonly onPress: () => void;
	readonly immediate?: boolean;
}

/**
 * 操作の一覧を出すシート（Orca の ActionSheetModal、モックの長押しメニュー・⋯メニュー）。
 * アイコン16＋ラベル14（＋補足12）の行を束ねて出す。破壊的な操作は赤。
 *
 * ```tsx
 * <ActionSheet
 *   visible={open}
 *   title="fix/login"
 *   actions={[
 *     { label: '名前を変更', icon: Pencil, onPress: startRename },
 *     { label: '削除', icon: Trash2, destructive: true, onPress: confirmDelete },
 *   ]}
 *   onClose={() => setOpen(false)}
 * />
 * ```
 */
export function ActionSheet({ visible, title, message, actions, onClose }: {
	visible: boolean;
	/** 何についての操作か（13pt の弱い灰）。 */
	title?: string;
	message?: string;
	actions: readonly ActionSheetAction[];
	onClose: () => void;
}) {
	const pending = useRef<(() => void) | undefined>(undefined);
	return (
		<BottomDrawer
			visible={visible}
			onClose={onClose}
			onAfterClose={() => {
				const run = pending.current;
				pending.current = undefined;
				run?.();
			}}
			accessibilityLabel={title}
		>
			<DrawerCaption title={title} message={message} />
			<ListGroup>
				{actions.map(action => (
					<ListRow
						key={action.key ?? action.label}
						label={action.label}
						hint={action.hint}
						icon={action.icon}
						leading={action.leading}
						destructive={action.destructive}
						disabled={action.disabled}
						selected={action.selected}
						trailing={action.selected === true ? 'check' : 'none'}
						onPress={() => {
							if (action.immediate === true) {
								action.onPress();
							} else {
								pending.current = action.onPress;
							}
							onClose();
						}}
					/>
				))}
			</ListGroup>
		</BottomDrawer>
	);
}

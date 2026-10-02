// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import { haptic } from '../haptics.js';
import { BottomDrawer } from './bottomDrawer.js';
import { DrawerCaption } from './drawerHeader.js';
import { ListGroup, ListRow } from './listRow.js';
import type { LucideIcon } from './icon.js';

export interface PickerOption<T extends string = string> {
	readonly value: T;
	readonly label: string;
	/** ラベルの下の補足（12pt）。 */
	readonly hint?: string;
	readonly icon?: LucideIcon;
	/** アイコンの代わりに置くもの（状態の点・スペースの色・エージェントのロゴなど）。 */
	readonly leading?: ReactNode;
	readonly disabled?: boolean;
}

/**
 * 1つを選ぶシート（Orca の PickerModal、モックの並び替え・モデル・文字サイズ）。
 * 選ばれている行の右端にチェックを出す。行を押すと `onSelect` を呼んでから閉じる。
 *
 * ```tsx
 * <PickerDrawer
 *   visible={open}
 *   title="並び替え"
 *   options={[{ value: 'smart', label: 'エージェントの動き', hint: '要対応のエージェント、次に最近の動き' }, ...]}
 *   selected={sort}
 *   onSelect={setSort}
 *   onClose={() => setOpen(false)}
 * />
 * ```
 */
export function PickerDrawer<T extends string = string>({ visible, title, message, options, selected, onSelect, onClose, onAfterClose }: {
	visible: boolean;
	title?: string;
	message?: string;
	options: readonly PickerOption<T>[];
	selected: T | undefined;
	onSelect: (value: T) => void;
	onClose: () => void;
	/** 閉じ切った後。選んだ値で次のシートを開くときはここで。 */
	onAfterClose?: () => void;
}) {
	return (
		<BottomDrawer visible={visible} onClose={onClose} onAfterClose={onAfterClose} accessibilityLabel={title}>
			<DrawerCaption title={title} message={message} />
			<ListGroup>
				{options.map(option => (
					<ListRow
						key={option.value}
						label={option.label}
						hint={option.hint}
						icon={option.icon}
						leading={option.leading}
						disabled={option.disabled}
						selected={option.value === selected}
						trailing={option.value === selected ? 'check' : 'none'}
						onPress={() => {
							// 値が 1 段変わった手応え（閉じる move はこの直後なので重ねない）
							if (option.value !== selected) {
								haptic('tick');
							}
							onSelect(option.value);
							onClose();
						}}
					/>
				))}
			</ListGroup>
		</BottomDrawer>
	);
}

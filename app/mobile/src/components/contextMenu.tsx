// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import React, { useCallback, useMemo, useState, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { ParaContextMenuView, type ParaContextMenuItem } from '../../modules/para-context-menu/index.js';
import { haptic } from '../haptics.js';
import { colors, radius } from '../theme.js';
import { AlignLeft, Code, Copy, ExternalLink, FileDiff, FileText, Folder, HardDrive, Hash, Minus, PencilLine, Plus, Quote, Search, Share, TextCursorInput, Type } from 'lucide-react-native';
import { ActionSheet, type ActionSheetAction, type LucideIcon } from '../ui/index.js';
import { findContextMenuAction, type ContextMenuAction, type ContextMenuIcon, type ContextMenuSpec } from './contextMenuModel.js';

export type { ContextMenuAction, ContextMenuSpec } from './contextMenuModel.js';

/**
 * 行や発言の長押し（iPad ではポインタの右クリックも）で出すメニュー（Q548 案 A）。
 *
 * - ネイティブの部品（`modules/para-context-menu`）が入ったビルドでは、iOS 標準のコンテキストメニューを出す
 * - 入っていない古いビルドでは、行の `onLongPress` からアプリのシート（`ActionSheet`）で同じ項目を出す
 *   （{@link useContextMenuSheet}）。会話の発言は今の「長押しで全文コピー」のまま（シートは出さない）
 *
 * ネイティブの有無はビルドで決まり、実行中に変わらないので、どちらの形でも木の形は変わらない。
 */

/** アイコンの対応（ネイティブは SF Symbols、シートは lucide）。 */
const ICONS: Readonly<Record<ContextMenuIcon, { readonly systemImage: string; readonly icon: LucideIcon }>> = {
	copy: { systemImage: 'doc.on.doc', icon: Copy },
	markdown: { systemImage: 'number', icon: Hash },
	paragraph: { systemImage: 'text.alignleft', icon: AlignLeft },
	code: { systemImage: 'chevron.left.forwardslash.chevron.right', icon: Code },
	select: { systemImage: 'text.cursor', icon: TextCursorInput },
	share: { systemImage: 'square.and.arrow.up', icon: Share },
	name: { systemImage: 'textformat', icon: Type },
	path: { systemImage: 'folder', icon: Folder },
	absolutePath: { systemImage: 'externaldrive', icon: HardDrive },
	open: { systemImage: 'doc.text', icon: FileText },
	diff: { systemImage: 'plusminus', icon: FileDiff },
	stage: { systemImage: 'plus.circle', icon: Plus },
	unstage: { systemImage: 'minus.circle', icon: Minus },
	hash: { systemImage: 'number', icon: Hash },
	subject: { systemImage: 'text.quote', icon: AlignLeft },
	browser: { systemImage: 'safari', icon: ExternalLink },
	note: { systemImage: 'square.and.pencil', icon: PencilLine },
	line: { systemImage: 'text.alignleft', icon: AlignLeft },
	quote: { systemImage: 'arrowshape.turn.up.left', icon: Quote },
	search: { systemImage: 'magnifyingglass', icon: Search },
};

/** ネイティブのメニューが使えるビルドか（iOS でモジュールが入っている）。 */
export const nativeContextMenuAvailable = ParaContextMenuView !== undefined;

function toNativeItems(actions: readonly ContextMenuAction[]): ParaContextMenuItem[] {
	return actions.map(action => ({
		id: action.id,
		title: action.title,
		...(action.subtitle !== undefined ? { subtitle: action.subtitle } : {}),
		...(action.icon !== undefined ? { systemImage: ICONS[action.icon].systemImage } : {}),
		...(action.startsSection === true ? { startsSection: true } : {}),
		...(action.disabled === true ? { disabled: true } : {}),
		...(action.destructive === true ? { destructive: true } : {}),
		...(action.children !== undefined && action.children.length > 0 ? {
			children: action.children.map(child => ({
				id: child.id,
				title: child.title,
				...(child.subtitle !== undefined ? { subtitle: child.subtitle } : {}),
				...(child.icon !== undefined ? { systemImage: ICONS[child.icon].systemImage } : {}),
				...(child.disabled === true ? { disabled: true } : {}),
			})),
		} : {}),
	}));
}

/**
 * 子を包み、ネイティブのメニューが使えるビルドでは長押しでメニューを出す。使えないビルドでは `View` で包むだけ
 * （長押しは呼び出し側の `onLongPress` が {@link useContextMenuSheet} のシートを出す）。
 * `menu` が無いあいだはメニューを出さない（木の形は変えない）。
 */
export function ContextMenu({ menu, style, previewRadius = radius.control, previewBackground = colors.bg, children }: {
	menu: ContextMenuSpec | undefined;
	style?: StyleProp<ViewStyle>;
	/** 浮き上がる形の角丸。包んだ部品の角丸に合わせる。 */
	previewRadius?: number;
	/** 浮き上がる形の地の色（既定はアプリの地の色。地を持つ部品なら `transparent`）。 */
	previewBackground?: string;
	children: ReactNode;
}) {
	const items = useMemo(() => toNativeItems(menu?.actions ?? []), [menu]);
	const Native = ParaContextMenuView;
	if (Native === undefined) {
		return <View style={style}>{children}</View>;
	}
	return (
		<Native
			items={items}
			title={[menu?.title, menu?.message].filter(part => part !== undefined && part.length > 0).join('\n')}
			previewCornerRadius={previewRadius}
			previewBackgroundColor={previewBackground}
			onSelect={event => {
				const action = menu !== undefined ? findContextMenuAction(menu.actions, event.nativeEvent.id) : undefined;
				if (action !== undefined && action.disabled !== true) {
					haptic('tick');
					action.onSelect?.();
				}
			}}
			style={style}
		>
			{children}
		</Native>
	);
}

/** シートの行に直す（入れ子は親の名前を補足にして平らに並べる）。 */
export function contextMenuSheetActions(menu: ContextMenuSpec | undefined): ActionSheetAction[] {
	const rows: ActionSheetAction[] = [];
	for (const action of menu?.actions ?? []) {
		const entries = action.children !== undefined && action.children.length > 0
			? action.children.map(child => ({ ...child, subtitle: child.subtitle ?? action.title, icon: child.icon ?? action.icon }))
			: [action];
		for (const entry of entries) {
			rows.push({
				key: entry.id,
				label: entry.title,
				...(entry.subtitle !== undefined ? { hint: entry.subtitle } : {}),
				...(entry.icon !== undefined ? { icon: ICONS[entry.icon].icon } : {}),
				...(entry.disabled === true ? { disabled: true } : {}),
				...(entry.destructive === true ? { destructive: true } : {}),
				onPress: () => entry.onSelect?.(),
			});
		}
	}
	return rows;
}

/**
 * ネイティブのメニューが無いビルドで、長押しで出すアプリのシート（画面に 1 つ）。
 * `longPress(menu)` を行の `onLongPress` に渡す。ネイティブのメニューがあるビルドでは `undefined` を返す
 * （長押しはネイティブのメニューが受ける）。`sheet` は画面の木に必ず置く（初めて開くまでは何も描かない。会話の発言ごとに
 * 置いても、開かないかぎり重くならない）。
 */
export function useContextMenuSheet(): { longPress: (menu: ContextMenuSpec | undefined) => (() => void) | undefined; sheet: ReactNode } {
	const [menu, setMenu] = useState<ContextMenuSpec | undefined>();
	const [visible, setVisible] = useState(false);
	const longPress = useCallback((next: ContextMenuSpec | undefined) => {
		if (nativeContextMenuAvailable || next === undefined || next.actions.length === 0) {
			return undefined;
		}
		return () => {
			haptic('lift');
			setMenu(next);
			setVisible(true);
		};
	}, []);
	const sheet = menu === undefined ? null : <ActionSheet visible={visible} title={menu.title} message={menu.message} actions={contextMenuSheetActions(menu)} onClose={() => setVisible(false)} />;
	return { longPress, sheet };
}

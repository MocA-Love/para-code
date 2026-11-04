// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ComponentType, ReactNode } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

/** メニュー1項目。`children` を持たせると入れ子（submenu）になる。 */
export interface ParaContextMenuItem {
	/** 選択されたときに `onSelect` で返る識別子。 */
	id: string;
	title: string;
	/** タイトルの下の補足（1行）。 */
	subtitle?: string;
	/** SF Symbols の名前。 */
	systemImage?: string;
	/** この項目の**前**に区切り線を入れる。 */
	startsSection?: boolean;
	/** 押せない（薄く出す）。理由は `subtitle` に書く。 */
	disabled?: boolean;
	/** 赤く出す。 */
	destructive?: boolean;
	/** 入れ子の項目（1段だけ）。 */
	children?: { id: string; title: string; subtitle?: string; systemImage?: string; disabled?: boolean }[];
}

export interface ParaContextMenuProps {
	items: ParaContextMenuItem[];
	/** メニューの上に出す見出し（ファイルの相対パスなど）。 */
	title?: string;
	/** 浮き上がる形の角丸（pt）。 */
	previewCornerRadius?: number;
	/** 浮き上がる形の地の色（背景が透明な行が地ごと浮くように）。 */
	previewBackgroundColor?: string;
	onSelect?: (event: { nativeEvent: { id: string } }) => void;
	style?: StyleProp<ViewStyle>;
	children?: ReactNode;
}

/**
 * RN の子を包み、長押し（iPad ではポインタの右クリックも）で iOS 標準のコンテキストメニュー
 * （`UIContextMenuInteraction`）を出すビュー。詳しくは `ios/ParaContextMenuView.swift` の説明を参照。
 *
 * 古いバイナリ（このモジュールを含まないビルド）でJSだけ更新された場合に備え、
 * 解決できなければ `undefined` を返す。呼び出し側は今の動き（長押しのコピー、またはアプリのシート）へ戻す。
 *
 * `requireNativeView` はモジュール不在でも例外を投げずにコンポーネントを返してしまう
 * （不在の検出はレンダー時まで遅れる）ため、先に `requireOptionalNativeModule` で
 * ネイティブモジュールの実在を確かめる（`para-plus-menu` と同じ）。
 */
export const ParaContextMenuView: ComponentType<ParaContextMenuProps> | undefined = (() => {
	if (Platform.OS !== 'ios') {
		return undefined;
	}
	try {
		if (requireOptionalNativeModule('ParaContextMenu') === null) {
			return undefined;
		}
		return requireNativeView<ParaContextMenuProps>('ParaContextMenu');
	} catch {
		return undefined;
	}
})();

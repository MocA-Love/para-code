// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ComponentType } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

/** メニュー1項目。`children` を持たせると入れ子（submenu）になる。 */
export interface ParaPlusMenuItem {
	/** 選択されたときに `onSelect` で返る識別子。 */
	id: string;
	title: string;
	/** SF Symbols の名前。 */
	systemImage?: string;
	/** この項目の**前**に区切り線を入れる。 */
	startsSection?: boolean;
	/** 入れ子の項目（1段だけ）。 */
	children?: { id: string; title: string; systemImage?: string }[];
}

export interface ParaPlusMenuProps {
	items: ParaPlusMenuItem[];
	/** ボタンの読み上げラベル。 */
	accessibilityTitle?: string;
	onSelect?: (event: { nativeEvent: { id: string } }) => void;
	style?: StyleProp<ViewStyle>;
}

/**
 * ＋ボタン（`UIButton` ＋ 標準の `UIMenu`）。
 *
 * メニューの提示をOSに任せることで、iOS 26 のボタン→メニューのモーフ（液体の変形・ばね・
 * 中身のピント送り）がそのまま手に入る。詳しくは `ios/ParaPlusMenuView.swift` の説明を参照。
 *
 * 古いバイナリ（このモジュールを含まないビルド）でJSだけ更新された場合に備え、
 * 解決できなければ `undefined` を返す。呼び出し側はRN製のメニューへフォールバックする。
 *
 * `requireNativeView` はモジュール不在でも例外を投げずにコンポーネントを返してしまう
 * （不在の検出はレンダー時まで遅れる）ため、先に `requireOptionalNativeModule` で
 * ネイティブモジュールの実在を確かめる。
 */
export const ParaPlusMenuButton: ComponentType<ParaPlusMenuProps> | undefined = (() => {
	if (Platform.OS !== 'ios') {
		return undefined;
	}
	try {
		if (requireOptionalNativeModule('ParaPlusMenu') === null) {
			return undefined;
		}
		return requireNativeView<ParaPlusMenuProps>('ParaPlusMenu');
	} catch {
		return undefined;
	}
})();

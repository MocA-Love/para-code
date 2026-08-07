// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ComponentType } from 'react';
import { Platform, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { requireNativeView, requireOptionalNativeModule } from 'expo';

export interface ParaGlassMorphProps {
	/** 開いているか。変化するとネイティブ側がspringでカプセル⇄パネルをモーフさせる。 */
	isExpanded: boolean;
	pillWidth: number;
	pillHeight: number;
	panelWidth: number;
	panelHeight: number;
	panelCornerRadius: number;
	/** パネルの色被せ（#RRGGBBAA）。空文字なら被せない。 */
	panelTint?: string;
	expandDuration?: number;
	expandBounce?: number;
	collapseDuration?: number;
	collapseBounce?: number;
	style?: StyleProp<ViewStyle>;
	pointerEvents?: ViewProps['pointerEvents'];
}

/**
 * ＋メニューのガラスの形（ネイティブモーフ）。
 *
 * 古いバイナリ（このモジュールを含まないビルド）でJSだけ更新された場合に備え、
 * 解決できなければ undefined を返す。呼び出し側はJS駆動のモーフへフォールバックする。
 *
 * `requireNativeView` はモジュール不在でも例外を投げずにコンポーネントを返してしまう
 * （不在の検出はレンダー時まで遅れる）ため、先に `requireOptionalNativeModule` で
 * ネイティブモジュールの実在を確かめる。
 */
export const ParaGlassMorphShape: ComponentType<ParaGlassMorphProps> | undefined = (() => {
	if (Platform.OS !== 'ios') {
		return undefined;
	}
	try {
		if (requireOptionalNativeModule('ParaGlassMorph') === null) {
			return undefined;
		}
		return requireNativeView<ParaGlassMorphProps>('ParaGlassMorph');
	} catch {
		return undefined;
	}
})();

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { NativePointerHover } from '../../modules/para-ipad-input/index.js';
import { isTablet } from '../hooks/useSizeClass.js';

/**
 * iPad のポインタ（トラックパッド・マウス）を乗せたときの効果（iPadOS 標準の UIPointerInteraction）。
 *  - `highlight`: 小さいボタン。ポインタがボタンの形になって少し浮く
 *  - `tint`: 行。ポインタの形は変えず、薄い色を重ねるだけ
 *
 * iPad では中身をネイティブの入れ物で包む。入れ物は中身の大きさに縮むので、中身が `flex: 1` などで
 * 親に合わせて伸びる場合は同じ指定を `style` に渡す。iPhone とモジュールの無いビルドでは包まずに中身をそのまま
 * 返す（端末で決まるので、実行中に木の形は変わらない）。
 */
export function PointerHover({ effect, cornerRadius, style, children }: {
	effect: 'highlight' | 'tint';
	cornerRadius?: number;
	style?: StyleProp<ViewStyle>;
	children: ReactNode;
}) {
	if (!isTablet || NativePointerHover === undefined) {
		return <>{children}</>;
	}
	return (
		<NativePointerHover effect={effect} {...(cornerRadius !== undefined ? { cornerRadius } : {})} style={style}>
			{children}
		</NativePointerHover>
	);
}

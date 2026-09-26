// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { LucideIcon } from 'lucide-react-native';
import { colors } from '../theme.js';

export type { LucideIcon };

/** Orca の線の太さ（lucide の既定）。 */
export const ICON_STROKE = 2;

/**
 * アイコンの大きさの段（Orca のモックで使っている値）。数字を画面ごとに発明しない。
 *  - `xs` 12: チップ・行のメタ情報の中
 *  - `sm` 14: シートの選択肢の横・小さい補足
 *  - `md` 16: 既定。行の頭・シートの操作・ツールバー
 *  - `lg` 18: ヘッダーの右の操作
 *  - `back` 22: 戻る（山かっこ）
 *  - `xl` 28: 空の状態
 */
export const iconSize = { xs: 12, sm: 14, md: 16, lg: 18, back: 22, xl: 28 } as const;

/**
 * lucide のアイコンを Orca の既定（16pt・線2・補足の灰）で描く薄いラッパー。
 *
 * アイコンは部品そのもの（`import { Bell } from 'lucide-react-native'`）を渡す。名前の文字列で
 * 引く対応表を作らないのは、使っていないアイコンまで束ねてしまうのと、名前の打ち間違いを
 * 型で止められないため。
 *
 * ```tsx
 * <Icon icon={Bell} size={iconSize.lg} />
 * <Icon icon={Trash2} color={colors.red} />
 * ```
 */
export function Icon({ icon: Glyph, size = iconSize.md, color = colors.textDim, strokeWidth = ICON_STROKE, fill }: {
	icon: LucideIcon;
	size?: number;
	color?: string;
	strokeWidth?: number;
	/** 塗りつぶす（未読のベルなど）。既定は塗らない。 */
	fill?: string;
}) {
	return <Glyph size={size} color={color} strokeWidth={strokeWidth} fill={fill ?? 'none'} />;
}

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { colors } from '../../theme.js';

/**
 * スペースの色（行のフォルダのアイコン・見出し・再開カードの点）。PC 側が色を送っていればそれを、
 * 無ければ ID から安定して決める。
 *
 * **旧 `src/components/wsDrawer.tsx` の `wsColor` と同じ規則**（同じスペースが旧画面と同じ色になる）。
 * wsDrawer はドロワー全体（ヘッダー層・ガラス・ジェスチャ）を読み込むので新しい画面からは引かず、
 * 段階8で wsDrawer を消すときにこちらへ一本化する。
 */
const PALETTE = [colors.accent, colors.purple, colors.green, colors.orange, colors.yellow, colors.red] as const;

export function spaceColor(space: { readonly id: string; readonly color?: string }): string {
	if (space.color !== undefined && space.color.length > 0) {
		return space.color;
	}
	let hash = 0;
	for (let i = 0; i < space.id.length; i++) {
		hash = (hash * 31 + space.id.charCodeAt(i)) >>> 0;
	}
	return PALETTE[hash % PALETTE.length] ?? colors.accent;
}

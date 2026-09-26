// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { agentStatusKind, agentStatusLabel } from '../agentStatus.js';
import type { SizeClass } from '../sizeClass.js';
import { status } from '../theme.js';

export const COMPACT_TERMINAL_MENU_WIDTH = 44;
export const TERMINAL_PICK_PREFIX = 'pick:';
export const TERMINAL_PRESETS_ACTION_ID = 'presets';
export const TERMINAL_CREATE_ACTION_ID = 'new-terminal';

export type TerminalNativeHeaderLayout =
	| { readonly kind: 'compact-menu'; readonly headerItemCount: 1; readonly itemWidth: 44 }
	| { readonly kind: 'regular-actions'; readonly headerItemCount: 3 };

export type TerminalCompactMenuAction =
	| { readonly kind: 'terminal'; readonly terminalKey: string }
	| { readonly kind: 'presets' }
	| { readonly kind: 'create' };

export type TerminalFallbackPlacement = 'body' | 'none';

export function terminalNativeHeaderLayout(sizeClass: SizeClass): TerminalNativeHeaderLayout {
	return sizeClass === 'compact'
		? { kind: 'compact-menu', headerItemCount: 1, itemWidth: COMPACT_TERMINAL_MENU_WIDTH }
		: { kind: 'regular-actions', headerItemCount: 3 };
}

export function terminalFallbackPlacement(nativeMenuAvailable: boolean, terminalCount: number): TerminalFallbackPlacement {
	return !nativeMenuAvailable && terminalCount > 0 ? 'body' : 'none';
}

export function decodeTerminalCompactMenuAction(id: string): TerminalCompactMenuAction | undefined {
	if (id.startsWith(TERMINAL_PICK_PREFIX)) {
		const terminalKey = id.slice(TERMINAL_PICK_PREFIX.length);
		return terminalKey.length > 0 ? { kind: 'terminal', terminalKey } : undefined;
	}
	if (id === TERMINAL_PRESETS_ACTION_ID) {
		return { kind: 'presets' };
	}
	if (id === TERMINAL_CREATE_ACTION_ID) {
		return { kind: 'create' };
	}
	return undefined;
}

/** 状態の判定に使う、ターミナル1件ぶんの材料（`TerminalPickerEntry` の一部）。 */
export interface TerminalStatusSource {
	readonly terminalKey: string;
	readonly index: number;
	readonly title: string;
	readonly waiting: boolean;
	readonly working: boolean;
	/** PC から届いた生の状態。あれば `agentStatus.ts` の呼び名（許可待ち・質問 など）を使う。 */
	readonly agentStatus?: string;
}

/** 見ているもの以外で、要対応（許可待ち・質問）のターミナルの件数。 */
export function otherAttentionCount(entries: readonly TerminalStatusSource[], activeKey: string | undefined): number {
	return entries.filter(entry => entry.waiting && entry.terminalKey !== activeKey).length;
}

/**
 * 島の副題。他のターミナルに要対応があれば件数を頭に付ける（例: 「他 1 件 要対応 · feat/auth」）。
 * 無ければ `undefined`（島は既定どおりブランチ名を出す）。
 *
 * 件数を先に置くのは、幅が足りずに末尾が省略されたとき、消えるのをブランチ名の側にするため。
 */
export function terminalAttentionSubtitle(count: number, branch: string | undefined): string | undefined {
	if (count <= 0) {
		return undefined;
	}
	const attention = `他 ${count} 件 ${status.attention.label}`;
	return branch !== undefined && branch !== '' ? `${attention} · ${branch}` : attention;
}

/**
 * ターミナルの状態の呼び名。手が空いている（待機）ときは `undefined`。
 * 生の状態があれば `agentStatus.ts` の呼び名、無ければ要対応／実行中の2値から決める。
 */
export function terminalEntryStatusLabel(entry: TerminalStatusSource): string | undefined {
	if (entry.agentStatus !== undefined) {
		return agentStatusKind(entry.agentStatus) === 'idle' ? undefined : agentStatusLabel(entry.agentStatus);
	}
	return entry.waiting ? status.attention.label : entry.working ? status.running.label : undefined;
}

/**
 * 切り替えメニューの項目名。以前は状態を記号（`?`＝応答待ち、`▶`＝実行中）で示していたが、
 * 記号の意味を覚えていないと読めないため、他の画面と同じ呼び名を文字で添える。
 * メニューの項目は色を持てない（`systemImage` は単色）ので、区別は文字だけで付ける。
 */
export function terminalMenuItemTitle(entry: TerminalStatusSource): string {
	const label = terminalEntryStatusLabel(entry);
	return label !== undefined ? `${entry.index}: ${entry.title}（${label}）` : `${entry.index}: ${entry.title}`;
}

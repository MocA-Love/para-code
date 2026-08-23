// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { SizeClass } from '../sizeClass.js';

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

export function terminalNativeHeaderLayout(sizeClass: SizeClass): TerminalNativeHeaderLayout {
	return sizeClass === 'compact'
		? { kind: 'compact-menu', headerItemCount: 1, itemWidth: COMPACT_TERMINAL_MENU_WIDTH }
		: { kind: 'regular-actions', headerItemCount: 3 };
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

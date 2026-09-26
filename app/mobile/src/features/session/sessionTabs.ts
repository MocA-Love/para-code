// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ResolvedSessionTab, SpaceTerminal } from '../../navigationTargets.js';
import { encodeSessionTab, type SessionTab } from '../../routes.js';

/**
 * セッション画面のタブの列（Orca の MobileSessionHeader の 128×36 のタブ）に並べるもの。
 * このスペースのターミナル（エージェントを含む。PC から届いた順）と、末尾にブラウザ。
 *
 * 画面から切り離した純関数にして、並びと選択の決まりをテストで固定する（`sessionTabs.test.ts`）。
 */

export type SessionTabItem =
	| {
		readonly kind: 'terminal';
		/** タブの識別子（ルートのクエリの値と同じ `terminal:<terminalKey>`）。 */
		readonly key: string;
		readonly tab: SessionTab;
		readonly terminal: SpaceTerminal;
		readonly title: string;
		/** エージェント（claude / codex）が動いた実績のあるターミナルか。 */
		readonly agent: boolean;
	}
	| {
		readonly kind: 'browser';
		readonly key: string;
		readonly tab: SessionTab;
		readonly title: string;
	};

const BROWSER_TAB: SessionTab = { kind: 'browser' };
export const BROWSER_TAB_TITLE = 'ブラウザ';

/** タブの列。ターミナルは PC から届いた順のまま、ブラウザは常に末尾。 */
export function buildSessionTabs(terminals: readonly SpaceTerminal[]): SessionTabItem[] {
	const items: SessionTabItem[] = terminals.map(terminal => {
		const tab: SessionTab = { kind: 'terminal', terminalKey: terminal.terminalKey };
		return {
			kind: 'terminal',
			key: encodeSessionTab(tab),
			tab,
			terminal,
			title: terminal.title.trim().length > 0 ? terminal.title : 'ターミナル',
			agent: terminal.agent === true,
		};
	});
	items.push({ kind: 'browser', key: encodeSessionTab(BROWSER_TAB), tab: BROWSER_TAB, title: BROWSER_TAB_TITLE });
	return items;
}

/** いま開いているタブの識別子（読み込み中・見つからないときは undefined）。 */
export function activeTabKey(resolved: ResolvedSessionTab): string | undefined {
	if (resolved.status === 'browser') {
		return encodeSessionTab(BROWSER_TAB);
	}
	if (resolved.status === 'terminal') {
		return encodeSessionTab({ kind: 'terminal', terminalKey: resolved.terminal.terminalKey });
	}
	return undefined;
}

/**
 * タブを閉じたあとに開くタブ。閉じるのが今のタブでなければ今のまま（undefined＝移らない）。
 * 今のタブなら右隣、右端なら左隣のターミナル。ターミナルが残らなければ undefined
 * （画面は空の状態を出す）。ブラウザへは移さない（閉じた直後にミラーを張り始めないため）。
 */
export function tabAfterClose(items: readonly SessionTabItem[], closingKey: string, currentKey: string | undefined): SessionTab | undefined {
	if (closingKey !== currentKey) {
		return undefined;
	}
	const terminals = items.filter(item => item.kind === 'terminal');
	const index = terminals.findIndex(item => item.key === closingKey);
	if (index < 0) {
		return undefined;
	}
	return (terminals[index + 1] ?? terminals[index - 1])?.tab;
}

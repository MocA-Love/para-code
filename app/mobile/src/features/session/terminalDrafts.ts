// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { create } from 'zustand';

/**
 * ターミナルの入力欄の書きかけ（ターミナルごと）。タブや表示を切り替えるとペインは作り直されるので、
 * 書きかけはペインの外に置く。端末には保存しない（アプリを閉じれば消える。旧画面と同じ扱い）。
 *
 * 鍵は `terminalDraftKey(pcId, terminalKey)`（PC をまたいで同じ鍵のターミナルがあっても混ざらないように）。
 */
export type TerminalDrafts = Readonly<Record<string, string>>;

export function terminalDraftKey(pcId: string | undefined, terminalKey: string): string {
	return `${pcId ?? ''}\u0000${terminalKey}`;
}

/** 書きかけを差し替えた新しい一覧。空にしたら鍵ごと消す。 */
export function withTerminalDraft(drafts: TerminalDrafts, key: string, text: string): TerminalDrafts {
	if (text.length === 0) {
		if (!(key in drafts)) {
			return drafts;
		}
		const { [key]: _removed, ...rest } = drafts;
		return rest;
	}
	return drafts[key] === text ? drafts : { ...drafts, [key]: text };
}

interface TerminalDraftStore {
	readonly drafts: TerminalDrafts;
	/** 書きかけを更新する（関数を渡すといまの値から作る）。 */
	update(key: string, next: string | ((current: string) => string)): void;
}

export const useTerminalDrafts = create<TerminalDraftStore>((set, get) => ({
	drafts: {},
	update(key, next) {
		const drafts = get().drafts;
		const text = typeof next === 'function' ? next(drafts[key] ?? '') : next;
		const updated = withTerminalDraft(drafts, key, text);
		if (updated !== drafts) {
			set({ drafts: updated });
		}
	},
}));

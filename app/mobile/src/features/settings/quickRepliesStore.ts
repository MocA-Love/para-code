// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useEffect } from 'react';
import { create } from 'zustand';
import { secureKeyStore } from '../../platform.js';
import { DEFAULT_QUICK_REPLIES, parseQuickReplies, serializeQuickReplies } from './quickReplies.js';

/**
 * クイック返信の一覧の保存先（Keychain。ほかの端末ローカルの設定と同じ `secureKeyStore`）。
 * この端末の中だけの設定で、PC へは送らない。形の判定は `quickReplies.ts`。
 */
const QUICK_REPLIES_KEY = 'quick-replies';

interface QuickRepliesState {
	/** いまの一覧。読み込む前・保存が無いときは既定。 */
	readonly replies: readonly string[];
	/** 読み込みを1度試し終えたか（読めなかった場合も true）。会話画面はこれが立つまでチップを出さない。 */
	readonly settled: boolean;
	load(): Promise<void>;
	/** 一覧を保存する。保存に失敗したら reject（一覧は元のまま）。 */
	save(list: readonly string[]): Promise<void>;
	/** 保存を消して既定に戻す。以降の版で既定が変わればそれに付いていく。 */
	reset(): Promise<void>;
}

let loading: Promise<void> | undefined;

export const useQuickReplies = create<QuickRepliesState>(set => ({
	replies: DEFAULT_QUICK_REPLIES,
	settled: false,
	load() {
		loading ??= secureKeyStore.getItem(QUICK_REPLIES_KEY).then(raw => {
			set({ replies: parseQuickReplies(raw) ?? DEFAULT_QUICK_REPLIES, settled: true });
		}).catch((error: unknown) => {
			// Keychain がロック中などで読めないときは既定で動かし、次に開いたときに読み直す。
			console.warn('[quick-replies] failed to load', error);
			loading = undefined;
			set({ settled: true });
		});
		return loading;
	},
	async save(list) {
		await secureKeyStore.setItem(QUICK_REPLIES_KEY, serializeQuickReplies(list));
		set({ replies: list, settled: true });
	},
	async reset() {
		await secureKeyStore.deleteItem(QUICK_REPLIES_KEY);
		set({ replies: DEFAULT_QUICK_REPLIES, settled: true });
	},
}));

/**
 * 会話画面・設定画面で使う一覧。読み込み前は undefined（既定をちらっと見せてから差し替えない）。
 * 読み込みは最初に使ったときに始める（何度呼んでも1回だけ読む）。
 */
export function useQuickReplyList(): readonly string[] | undefined {
	const replies = useQuickReplies(s => s.replies);
	const settled = useQuickReplies(s => s.settled);
	const load = useQuickReplies(s => s.load);
	useEffect(() => { void load(); }, [load]);
	return settled ? replies : undefined;
}

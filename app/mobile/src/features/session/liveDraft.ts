// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { AgentChatMessage, AgentLiveState } from '../../store.js';

/**
 * 書いている最中の返信（Claude Code の生成中の文。Q657 案 C）を、会話の末尾にどう出すか。UI を持たない純粋な関数だけを置く。
 *
 * 改行で確定した行は地の文（Markdown）で、書きかけの 1 行だけを弱い色の文字で出す（モック mobile-streaming-2026-11-17 の案 C の
 * `liveBlock`）。Markdown として読み直すのは確定した所だけなので、閉じていない表やコードが途中で崩れて見えない。
 */
export interface LiveDraftParts {
	/** 改行で確定した行（Markdown で描く）。コードブロックの途中なら書きかけの行も含め、フェンスを閉じてある。 */
	readonly committed: string;
	/** 書きかけの 1 行（弱い色の文字）。コードブロックの途中・書き終わった（final）ときは空。箇条の印は「• 」にしてある。 */
	readonly tail: string;
	/** コードブロックの途中か（書きかけの行をコードの枠の中に置いた）。 */
	readonly inCode: boolean;
	/** 末尾にカーソルを出すか（書き終わった final では出さない）。 */
	readonly caret: boolean;
}

const FENCE = '```';

/** 書いている最中の文を、確定した行と書きかけの 1 行に分ける。`textOffset` が付いていたら先頭に「…」を付ける。 */
export function splitLiveDraft(text: string, options: { readonly final?: boolean; readonly textOffset?: number } = {}): LiveDraftParts {
	// allow-any-unicode-next-line
	const full = (options.textOffset ?? 0) > 0 ? `…${text}` : text;
	if (options.final === true) {
		return { committed: full, tail: '', inCode: false, caret: false };
	}
	const cut = full.lastIndexOf('\n');
	const committed = cut >= 0 ? full.slice(0, cut) : '';
	const tail = cut >= 0 ? full.slice(cut + 1) : full;
	const fences = committed.split('\n').filter(line => line.trimStart().startsWith(FENCE)).length;
	if (fences % 2 === 1) {
		// コードブロックの途中は、書きかけの行もコードの枠の中に置く（枠を閉じて描く）
		return { committed: `${committed}\n${tail}\n${FENCE}`, tail: '', inCode: true, caret: true };
	}
	const bullet = /^(\s*)[-*]\s+/.exec(tail);
	return { committed, tail: bullet !== null ? `${bullet[1]}• ${tail.slice(bullet[0].length)}` : tail, inCode: false, caret: true };
}

/** 会話の写しのうち、書いている最中の返信の判断に使うところ。 */
interface LiveDraftChat {
	readonly agent?: string;
	readonly live?: AgentLiveState;
	readonly messages: readonly AgentChatMessage[];
}

/**
 * 会話の末尾に出す書いている最中の返信（出さないときは undefined）。
 *  - Claude Code の生成中の文だけ（Codex・agy は流さない。Q657）
 *  - 会話の最後の行が同じ文の確定した返信なら出さない。PC は確定した本文の差分を先に送り、生成中の文を消す差分を
 *    後から送るので、その間に同じ文が 2 つ並ばないようにする。確定した本文は 6,000 字で切られて「…」が付くことがある
 */
export function liveDraftOf(chat: LiveDraftChat | undefined): AgentLiveState | undefined {
	const live = chat?.live;
	if (chat === undefined || chat.agent !== 'claude' || live === undefined || live.phase !== 'message' || live.text === undefined || live.text.trim().length === 0) {
		return undefined;
	}
	const last = chat.messages[chat.messages.length - 1];
	if (last !== undefined && last.role === 'assistant' && last.kind === 'text' && last.notice !== true && (live.textOffset ?? 0) === 0) {
		const shown = live.text.trim();
		const confirmed = last.text.trim();
		// allow-any-unicode-next-line
		const head = confirmed.endsWith('…') ? confirmed.slice(0, -1) : confirmed;
		if (head.length > 0 && (shown.startsWith(head) || confirmed.startsWith(shown))) {
			return undefined;
		}
	}
	return live;
}

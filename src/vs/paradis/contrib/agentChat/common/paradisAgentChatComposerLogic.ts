/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// チャット表示の入力欄の、画面に依存しない判断（補完を出すか・候補の並べ方・送信履歴の積み方）。

import { IParadisAgentChatCommand } from './paradisAgentChat.js';

/**
 * 入力がスラッシュコマンドの名前を打っている途中なら、`/` の後ろの打ちかけの名前を返す。
 * 先頭が `/` で、カーソルより前に空白が無いときだけ補完を出す（引数を打ち始めたら閉じる）。
 */
export function paradisAgentChatSlashQuery(value: string, caret: number): string | undefined {
	if (!value.startsWith('/')) {
		return undefined;
	}
	const typed = value.slice(1, caret);
	return /\s/.test(typed) || caret < 1 ? undefined : typed;
}

/** 候補を絞り込む。名前の前方一致を先に、部分一致を後に並べる（大文字小文字は区別しない）。 */
export function paradisFilterAgentChatCommands(commands: readonly IParadisAgentChatCommand[], query: string): IParadisAgentChatCommand[] {
	const needle = query.toLowerCase();
	const prefix: IParadisAgentChatCommand[] = [];
	const contains: IParadisAgentChatCommand[] = [];
	const seen = new Set<string>();
	for (const command of commands) {
		const name = command.name.toLowerCase();
		if (seen.has(name)) {
			continue;
		}
		if (name.startsWith(needle)) {
			prefix.push(command);
			seen.add(name);
		} else if (needle.length > 0 && name.includes(needle)) {
			contains.push(command);
			seen.add(name);
		}
	}
	return [...prefix, ...contains];
}

/** 送った文を履歴の末尾へ積む。直前と同じ文は重ねない。古いものから捨てる。 */
export function paradisPushAgentChatHistory(history: readonly string[], text: string, limit: number): string[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return [...history];
	}
	const next = history.at(-1) === text ? [...history] : [...history, text];
	return next.slice(-limit);
}

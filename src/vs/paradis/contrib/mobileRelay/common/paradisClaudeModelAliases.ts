/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code のモデルの別名。PC（paradisAgentSlashCommand.ts）とモバイルアプリ（app/mobile の agentBuiltinCommands.ts）で
// 共有する（アプリの tsconfig は noUncheckedIndexedAccess なので、ここは添字で読まない書き方にしておく）。

/**
 * `/config model=<値>` が受け付ける Claude Code のモデルの別名（2.1.289 で実測。ほかの値は `Model takes one of: …` で断られる）。
 * `/config model=` は `/model <値>` と違って会話の途中でも確認（Switch model?）を出さない。どちらも既定値（settings.json の
 * model）を書き換える。
 */
export const PARADIS_CLAUDE_MODEL_ALIASES: readonly string[] = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'];

/** モデルの別名なら小文字にしたもの。別名でなければ undefined。 */
export function paradisClaudeModelAlias(value: string): string | undefined {
	const lower = value.trim().toLowerCase();
	return PARADIS_CLAUDE_MODEL_ALIASES.includes(lower) ? lower : undefined;
}

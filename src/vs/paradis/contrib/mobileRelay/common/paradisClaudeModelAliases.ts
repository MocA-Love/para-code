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
 * model）を書き換える。版を固定した id（`claude-mythos-5-1` など）は `/config` では受け付けられない（2.1.319 の `/config` の
 * model 行は別名の選択肢だけを持ち、「For a specific model ID, use /model.」と案内する）。
 */
export const PARADIS_CLAUDE_MODEL_ALIASES: readonly string[] = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'];

/** モデルの別名なら小文字にしたもの。別名でなければ undefined。 */
export function paradisClaudeModelAlias(value: string): string | undefined {
	const lower = value.trim().toLowerCase();
	return PARADIS_CLAUDE_MODEL_ALIASES.includes(lower) ? lower : undefined;
}

/** モバイルから受け付けるモデルの値の形（別名・`[1m]` の付いた別名・版付きの id。キーで打つので、ほかの文字は通さない）。 */
export const PARADIS_CLAUDE_SETTING_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,200}(?:\[[a-z0-9]{1,8}\])?$/;

/**
 * `/model <値>` の値の扱い。
 * - `alias`: 別名（`/config model=<別名>` で送る）
 * - `id`: 別名ではないが形は正しい値（版付きの id など）。PC が持つモデルの一覧に載っていれば `/model <id>` で送る
 * - undefined: 形が違う（空白・記号を含む）。送らない
 */
export function paradisClaudeModelValue(value: string): { readonly kind: 'alias' | 'id'; readonly value: string } | undefined {
	const alias = paradisClaudeModelAlias(value);
	if (alias !== undefined) {
		return { kind: 'alias', value: alias };
	}
	const trimmed = value.trim();
	return PARADIS_CLAUDE_SETTING_VALUE_PATTERN.test(trimmed) ? { kind: 'id', value: trimmed } : undefined;
}

/**
 * PC が持つモデルの一覧（`--model` に渡す id と、別名が指す正式な id）から、`value` に当たる id を探す（大文字小文字は問わない）。
 * 一覧に無ければ undefined（任意の文字列を打たないため、一覧に載っている id だけを切り替えの対象にする）。
 */
export function paradisFindListedClaudeModel(value: string, models: readonly { readonly id: string; readonly resolvedModel?: string }[]): string | undefined {
	const lower = value.trim().toLowerCase();
	for (const model of models) {
		for (const candidate of [model.id, model.resolvedModel]) {
			if (candidate !== undefined && candidate.toLowerCase() === lower && PARADIS_CLAUDE_SETTING_VALUE_PATTERN.test(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

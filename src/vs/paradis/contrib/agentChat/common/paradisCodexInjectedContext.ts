/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex が rollout へ role user のメッセージとして差し込む文（AGENTS.md・環境情報・plugin の案内・/goal の
// 内部文脈など）を、ユーザーの発言と見分ける判定。チャット・セッション名・ターミナルのタブ名・再開一覧の
// プレビュー・サブエージェントの指示が、すべてここを通す。
//
// 判定の順:
//  1. `internal_chat_message_metadata_passthrough.content_item_kinds`（codex-cli 0.151 以降）。content の
//     1 件ごとに素性が書かれており、ユーザーが書いたものは `user.` で始まる（`user.text` / `user.image`）。それ以外
//     （`agents_md.instructions`、`environments.environment_context`、`plugins.recommendations`、
//     `goal.internal_context`、`additional_content.codex_apps_open_page` など）は差し込み。
//  2. 無い古い形式は、本文の先頭の決まった見出し・タグで見分ける（{@link INJECTED_TAG_PATTERN}）。
//
// 実データ（2026-10-03、cli 0.147〜0.159.3 の rollout 1500 本）で 1 と 2 の結果が食い違わないことを確かめた。
// Node の API は使わない（common に置き、node・worker の両方から呼ぶ）。

/**
 * ユーザーが書いた content の素性の接頭辞（実データでは `user.text` / `user.image`）。これ以外は Codex が差し込んだもの。
 * 将来 `user.` の素性が増えても発言として扱う。
 */
const USER_CONTENT_KIND_PREFIX = 'user.';

/** Codex の multi-agent が引数・メッセージに入れる暗号化済みの本文（Fernet の token）の形。 */
const CODEX_ENCRYPTED_PATTERN_SOURCE = 'gAAAAA[A-Za-z0-9_=-]{20,}';
const CODEX_ENCRYPTED_WHOLE = new RegExp(`^${CODEX_ENCRYPTED_PATTERN_SOURCE}$`);
const CODEX_ENCRYPTED_ANYWHERE = new RegExp(CODEX_ENCRYPTED_PATTERN_SOURCE, 'g');

/** 文字列全体が暗号化された本文か（読めないので画面に出さない）。 */
export function paradisIsCodexEncryptedPayload(value: string): boolean {
	return CODEX_ENCRYPTED_WHOLE.test(value.trim());
}

/** 文字列の中の暗号化された本文を伏せる（JSON として読めなかった引数の最後の守り）。 */
export function paradisMaskCodexEncryptedPayloads(value: string): string {
	return value.replace(CODEX_ENCRYPTED_ANYWHERE, '[encrypted]');
}

/**
 * 素性が書かれていない古い rollout で、差し込みとみなす本文の先頭。
 * `# AGENTS.md instructions` は、プロジェクトの AGENTS.md が無い（グローバルだけ）とき後ろの ` for <path>` が付かない。
 */
const INJECTED_TAG_PATTERN = /^(?:# AGENTS\.md instructions(?:\s|$)|<(?:environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS|turn_aborted|recommended_plugins|codex_internal_context|subagent_notification|user_shell_command|realtime_delegation|skill|external_codex_apps_open_page|goal_context)[\s>/])/;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 本文の先頭が、Codex が差し込む文の見出し・タグか（素性の書かれていない古い形式・本文だけが分かる呼び出し側用）。 */
export function paradisIsCodexInjectedText(text: string): boolean {
	return INJECTED_TAG_PATTERN.test(text.trimStart());
}

/** content の 1 件ずつの素性。数が content と合わない・形が違うときは使わない（undefined）。 */
function contentItemKinds(payload: Record<string, unknown>, itemCount: number): readonly string[] | undefined {
	const kinds = record(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
	if (!Array.isArray(kinds) || kinds.length !== itemCount || !kinds.every(kind => typeof kind === 'string')) {
		return undefined;
	}
	return kinds as readonly string[];
}

function itemText(item: unknown): string {
	const value = record(item)?.text;
	return typeof value === 'string' ? value : '';
}

/**
 * role user の message（rollout の `response_item` の payload）から、ユーザーが書いた content だけを返す。
 * 全部が差し込みなら undefined。素性が書かれていれば素性で選び、無ければ本文の先頭で判定する
 * （古い形式は 1 件のメッセージが丸ごと差し込みか発言かのどちらかなので、丸ごと返すか捨てるか）。
 */
export function paradisCodexUserAuthoredContent(payload: Record<string, unknown>): string | readonly unknown[] | undefined {
	const content = payload.content;
	if (typeof content === 'string') {
		return paradisIsCodexInjectedText(content) ? undefined : content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const kinds = contentItemKinds(payload, content.length);
	if (kinds !== undefined) {
		const authored = content.filter((_, index) => kinds[index].startsWith(USER_CONTENT_KIND_PREFIX));
		return authored.length > 0 ? authored : undefined;
	}
	const text = content.map(itemText).join('\n');
	return paradisIsCodexInjectedText(text) ? undefined : content;
}

/** role user の message が丸ごと Codex の差し込みか。 */
export function paradisIsCodexInjectedUserMessage(payload: Record<string, unknown>): boolean {
	return paradisCodexUserAuthoredContent(payload) === undefined;
}

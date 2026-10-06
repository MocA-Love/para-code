/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ブラウザのツールの「スコープ」: ペインのトークンと、そのペインが使うタブ（BrowserView の viewId）の組。
// 1 つのペイン（と、そのペインのサブエージェント）が複数のタブを tab_id で使い分けるとき、CDP ゲートウェイの
// 接続・chrome-devtools-mcp の子プロセス・ページ操作の持ち主・世代の台帳をタブごとに分けるためのキー。
// トークンだけのキー（スコープ無し）は、今までどおり共有中のページ 1 件を指す。

/** スコープキーの区切り。トークン（UUID）と viewId のどちらにも現れない文字。 */
const SCOPE_SEPARATOR = '\u0001';

/** tab_id として受ける最大の長さ。viewId は UUID なので十分に大きい。 */
export const PARADIS_AGENT_TAB_ID_MAX_LENGTH = 128;

/** ツールの引数の名前。 */
export const PARADIS_TAB_ID_ARGUMENT = 'tab_id';

/** ツールの入力スキーマに足す `tab_id` の説明（LLM 向け・英語）。 */
export const PARADIS_TAB_ID_ARGUMENT_DESCRIPTION = 'Optional. The tab to act on: a tabId from list_browser_tabs / open_browser_tab (the same value as get_shared_page\'s pageId). Omit it to use this pane\'s current tab (the one you last opened or selected, otherwise the page the user shared). When you split browser work across subagents, give each subagent its own tab_id and have it pass that tab_id on every browser tool call; calls on different tabs run in parallel.';

/** 入力スキーマの `properties` に足す 1 項目。 */
export const PARADIS_TAB_ID_PROPERTY_SCHEMA: Readonly<{ type: 'string'; description: string }> = Object.freeze({
	type: 'string',
	description: PARADIS_TAB_ID_ARGUMENT_DESCRIPTION,
});

/** tab_id として受けてよい文字列か（制御文字・区切り文字・長すぎるものは断る）。 */
export function paradisIsValidAgentTabId(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= PARADIS_AGENT_TAB_ID_MAX_LENGTH
		&& !/[\u0000-\u001f\u007f]/.test(value);
}

/** ペインのトークンとタブからスコープキーを作る。 */
export function paradisAgentTabScopeKey(token: string, tabId: string): string {
	return `${token}${SCOPE_SEPARATOR}${tabId}`;
}

/** スコープキーを分ける。区切りが無ければトークンだけ（スコープ無し）。 */
export function paradisParseAgentTabScopeKey(key: string): { readonly token: string; readonly tabId?: string } {
	const index = key.indexOf(SCOPE_SEPARATOR);
	if (index < 0) {
		return { token: key };
	}
	return { token: key.slice(0, index), tabId: key.slice(index + 1) };
}

/** スコープキーからペインのトークンだけを取り出す。 */
export function paradisPaneTokenOfScopeKey(key: string): string {
	return paradisParseAgentTabScopeKey(key).token;
}

/** そのペインのスコープキーか（トークンだけのキーも含む）。 */
export function paradisScopeKeyBelongsTo(key: string, token: string): boolean {
	return key === token || key.startsWith(`${token}${SCOPE_SEPARATOR}`);
}

/**
 * ツールの引数から tab_id を取り出し、残りの引数を返す。`tab_id` が無ければ `tabId` は undefined。
 * 文字列でない・空・長すぎる値は `invalid: true`。
 */
export function paradisTakeTabIdArgument(args: unknown): { readonly tabId?: string; readonly invalid: boolean; readonly rest: unknown } {
	if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, PARADIS_TAB_ID_ARGUMENT)) {
		return { invalid: false, rest: args };
	}
	const { [PARADIS_TAB_ID_ARGUMENT]: value, ...rest } = args as Record<string, unknown>;
	if (value === undefined || value === null || value === '') {
		return { invalid: false, rest };
	}
	return paradisIsValidAgentTabId(value) ? { tabId: value, invalid: false, rest } : { invalid: true, rest };
}

/**
 * MCP のツール記述子の inputSchema に `tab_id` を足した写しを返す。inputSchema が object 型でなければそのまま。
 */
export function paradisWithTabIdArgument<T extends { readonly inputSchema?: unknown }>(tool: T): T {
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
		return tool;
	}
	const record = schema as { readonly type?: unknown; readonly properties?: unknown };
	if (record.type !== undefined && record.type !== 'object') {
		return tool;
	}
	const properties = record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
		? record.properties as Record<string, unknown>
		: {};
	if (Object.hasOwn(properties, PARADIS_TAB_ID_ARGUMENT)) {
		return tool;
	}
	return {
		...tool,
		inputSchema: {
			...record,
			type: 'object',
			properties: { ...properties, [PARADIS_TAB_ID_ARGUMENT]: PARADIS_TAB_ID_PROPERTY_SCHEMA },
		},
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * para-browser の MCP の道具のうち、ページ・ブラウザ・端末の状態を変えずに読むだけのもの。tools/list でこれらに MCP の
 * 注釈 `readOnlyHint: true` を付ける。Codex は既定（`approval_mode = "auto"`）で読むだけの道具を承認なしで通すので、
 * 画面を読む・撮る・一覧を出すたびに承認（モバイルのカードと通知）が出なくなる。
 *
 * 入れないもの: 押す・入力する・移動する・スクロールする・タブを選ぶ（ペインの全員の今のタブが変わる）・強調する・
 * 待つ（`wait_until`。条件に任意の JavaScript を書け、確認中に出たダイアログを閉じる）・通信の中身を取る
 * （`get_network_request`。本文をファイルへ書けるので、内蔵の chrome-devtools-mcp も読むだけにしていない）・
 * メモを書く／チェックを付ける（`check_space_note_task`）・計測を始める・CDP の接続先を渡す（`get_cdp_endpoint`。
 * 受け取った側が何でもできる）・Lighthouse（ページを読み込み直す）・ヒープのスナップショット（大きなファイルを書く）。
 * 撮る道具（`take_screenshot`・`take_snapshot`・`capture_screenshot`）は、保存先を渡すとファイルを 1 つ書くが、書ける
 * 場所はペインのスペースと Para Code の受け渡しのフォルダの中だけなので入れる（内蔵の chrome-devtools-mcp は
 * `take_screenshot`・`take_snapshot` を `readOnlyHint: false` にしているが、ここで上書きする）。
 */
export const PARADIS_READ_ONLY_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
	// Para Code の道具: ページとタブ
	'get_shared_page',
	'list_browser_tabs',
	'list_browser_profiles',
	'list_viewports',
	'list_init_scripts',
	'get_page_network_overrides',
	'get_text',
	'inspect_element',
	'capture_screenshot',
	'read_download',
	'get_session_health',
	// スペースのメモ・サイトのメモ・手順（読むだけ）
	'list_space_notes',
	'read_space_note',
	'list_site_notes',
	'list_recipes',
	// 内蔵の chrome-devtools-mcp
	'list_pages',
	'take_snapshot',
	'take_screenshot',
	'list_console_messages',
	'get_console_message',
	'list_network_requests',
	'wait_for',
	'performance_analyze_insight',
	// モバイルの端末（シミュレータ・エミュレータ）
	'mobile_list_devices',
	'mobile_get_attached_device',
	'mobile_screenshot',
	'mobile_ui_snapshot',
	'mobile_ui_find',
	'mobile_read_log',
]);

/** 読むだけの道具なら `readOnlyHint: true` を足した写しを返す（ほかの注釈は残す）。それ以外はそのまま返す。 */
export function paradisWithReadOnlyToolAnnotation<T extends { readonly name: string }>(tool: T): T {
	if (!PARADIS_READ_ONLY_MCP_TOOL_NAMES.has(tool.name)) {
		return tool;
	}
	const annotations = (tool as { readonly annotations?: unknown }).annotations;
	const base = annotations !== null && typeof annotations === 'object' && !Array.isArray(annotations) ? annotations : {};
	return { ...tool, annotations: { ...base, readOnlyHint: true } };
}

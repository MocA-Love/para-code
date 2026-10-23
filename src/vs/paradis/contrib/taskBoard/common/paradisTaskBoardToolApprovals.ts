/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Keep this module free of imports: the task board server (app/taskboard) imports it directly.

/**
 * para-browser のツールのうち、タスクボードの承認の帯で「常に許可」にできる、スクショの工程が使う
 * 読むだけ・撮るだけのツール（q.html Q413 = A）。
 *
 * - `list_browser_tabs`・`get_shared_page`: 使えるタブの一覧と URL を読むだけ（どのタブが current かも変えない）
 * - `take_screenshot`・`capture_screenshot`・`take_snapshot`: 撮った画像・スナップショットをファイルに書くことがある。
 *   書き込み先はペインのスペースのフォルダか一時フォルダに限られ、`.git` などの中には書かない。既にあるファイルは
 *   上書きしない（拡張子を形式に付け替えた後の名前で確かめる。paradisDevtoolsPathPolicy.ts・paradisAgentBrowserService.ts・
 *   paradisRemoteFileBridge.ts）
 * - `take_snapshot`・`get_text`・`inspect_element`: ページの中身・文字・位置を読む（マウスやキーの入力を送らない）
 *
 * 入れないもの: クリック・入力・キー（click*・fill*・type_text・press_key など）、スクリプトの実行（`evaluate_script`、
 * 条件にスクリプトを書ける `wait_until`）、ページの移動とタブの切り替え（`navigate_page`・`open_browser_tab`・
 * `select_browser_tab`・`scroll_to`）、ファイルの書き込み（`upload_file`・`write_site_note` など）、`preview_file`
 * （スペースの外の絶対パスも開け、HTML のスクリプトも動く。スクショの工程の指示文も使わない）。
 * 名前が para-browser のツールとして実在することは test/node/paradisTaskBoardToolApprovals.test.ts が確かめる。
 */
export const PARADIS_TASK_BOARD_SCREENSHOT_TOOLS = [
	'list_browser_tabs',
	'get_shared_page',
	'take_screenshot',
	'capture_screenshot',
	'take_snapshot',
	'get_text',
	'inspect_element',
] as const;

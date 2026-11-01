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

/** ボードへ報告する para-browser のツール（担当がどの工程でも使う）。 */
export const PARADIS_TASK_BOARD_BOARD_TOOLS = ['board_complete_step', 'board_ask_human'] as const;

/**
 * SSH の担当を起動するときだけ許可を渡すツール（q.html Q525 の d = B）。設定ファイルには書かず、その起動の引数にだけ載せる。
 */
export const PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS: readonly string[] = [...PARADIS_TASK_BOARD_BOARD_TOOLS, ...PARADIS_TASK_BOARD_SCREENSHOT_TOOLS];

/**
 * 起動の引数（{@link PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS} だけ。窓が固定の一覧から組み立て、ボードから受けるのは渡すかどうか
 * だけ）。どれも英数字と `_.,=-` だけの固定の文字列を単一引用符で囲むので、POSIX・fish・PowerShell のどれでも 1 つの引数になる。
 * - Claude Code: `--allowedTools` は値を可変長で取るので、必ず `=` の形にする（空白で区切ると後ろの指示までツールの名前として
 *   飲み込む。2.1.316 で `claude --allowedTools a doctor --help` が本体の help になることを確かめた）
 * - Codex: `-c <key>=approve`。値は TOML として読めなければ文字列になり、`approval_mode` の値として確かめられる
 *   （0.1xx で `mcp get` が通り、違う値は `unknown variant` で落ちることを確かめた）
 */
export function paradisTaskBoardLaunchApprovalFlags(agent: 'claude' | 'codex'): string {
	if (agent === 'claude') {
		return `'--allowedTools=${PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS.map(tool => `mcp__para-browser__${tool}`).join(',')}'`;
	}
	return PARADIS_TASK_BOARD_LAUNCH_APPROVAL_TOOLS.map(tool => `-c 'mcp_servers.para-browser.tools.${tool}.approval_mode=approve'`).join(' ');
}

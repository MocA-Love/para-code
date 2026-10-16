/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test fixtures)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// codex-cli 0.162.1 の確認の画面（タスクボードの実地試験で、幅およそ 80 桁のペインに出たもの）。空行の位置は
// codex-rs/tui の approval_overlay / mcp_server_elicitation のスナップショットに合わせた。

/** コマンドの許可。見出しは下から 18 行目（下端の 14 行の外）。 */
export const CODEX_EXEC_APPROVAL_SCREEN = [
	'• Running rtk git add -- README.md && rtk git commit -m \'README のテスト出力例…',
	'    + Show details',
	'',
	'  Would you like to run the following command?',
	'',
	'  Environment: local',
	'',
	'  Reason: タスクのブランチに README.md の修正だけをコミットするため、Git',
	'  管理領域への書き込みを許可しますか？',
	'',
	'  $ rtk git add -- README.md && rtk git commit -m \'README',
	'  のテスト出力例にレポーターの条件を明記\' && rtk git status --short && rtk git',
	'  log -1 --format=\'%h %s\' && rtk proxy git show --format= --name-only HEAD',
	'',
	'',
	'› 1. Yes, proceed (y)',
	'  2. Yes, and don\'t ask again for commands that start with `rtk git add --',
	'     README.md` (p)',
	'  3. No, and tell Codex what to do differently (esc)',
	'',
	'  Press enter to confirm or esc to cancel',
	'',
].join('\n');

/** 上の許可の、ボードに出た承認の中身（hook の PermissionRequest の `description`）。 */
export const CODEX_EXEC_APPROVAL_DETAIL = 'Bash: タスクのブランチに README.md の修正だけをコミットするため、Git 管理領域への書き込みを許可しますか？';

/** MCP のツールの許可（elicitation のフォーム）。 */
export const CODEX_MCP_APPROVAL_SCREEN = [
	'• Calling para-browser.board_complete_step',
	'    + Show details',
	'  Field 1/1',
	'  Allow the para-browser MCP server to run tool "board_complete_step"?',
	'',
	'  artifacts: [{"kind": "report", "title": "Issue #2 差分レビュー報告",',
	'  "conten...',
	'  summary: 差分レビューを完了しました。修正の指摘はなく、ファイルの変更は行っ',
	'  ていません。テストはユーザー指示に従って実行して...',
	'',
	'  › 1. Allow                   Run the tool and continue',
	'    2. Allow for this session  Run the tool and remember this choice for this',
	'                               session',
	'    3. Always allow            Run the tool and remember this choice for',
	'                               future tool calls',
	'    4. Cancel                  Cancel this tool call',
	'',
	'',
	'  enter to submit | esc to cancel',
].join('\n');

/** 上の許可の、承認の中身（hook のツール名と引数）。 */
export const CODEX_MCP_APPROVAL_DETAIL = 'mcp__para-browser__board_complete_step: {"artifacts":[{"kind":"report","title":"Issue #2 差分レビュー報告"}],"summary":"差分レビューを完了しました。"}';

/** 許可した後の画面（作業中）。 */
export const CODEX_WORKING_SCREEN = [
	'• Called para-browser.board_complete_step',
	'',
	'• Working (3s • esc to interrupt)',
	'',
	'› Ask Codex to do anything',
].join('\n');

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `para` コマンド（CLI）をエージェントに知らせる手引き（スキル）と、Codex のサンドボックスから `para` を通す規則。
// 設定 `paradis.agentCli.enabled`（既定はオフ）をオンにした利用者の、Claude Code と Codex の置き場所へ Para Code が置く。
// 手元は shared process（`../node/paradisAgentCliInstall.ts`）、SSH の接続先は窓
// （`../electron-browser/paradisRemoteAgentHooks.contribution.ts`）が置く。
//
// 置いたファイルには印（{@link PARADIS_AGENT_CLI_MANAGED_MARK}）を入れる。印の無いファイル（利用者が自分で置いたもの）は
// 上書きも削除もしない。オフにしたら、印のあるものだけを消す。
//
// 手引きは短い入口だけにする。分野ごとの約束とコマンドの説明は `para help <分野>` が本体から返す（MCP の説明文と同じ文）。

/** `para` コマンドの手引きと Codex の規則を置く設定（既定はオフ）。 */
export const PARADIS_AGENT_CLI_ENABLED_SETTING = 'paradis.agentCli.enabled';

/** 明示的に `true` のときだけオン（shared process にはスキーマが無く、既定値を読めない）。 */
export function paradisAgentCliEnabled(value: unknown): boolean {
	return value === true;
}

/** スキルの名前（ディレクトリ名）。 */
export const PARADIS_AGENT_CLI_SKILL_DIRECTORY = 'para-cli';
/** Codex の規則のファイル名（`<Codex のホーム>/rules/` の中）。利用者の規則のファイルとは別にする。 */
export const PARADIS_AGENT_CLI_CODEX_RULES_FILE = 'para-code.rules';

/** Para Code が置いたファイルの印。これが無いファイルは触らない。 */
export const PARADIS_AGENT_CLI_MANAGED_MARK = 'PARA-CODE: managed by Para Code';

/**
 * ブラウザの道具を使う前の約束のうち、手引きにもそのまま書く 2 つ。MCP のサーバーの説明文
 * （`../node/paradisAgentBrowserService.ts` の `PARADIS_BROWSER_INSTRUCTION_PARTS`）と同じ定数を使い、文を二重に持たない。
 */
// allow-any-unicode-next-line
export const PARADIS_CURSOR_LABEL_INSTRUCTION = 'Before your first click, key or scroll on a page, call set_cursor_label with a short name for your current task (2-12 characters, e.g. "Checkout", "注文入力"). Name the task, not a person or the page title.';
export const PARADIS_SHARED_PAGE_ACTION_INSTRUCTION = 'On pages the user shared, submit, buy, send or delete something only when the user asked for it.';

// YAML の折り返しは空白の字下げが要る。hygiene がソースの行頭の空白を許さないので、字下げは文字列の中に書く。
const INDENT = '  ';

/** スキルファイル（SKILL.md）の本文。Claude Code と Codex で同じものを置く。 */
export const PARADIS_AGENT_CLI_SKILL_CONTENT = [
	'---',
	`name: ${PARADIS_AGENT_CLI_SKILL_DIRECTORY}`,
	'description: >-',
	`${INDENT}Use the tools of Para Code, the editor this terminal runs in, with the \`para\` shell command:`,
	`${INDENT}the built-in browser (open a page, read it, click, fill, take screenshots), other terminals`,
	`${INDENT}and agents, spaces and git worktrees, notes. Use when a task needs a web page opened, tested`,
	`${INDENT}or looked at, or another Para Code terminal read or driven.`,
	'---',
	'',
	'# para',
	'',
	'`para` is a shell command that talks to the Para Code window hosting this terminal. Run it with',
	'your shell tool. The same tools may also be registered as MCP tools (server "para-browser"); both',
	'act on the same tabs and terminals, so use whichever is at hand.',
	'',
	'If the shell says `para` is not found, this terminal is not inside Para Code (or was opened before',
	'Para Code was updated). Do not install anything: tell the user, and use the MCP tools if they exist.',
	'',
	'## Read before you run',
	'',
	'- `para help`: the groups (browser, terminal, ide, note, ...) and the rules for every command',
	`${INDENT}(images, --out, exit codes).`,
	'- `para help browser`: the rules of one group and its commands, one line each. Read it before the',
	`${INDENT}first command of that group.`,
	'- `para help browser click_by`: the flags of one command. Unknown flags are refused.',
	'',
	'## Usual browser flow',
	'',
	'```',
	'para browser open --url https://example.com --label "Check"   # your own tab; it becomes the current tab',
	'para browser text                                             # the words of the page',
	'para browser snapshot                                         # elements with uids',
	'para browser click_by --role button --name "Save"',
	'para browser fill_by --role textbox --name "Email" --value a@b.c',
	'para browser wait --text "Saved" --timeout-seconds 10',
	'para browser screenshot --out ./shot.png                      # then open ./shot.png with your image viewing tool',
	'para browser close --tab-id <tabId printed by open>',
	'```',
	'',
	'## Rules',
	'',
	`- ${PARADIS_CURSOR_LABEL_INSTRUCTION}`,
	`${INDENT}(\`para browser set_cursor_label --label "Checkout"\`, or --label on \`para browser open\`.)`,
	`- ${PARADIS_SHARED_PAGE_ACTION_INSTRUCTION}`,
	'- Before you finish a task on a website, do what `para help browser` says about leaving a note',
	`${INDENT}for the next agent (write_site_note), if it says so.`,
	'- If a terminal waits for a person (a permission, a question, a menu), tell the user instead of',
	`${INDENT}answering it.`,
	'- Never print the environment (env, printenv, set): it holds the access token of this terminal.',
	'- Never change Para Code settings yourself to unlock tools. Ask the user.',
	'',
	`<!-- ${PARADIS_AGENT_CLI_MANAGED_MARK} (setting "${PARADIS_AGENT_CLI_ENABLED_SETTING}"). It rewrites this file and removes it when the setting is turned off. To keep your own version, delete this line. -->`,
	'',
].join('\n');

/**
 * Codex の規則（`<Codex のホーム>/rules/para-code.rules`）。`para` で始まるコマンドをサンドボックスの外で走らせる。
 * Codex のサンドボックス（workspace-write）は 127.0.0.1 への接続も止めるので、これが無いと `para` は Para Code に届かない。
 * `para ... && 別のコマンド` のようにつないだものは当たらない（`para` だけが外で走る）。
 */
export const PARADIS_AGENT_CLI_CODEX_RULES_CONTENT = [
	`# ${PARADIS_AGENT_CLI_MANAGED_MARK} (setting "${PARADIS_AGENT_CLI_ENABLED_SETTING}"). It rewrites this file and removes it when the setting is turned off.`,
	'# The para command (the Para Code tools) talks to Para Code on 127.0.0.1, which the Codex sandbox blocks.',
	'# This rule runs commands that start with "para" outside the sandbox. To keep your own version, delete the first line.',
	'prefix_rule(pattern=["para"], decision="allow")',
	'',
].join('\n');

/** 置くファイル 1 つ。 */
export interface IParadisAgentCliFile {
	/** どのエージェントの何か（ログと結果の表示用）。 */
	readonly kind: 'claude-skill' | 'codex-skill' | 'codex-rules';
	readonly path: string;
	readonly content: string;
}

/** ファイルの今の中身から、どうするかを決める。 */
export type ParadisAgentCliFileAction = 'write' | 'remove' | 'keep';

/**
 * @param existing 今の中身（無ければ undefined）
 * @param wanted 置きたい中身（外すなら undefined）
 */
export function paradisAgentCliFileAction(existing: string | undefined, wanted: string | undefined): ParadisAgentCliFileAction {
	const managed = existing !== undefined && existing.includes(PARADIS_AGENT_CLI_MANAGED_MARK);
	if (wanted === undefined) {
		// 外すのは自分が置いたものだけ
		return managed ? 'remove' : 'keep';
	}
	if (existing === undefined) {
		return 'write';
	}
	// 印の無いファイルは利用者のもの。同じ中身なら何もしない
	return managed && existing !== wanted ? 'write' : 'keep';
}

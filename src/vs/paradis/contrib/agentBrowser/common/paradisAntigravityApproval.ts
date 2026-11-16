/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Antigravity CLI（`agy`）の許可を、モバイルと PC のカードから返すための定義（Q654-1、計画の案 2）。
//
// agy には「許可を求めている」ことを知らせる hook が無く、PreToolUse は許可の判定より前に、すべてのツールで走る。
// PreToolUse の hook が stdout に `{"decision":"allow"}` / `{"decision":"deny"}` を書くと、agy はその通りにする
// （agy 1.5.9 の内蔵の説明書）。何も書かなければ、agy は自分の許可の判定（TUI の許可の画面）へ進む（実測）。
// `{}` を書くとツールは拒否される（実測）ので、決めないときは必ず何も書かない。
//
// そこで、許可の画面が出うるツールの PreToolUse にだけ、別の名前付きの hook（{@link PARADIS_ANTIGRAVITY_APPROVAL_HOOK_NAME}）
// を置く。hook のスクリプトは、モバイルのアプリがそのペインを見ているときだけ Para Code に答えを待たせ、カードの答えを
// agy へ返す。待っている間は agy の TUI に許可の画面が出ないので、待つのはモバイルが見ているときだけ、上限つきにする。
// 答えが来なければ何も書かずに終わり、agy の TUI の許可の画面に任せる。
//
// 通知の hook（`para-code`）と名前を分けるのは、古い版の Para Code が `para-code` を自分の定義へ書き戻しても、
// この hook を消し合わないようにするため（agy は同じイベントの名前付きの hook を順に全部走らせる）。

/** Para Code が `hooks.json` に置く、許可を待つための名前付きの hook の名前。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_HOOK_NAME = 'para-code-approval';

/** 許可のスクリプトの版（ファイル名に入る。中身の形を変えたら上げる）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_SCRIPT_VERSION = 1;

/** 許可のスクリプトの置き場所（ホーム相対）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_SCRIPT_RELATIVE_PATH = `.para-code/hooks/antigravity-approval-v${PARADIS_ANTIGRAVITY_APPROVAL_SCRIPT_VERSION}.sh`;

/**
 * 許可を待つツール（agy の hook の `toolCall.name`）。agy が許可を求めうるもの（コマンド・ファイルの書き換え・MCP）だけ。
 * 読むだけのツール（read_file など）は待たない（agy が許可を求めないのにカードが出て止まるのを避ける）。
 */
export const PARADIS_ANTIGRAVITY_APPROVAL_TOOLS: readonly string[] = ['run_command', 'edit_file', 'write_file', 'call_mcp_tool'];

/** agy が起動の引数のモードで聞かずに通す、ファイルの書き換えのツール（accept-edits・auto のモード）。 */
const EDIT_TOOLS: readonly string[] = ['edit_file', 'write_file'];

/**
 * ペインの agy の起動の行（プロセスの引数）から、この呼び出しを agy が聞かずに通すと分かるか（分かれば待たない）。
 * 待つと外したとき（agy が聞かないのに待つ）は最大 {@link PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS} 止まり、待たないと外したとき
 * （agy が聞く）は TUI の許可の画面が今までどおり出るだけなので、分かる範囲で待たない側へ倒す。
 *
 * | 起動の引数 | 待たないツール |
 * |---|---|
 * | `--dangerously-skip-permissions` | 全部 |
 * | `--mode accept-edits`・`--mode auto` | `edit_file`・`write_file`（agy の説明: 書き換えは聞かない。コマンドは聞く・auto は戻せない操作だけ聞く） |
 *
 * 会話の途中のモードの切り替え（shift+tab）・`/config` に保存したモード・`--settings`・`permissions.allow` は読まない
 * （起動の行に出ない）。agy は Go の flag なので `-` 1 つの書き方と `=` の書き方も読む。
 */
export function paradisAntigravityApprovalSkippedByLaunch(commandLine: string, toolName: string | undefined): boolean {
	if (/(?:^|\s)--?dangerously-skip-permissions(?:=(?:true|t|1))?(?:\s|$)/i.test(commandLine)) {
		return true;
	}
	const mode = /(?:^|\s)--?mode(?:\s+|=)(?<mode>\S+)/.exec(commandLine)?.groups?.mode;
	return (mode === 'accept-edits' || mode === 'auto') && toolName !== undefined && EDIT_TOOLS.includes(toolName);
}

/** shared process の受け口の接頭辞（`register` と `wait`）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_HTTP_PREFIX = '/antigravity-approval/v1/';

/**
 * 答えを待つ上限。待っている間は agy の TUI に許可の画面が出ないので、長く止めない。
 * 時間の上限は 3 段で、内側ほど先に切れる: この上限 < スクリプトの curl の `-m`（{@link PARADIS_ANTIGRAVITY_APPROVAL_WAIT_CURL_SECONDS}）
 * < hooks.json の handler の `timeout`（{@link PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS}）。agy が hook を打ち切ったときの
 * 扱いは測っていないので、必ずスクリプトの方が先に、何も書かずに終わる。
 */
export const PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS = 120_000;

/** スクリプトが答えを待つ curl の上限（秒）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_WAIT_CURL_SECONDS = 130;

/** hooks.json の handler の `timeout`（秒。agy の既定は 30 秒なので明示する）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS = 150;

/** 拒否したときに agy へ添える理由（agy はこれを利用者とモデルに見せる）。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_DENY_REASON = 'The user declined this tool call from Para Code.';

/** 受け口が返す、待ちの登録の答え。 */
export const PARADIS_ANTIGRAVITY_APPROVAL_WAIT_PREFIX = 'wait:';

/** hooks.json に書く、許可のスクリプトを呼ぶコマンド（$HOME 参照。スクリプトが無ければ何もせず正常に終わる）。 */
export function paradisAntigravityApprovalHookCommand(): string {
	return `[ -x "$HOME/${PARADIS_ANTIGRAVITY_APPROVAL_SCRIPT_RELATIVE_PATH}" ] && "$HOME/${PARADIS_ANTIGRAVITY_APPROVAL_SCRIPT_RELATIVE_PATH}" || true`;
}

/**
 * hooks.json の許可の名前付きの hook の中身。matcher の正規表現の方言（`|` の書き方）は確かめていないので、
 * ツールごとに名前そのままの matcher の組を並べる。
 */
export function paradisAntigravityApprovalHookDefinition(command: string = paradisAntigravityApprovalHookCommand()): Record<string, unknown> {
	return {
		PreToolUse: PARADIS_ANTIGRAVITY_APPROVAL_TOOLS.map(tool => ({
			matcher: tool,
			hooks: [{ type: 'command', command, timeout: PARADIS_ANTIGRAVITY_APPROVAL_HOOK_TIMEOUT_SECONDS }],
		})),
	};
}

/** コマンドが、Para Code の置いた許可のスクリプトを呼ぶものなら、その版。違えば undefined。 */
export function paradisAntigravityApprovalScriptVersion(command: unknown): number | undefined {
	if (typeof command !== 'string') {
		return undefined;
	}
	const match = /\/\.para-code\/hooks\/antigravity-approval-v(?<version>\d+)\.sh(?:["'\s]|$)/.exec(command.replace(/\\/g, '/'));
	return match?.groups?.version !== undefined ? Number(match.groups.version) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 許可のカード（paradisBuildAgentApprovalRequest）が読む引数の名前。agy の引数のうちこの名前のものはカードへ渡さない
 * （モデルが `{CommandLine: 'rm -rf x', command: 'ls'}` のように足した名前で、agy が実行するものと違う中身をカードに出させない）。
 */
const CARD_INPUT_KEYS: readonly string[] = ['command', 'description', 'file_path', 'notebook_path', 'edits', 'old_string', 'new_string', 'replace_all', 'content', 'url', 'prompt'];

/**
 * agy の許可を求めるツールの名前と引数を、許可のカード（paradisBuildAgentApprovalRequest）が読む形にする。
 * カードの中身は、agy が実際に使う引数（`CommandLine` など）からだけ作る。
 *
 * | agy | カード |
 * |---|---|
 * | `run_command` の `CommandLine`・`toolSummary` | コマンドと説明 |
 * | `edit_file` の `Path`・`Target`・`Replacement` | パスと置き換え前後 |
 * | `write_file` の `Path`・`Content` | パスと中身 |
 * | `call_mcp_tool` の `ServerName`・`ToolName`・`Arguments` | `mcp__<server>__<tool>` と引数 |
 *
 * 許可を待つツールで形が違うものは、カードが読む名前を外して返す。ほかのツールはそのまま返す。
 */
export function paradisAntigravityApprovalCardInput(toolName: string | undefined, toolInput: unknown): { readonly toolName: string | undefined; readonly toolInput: unknown } {
	if (!isRecord(toolInput)) {
		return { toolName, toolInput };
	}
	const input = toolInput;
	// カードが読む名前と、写し元の名前を外した残り（明示した値はこの後ろに置き、残りから上書きされないようにする）
	const rest = (...keys: string[]) => Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key) && !CARD_INPUT_KEYS.includes(key)));
	if (toolName === 'run_command' && stringOf(input.CommandLine) !== undefined) {
		const description = stringOf(input.toolSummary);
		return { toolName, toolInput: { ...rest('CommandLine', 'toolSummary'), command: input.CommandLine, ...(description !== undefined ? { description } : {}) } };
	}
	if (toolName === 'edit_file' && stringOf(input.Path) !== undefined) {
		return {
			toolName, toolInput: {
				...rest('Path', 'Target', 'Replacement'),
				file_path: input.Path, old_string: typeof input.Target === 'string' ? input.Target : '', new_string: typeof input.Replacement === 'string' ? input.Replacement : '',
			},
		};
	}
	if (toolName === 'write_file' && stringOf(input.Path) !== undefined && typeof input.Content === 'string') {
		return { toolName, toolInput: { ...rest('Path', 'Content'), file_path: input.Path, content: input.Content } };
	}
	const server = stringOf(input.ServerName);
	const tool = stringOf(input.ToolName);
	if (toolName === 'call_mcp_tool' && server !== undefined && tool !== undefined) {
		return { toolName: `mcp__${server}__${tool}`, toolInput: isRecord(input.Arguments) ? input.Arguments : {} };
	}
	if (toolName !== undefined && PARADIS_ANTIGRAVITY_APPROVAL_TOOLS.includes(toolName)) {
		return { toolName, toolInput: rest() };
	}
	return { toolName, toolInput };
}

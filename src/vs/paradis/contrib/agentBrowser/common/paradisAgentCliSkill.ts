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
// 手引きは短い入口だけにする（本文は日本語）。分野ごとの約束とコマンドの説明は `para help <分野>` が本体から返す（MCP の説明文と同じ文）。

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

/**
 * スキルファイル（SKILL.md）の本文。Claude Code と Codex で同じものを置く。
 *
 * 本文は日本語（利用者の決定、2026-11-27）。コマンド名・フラグ・道具の名前は英語のまま書く。`para help` の出力と
 * 道具の説明は英語のままなので、上の 2 つの定数（MCP の説明文と共有）は訳さず、手引きには同じ約束を日本語で書く。
 * description は、日本語の依頼でも英語の依頼でも呼ばれるよう、両方の言い回しを入れる。YAML の `>-` は行の継ぎ目に
 * 空白を入れるので、文の切れ目でだけ折り返す。
 *
 * 印（{@link PARADIS_AGENT_CLI_MANAGED_MARK}）の文字列は変えない。前の版（英語）を置いている利用者のファイルは、
 * 印があるので、設定がオンの間に {@link paradisAgentCliFileAction} が `write` と判定して置き直す。
 */
export const PARADIS_AGENT_CLI_SKILL_CONTENT = [
	'---',
	`name: ${PARADIS_AGENT_CLI_SKILL_DIRECTORY}`,
	'description: >-',
	`${INDENT}Para Code（このターミナルが動いているエディタ）の道具を、シェルの \`para\` コマンドで使う。`,
	`${INDENT}内蔵ブラウザ（ページを開く・読む・クリック・入力・スクリーンショット）、ほかのターミナルとエージェント、スペースと git worktree、メモ、モバイルのシミュレータを扱う。`,
	`${INDENT}「ブラウザで開いて」「画面を確認して」「スクショを撮って」「動作確認して」「open this page in the browser」「take a screenshot」「test the web page」のように、Web ページを開く・試す・見る依頼と、ほかの Para Code のターミナルを読む・動かす依頼で使う。`,
	'---',
	'',
	'# para',
	'',
	'`para` は、このターミナルを載せている Para Code の窓と話すシェルのコマンドです。シェルの道具で実行します。同じ道具が MCP の道具（サーバー名 "para-browser"）として登録されていることもあります。どちらも同じタブとターミナルを操作するので、手元にあるほうを使います。',
	'',
	'シェルが `para` を見つけられないときは、このターミナルが Para Code の中に無いか、Para Code の更新より前に開かれています。何もインストールせず、利用者に伝えます。MCP の道具があれば、それを使います。',
	'',
	'## 実行の前に読む',
	'',
	'- `para help`: グループ（browser、terminal、ide、note など）と、全コマンドに共通の決まり（画像、`--out`、終了コード）。',
	'- `para help browser`: 1 つのグループの決まりと、コマンドごとの 1 行の説明。そのグループの最初のコマンドの前に読みます。',
	'- `para help browser click_by`: 1 つのコマンドのフラグ。知らないフラグは断られます。',
	'',
	'`para help` の出力と道具の返事は英語です。',
	'',
	'## ブラウザのよくある流れ',
	'',
	'```',
	'para browser open --url https://example.com --label "Check"   # 自分のタブを開く。今のタブになる',
	'para browser text                                             # ページの文章',
	'para browser snapshot                                         # uid 付きの要素の一覧',
	'para browser click_by --role button --name "Save"',
	'para browser fill_by --role textbox --name "Email" --value a@b.c',
	'para browser wait --text "Saved" --timeout-seconds 10',
	'para browser screenshot --out ./shot.png                      # その後、画像を見る道具で ./shot.png を開く',
	'para browser close --tab-id <open が出した tabId>',
	'```',
	'',
	'## 決まり',
	'',
	'- ページで最初にクリック・キー入力・スクロールをする前に、今の作業の短い名前（2〜12 文字。例: "Checkout"、"注文入力"）を `set_cursor_label` で付けます。人の名前やページの題ではなく、作業の名前にします（`para browser set_cursor_label --label "Checkout"`、または `para browser open` の `--label`）。',
	'- 利用者が共有したページでは、送信・購入・送付・削除は、利用者が頼んだときだけ行います。',
	'- Web サイトでの作業を終える前に、`para help browser` が次のエージェントへのメモ（`write_site_note`）を求めていれば、そのとおりに残します。',
	'- ターミナルが人を待っているとき（許可、質問、メニュー）は、答えずに利用者へ伝えます。',
	'- 環境変数を表示しません（`env`、`printenv`、`set`）。このターミナルのアクセストークンが入っています。',
	'- 道具を使えるようにするために、Para Code の設定を自分で変えません。利用者に頼みます。',
	'',
	'## ページが出す確認',
	'',
	'- クリックが `alert`・`confirm`・`prompt` を開くと、返事に「The click opened a JavaScript dialog」か「# Open dialog」が出ます。そのページのほかの操作の前に、`para browser handle_dialog --action accept`（または `dismiss`）で答えます。`prompt` に入れる文字は `--prompt-text` で渡します。',
	'- ページが位置情報・通知などの許可を求めると、返事に「Permission request: ...」が出ます。約 30 秒で断られるので、続けて `para browser handle_permission_request --action allow`（または `deny`）で答えます。許可できるのは自分で開いたタブだけです。利用者が共有したページでは、断るか、利用者に伝えます。カメラ・マイク・機器は利用者だけが許可できます。',
	'- ページを離れる確認（beforeunload）でページに残るには、`para browser goto` に `--handle-before-unload decline` を付けます。',
	'',
	'## 詰まりやすい点',
	'',
	'- 画像を返すコマンドの `--out` は、今のフォルダの中か `~/.para-code/browser-files` に書けます。`--file-path` と `--save-to` は、ペインのフォルダか一時フォルダに書けます。',
	'- `set_request_rules`・`set_extra_http_headers`・`set_http_credentials` は、`para browser open --private` で開いた自分だけのタブでしか使えません。',
	'- 真偽値のフラグは、`--auto-stop false` か `--no-auto-stop` の形で切ります。',
	'',
	`<!-- ${PARADIS_AGENT_CLI_MANAGED_MARK}（設定 "${PARADIS_AGENT_CLI_ENABLED_SETTING}"）。Para Code がこのファイルを書き直し、設定をオフにすると消します。自分の版を残すには、この行を消してください。 -->`,
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

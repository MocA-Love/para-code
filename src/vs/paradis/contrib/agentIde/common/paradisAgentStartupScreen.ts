/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動直後の Claude Code / Codex の画面から「フォルダの信頼の確認で止まっている」「入力を待っている」
// を読む（Orca `runtime/tui-idle-evidence.ts` と PR #22927 / #23475 に相当）。
//
// 信頼の確認は hook が届く前に出るので、状態だけを見ていると `wait_for_terminal` が 90 秒待ってから
// 「状態が分からない」と返し、`send_terminal_input` は確認の画面へ文字を打ち込んでいた（数字は選択肢を
// 選んでしまう）。また、プロンプト無しで起動したエージェントは作業を始めないので、準備ができたことを
// 画面で見ないと、同じく 90 秒待たされていた。
//
// 文言は CLI の版で変わるので、実際の CLI から拾った文字列だけを下の表に固定で持つ。外れたときは
// これまでどおり hook の状態だけで判断する（誤って当たる方向には倒さない: 複数の文言がそろったとき
// だけ当てる）。

/** 画面から読める起動時の状態。 */
export type ParadisAgentStartupScreenState =
	/** フォルダを信頼するかの確認で止まっている（利用者しか答えられない）。 */
	| 'trust_dialog'
	/** 起動を終え、空の入力欄で指示を待っている。 */
	| 'ready';

interface IParadisAgentStartupScreenRule {
	readonly agent: 'claude' | 'codex';
	readonly state: ParadisAgentStartupScreenState;
	/** 文言を拾った CLI の版（表を見直すときの目安）。 */
	readonly observedIn: string;
	/** 空白と罫線を落とした画面の末尾に、すべてが現れたら当てる。 */
	readonly allOf: readonly RegExp[];
	/**
	 * 選択肢の2行。画面の中で隣り合う2行（順番は問わない）の文言がそれぞれに当たり、どちらかの行頭に
	 * 選択のカーソルがあるときだけ当てる。会話の中で文言に触れただけの画面や、この表のような
	 * ソースコードを表示している画面では当たらない。
	 */
	readonly choices?: readonly [RegExp, RegExp];
	/** 空白と罫線を落とした画面の末尾に、どれかが現れたら当てない（準備完了を信頼の確認の最中に言わない）。 */
	readonly noneOf?: readonly RegExp[];
	/** 中身の無い入力欄（横罫線のすぐ下に、`❯` だけか `❯ Try "…"` の案内だけの行）が見えているときだけ当てる。 */
	readonly emptyPromptBox?: boolean;
}

/** 信頼の確認の見出し（空白と罫線を落とした形）。準備完了の判定から外すために使う。 */
const TRUST_DIALOG_HEADERS: readonly RegExp[] = [
	/Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust\?|Accessingworkspace:/,
	/Doyoutrustthecontentsofthisdirectory\?/,
];

/**
 * 判定の表。上から順に見て、最初に当たったものを返す（信頼の確認を先に置く）。
 * `allOf` は空白と罫線（U+2500〜U+257F）を落とした形で書く（入力欄の枠と折り返しをまたいで照合するため）。
 * `choices` は1行分の文言を、行頭のカーソル・番号と前後の空白・罫線を落とした形で書く。
 */
export const PARADIS_AGENT_STARTUP_SCREEN_RULES: readonly IParadisAgentStartupScreenRule[] = [
	{
		// 見出しは「Accessing workspace:」と「Quick safety check: …」。選択肢は番号無しで、既定で
		// 断る側にカーソルがある（2.1.283 の `hideIndexes` / `cancelFirst` / `focus: "cancel"`）。
		agent: 'claude',
		state: 'trust_dialog',
		observedIn: 'Claude Code 2.1.283',
		allOf: [TRUST_DIALOG_HEADERS[0]],
		choices: [/^Yes, I trust this folder$/, /^No, (?:exit|continue without these permissions)$/],
	},
	{
		// 見出しは「Do you trust the contents of this directory?」。承諾の選択肢の次の行が断る側。
		agent: 'codex',
		state: 'trust_dialog',
		observedIn: 'codex-cli 0.155.1',
		allOf: [TRUST_DIALOG_HEADERS[1]],
		choices: [/^Yes, continue$/, /^No\b/],
	},
	{
		// 入力欄の下の「? for shortcuts」。入力が空で、作業していないときだけ出る。
		agent: 'claude',
		state: 'ready',
		observedIn: 'Claude Code 2.1.283',
		allOf: [/\?forshortcuts/],
		noneOf: TRUST_DIALOG_HEADERS,
	},
	{
		// 権限モードが既定以外（2.1.283 は auto mode が既定のことがある）だと、入力欄の下の案内は
		// 「? for shortcuts」ではなく「⏵⏵ auto mode on (shift+tab to cycle) · ← for agents」のような
		// モードの表示になる（実機の NG）。モードの名前は 2.1.283 の `accept edits on` / `plan mode on` /
		// `auto mode on`（バイナリの文字列）と、以前の版の `bypass permissions on`。表示だけでは
		// 作業中と区別できないので、中身の無い入力欄が見えていることも条件にする。
		agent: 'claude',
		state: 'ready',
		observedIn: 'Claude Code 2.1.283',
		allOf: [/(?:acceptedits|planmode|automode|bypasspermissions)on\(shift\+tabtocycle\)/],
		noneOf: TRUST_DIALOG_HEADERS,
		emptyPromptBox: true,
	},
	{
		// 空の入力欄の案内「Ask Codex to do anything」。
		agent: 'codex',
		state: 'ready',
		observedIn: 'codex-cli 0.155.1',
		allOf: [/AskCodextodoanything/],
		noneOf: TRUST_DIALOG_HEADERS,
	},
];

/** 見る画面の末尾の行数（確認の画面と入力欄は画面の下の方に出る）。 */
const STARTUP_SCREEN_TAIL_LINES = 30;

/** 空白（改行を含む）と罫線の文字を落とす。 */
function compactScreen(text: string): string {
	return text.replace(/[\s\u2500-\u257f]+/g, '');
}

/** 選択肢の1行を、カーソルの有無と文言に分ける（前後の空白と枠の罫線、番号は落とす）。 */
const CHOICE_LINE = /^(?<cursor>[\u276f\u203a>]\s*)?(?:\d+\.\s*)?(?<label>\S.*?)$/;

function parseChoiceLine(line: string): { readonly cursor: boolean; readonly label: string } | undefined {
	const trimmed = line.replace(/^[\s\u2500-\u257f]+|[\s\u2500-\u257f]+$/g, '');
	const match = CHOICE_LINE.exec(trimmed);
	return match?.groups ? { cursor: match.groups.cursor !== undefined, label: match.groups.label } : undefined;
}

/** 隣り合う2行（空行は飛ばす）が、選択肢の2つにそれぞれ当たり、どちらかにカーソルがあるか。 */
function showsChoicePair(lines: readonly string[], [first, second]: readonly [RegExp, RegExp]): boolean {
	const choices = lines.map(parseChoiceLine).filter((line): line is { readonly cursor: boolean; readonly label: string } => line !== undefined);
	for (let index = 0; index + 1 < choices.length; index++) {
		const a = choices[index];
		const b = choices[index + 1];
		const pairs = (first.test(a.label) && second.test(b.label)) || (second.test(a.label) && first.test(b.label));
		if (pairs && (a.cursor || b.cursor)) {
			return true;
		}
	}
	return false;
}

/** 横罫線（U+2500 が 8 文字以上）のすぐ下（空行は飛ばす）に、`❯` だけ（か入力例の案内だけ）の行があるか。 */
function showsEmptyPromptBox(lines: readonly string[]): boolean {
	const filled = lines.map(line => line.trim()).filter(line => line.length > 0);
	for (let index = 1; index < filled.length; index++) {
		const prompt = filled[index].replace(/^[\u2502|]\s*|\s*[\u2502|]$/g, '');
		if (/^\u276f(?:\s+Try ".*)?$/.test(prompt) && /\u2500{8,}/.test(filled[index - 1])) {
			return true;
		}
	}
	return false;
}

/**
 * 画面の末尾から、起動時の状態を読む。分からなければ undefined。
 * 画面の文字はターミナルの中のプログラムが自由に書けるので、「止めて人に任せる」側
 * （信頼の確認）にだけ強く使い、「送ってよい」の根拠にはしない。呼び出し側は、hook の状態を
 * まだ受け取っていないペインか、起動した直後のペインにだけ使うこと。
 */
export function paradisAgentStartupScreenState(screen: string | undefined): ParadisAgentStartupScreenState | undefined {
	if (screen === undefined || screen.length === 0) {
		return undefined;
	}
	const lines = screen.split('\n').slice(-STARTUP_SCREEN_TAIL_LINES);
	const tail = compactScreen(lines.join('\n'));
	for (const rule of PARADIS_AGENT_STARTUP_SCREEN_RULES) {
		if (rule.allOf.every(pattern => pattern.test(tail))
			&& !(rule.noneOf ?? []).some(pattern => pattern.test(tail))
			&& (rule.choices === undefined || showsChoicePair(lines, rule.choices))
			&& (rule.emptyPromptBox !== true || showsEmptyPromptBox(lines))) {
			return rule.state;
		}
	}
	return undefined;
}

/** エージェント（や親エージェント）へ返す、信頼の確認で止まっているときの説明。 */
export const PARADIS_AGENT_TRUST_DIALOG_MESSAGE = 'The agent in that terminal is asking whether to trust this folder (its startup trust dialog). Only the user can answer that: tell the user, and do not type into that terminal until the dialog is gone.';

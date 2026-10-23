/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの TUI（Claude Code / Codex）へ、質問・承認の回答を打鍵として流す部品。
//
// もとはモバイル中継の renderer 側（mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts）に
// あったものを、デスクトップのチャット表示からも使えるよう切り出した（フェーズ6）。キー列そのものは
// mobileRelay/common/paradisAgentQuestionKeys.ts が組み立てる。ここは「いつ・どう流すか」だけを持つ。

import { StringSHA1 } from '../../../../base/common/hash.js';
import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisCodexApprovalFormHeadingAt } from '../../mobileRelay/common/paradisAgentApprovalOptions.js';

/**
 * 質問の選択肢が画面に出るのを待つ上限。ここを過ぎたら待たずに流す（送信を止める門ではない）。
 *
 * 実測（Claude Code 2.1.223）では、質問が描かれてから打鍵が効くまでに待ちが要る。待たずに
 * 送った1打鍵は入力欄へ吸われて消え、3秒待った同じ打鍵は通った。上限はその実測より少し広く取る。
 */
const INTERACTION_READY_TIMEOUT_MS = 5_000;
/** 選択肢が見えてから打鍵するまでの一拍（描画とフォーカス移動の隙間ぶん）。 */
const INTERACTION_READY_SETTLE_MS = 400;
/** 画面を見に行く間隔。 */
const INTERACTION_READY_POLL_MS = 150;

/**
 * ターミナルの**見えている範囲**だけを文字列にする。
 *
 * `getContentsAsText()` を引数無しで呼ぶと**スクロールバック全体**（既定1000行、設定次第でもっと）
 * を走査する。目印の照合にそれを使うと、**過去に同じ質問が出ていれば履歴に必ず当たる**ので
 * 「もう描かれている」と誤判定し、待ちの意味が消える。同じ質問へ答え直すケース（まさに直したい
 * 場面）ほど確実に踏むので、可視領域に限ること。走査量が数十行で収まる利点もある。
 */
export function paradisVisibleTerminalText(instance: ITerminalInstance): string {
	const raw = instance.xterm?.raw;
	if (raw === undefined) {
		return '';
	}
	const buffer = raw.buffer.active;
	const lines: string[] = [];
	for (let y = buffer.baseY; y < buffer.baseY + raw.rows; y++) {
		lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
	}
	return lines.join('\n');
}

/**
 * {@link paradisVisibleTerminalText} と同じ範囲を、端末の自動折り返しでつながっている行（`isWrapped`）を 1 行にまとめて返す。
 * 許可の確認の選択肢を読むときに使う（W2-21 のシミュレータ確認: 長い選択肢が画面の幅で折り返されると、続きが 0 桁目から
 * 始まり、字下げで続きの行と見分けられずに後ろの選択肢が読めなかった）。見えている範囲の先頭が折り返しの途中なら、
 * その行の頭まではさかのぼらない。
 */
export function paradisVisibleTerminalLogicalText(instance: ITerminalInstance): string {
	const raw = instance.xterm?.raw;
	if (raw === undefined) {
		return '';
	}
	const buffer = raw.buffer.active;
	const lines: string[] = [];
	for (let y = buffer.baseY; y < buffer.baseY + raw.rows; y++) {
		const line = buffer.getLine(y);
		const text = line?.translateToString(true) ?? '';
		if (line?.isWrapped === true && lines.length > 0) {
			lines[lines.length - 1] += text;
		} else {
			lines.push(text);
		}
	}
	return lines.join('\n');
}

/**
 * 画面に目印が出ているかを、**空白と改行を無視して**照合する。
 *
 * ターミナルは幅で折り返し、折り返しの境目には改行が入る。Para Code は2Dグリッドで
 * 狭いペインが常態なので、素朴な部分一致だと日本語ラベルなどは折り返しでほぼ必ず外れる。
 * 目印側も同じ規則で作る（paradisQuestionReadyMarker）。
 */
export function paradisScreenShowsMarker(screen: string, marker: string): boolean {
	return screen.replace(/\s+/g, '').includes(marker);
}

/**
 * 回答待ちの画面を探す範囲（見えている範囲の下からの行数）。確認の画面は常に最下部に出る。上の方に
 * 残っている会話の本文（エージェントが「Do you want to proceed?」と書いた返答など）に反応しないよう、
 * 下端に限る。
 */
const PROMPT_REGION_LINES = 14;

/**
 * Codex の確認の画面は背が高い（理由の `Reason:` の折り返し、複数行のコマンド、MCP のツールの引数の行と、その間の空行）。
 * codex-cli 0.162.1 の実画面では、コマンドの許可の見出し `Would you like to run the following command?` が下から 18 行目にあり、
 * {@link PROMPT_REGION_LINES} 行の範囲から外れて、ボード・チャット表示から答えられなかった。最下部に Codex の確認の操作説明
 * （{@link showsCodexPromptFooter}）が出ているときだけ、許可の見出しを探す範囲をこの行数へ広げる。操作説明が
 * 最下部にある限り、確認の画面がそこに出ているので、上に残る会話の本文を確認と取り違える心配は増えない。
 */
const CODEX_PROMPT_REGION_LINES = 40;

/** 見出しの文言が折り返しでまたがる行数の上限（狭いペインで 2〜3 行に分かれる）。 */
const PROMPT_HEADING_SPAN_LINES = 4;

/**
 * 許可の確認の文言（空白を除いた小文字）。【推測】Claude Code 2.1 系と Codex 0.14x の表示から取った
 * （実測したキー注入の文言ではない）。文言が変わると見落とす（＝従来どおり送る）方向に外れる。
 */
const PERMISSION_PROMPT_MARKERS: readonly string[] = [
	// Claude Code の許可の確認（Bash / 編集 / 作成 / その他）と、計画の確定（ExitPlanMode）
	'doyouwanttoproceed?',
	'doyouwanttomakethisedit',
	'doyouwanttocreate',
	'doyouwanttoallow',
	'wouldyouliketoproceed?',
	// 計画が空の ExitPlanMode（Claude Code 2.1.283 の実画面: `Exit plan mode?` / `Claude wants to exit plan mode` /
	// `❯ 1. Yes, and switch to default (ask each time) for this session`）
	'exitplanmode?',
	// Codex の承認（MCP のツールの許可のフォームは文言ではなく見出しの行の形で見る。permissionHeadingEndsAt）
	'wouldyouliketorunthefollowingcommand',
	'wouldyouliketomakethefollowingedits',
	'allowcommand?',
];

/** 質問の画面の操作説明と確認画面。 */
const QUESTION_PROMPT_MARKERS: readonly string[] = [
	// Claude Code の AskUserQuestion
	'entertoselect',
	'reviewyouranswers',
	// Codex の request_user_input（codex-cli 0.155.1 の実画面: `tab to add notes | enter to submit answer | esc to interrupt`）
	'entertosubmitanswer',
];

/** Codex の request_user_input の見出し（実画面: `Question 1/1 (1 unanswered)`）。 */
const CODEX_QUESTION_HEADING = /question\d+\/\d+/;

/**
 * Claude Code が入力待ちのときの入力欄（実画面: 横線の下の `❯ ` の行。Claude Code 2.1.283）。確認の画面は
 * 入力欄の代わりに出るので、文言の後ろにこれがあれば、文言は会話の本文の中のもの。
 */
const HORIZONTAL_RULE_LINE = /^\s*[─━]{8,}\s*$/;
const IDLE_INPUT_LINE = /^\s*❯(?!\s*\d+[.)])/;

/** 選択肢の1行目（`❯ 1. Yes` / `› 1. Yes, proceed` / `1) OK`。枠の縦線 `│` の内側でもよい）。 */
const FIRST_OPTION_LINE = /^[\s│┃|]*[❯›>▶]?\s*1[.)]\s*\S/;

function compact(text: string): string {
	return text.replace(/\s+/g, '').toLowerCase();
}

/** 末尾の空行を除いた行。 */
function screenLines(screen: string): string[] {
	const lines = screen.split('\n');
	while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
		lines.pop();
	}
	return lines;
}

/** 見えている範囲の下端の行（末尾の空行は除く）。 */
function promptRegion(screen: string): string[] {
	return screenLines(screen).slice(-PROMPT_REGION_LINES);
}

/** Codex の確認の操作説明（空白を除いた小文字）。文言を丸ごと照らす。 */
const CODEX_PROMPT_FOOTERS: readonly string[] = ['pressentertoconfirmoresctocancel', 'entertosubmit|esctocancel'];

/**
 * 最下部（末尾の 2 行。狭いペインでは操作説明が折り返す）に、Codex の確認の操作説明が出ているか。コマンド・編集の承認は
 * `Press enter to confirm or esc to cancel`（codex-rs/tui/src/bottom_pane/approval_overlay.rs）、MCP のツールの許可は
 * `enter to submit | esc to cancel`（mcp_server_elicitation.rs）。Claude Code の `Esc to cancel · Tab to amend` と
 * Codex の質問の `enter to submit answer | esc to interrupt` は当たらない。
 */
function showsCodexPromptFooter(lines: readonly string[]): boolean {
	const footer = compact(lines.slice(-2).join(''));
	return CODEX_PROMPT_FOOTERS.some(text => footer.includes(text));
}

/** 許可の確認を探す範囲。Codex の確認の操作説明が最下部にあれば広げる（{@link CODEX_PROMPT_REGION_LINES}）。 */
function permissionRegion(screen: string): string[] {
	const lines = screenLines(screen);
	return lines.slice(-(showsCodexPromptFooter(lines) ? CODEX_PROMPT_REGION_LINES : PROMPT_REGION_LINES));
}

/**
 * 許可の確認の見出しが `index` の行で終わるか。文言は折り返しで数行にまたがってもよい（空白を除いて照合する）。
 * Codex の MCP のツールの許可のフォームは、見出しの `Field 1/1` の行（最初の選択肢が `1. Allow` のときだけ）。
 */
function permissionHeadingEndsAt(lines: readonly string[], index: number): boolean {
	const from = Math.max(0, index - PROMPT_HEADING_SPAN_LINES + 1);
	const through = compact(lines.slice(from, index + 1).join(''));
	const before = compact(lines.slice(from, index).join(''));
	return PERMISSION_PROMPT_MARKERS.some(marker => through.includes(marker) && !before.includes(marker))
		|| paradisCodexApprovalFormHeadingAt(lines, index);
}

/**
 * 範囲の中で、いちばん下にある許可の確認の見出しの行。その後ろに選択肢の 1 行目が続き、入力欄が出ていないときだけ
 * （文言と選択肢の後ろに入力欄が出ていれば、それは本文の中の例示）。見つからなければ -1。
 */
function permissionHeadingIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 0; index--) {
		if (!permissionHeadingEndsAt(lines, index)) {
			continue;
		}
		const after = lines.slice(index + 1);
		if (!after.some(line => FIRST_OPTION_LINE.test(line))) {
			return -1;
		}
		const idleInput = after.some((line, lineIndex) => IDLE_INPUT_LINE.test(line) && lineIndex > 0 && HORIZONTAL_RULE_LINE.test(after[lineIndex - 1]));
		return idleInput ? -1 : index;
	}
	return -1;
}

/**
 * 画面の下端に出ている許可の確認を、見出しまで（見出しとその上のコマンドの行）と、見出しより後（選択肢の並び）に
 * 分ける（W2-21 のレビュー M1 / M2）。許可の確認が出ていなければ undefined。
 *
 * 選択肢は見出しより後の行からだけ読む（会話の本文に残っている番号付きの箇条書きを拾わないため）。`context` は
 * 見出しの行と、その上の空行までの行（コマンドの中身など。最大 {@link PROMPT_CONTEXT_LINES} 行）で、送る直前に
 * 同じ確認のままかを照らし合わせるのに使う。
 */
export function paradisPermissionPromptParts(screen: string): { readonly context: string; readonly options: string } | undefined {
	const lines = permissionRegion(screen);
	const index = permissionHeadingIndex(lines);
	if (index < 0) {
		return undefined;
	}
	// 見出しの上は、確認の枠の上端の横線か、空行が 2 つ続くところまで（最大 PROMPT_CONTEXT_LINES 行の中身）。
	// Claude Code の確認は「横線 / Bash command / 空行 / コマンド / 説明 / 空行 / 見出し」の形で、1 つの空行では止めない。
	let top = index;
	let filled = 0;
	while (top > 0 && filled < PROMPT_CONTEXT_LINES) {
		const above = lines[top - 1];
		if (HORIZONTAL_RULE_LINE.test(above) || (above.trim().length === 0 && top > 1 && lines[top - 2].trim().length === 0)) {
			break;
		}
		top--;
		if (above.trim().length > 0) {
			filled++;
		}
	}
	return { context: lines.slice(top, index + 1).join('\n'), options: lines.slice(index + 1).join('\n') };
}

/** 許可の確認の見出しの上から、照らし合わせに含める行の数。 */
const PROMPT_CONTEXT_LINES = 8;

/**
 * 許可の確認の見出しまで（{@link paradisPermissionPromptParts} の `context`）の指紋。空白の違い（折り返しの位置）は見ない。
 * 選択肢を見せたときと送る直前で違えば、別の確認に変わっている。
 */
export function paradisPermissionPromptHash(context: string): string {
	const sha = new StringSHA1();
	sha.update(context.replace(/\s+/g, ''));
	return sha.digest();
}

/**
 * 画面の下端に、許可の確認（Claude Code の許可・計画の確定、Codex の承認）が出ているか。文言に続いて
 * 選択肢の行が見えているときだけ true（会話の本文に同じ文言があるだけでは反応しない）。
 */
export function paradisScreenShowsPermissionPrompt(screen: string): boolean {
	return permissionHeadingIndex(permissionRegion(screen)) >= 0;
}

/** 画面の下端に、質問の選択の画面（操作説明か回答の確認）が出ているか。 */
export function paradisScreenShowsQuestionPrompt(screen: string): boolean {
	const region = compact(promptRegion(screen).join('\n'));
	return QUESTION_PROMPT_MARKERS.some(marker => region.includes(marker)) || CODEX_QUESTION_HEADING.test(region);
}

/**
 * 画面に、エージェントの TUI が利用者の回答を待つ画面（許可の確認・質問の選択肢）が出ているか。
 * デスクトップのチャット表示が文を送る前に使う。送った文の Enter が許可の既定の「Yes」や、質問の
 * ハイライト中の選択肢を確定してしまうのを防ぐため。`agent` が `'claude'` のときは、会話を開き直した直後の Claude Code の確認
 * （{@link paradisClaudeResumeScreenPrompt}）も含める（Codex の画面に同じ文言が出ても断らないよう、分からなければ見ない）。
 */
export function paradisScreenShowsAgentPrompt(screen: string, agent?: 'claude' | 'codex'): boolean {
	return paradisScreenShowsPermissionPrompt(screen) || paradisScreenShowsQuestionPrompt(screen)
		|| (agent === 'claude' && paradisScreenShowsClaudeResumePrompt(screen));
}

/**
 * 会話を開き直した直後・送る前に Claude Code が出す確認の種類（2.1.309 の `_promptStaleResume` が順に出す 3 つ）。
 * - `resume`: 「Resume this conversation?」（5 時間の使用量のうちどれだけを使うか）
 * - `session-age`: 「This session is … old and … tokens.」（要約から再開するか、そのまま再開するか）
 * - `newer-model`: 「You’re resuming an … session. Continue with …?」（同じ系統の新しいモデルへ切り替えるか）
 */
export type ParadisClaudeResumeScreenPrompt = 'resume' | 'session-age' | 'newer-model';

/** 断りの文に入れる、確認の呼び名。 */
export const PARADIS_CLAUDE_RESUME_SCREEN_PROMPT_NAMES: Readonly<Record<ParadisClaudeResumeScreenPrompt, string>> = {
	'resume': '「Resume this conversation?」（会話を再開するか、新しい会話にするか）の再開の確認',
	'session-age': '「This session is ... old」（要約から再開するか、そのまま再開するか）の古いセッションの確認',
	'newer-model': '「You\'re resuming ... session」（新しいモデルに切り替えて再開するか）のモデルの確認',
};

/**
 * 確認ごとの、最下部（末尾の 2 行）の操作説明と、その上で探す見出し（どちらも空白を除いた小文字）。
 *
 * - `resume`: 操作説明は `Enter to confirm · Esc to resume`（使っていない間に出る型は `Esc to dismiss`）。見出しは
 *   `Resume this conversation?`（2.1.306 の実画面）。
 * - `session-age`: 操作説明は汎用の `Enter to confirm · Esc to cancel`。見出し `This session is 4h 59m old and 300k tokens.` と
 *   選択肢 `Resume full session as-is` がそろうときだけ（2.1.309 の実画面）。旗 `tengu_gleaming_fair`（または要約の用意が
 *   できた `_reuse`）があり、最後の発言から 70 分以上・10 万トークン以上のときに出る。
 * - `newer-model`: 操作説明は汎用の `Enter to confirm · Esc to cancel`（2.1.309 のバイナリで、この確認も古いセッションの確認と同じ
 *   確認の部品に題名と `onCancel` だけを渡して描いており、操作説明を差し替えていないことを確かめた）。見出しは
 *   `You’re resuming an Opus 5 session. Continue with Opus 5.5?`、選択肢は `Keep …` と `Continue with …`（2.1.309 の
 *   バイナリの文字列。旗 `tengu_hidden_volcano` が `form: "dialog"` のときだけ出るので、実画面は出せていない）。
 */
const CLAUDE_RESUME_SCREEN_PROMPTS: readonly { readonly kind: ParadisClaudeResumeScreenPrompt; readonly footer: RegExp; readonly body: readonly RegExp[] }[] = [
	{ kind: 'resume', footer: /entertoconfirm\u00b7escto(?:resume|dismiss)/, body: [/resumethisconversation\?/] },
	{ kind: 'session-age', footer: /entertoconfirm\u00b7esctocancel/, body: [/thissessionis.{1,40}oldand.{1,20}tokens\./, /resumefullsessionas-is/] },
	{ kind: 'newer-model', footer: /entertoconfirm\u00b7esctocancel/, body: [/you[\u2019']reresuminga.{1,60}session\.continuewith.{1,60}\?/, /keep.{1,60}continuewith/] },
];

/**
 * 画面の最下部に、会話を開き直した直後の Claude Code の確認（{@link ParadisClaudeResumeScreenPrompt}）が出ていれば、その種類。
 * Claude Code のペインでだけ使うこと（文言だけで見るので、Codex の画面の本文に同じ文が出ると当たる）。
 *
 * どの確認も入力欄の代わりに出て、出ている間に打った文字は捨てられ、Enter はカーソルのある選択肢（再開・要約から再開・
 * 新しいモデル）を選ぶ（文はどこにも届かない。2.1.306 と 2.1.309 の実画面で確かめた）。Esc も選択の 1 つで、再開の確認と
 * 古いセッションの確認ではそのまま全部を読み直して再開する。
 *
 * 最下部（末尾の 2 行。狭いペインでは折り返す）の操作説明を基準にし（Codex の {@link showsCodexPromptFooter} と同じ形）、
 * その上の {@link CODEX_PROMPT_REGION_LINES} 行の中に見出しと選択肢があれば当たる。狭いペインで本文が折り返して確認が
 * 背高になっても取りこぼさない。操作説明が最下部にある限り確認がそこに出ているので、上の会話の本文とは取り違えない。
 */
export function paradisClaudeResumeScreenPrompt(screen: string): ParadisClaudeResumeScreenPrompt | undefined {
	const lines = screenLines(screen);
	const footer = compact(lines.slice(-2).join(''));
	const region = compact(lines.slice(-CODEX_PROMPT_REGION_LINES).join(''));
	return CLAUDE_RESUME_SCREEN_PROMPTS.find(prompt => prompt.footer.test(footer) && prompt.body.every(body => body.test(region)))?.kind;
}

/** {@link paradisClaudeResumeScreenPrompt} のどれかが出ているか。 */
export function paradisScreenShowsClaudeResumePrompt(screen: string): boolean {
	return paradisClaudeResumeScreenPrompt(screen) !== undefined;
}

/**
 * 画面の下端の許可の確認（{@link paradisPermissionPromptParts} の、見出しの上の行から最下部まで）に、この一片が見えているか。
 * 空白と改行は見ない（理由やコマンドが折り返していても当たる）。確認の外（上に残る会話の本文）は見ない。
 */
export function paradisPromptRegionShows(screen: string, piece: string): boolean {
	const prompt = paradisPermissionPromptParts(screen);
	return prompt !== undefined && compact(piece).length > 0 && compact(`${prompt.context}\n${prompt.options}`).includes(compact(piece));
}

/** 打鍵の送り先（ITerminalInstance の必要な部分だけ。テストで差し替えられるように）。 */
export interface IParadisAgentTuiTarget {
	sendText(text: string, shouldExecute: boolean): Promise<void>;
}

/** 打鍵を始める前の確かめ方。 */
export interface IParadisAgentTuiReadyOptions {
	/** 今の画面の見えている範囲。 */
	readonly readScreen: () => string;
	/** 画面にこれが出たら流し始める（質問の選択肢ラベル、または判定関数）。 */
	readonly ready: string | ((screen: string) => boolean) | undefined;
	/**
	 * true なら、目印が無い・待っても出ないときは流さない（デスクトップ）。false なら流す（モバイル。
	 * 利用者はその場で画面を見られないので、取りこぼしを減らすための待ちであって門ではない）。
	 */
	readonly strict: boolean;
	/** 計測で経路を分けるため。 */
	readonly source: 'mobile' | 'desktop';
	/** 目印を待つ上限（テストで短くする）。既定は INTERACTION_READY_TIMEOUT_MS。 */
	readonly timeoutMs?: number;
}

/**
 * 打鍵を流し始めてよい状態になるまで待つ。流してよければ true。
 *
 * TUI は「質問を描く」のと「選択肢リストがキーボードフォーカスを取る」のが同時ではない。
 * その隙間に届いたキーは**入力欄へ吸われて消える**（Claude Code 2.1.223 で実測。待たずに
 * 送ると入力欄に文字が残るだけで質問は動かず、3秒待てば同じキーがそのまま通った）。
 * 単問・単一選択のキー列は数字1つだけなので、これを落とすと後続で拾い直す機会が無い。
 *
 * 目印は質問自身の選択肢ラベル（paradisQuestionReadyMarker）。TUI のフッタ文言に
 * 頼ると、表示が変わったときに黙って壊れる。
 */
export async function paradisWaitForAgentInteractionTarget(options: IParadisAgentTuiReadyOptions, partCount: number): Promise<boolean> {
	const startedAt = Date.now();
	const settle = () => new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_SETTLE_MS));
	// この待ちが効いているかは本番でしか分からない。目印を見つけられたのか、時間切れだったのか、
	// そもそも目印が無かったのかを残さないと、「まだ落ちる」ときに次の一手を決められない。
	//
	// **これは renderer 発なので、届く保証がまだない**（このプロジェクトでは renderer 由来の
	// transaction が一度も観測できていない。原因は未特定）。レース説そのものの判定は
	// PC側（shared process）の `agentQuestion.answer-settled` に載せた `safe_ms_since_question`
	// で行う。こちらは届けば「目印の待ちが効いたか」という一段細かい話が読める、という位置づけ。
	const record = (outcome: 'marker-seen' | 'timed-out' | 'no-marker') => {
		runInParadisSpan('agentQuestion', 'inject-wait', {
			safe_outcome: outcome,
			safe_wait_ms: Date.now() - startedAt,
			// 1つだけの回答（単問・単一選択、承認）は取りこぼすと拾い直せない。
			safe_key_parts: partCount,
			safe_source: options.source,
		}, () => { });
	};
	const ready = options.ready;
	if (ready === undefined) {
		record('no-marker');
		if (options.strict) {
			return false;
		}
		// 目印を作れない回答（承認など）は、少なくとも先頭を0msで叩かない。
		// 承認の「はい」は `1` に続けて Enter を送るので、先頭が入力欄へ吸われると
		// **Enterがその `1` をエージェントへのメッセージとして送信してしまう**。
		await settle();
		return true;
	}
	const matches = typeof ready === 'string' ? (screen: string) => paradisScreenShowsMarker(screen, ready) : ready;
	const deadline = startedAt + (options.timeoutMs ?? INTERACTION_READY_TIMEOUT_MS);
	while (Date.now() < deadline) {
		if (matches(options.readScreen())) {
			// 描かれてからフォーカスが移るまでのわずかな隙間を越えるための一拍。
			await settle();
			record('marker-seen');
			return true;
		}
		await new Promise<void>(resolve => setTimeout(resolve, INTERACTION_READY_POLL_MS));
	}
	record('timed-out');
	if (options.strict) {
		return false;
	}
	// 目印が見つからないまま時間切れ。モバイルではそのまま流す（画面の読み取りに失敗して回答できなく
	// なる方が悪い）。
	await settle();
	return true;
}

/**
 * 回答のキー列を、先頭の前に画面を確かめてから一定間隔で1つずつ流す。
 *
 * `beforeEachKey` は各キーを流す直前に呼ばれ、`false` を返すとそこで止める。**待ちを挟んだ後は
 * 必ず作り直しと差し替えを確かめること。** 先頭の打鍵にも待ちが入るので、「待っている間に別の
 * 経路で答えられた／別の質問に変わった」窓がある。ここを飛ばすと、消えた質問の跡地へ数字を
 * 打ち込むことになり、続く Enter でそれがエージェントへのメッセージとして送信される。
 *
 * @returns 全部流せたら 'sent'、途中で止めたら 'stopped'、流し始める前に目印を確かめられなかったら 'not-ready'。
 */
export async function paradisSendAgentInteractionKeys(
	target: IParadisAgentTuiTarget,
	parts: readonly string[],
	delayMs: number,
	readyOptions: IParadisAgentTuiReadyOptions,
	beforeEachKey: () => Promise<boolean>,
): Promise<'sent' | 'stopped' | 'not-ready'> {
	// **最初の1打鍵を待たずに流さないこと。** TUI が選択肢リストへキーボードフォーカスを
	// 移す前に届いたキーは、リストではなく入力欄へ吸われて消える（Claude Code 2.1.223 で
	// 実測）。キー列が1つだけの回答は、これを落とすと拾い直す機会が無い。
	if (!(await paradisWaitForAgentInteractionTarget(readyOptions, parts.length))) {
		return 'not-ready';
	}
	for (let index = 0; index < parts.length; index++) {
		if (index > 0) {
			await new Promise<void>(resolve => setTimeout(resolve, delayMs));
		}
		if (!(await beforeEachKey())) {
			return 'stopped';
		}
		await target.sendText(parts[index], false);
	}
	return 'sent';
}

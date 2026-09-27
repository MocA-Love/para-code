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

import { runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

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
	// Codex の承認
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

/** 見えている範囲の下端の行（末尾の空行は除く）。 */
function promptRegion(screen: string): string[] {
	const lines = screen.split('\n');
	while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
		lines.pop();
	}
	return lines.slice(-PROMPT_REGION_LINES);
}

/**
 * 下端の範囲に、いずれかの文言があり、しかもその後ろに選択肢の1行目が続いているか。折り返しで文言が
 * 2行にまたがっても見つけられるよう、行を足しながら空白を除いて照合する。
 */
function regionShowsPromptWithOptions(lines: readonly string[], markers: readonly string[]): boolean {
	let joined = '';
	for (let index = 0; index < lines.length; index++) {
		joined += compact(lines[index]);
		if (markers.some(marker => joined.includes(marker))) {
			const after = lines.slice(index + 1);
			if (!after.some(line => FIRST_OPTION_LINE.test(line))) {
				return false;
			}
			// 文言と選択肢の後ろに入力欄が出ていれば、それは本文の中の例示（確認の画面ではない）。
			const idleInput = after.some((line, lineIndex) => IDLE_INPUT_LINE.test(line) && lineIndex > 0 && HORIZONTAL_RULE_LINE.test(after[lineIndex - 1]));
			return !idleInput;
		}
	}
	return false;
}

/**
 * 画面の下端に、許可の確認（Claude Code の許可・計画の確定、Codex の承認）が出ているか。文言に続いて
 * 選択肢の行が見えているときだけ true（会話の本文に同じ文言があるだけでは反応しない）。
 */
export function paradisScreenShowsPermissionPrompt(screen: string): boolean {
	return regionShowsPromptWithOptions(promptRegion(screen), PERMISSION_PROMPT_MARKERS);
}

/** 画面の下端に、質問の選択の画面（操作説明か回答の確認）が出ているか。 */
export function paradisScreenShowsQuestionPrompt(screen: string): boolean {
	const region = compact(promptRegion(screen).join('\n'));
	return QUESTION_PROMPT_MARKERS.some(marker => region.includes(marker)) || CODEX_QUESTION_HEADING.test(region);
}

/**
 * 画面に、エージェントの TUI が利用者の回答を待つ画面（許可の確認・質問の選択肢）が出ているか。
 * デスクトップのチャット表示が文を送る前に使う。送った文の Enter が許可の既定の「Yes」や、質問の
 * ハイライト中の選択肢を確定してしまうのを防ぐため。
 */
export function paradisScreenShowsAgentPrompt(screen: string): boolean {
	return paradisScreenShowsPermissionPrompt(screen) || paradisScreenShowsQuestionPrompt(screen);
}

/** 画面の下端に、この一片（空白を除いたもの）が見えているか。 */
export function paradisPromptRegionShows(screen: string, piece: string): boolean {
	return compact(promptRegion(screen).join('\n')).includes(compact(piece));
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

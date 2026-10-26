/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisApprovalOptionKey, paradisCodexApprovalFormShown, paradisCodexApprovalFormShows, paradisParseApprovalOptionChoice, paradisParseApprovalOptions } from './paradisAgentApprovalOptions.js';

/**
 * モバイルからの AskUserQuestion 回答を、Claude Code のTUIへ流し込むキー列に変換する。
 *
 * TUI（Claude Code 2.1系）の実挙動は以下の通りで、素朴な「番号 → Enter」では合わない:
 *
 *  - **数字キーは即選択**。ハイライトの移動ではなく、その場で回答が確定する。単一選択の
 *    質問では確定と同時に次の質問へ自動で進むため、続けてEnterを送ると *次の質問* の
 *    先頭選択肢を確定させてしまう（多問で答えが1問ずつずれる原因）
 *  - **自由入力（Other）は入力欄が空のあいだ、数字キーではフォーカスが移るだけ**。
 *    その状態でEnterを送ると空のまま確定を試み、単一選択では質問全体がキャンセルされる。
 *    正しくは「番号 → 本文 → Enter」の順
 *  - **複数選択の質問はEnterでも数字でも次へ進まない**。数字はトグル、Enter/スペースは
 *    フォーカス中の項目のトグルで、前進するには末尾の送信ボタンへ移動してEnterが要る。
 *    進めないまま次の答えを送ると、すべて同じ質問に降り注いでチェックが増え続ける
 *  - **送信ボタンへの移動にTabは使えない**。TUIはTabを「次の質問へのタブ切り替え」に
 *    割り当てていて（`{context:"Tabs", bindings:{tab:"tabs:next", right:"tabs:next", ...}}`）、
 *    そちらが選択肢リスト側のフォーカス移動より先に食う。実機（2.1.220）で、4選択肢の質問へ
 *    Tabを5回送ると Q1→Q2→確認画面 まで飛び、締めのEnterが未回答のまま送信を叩いた。
 *    下矢印にはこの割り当てが無いので、そちらで送信ボタンまで降りる
 *  - 単問かつ単一選択のときだけ確認画面が出ない。それ以外は最後に「Review your answers」
 *    が出るので、締めのEnterが1回要る
 *
 *
 * **2026-08-06に Claude Code 2.1.223 で測り直した**: 数字キーの規則そのものは 2.1.220 から
 * 変わっていない（単一選択は数字だけで確定し、次の質問へ自動で進む）。ただし
 * **質問が描かれてから選択肢リストがキーボードフォーカスを取るまでに隙間があり、
 * そこへ届いたキーは入力欄へ吸われて消える**（待たずに送ると入力欄に文字が残るだけで質問は
 * 動かず、3秒待った同じキーはそのまま通った）。注入側は先頭の打鍵の前に画面を確かめる
 * （paradisMobileWorkspaceProvider の waitForInteractionTarget）。
 * 送信側（PC/モバイル）で同じ列を組み立てられるよう、副作用のない関数だけを置く。
 * この段取りは Claude Code 2.1.220 の TUI に**生バイトを PTY へ書き込んで**実測したもので、
 * 注入の形式（`\u001b[B` をそのまま流す）まで本番と同じ条件で確かめてある。行の並びが前提なので、
 * **Claude Code を更新したら測り直すこと**。前提が崩れると、行き過ぎた Enter がチャットを開き、
 * 以降の回答キーがそのままエージェントへのメッセージとして送られる。
 */

/** 1問ぶんのTUI上の形（キー列の組み立てに要るものだけ）。 */
export interface IParadisAgentQuestionShape {
	/** 「Other」を除いた選択肢の数。 */
	readonly optionCount: number;
	readonly multiSelect: boolean;
	/**
	 * TUI がこの質問で preview を描くか（`paradisAgentQuestionHasPreview`）。描く質問には「その他」（Type something）の
	 * 行が無い（Claude Code 2.1.288 で確認）。
	 */
	readonly hasPreview: boolean;
}

/** 1問ぶんの回答。モバイルから届くものと同じ形。 */
export type ParadisAgentQuestionAnswer =
	| { readonly kind: 'option'; readonly index: number }
	| { readonly kind: 'multi'; readonly indices: readonly number[] }
	| { readonly kind: 'text'; readonly optionCount: number; readonly text: string };

const ENTER = '\r';
const DOWN = '\u001b[B';

/**
 * 自由入力の本文をTUIの1行入力に流せる形へ均す。
 *
 * 潰すのは改行だけではない。本文は bracketed paste で包まずそのまま PTY へ流れ、TUI は届いた
 * チャンクを打鍵に分解するので、**制御文字はキーとして食われる**:
 *  - 改行はその場で確定扱いになり、残りが次の質問へ流れ込む
 *  - タブは `tabs:next`（次の質問へのタブ切り替え）に割り当てられている。PCからコピーした
 *    コードを貼ると普通に混入するので、これがいちばん踏みやすい
 *  - ESC はエスケープシーケンスの開始として解釈され、後続の文字次第で矢印やキャンセルに化ける
 * どれも「本文の途中から別の質問へ答えが降り始める」形で壊れるため、まとめて空白にする。
 */
function flattenText(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * 選択肢の並びの末尾にある Other（自由入力）行まで降りるための下矢印。
 *
 * 起点が0行目であることに依存している。質問が出た直後のフォーカスは常に先頭の選択肢で、
 * 数字キーはトグルするだけでフォーカスを動かさない（どちらも実機 2.1.220 で確認）。
 */
function downsToOtherRow(optionCount: number): string[] {
	return new Array<string>(optionCount).fill(DOWN);
}

/**
 * 送信ボタン（Next/Submit）まで降りるための下矢印。Other 行のちょうど1つ下にある。
 *
 * Tab と違い**多く送ると行き過ぎる**（送信ボタンの先に「Chat about this」があり、そこで
 * Enter を送るとチャットが開く。以降のキーは入力欄へ流れ込み、最後の Enter で混ざった文字列が
 * エージェントへ送信されてしまう）ので、過不足の無い数でなければならない。
 */
function downsToSubmitButton(optionCount: number): string[] {
	return [...downsToOtherRow(optionCount), DOWN];
}

/**
 * 回答をキー列にする。`questions` は `answers` と同じ並び（TUIの質問順）で渡す。
 *
 * 返る各要素は「1回ぶんの入力」で、呼び出し側が一定間隔を空けて順に流す前提。
 *
 * preview のある質問（単一選択で、どれかの選択肢に preview がある）は数字キーの規則が違う。Claude Code 2.1.288 を tmux で
 * 操作して測った（2026-10-04）:
 *  - 数字キーはフォーカスを移して preview を切り替えるだけで、確定しない。単問でも多問でも次へ進まない
 *  - 確定は Enter。単問ならそのまま送信され、多問なら次の質問へ進む（多問の最後の確認画面は従来どおり Enter が要る）
 *  - 「その他」（Type something）の行が無い。選択肢の下は区切り線を挟んで「Chat about this」
 * そこで preview のある質問の選択肢は「番号 → Enter」にし、自由入力は列を作らない（呼び出し側は送らずに断る）。
 * `選択肢数+1` は何も選ばず、続く本文の `n` がメモ欄を開き、最後の Enter がフォーカス中の選択肢を確定してしまうため。
 */
export function paradisAgentQuestionKeySequence(
	questions: readonly IParadisAgentQuestionShape[],
	answers: readonly ParadisAgentQuestionAnswer[],
): string[] {
	return paradisAgentQuestionKeyPlan(questions, answers).parts;
}

/**
 * 複数選択の問いで、チェックの数字を打ち終えて送信ボタンへ降りる前に、画面で確かめるチェック。
 *
 * 選択肢リストがキーを受け付ける前に届いた数字は入力欄へ吸われ、そのチェックだけが黙って抜けたまま次へ進む
 * （Claude Code 2.1.310 で、先頭の選択肢のラベルが出た直後に流すと再現した）。打ち直すか止めるかは流す側が決める。
 */
export interface IParadisAgentQuestionKeyCheck {
	/** この添字の `parts` を流す直前に確かめる。 */
	readonly beforePart: number;
	/** チェックが付いているはずの選択肢の番号（1 始まり、昇順）。 */
	readonly checked: readonly number[];
	/** 「その他」を除いた選択肢の数。 */
	readonly optionCount: number;
}

/** {@link paradisAgentQuestionKeySequence} のキー列と、その途中で確かめるチェック（{@link IParadisAgentQuestionKeyCheck}）。 */
export function paradisAgentQuestionKeyPlan(
	questions: readonly IParadisAgentQuestionShape[],
	answers: readonly ParadisAgentQuestionAnswer[],
): { readonly parts: string[]; readonly checks: IParadisAgentQuestionKeyCheck[] } {
	const parts: string[] = [];
	const checks: IParadisAgentQuestionKeyCheck[] = [];
	for (const [index, answer] of answers.entries()) {
		const question = questions[index];
		if (question === undefined) {
			continue;
		}
		if (answer.kind === 'text' && question.hasPreview === true) {
			return { parts: [], checks: [] };
		}
		if (answer.kind === 'option') {
			// 数字だけで確定し、次の質問へ自動で進む。Enterは送らない。
			// preview のある質問だけは数字がフォーカスを移すだけなので、Enter で確定する（上の実測）。
			parts.push(String(answer.index + 1));
			if (question.hasPreview === true) {
				parts.push(ENTER);
			}
			continue;
		}
		if (answer.kind === 'multi') {
			// 数字はトグルのみ（フォーカスは動かない）。スペースは「フォーカス中の項目」を
			// トグルしてしまうので送らない。
			const checked = [...new Set(answer.indices)].sort((a, b) => a - b).map(optionIndex => optionIndex + 1);
			for (const optionNumber of checked) {
				parts.push(String(optionNumber));
			}
			checks.push({ beforePart: parts.length, checked, optionCount: question.optionCount });
			parts.push(...downsToSubmitButton(question.optionCount), ENTER);
			continue;
		}
		const text = flattenText(answer.text);
		if (question.multiSelect) {
			// 複数選択のOther行は数字では選べない（数字はトグル）。下矢印で入力欄まで降りて
			// 本文を入れると自動で選択され、そこからもう1つ下で送信ボタンへ。
			parts.push(...downsToOtherRow(question.optionCount), text, DOWN, ENTER);
			continue;
		}
		// 単一選択のOther: 番号でフォーカスを移し、本文を入れてからEnterで確定する。
		parts.push(String(answer.optionCount + 1), text, ENTER);
	}
	if (parts.length > 0 && paradisAgentQuestionNeedsReviewSubmit(questions)) {
		parts.push(ENTER);
	}
	return { parts, checks };
}

/**
 * 画面に出ている複数選択の問いの、チェックの付いた選択肢の番号（1 始まり）。読めなければ undefined。
 *
 * Claude Code 2.1.310 の複数選択の行は `❯ 1. [✔] Apple` / `  2. [ ] Banana`（フォーカスの印 `❯` は 1 行だけ）。
 * 「その他」の行も `5. [ ] Type something` と同じ形で並ぶので、`optionCount` より大きい番号は数えない。
 * 会話の上の方に同じ形の行が残っていても取り違えないよう、1 番から始まるいちばん下のまとまりを読む。
 */
export function paradisVisibleQuestionChecks(screen: string, optionCount: number): number[] | undefined {
	let block: Map<number, boolean> | undefined;
	let last: Map<number, boolean> | undefined;
	for (const line of screen.split(/\r?\n/)) {
		const row = /^\s*(?:[\u276f\u203a>]\s*)?(?<number>\d{1,2})\.\s+\[(?<mark>.)\]/u.exec(line);
		if (row?.groups === undefined) {
			continue;
		}
		const optionNumber = Number(row.groups.number);
		if (optionNumber === 1) {
			block = new Map();
			last = block;
		}
		block?.set(optionNumber, (row.groups.mark ?? ' ').trim().length > 0);
	}
	if (last === undefined) {
		return undefined;
	}
	const checked: number[] = [];
	for (let optionNumber = 1; optionNumber <= optionCount; optionNumber++) {
		const mark = last.get(optionNumber);
		if (mark === undefined) {
			return undefined;
		}
		if (mark) {
			checked.push(optionNumber);
		}
	}
	return checked;
}

/**
 * 全問に答えたあと「Review your answers」の確認画面が出るか。
 * 単問かつ単一選択のときだけ、確定と同時に送信されて確認画面を挟まない。
 */
export function paradisAgentQuestionNeedsReviewSubmit(questions: readonly IParadisAgentQuestionShape[]): boolean {
	return !(questions.length === 1 && questions[0]?.multiSelect === false);
}

/**
 * 許可の確認（Claude Code の「Do you want to proceed?」、Codex の承認プロンプト）への回答をキー列にする。
 *
 * Claude は `1`（Yes）で許可、Esc で拒否。`1` だけを送り、Enter は送らない: Claude Code 2.1.283 の許可画面は
 * 数字キーで即確定するので、後から送った Enter が次の入力に漏れ、次に出た同じ内容の許可を確定した
 * （フェーズ6の実機確認 NG-2）。以前はモバイルだけ `1` の後に Enter も送っていたが、デスクトップのチャット表示と
 * 揃えた（Orca の `mobile-native-chat-permission-send.ts` も `1` だけ）。`confirmWithEnter: true` は、
 * 数字で確定しない版のための逃げ道として残す（今は使っていない）。
 *
 * Codex は `y` で許可。拒否のキーは版で違う: codex-cli 0.155.1 の画面は
 * `3. No, and tell Codex what to do differently (esc)` で Esc、それより前の版は `d`。画面の文字が
 * 渡されれば、選択肢の行の末尾の `(…)` から選ぶ（{@link paradisCodexApprovalDenyKey}）。
 * 画面が MCP のツールの許可のフォーム（{@link paradisCodexApprovalFormShown}）なら、許可は `1`、拒否は Esc、
 * 番号の選択肢はその数字（フォームには近道が無く、`y` / `d` は何もしない。codex-cli 0.162.1）。
 *
 * モバイルとデスクトップのチャット表示が同じ関数を使う（Codex の app-server 経由の承認は
 * キーではなく構造化された回答で返すので、ここは通らない）。
 */
export function paradisAgentApprovalKeySequence(agent: 'claude' | 'codex', choice: 'yes' | 'no' | `opt:${number}`, options?: { readonly screen?: string; readonly confirmWithEnter?: boolean }): string[] {
	// 画面の番号付きの選択肢から選んだ回答（W2-21）。Claude は数字 1 文字だけ（Enter は付けない）。
	// Codex は画面の行末の近道が要るので、画面が無い・読めない・近道の無い行なら空（呼び出し側は断る）。
	const optionNumber = choice === 'yes' || choice === 'no' ? undefined : paradisParseApprovalOptionChoice(choice);
	if (choice !== 'yes' && choice !== 'no') {
		if (optionNumber === undefined) {
			return [];
		}
		if (agent === 'claude') {
			return [String(optionNumber)];
		}
		const screen = options?.screen;
		const option = screen !== undefined ? paradisParseApprovalOptions(screen)?.find(candidate => candidate.n === optionNumber) : undefined;
		const key = option !== undefined && screen !== undefined ? paradisApprovalOptionKey('codex', option, paradisCodexApprovalFormShown(screen)) : undefined;
		return key !== undefined ? [key] : [];
	}
	if (agent === 'codex') {
		if (options?.screen !== undefined && paradisCodexApprovalFormShown(options.screen)) {
			return [choice === 'yes' ? '1' : '\u001b'];
		}
		return [choice === 'yes' ? 'y' : paradisCodexApprovalDenyKey(options?.screen)];
	}
	if (choice === 'no') {
		return ['\u001b'];
	}
	return options?.confirmWithEnter === true ? ['1', ENTER] : ['1'];
}

/**
 * モバイルの許可・拒否（中継は画面を見られないので、Codex には `y` / `d` を送ってくる）を、送る直前の画面に合わせたキーにする。
 * 拒否は画面の選択肢の近道から選ぶ。MCP のツールの許可のフォームには近道が無いので `1` / Esc にするが、それはフォームが
 * この承認の確認だと確かめられた（`piece` がフォームに見えている）ときだけ。確かめられなければ `y` / `d` のまま返す
 * （フォームでは何も起きない。カードと違うツールの許可を確定しないため）。
 */
export function paradisCodexMobileApprovalKeys(key: 'y' | 'd', screen: string, piece: string | undefined): string[] {
	if (paradisCodexApprovalFormShown(screen) && (piece === undefined || !paradisCodexApprovalFormShows(screen, piece))) {
		return [key];
	}
	return paradisAgentApprovalKeySequence('codex', key === 'y' ? 'yes' : 'no', { screen });
}

/**
 * 拒否の選択肢の行（`No, …` で始まり、行末に近道 `(esc)` / `(d)` / `(n)` がある）。行頭の枠（古い Codex の `▌` を含む）・選択の印・番号の後に
 * `No` が来るものだけ（承認の画面の上に残る会話の文、例えば `No match (a)` を拾わない）。
 */
const DENY_OPTION_LINE = /^[\s│┃|▌]*(?:[❯›>▶]\s*)?(?:[1-9][.)]\s+)?No\b.*\((?<key>esc|[a-z])\)\s*[│┃|]?\s*$/;

/**
 * Codex の承認の画面から、拒否のキーを選ぶ。画面の下にある番号付きの選択肢の並びから `No, …` の行の近道を読む。
 * 並びとして読めなければ、下から探して最初の拒否の選択肢の行（承認の画面は画面のいちばん下に出る）。
 * 画面が無い・読めないときは、以前からの `d`。
 */
export function paradisCodexApprovalDenyKey(screen: string | undefined): string {
	if (screen !== undefined) {
		const option = paradisParseApprovalOptions(screen)?.find(candidate => /^No\b/.test(candidate.label) && candidate.shortcut !== undefined);
		const optionKey = option !== undefined ? paradisApprovalOptionKey('codex', option) : undefined;
		if (optionKey !== undefined) {
			return optionKey;
		}
		for (const line of screen.split('\n').reverse()) {
			const key = DENY_OPTION_LINE.exec(line)?.groups?.key;
			if (key !== undefined) {
				return key === 'esc' ? '\u001b' : key;
			}
		}
	}
	return 'd';
}

/** 中継から届いた {@link IParadisAgentQuestionKeyCheck} の並びを読む（形が違うものは捨てる）。`partCount` はキー列の長さ。 */
export function paradisReadQuestionKeyChecks(value: unknown, partCount: number): IParadisAgentQuestionKeyCheck[] {
	if (!Array.isArray(value) || value.length > 4) {
		return [];
	}
	const checks: IParadisAgentQuestionKeyCheck[] = [];
	for (const item of value) {
		const candidate = typeof item === 'object' && item !== null ? item as { beforePart?: unknown; checked?: unknown; optionCount?: unknown } : undefined;
		const beforePart = candidate?.beforePart;
		const optionCount = candidate?.optionCount;
		const checked = candidate?.checked;
		if (typeof beforePart !== 'number' || !Number.isInteger(beforePart) || beforePart < 0 || beforePart >= partCount
			|| typeof optionCount !== 'number' || !Number.isInteger(optionCount) || optionCount < 1 || optionCount > 9
			|| !Array.isArray(checked) || checked.length === 0
			|| !checked.every(number => typeof number === 'number' && Number.isInteger(number) && number >= 1 && number <= optionCount)) {
			continue;
		}
		checks.push({ beforePart, checked: [...new Set(checked as number[])].sort((a, b) => a - b), optionCount });
	}
	return checks;
}

/**
 * 画面のチェック（{@link paradisVisibleQuestionChecks}）が送るつもりのものと合うか。`missing` は打ち直せば直る（数字はトグル）。
 * `extra` は付いているはずの無いチェック（PC で誰かが触った等）で、打ち直すと別のものを外しかねないので止める。
 * 画面を読めなければ `unreadable`（今までどおり流す）。
 */
export function paradisQuestionChecksVerdict(visible: readonly number[] | undefined, check: IParadisAgentQuestionKeyCheck): { readonly kind: 'ok' } | { readonly kind: 'extra' } | { readonly kind: 'unreadable' } | { readonly kind: 'missing'; readonly missing: number[] } {
	if (visible === undefined) {
		return { kind: 'unreadable' };
	}
	if (visible.some(number => !check.checked.includes(number))) {
		return { kind: 'extra' };
	}
	const missing = check.checked.filter(number => !visible.includes(number));
	return missing.length > 0 ? { kind: 'missing', missing } : { kind: 'ok' };
}

/** {@link paradisConfirmQuestionChecks} が画面とのやり取りに使うもの（テストでは偽物を渡す）。 */
export interface IParadisQuestionCheckScreen {
	/** 今の画面の文字。 */
	read(): string;
	/** 1 打鍵を送る。 */
	send(key: string): Promise<void>;
	/** `ms` だけ待つ。 */
	wait(ms: number): Promise<void>;
	/** 答える相手がまだこの質問か（打ち直す直前に確かめる。待つあいだに PC で答えられたり、質問が変わったりするため）。 */
	stillCurrent(): Promise<boolean>;
}

/** {@link paradisConfirmQuestionChecks} の結果。`ok` と `unreadable` のときだけ送信ボタンへ降りてよい。 */
export type ParadisQuestionChecksOutcome = 'ok' | 'unreadable' | 'retyped' | 'extra' | 'unsettled' | 'still-missing' | 'stale';

/** 画面が落ち着いたとみなすまでに読む回数の上限（2 回続けて同じなら落ち着いた）。 */
const QUESTION_CHECK_MAX_READS = 6;
/** 読む間隔の下限。`delayMs` が 0 でも、画面へ届くまでの間を空ける。 */
const QUESTION_CHECK_MIN_INTERVAL_MS = 150;
/**
 * 落ち着いた画面でチェックが抜けていたとき、打ち直す前にもう一度待つ時間。往復が読む間隔の 2 倍を超えると、
 * まだ届いていないだけの画面でも 2 回続けて同じに読めてしまうため。抜けたときだけ掛かる。
 */
const QUESTION_CHECK_MISSING_GRACE_MS = 1_000;

/**
 * 画面のチェックを、`intervalMs` を空けて 2 回続けて同じに読めるまで読む。落ち着かなければ undefined。
 * 打鍵の反映は SSH の往復だけ遅れるので、1 回読んだだけで「抜けた」と決めない（まだ届いていないチェックを打ち直すと、
 * 数字はトグルなので外れてしまう）。
 */
async function settledQuestionChecks(screen: IParadisQuestionCheckScreen, optionCount: number, intervalMs: number): Promise<{ readonly visible: number[] | undefined } | undefined> {
	let previous: string | undefined;
	for (let read = 0; read < QUESTION_CHECK_MAX_READS; read++) {
		if (read > 0) {
			await screen.wait(intervalMs);
		}
		const visible = paradisVisibleQuestionChecks(screen.read(), optionCount);
		const key = visible === undefined ? 'unreadable' : visible.join(',');
		if (key === previous) {
			return { visible };
		}
		previous = key;
	}
	return undefined;
}

/**
 * 複数選択の問いのチェックが、送るつもりのものと画面で合っているかを確かめる。選択肢リストがキーを受け付ける前に届いた数字は
 * 入力欄へ吸われ、そのチェックだけが黙って抜ける（Claude Code 2.1.310 で再現）。画面が落ち着いてから（2 回続けて同じに読めてから）
 * 判断し、落ち着いた画面で抜けていて、{@link QUESTION_CHECK_MISSING_GRACE_MS} 待って読み直しても抜けていたときだけ、抜けた数字を
 * 1 回打ち直す。打ち直した後も、落ち着いた画面で合ったときだけ進める。
 */
export async function paradisConfirmQuestionChecks(screen: IParadisQuestionCheckScreen, check: IParadisAgentQuestionKeyCheck, delayMs: number): Promise<ParadisQuestionChecksOutcome> {
	const intervalMs = Math.max(delayMs, QUESTION_CHECK_MIN_INTERVAL_MS);
	const first = await settledQuestionChecks(screen, check.optionCount, intervalMs);
	if (first === undefined) {
		return 'unsettled';
	}
	const firstVerdict = paradisQuestionChecksVerdict(first.visible, check);
	if (firstVerdict.kind !== 'missing') {
		return firstVerdict.kind;
	}
	await screen.wait(QUESTION_CHECK_MISSING_GRACE_MS);
	const second = await settledQuestionChecks(screen, check.optionCount, intervalMs);
	if (second === undefined) {
		return 'unsettled';
	}
	const verdict = paradisQuestionChecksVerdict(second.visible, check);
	if (verdict.kind !== 'missing') {
		return verdict.kind;
	}
	if (!(await screen.stillCurrent())) {
		return 'stale';
	}
	for (const optionNumber of verdict.missing) {
		await screen.send(String(optionNumber));
		await screen.wait(intervalMs);
	}
	const after = await settledQuestionChecks(screen, check.optionCount, intervalMs);
	if (after === undefined) {
		return 'unsettled';
	}
	return paradisQuestionChecksVerdict(after.visible, check).kind === 'ok' ? 'retyped' : 'still-missing';
}

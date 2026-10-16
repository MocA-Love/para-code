/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 履歴の一覧の前方一致に使う「自分で打った文字」を決める。
//
// シェル統合の入力行（promptInputModel の value）は、プロンプトの終わりの印（OSC 633;B / 133;B）を
// 受けた時点のカーソルの列から右を読んでいる。印がプロンプトを描き終える前に届く・描き直しで列が
// ずれる（p10k、右プロンプト、複数行のプロンプト、SSH）と、value にプロンプトの表示が入る。
// zsh-autosuggestions の薄い文字も、色が判定に合わないと value に残る。value をそのまま前方一致に
// 使うと、どの履歴とも一致しない。
//
// そこで、送ったキーから「プロンプトの終わりからカーソルまで」を組み立て、入力行のカーソルより前の
// 部分の末尾と一致したときにそれを使う。キーから組み立てられない操作（Tab の補完、カーソル移動、
// 履歴の呼び出し）の後は、組み立てられていた間に覚えた「入力行の頭に付くプロンプトの残り」を
// 入力行から外して使う。どちらも確かめられなければ undefined（一覧は開かず、↓ はシェルへ）。
//
// 打った文字が分からない間（つなぎ直したターミナル、前のコマンドの実行中に打った後など）は、
// 「この時点の入力行のカーソルより前はこうだったはず」という見込みをキーで組み立て、入力行の
// カーソルより前と同じになったときに打った文字にする。

import { raceTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { type IPromptInputModel, PromptInputState } from '../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { PARADIS_EXTERNAL_PROMPT_CHANGE_MS, ParadisTerminalInputKind, paradisClassifyTerminalInput } from './paradisTerminalHistoryNavigation.js';

type PromptModel = Pick<IPromptInputModel, 'state' | 'value' | 'ghostTextIndex' | 'cursorIndex'>;

const BRACKETED_PASTE = /^\x1b\[200~(?<text>[\s\S]*)\x1b\[201~$/;
const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;
const BACKSPACES = /^[\x7f\x08]+$/;
const DELETE_KEYS = /^(?:\x1b\[3~)+$/;

/**
 * 入力行のうちカーソルより前の文字（ゴースト文字を除く）。入力を受けていない・カーソルの位置が
 * 分からないときは undefined。
 */
export function paradisPromptTextBeforeCursor(model: PromptModel): string | undefined {
	if (model.state !== PromptInputState.Input || model.cursorIndex < 0) {
		return undefined;
	}
	const end = model.ghostTextIndex === -1 ? model.cursorIndex : Math.min(model.cursorIndex, model.ghostTextIndex);
	return model.value.substring(0, end);
}

/** 入力行のうちカーソルより後ろの文字（ゴースト文字を除く）。カーソルの位置が分からなければ空。 */
export function paradisPromptTextAfterCursor(model: PromptModel): string {
	if (model.cursorIndex < 0) {
		return '';
	}
	return model.ghostTextIndex === -1 ? model.value.substring(model.cursorIndex) : model.value.substring(model.cursorIndex, Math.max(model.cursorIndex, model.ghostTextIndex));
}

/**
 * 送った 1 回分の入力で、カーソルより前の文字がどう変わるか。文字・貼り付けは足し、Backspace は
 * 末尾を消し、Delete と端末の応答は変えない。それまでの文字が分かっているときの Enter・Ctrl+C・Ctrl+U
 * は空に戻す。分からないときは、Enter・Ctrl+C でも分からないまま（補完のメニュー（oh-my-zsh の
 * menu select、fzf-tab）では、Enter は候補を選ぶだけ、Ctrl+C はメニューを抜けるだけで行が残る。
 * Ctrl+U は逐次検索の最中かもしれない）。それ以外（Tab、カーソル移動、↑↓、Ctrl+W、Ctrl+G（逐次検索を
 * 抜けると元の行に戻る）、Esc など、シェルによって結果が変わるもの）は undefined（分からない）。
 */
export function paradisApplyTypedInput(before: string | undefined, data: string): string | undefined {
	const kind = paradisClassifyTerminalInput(data);
	if (kind === ParadisTerminalInputKind.Ignore) {
		return before;
	}
	if (data === '\x07' || before === undefined) {
		return undefined;
	}
	if (kind === ParadisTerminalInputKind.Submit) {
		return '';
	}
	if (kind !== ParadisTerminalInputKind.Edit) {
		return undefined;
	}
	if (data === '\x15') {
		return '';
	}
	const pasted = BRACKETED_PASTE.exec(data)?.groups?.text;
	const text = pasted ?? data;
	if (PRINTABLE.test(text)) {
		return before + text;
	}
	if (BACKSPACES.test(data)) {
		const chars = Array.from(before);
		return chars.slice(0, Math.max(0, chars.length - data.length)).join('');
	}
	if (DELETE_KEYS.test(data)) {
		return before;
	}
	return undefined;
}

/**
 * 入力行のカーソルより前の文字 `text` が「プロンプトの残り＋打った文字 `typed`」になっているとき、
 * プロンプトの残りの部分を返す。末尾の空白はシェル統合が詰めることがあるので比べない。
 */
function promptHeadOf(text: string, typed: string): string | undefined {
	if (text.endsWith(typed)) {
		return text.substring(0, text.length - typed.length);
	}
	const trimmedText = text.trimEnd();
	const trimmedTyped = typed.trimEnd();
	return trimmedText.endsWith(trimmedTyped) ? trimmedText.substring(0, trimmedText.length - trimmedTyped.length) : undefined;
}

/** 実行中のコマンド 1 つ分（実行の印から次のプロンプトまで）に打った文字。 */
interface IRunningCommand {
	/** 何か打った。 */
	input: boolean;
	/** 実行の印から打った文字（実行中のプログラムが読まずに残れば、次のプロンプトにシェルが出す）。 */
	typed: string | undefined;
	/** 終わりの印を受けた。 */
	finished: boolean;
	/** 終わりの印から打った文字（プログラムが読んだ分を除く）。 */
	typedAfterFinish: string | undefined;
}

/**
 * 1 つのターミナルの「自分で打った文字」を追う。キーと入力行の変化を届いた順に渡し、
 * {@link resolve} で今の前方一致の文字を受け取る。時刻は呼び出し側が渡す。
 */
export class ParadisTypedPrefixTracker {
	/** 送ったキーから組み立てた、プロンプトの終わりからカーソルまで。分からなければ undefined。 */
	private _typed: string | undefined;
	/** 入力行の頭に付いているプロンプトの残り（組み立てた文字と一致したときに覚える）。 */
	private _promptHead: string | undefined;
	/** {@link _promptHead} を覚えたときの打った文字。 */
	private _typedAtHead: string | undefined;
	/** {@link _typed} が分からない間の、カーソルより前の文字の見込み（キーで組み立てる）。 */
	private _guesses: string[] = [];
	private _lastInputAt = Number.NEGATIVE_INFINITY;
	/** コマンドの実行中（次のプロンプトまで）。打った文字は実行中のプログラムへ行く。 */
	private _running: IRunningCommand | undefined;

	/** xterm.js の `onData`（ユーザーの入力）。 */
	input(data: string, now: number): void {
		if (paradisClassifyTerminalInput(data) === ParadisTerminalInputKind.Ignore) {
			return;
		}
		this._lastInputAt = now;
		const running = this._running;
		if (running) {
			running.input = true;
			running.typed = paradisApplyTypedInput(running.typed, data);
			if (running.finished) {
				running.typedAfterFinish = paradisApplyTypedInput(running.typedAfterFinish, data);
			}
			return;
		}
		this._typed = paradisApplyTypedInput(this._typed, data);
		this._setGuesses(this._guesses.map(guess => paradisApplyTypedInput(guess, data)));
	}

	/** Para Code 自身が入力行を `line`（カーソルは末尾）に書き換えた。 */
	wrote(line: string, now: number): void {
		this._lastInputAt = now;
		this._typed = line;
		this._guesses = [];
	}

	/**
	 * シェルの入力行が変わった。打った文字と一致していれば、頭に付くプロンプトの残りを覚え直す。
	 * 入力から時間が経っても一致しなければ、入力を通らずに書き換わった（補完の候補の挿入、ファイルの
	 * ドロップなど）ので、組み立てた文字は捨てる。打った文字が分からなければ、見込みと比べる。
	 */
	prompt(model: PromptModel, now: number): void {
		const text = paradisPromptTextBeforeCursor(model);
		if (text === undefined) {
			return;
		}
		if (this._typed !== undefined) {
			const head = promptHeadOf(text, this._typed);
			if (head !== undefined) {
				this._promptHead = head;
				this._typedAtHead = this._typed;
				return;
			}
			if (now - this._lastInputAt <= PARADIS_EXTERNAL_PROMPT_CHANGE_MS) {
				return;
			}
			this._typed = undefined;
		}
		this._matchGuesses(text);
	}

	/**
	 * 入力行のカーソルより前の文字 `text` と見込みを比べ、同じになった見込みを打った文字にする。
	 * カーソルより前が空（または覚えたプロンプトの残りだけ）なら、ここから打つ文字が打った文字になる。
	 */
	private _matchGuesses(text: string): void {
		const head = this._promptHead;
		if (text.length === 0 || text === head) {
			this._setGuesses([...this._guesses, '']);
			return;
		}
		for (const guess of this._guesses) {
			// 空の見込みは、遅れて出る文字（前のコマンドの実行中に打った文字）と見分けられないので使わない。
			if (guess.trim().length === 0) {
				continue;
			}
			const before = promptHeadOf(text, guess);
			if (before === '' || (before !== undefined && before === head)) {
				this._typed = guess;
				this._promptHead = before;
				this._typedAtHead = guess;
				this._guesses = [];
				return;
			}
		}
	}

	private _setGuesses(guesses: readonly (string | undefined)[]): void {
		this._guesses = [...new Set(guesses.filter((guess): guess is string => guess !== undefined))];
	}

	/** コマンドが実行された。次のプロンプトまで、打った文字は数えない。 */
	commandExecuted(): void {
		this._running = { input: false, typed: '', finished: false, typedAfterFinish: undefined };
		this._typed = undefined;
		this._promptHead = undefined;
		this._typedAtHead = undefined;
		this._guesses = [];
	}

	/** コマンドが終わった。ここから次のプロンプトまでに打った文字は、シェルが受け取る。 */
	commandFinished(): void {
		if (this._running && !this._running.finished) {
			this._running.finished = true;
			this._running.typedAfterFinish = '';
		}
	}

	/**
	 * 新しいプロンプトが出た。実行中に打った文字はシェルに残っているか分からないので、そのときは
	 * 「残った」「プログラムが読んだ」の両方を見込みにして、入力行と比べる。
	 */
	promptStarted(): void {
		const running = this._running;
		this._running = undefined;
		this._promptHead = undefined;
		this._typedAtHead = undefined;
		if (!running?.input) {
			this._typed = '';
			this._guesses = [];
			return;
		}
		this._typed = undefined;
		this._setGuesses([running.typed, running.finished ? running.typedAfterFinish : undefined]);
	}

	/**
	 * 前方一致に使う文字（プロンプトの終わりからカーソルまで、ゴースト文字を除く）。確かめられなければ
	 * undefined。
	 */
	resolve(model: PromptModel, now: number): string | undefined {
		const text = paradisPromptTextBeforeCursor(model);
		if (text === undefined) {
			return undefined;
		}
		if (this._typed !== undefined) {
			if (promptHeadOf(text, this._typed) !== undefined) {
				return this._typed;
			}
			if (now - this._lastInputAt <= PARADIS_EXTERNAL_PROMPT_CHANGE_MS) {
				// シェルの表示がまだ追いついていないかもしれない。
				return undefined;
			}
			// 入力を通らずに入力行が変わった。入力行から読む。
		}
		const head = this._promptHead;
		if (head === undefined || !text.startsWith(head)) {
			return undefined;
		}
		const typed = text.substring(head.length);
		const known = this._typedAtHead?.trimStart() ?? '';
		const current = typed.trimStart();
		// プロンプトが描き直されて頭の長さが変わると、残りが前に打った文字と繋がらなくなる。
		return current.startsWith(known) || known.startsWith(current) ? typed : undefined;
	}
}

/** 選んだ履歴を入力行へ入れるときに送るもの。 */
export interface IParadisHistoryWrite {
	/** 先に送る、入力行の今の文字を消すキー。 */
	readonly edit: string;
	/** 続けて送る文字。 */
	readonly text: string;
	/** 書いた後の、プロンプトの終わりからカーソルまで。 */
	readonly line: string;
}

/**
 * 打った文字 `typed` の入力行へ `command` を入れるときに送るもの。打った文字で始まる履歴なら足りない
 * 分だけを書く。カーソルの後ろ（判定できた薄い文字を除く）に文字があれば、Delete で消してから
 * 打った文字ごと書き直す（zsh-autopair の閉じ括弧・閉じ引用符はシェルの入力で、残すと二重になる。
 * 右プロンプト・判定に漏れた薄い文字なら、行の末尾での Delete は何もしない）。
 */
export function paradisPlanHistoryWrite(model: PromptModel, typed: string, command: string): IParadisHistoryWrite {
	const after = paradisPromptTextAfterCursor(model);
	const prefix = typed.trimStart();
	if (after.length === 0 && command.startsWith(prefix)) {
		const text = command.substring(prefix.length);
		return { edit: '', text, line: typed + text };
	}
	return { edit: '\x1b[3~'.repeat(after.length) + '\x7f'.repeat(typed.length), text: command, line: command };
}

/**
 * `resolve` が打った文字を返すまで、入力行の変化 `onDidChange` のたびに確かめ直して待つ。`timeout` ms
 * 経つか取り消されたら、その時点の値（undefined かもしれない）を返す。
 */
export async function paradisWaitForTypedText(resolve: () => string | undefined, onDidChange: Event<unknown>, timeout: number, token: CancellationToken): Promise<string | undefined> {
	const deadline = Date.now() + timeout;
	let typed = resolve();
	while (typed === undefined && Date.now() < deadline && !token.isCancellationRequested) {
		const store = new DisposableStore();
		try {
			await raceTimeout(new Promise<void>(resolve => {
				store.add(onDidChange(() => resolve()));
				store.add(token.onCancellationRequested(() => resolve()));
			}), deadline - Date.now());
		} finally {
			store.dispose();
		}
		typed = resolve();
	}
	return typed;
}

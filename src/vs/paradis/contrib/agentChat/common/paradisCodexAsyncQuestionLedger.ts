/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisCodexAsyncQuestion, paradisParseCodexAsyncQuestionItemId } from '../../mobileRelay/common/paradisCodexAsyncQuestions.js';

/** 覚えておく呼び出しの数（古いものから捨てる）。 */
const MAX_CALLS = 50;
/** 質問より先に届いた答え（hook の UserPromptSubmit など）を覚えておく数。 */
const MAX_EARLY_ANSWERS = 200;

interface ICallEntry {
	readonly questions: readonly IParadisCodexAsyncQuestion[];
	readonly answered: Set<number>;
	/** rollout で確かめた（hook から仮に入れただけではない）。 */
	confirmed: boolean;
}

/**
 * 1 ペインの、Codex の非同期の質問（request_user_input_async）の台帳。
 *
 * 承認の枠（interaction）とは別に持ち、ターンの終わり・普通の発言では消さない（Codex 本体は質問を覚えておらず、後から返信の形で
 * 送っても受け付けるため）。消すのは、答えた質問の ID が返信の発言に現れたときだけ。rollout の `item_completed` を正とし、
 * PreToolUse hook の質問は仮に入れて（呼び出しが失敗したら外す）、rollout で確かめる。
 */
export class ParadisCodexAsyncQuestionLedger {

	private readonly calls = new Map<string, ICallEntry>();
	/** 質問より先に読んだ答えの ID（呼び出しを足すときに当てる）。 */
	private readonly earlyAnswers = new Set<string>();
	/**
	 * 台帳から離れた呼び出し（全部の問いに答えた・hook の失敗で外した・上限で捨てた・読み直しで空にした・古いターンとして
	 * 戻さなかった）。その質問の通知を片付けるため、{@link takeGoneCalls} で受け取る。
	 */
	private readonly gone = new Set<string>();
	private _revision = 0;

	/** 変わるたびに進む番号（送ったものと比べて、変わったときだけ送るため）。 */
	get revision(): number {
		return this._revision;
	}

	/**
	 * rollout で読んだ質問を足す。初めて知った呼び出しの質問を返す（知らせを出すのはこれだけ。hook で先に足した呼び出しは
	 * 返さない）。hook で仮に足した呼び出しは、rollout の中身で置き換える（rollout を正とする）。
	 */
	addConfirmed(questions: readonly IParadisCodexAsyncQuestion[]): IParadisCodexAsyncQuestion[] {
		return this.add(questions, true);
	}

	/** PreToolUse hook で受けた質問を仮に足す。初めて知った呼び出しの質問を返す。 */
	addProvisional(questions: readonly IParadisCodexAsyncQuestion[]): IParadisCodexAsyncQuestion[] {
		return this.add(questions, false);
	}

	private add(questions: readonly IParadisCodexAsyncQuestion[], confirmed: boolean): IParadisCodexAsyncQuestion[] {
		const added: IParadisCodexAsyncQuestion[] = [];
		const byCall = new Map<string, IParadisCodexAsyncQuestion[]>();
		for (const question of questions) {
			const list = byCall.get(question.callId);
			if (list === undefined) {
				byCall.set(question.callId, [question]);
			} else {
				list.push(question);
			}
		}
		let changed = false;
		for (const [callId, list] of byCall) {
			const existing = this.calls.get(callId);
			if (existing !== undefined) {
				if (confirmed && !existing.confirmed) {
					// hook の中身を rollout の中身で置き換える。答えた番号は、置き換えた後にもある問いの分だけ持ち越す
					const indices = new Set(list.map(question => question.index));
					const answered = new Set([...existing.answered].filter(index => indices.has(index)));
					this.calls.set(callId, { questions: list, answered, confirmed: true });
					changed = changed || JSON.stringify(existing.questions) !== JSON.stringify(list);
				}
				continue;
			}
			const answered = new Set<number>();
			for (const question of list) {
				if (this.earlyAnswers.delete(question.id)) {
					answered.add(question.index);
				}
			}
			this.calls.set(callId, { questions: list, answered, confirmed });
			this.gone.delete(callId);
			changed = true;
			added.push(...list.filter(question => !answered.has(question.index)));
		}
		while (this.calls.size > MAX_CALLS) {
			const oldest = this.calls.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.calls.delete(oldest);
			this.gone.add(oldest);
		}
		if (changed) {
			this._revision++;
		}
		return added;
	}

	/**
	 * 返信の発言で答えた質問（`questionItemId`）を外す。全部の問いに答え終えた呼び出しは {@link takeGoneCalls} に入る。
	 * 変わったかは {@link revision} で見る。
	 */
	answer(itemIds: readonly string[]): void {
		let changed = false;
		for (const itemId of itemIds) {
			const id = paradisParseCodexAsyncQuestionItemId(itemId);
			if (id === undefined) {
				continue;
			}
			const entry = this.calls.get(id.callId);
			if (entry === undefined) {
				this.earlyAnswers.add(itemId);
				if (this.earlyAnswers.size > MAX_EARLY_ANSWERS) {
					const oldest = this.earlyAnswers.values().next().value;
					if (oldest !== undefined) {
						this.earlyAnswers.delete(oldest);
					}
				}
				continue;
			}
			if (!entry.answered.has(id.index) && entry.questions.some(question => question.index === id.index)) {
				entry.answered.add(id.index);
				changed = true;
				if (entry.questions.every(question => entry.answered.has(question.index))) {
					this.gone.add(id.callId);
				}
			}
		}
		if (changed) {
			this._revision++;
		}
	}

	/** hook で仮に足した呼び出しが失敗した（PostToolUseFailure）。rollout で確かめていなければ外す。変わったら true。 */
	dropProvisional(callId: string): boolean {
		const entry = this.calls.get(callId);
		if (entry === undefined || entry.confirmed) {
			return false;
		}
		this.calls.delete(callId);
		this.gone.add(callId);
		this._revision++;
		return true;
	}

	/** 台帳に入れなかった呼び出し（古いターンとして戻さなかった）を、離れたものとして知らせる。 */
	noteGone(callIds: Iterable<string>): void {
		for (const callId of callIds) {
			if (!this.calls.has(callId)) {
				this.gone.add(callId);
			}
		}
	}

	/** 会話を読み直すときに空にする。変わったら true。 */
	clear(): boolean {
		this.earlyAnswers.clear();
		if (this.calls.size === 0) {
			return false;
		}
		for (const callId of this.calls.keys()) {
			this.gone.add(callId);
		}
		this.calls.clear();
		this._revision++;
		return true;
	}

	/** まだ答えていない問いが残っている呼び出しか。 */
	isPending(callId: string): boolean {
		const entry = this.calls.get(callId);
		return entry !== undefined && entry.questions.some(question => !entry.answered.has(question.index));
	}

	/**
	 * 台帳から離れた呼び出しを受け取る（受け取ると空になる）。読み直しで戻った呼び出しのように、今もまだ答えていない問いが
	 * 残っているものは除く。
	 */
	takeGoneCalls(): string[] {
		const result = [...this.gone].filter(callId => !this.isPending(callId));
		this.gone.clear();
		return result;
	}

	/** まだ答えていない質問（出た順、呼び出しの中は番号順）。 */
	pending(): IParadisCodexAsyncQuestion[] {
		const result: IParadisCodexAsyncQuestion[] = [];
		for (const entry of this.calls.values()) {
			for (const question of entry.questions) {
				if (!entry.answered.has(question.index)) {
					result.push(question);
				}
			}
		}
		return result;
	}
}

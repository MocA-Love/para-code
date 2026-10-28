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
	private _revision = 0;

	/** 変わるたびに進む番号（送ったものと比べて、変わったときだけ送るため）。 */
	get revision(): number {
		return this._revision;
	}

	/**
	 * rollout で読んだ質問を足す。初めて知った呼び出しの質問を返す（知らせを出すのはこれだけ。hook で先に足した呼び出しは
	 * 返さない）。
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
					existing.confirmed = true;
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
			changed = true;
			added.push(...list.filter(question => !answered.has(question.index)));
		}
		while (this.calls.size > MAX_CALLS) {
			const oldest = this.calls.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.calls.delete(oldest);
		}
		if (changed) {
			this._revision++;
		}
		return added;
	}

	/**
	 * 返信の発言で答えた質問（`questionItemId`）を外す。これで全部の問いに答え終えた呼び出しの call_id を返す（質問の通知を
	 * 片付けるため）。変わったかは {@link revision} で見る。
	 */
	answer(itemIds: readonly string[]): string[] {
		let changed = false;
		const settled: string[] = [];
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
					settled.push(id.callId);
				}
			}
		}
		if (changed) {
			this._revision++;
		}
		return settled;
	}

	/** hook で仮に足した呼び出しが失敗した（PostToolUseFailure）。rollout で確かめていなければ外す。変わったら true。 */
	dropProvisional(callId: string): boolean {
		const entry = this.calls.get(callId);
		if (entry === undefined || entry.confirmed) {
			return false;
		}
		this.calls.delete(callId);
		this._revision++;
		return true;
	}

	/** 会話を読み直すときに空にする。変わったら true。 */
	clear(): boolean {
		this.earlyAnswers.clear();
		if (this.calls.size === 0) {
			return false;
		}
		this.calls.clear();
		this._revision++;
		return true;
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

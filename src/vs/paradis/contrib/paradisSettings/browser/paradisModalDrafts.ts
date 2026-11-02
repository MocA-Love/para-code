/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// fork のモーダルの「保存前の入力の下書き」。ParadisModalFocus は別のモーダルが開くと前のモーダルを閉じるので
// （確かめの答えを待てない）、打ちかけの入力を対象ごと（辞書の uuid・定期実行の id など）に覚え、
// 次にその対象を開いたときに戻す。「キャンセル」と保存で捨てる。
//
// - このウィンドウを開いている間だけ（ディスクには書かない）。API キーなどの秘密は入れない（入れるのは画面の入力欄の値だけ）
// - 値は JSON で写して持つ（開いている画面の配列や行と同じものを共有しない）
// - 件数に上限を持ち、超えたら古いものから捨てる

import { localize } from '../../../../nls.js';

/** 1 つの種類の下書きを持てる件数（超えたら古いものから捨てる）。 */
export const PARADIS_MODAL_DRAFT_LIMIT = 20;

/** 下書きを戻したときに箱に添える注記。 */
export const PARADIS_MODAL_DRAFT_RESTORED = localize('paradis.modalDraft.restored', "保存する前に閉じた編集を戻しました。いらなければ「キャンセル」で捨てられます。");

/** 下書きの比べ方・写し方（JSON の文字列）。 */
export function paradisModalDraftSnapshot(value: unknown): string {
	return JSON.stringify(value);
}

/** 1 つの種類の箱（辞書の編集・定期実行の編集など）の下書き。キー → 中身。 */
export class ParadisModalDrafts<T> {

	private readonly drafts = new Map<string, string>();

	constructor(private readonly limit: number = PARADIS_MODAL_DRAFT_LIMIT) { }

	/** 下書きを取り出す（取り出したら消す。もう一度閉じたときに改めて覚える）。 */
	take(key: string): T | undefined {
		const draft = this.drafts.get(key);
		this.drafts.delete(key);
		return draft === undefined ? undefined : JSON.parse(draft) as T;
	}

	/** 下書きとして覚える。同じキーは新しいものに置き換え、上限を超えたら古いものから捨てる。 */
	keep(key: string, value: T): void {
		this.drafts.delete(key);
		this.drafts.set(key, paradisModalDraftSnapshot(value));
		while (this.drafts.size > this.limit) {
			const oldest = this.drafts.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.drafts.delete(oldest);
		}
	}

	/** 読み込んだときの写し（`paradisModalDraftSnapshot`）から変わっていれば覚える。読み込む前（undefined）は覚えない。 */
	keepIfChanged(key: string, value: T, baseline: string | undefined): void {
		if (baseline !== undefined && paradisModalDraftSnapshot(value) !== baseline) {
			this.keep(key, value);
		}
	}

	/** 下書きを捨てる（「キャンセル」と保存のとき）。 */
	discard(key: string): void {
		this.drafts.delete(key);
	}

	/** 覚えているキー（古い順）。 */
	keys(): string[] {
		return [...this.drafts.keys()];
	}
}

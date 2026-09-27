/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 質問の選択肢が TUI に描かれたかを画面で確かめるための目印。renderer（デスクトップのチャット表示）が
// transcript のパーサー全体を読み込まずに使えるよう、小さなファイルに分けてある。

import { IParadisAgentQuestionOption } from './paradisAgentChat.js';

/** 目印にするラベル片の長さ。検証側の上限（`paradisMobileWorkspaceProvider`）はこれより緩い。 */
const PARADIS_QUESTION_READY_MARKER_LENGTH = 12;

/**
 * 「TUI が選択肢リストを出し終えたか」を画面文字列で判定するための目印を作る。
 *
 * 打鍵を流し始めてよいのは、リストがキーボードフォーカスを取った後。**それより前に送ると
 * 入力欄へ吸われて消える**（Claude Code 2.1.223 で実測。単問・単一選択はキーが1つしか無いので、
 * 取りこぼすと二度と拾えない）。フッタの英語表記（`Esc to cancel` 等）に頼ると TUI の文言変更で
 * 黙って壊れるため、**その質問自身の先頭の選択肢ラベル**を目印にする。
 *
 * ターミナルは折り返すので、長いラベルは画面上で途切れる。先頭の短い一片だけを使う。
 * 目印を作れない場合（ラベルが無い・記号だけ等）は `undefined` を返し、待たずに従来どおり流す。
 */
export function paradisQuestionReadyMarker(question: { readonly options?: readonly IParadisAgentQuestionOption[] } | undefined): string | undefined {
	const label = question?.options?.[0]?.label;
	if (typeof label !== 'string') {
		return undefined;
	}
	// **空白を取り除いてから切る**。空白の手前で切ると `"✓ Yes"` のような1文字トークンで
	// 目印を作れなくなり、逆に空白を残すと折り返しの改行で照合が外れる。
	// 照合側も同じ規則で空白を落とす（paradisScreenShowsMarker）。
	const marker = label.replace(/\s+/g, '').slice(0, PARADIS_QUESTION_READY_MARKER_LENGTH);
	return marker.length >= 2 ? marker : undefined;
}


/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code（2.1.278 以降）は貼り付けた文字を transcript の user 行へ
// `\n\n<pasted_content id="512f">\n本文\n</pasted_content id="512f">\n` の形で書く（閉じタグにも同じ id が付く）。
// 会話の表示（agentChat の transcript parser）とセッションのタイトル（agentSessionTitle）の両方で
// 中身へ戻すため、contrib 共通の src/vs/paradis/common に置く。
// モバイルの app/mobile/src/pendingAgentMessages.ts にも同じ正規表現がある（変えるときは両方そろえる）。

/**
 * 実データの形だけを受ける。開きタグの前の改行 2 つと id を必須にし、閉じタグの id を後方参照で対にする
 * （本文に文字としてタグを書いた場合や、貼った本文に別の包みが入っている場合に途中で閉じないように）。
 */
/** これより長い本文は展開しない（照合の最悪計算量を抑える）。 */
const PASTED_CONTENT_MAX_LENGTH = 1_000_000;

const PASTED_CONTENT_PATTERN = /\n\n<pasted_content id="(?<id>[^"]*)">\n(?<body>[\s\S]*?)\n<\/pasted_content id="\k<id>">\n?/g;

/**
 * 貼り付けの包みを中身に置き換える。包みの前後に文字があるときは、区切りとして改行を 1 つだけ残す
 * （`これを見て` + 包み + `どう思う?` → `これを見て\n本文\nどう思う?`）。
 */
export function paradisExpandPastedContent(text: string): string {
	// 閉じタグの無い開きタグが大量に並ぶと照合が 2 乗で伸びるので、極端に長い本文は展開しない。
	if (!text.includes('<pasted_content') || text.length > PASTED_CONTENT_MAX_LENGTH) {
		return text;
	}
	return text.replace(PASTED_CONTENT_PATTERN, (match: string, _id: string, body: string, offset: number) => {
		const before = offset > 0 ? '\n' : '';
		const after = offset + match.length < text.length ? '\n' : '';
		return `${before}${body}${after}`;
	});
}

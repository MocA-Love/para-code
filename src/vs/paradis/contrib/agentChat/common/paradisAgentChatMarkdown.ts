/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { localize } from '../../../../nls.js';

const IMAGE_SYNTAX = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/**
 * エージェントの発言の Markdown で、外部を指す画像の書き方（`![説明](https://...)`）をリンクに
 * 書き換える。チャット表示は外部の画像を読み込まない（読み込むと、プロンプトインジェクションで
 * 仕込まれた URL へ会話の中身を送れてしまう）ので、見えない画像の代わりに押せるリンクとして残す。
 * `data:` の画像はそのまま。コードブロック（``` / ~~~）の中は書き換えない。
 */
export function paradisAgentChatImagesToLinks(markdown: string): string {
	if (!markdown.includes('![')) {
		return markdown;
	}
	const lines = markdown.split('\n');
	let fence: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceMatch !== null) {
			const marker = fenceMatch[1][0];
			if (fence === undefined) {
				fence = marker;
			} else if (fence === marker) {
				fence = undefined;
			}
			continue;
		}
		if (fence !== undefined) {
			continue;
		}
		lines[index] = line.replace(IMAGE_SYNTAX, (whole, alt: string, url: string) => {
			if (/^data:/i.test(url)) {
				return whole;
			}
			const label = alt.trim().length > 0
				? localize('paradisAgentChat.imageLinkWithAlt', "画像: {0}", alt.trim())
				: localize('paradisAgentChat.imageLink', "画像");
			return `[${label.replace(/[[\]]/g, '')}](${url})`;
		});
	}
	return lines.join('\n');
}

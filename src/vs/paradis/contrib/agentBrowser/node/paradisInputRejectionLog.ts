/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP ゲートウェイが断った入力（ユーザーがページを操作中、入力の関所の時間切れ など）の理由を、ペインごとに
// 直近の 1 件だけ覚える。chrome-devtools-mcp の click / fill / hover は puppeteer の Locator が途中の例外を
// すべて捨てて「not interactive」とだけ返すので、ツールの結果に理由を書き足すために使う。

/** 理由を書き足すのは、この時間内に断ったものに限る（ツール 1 回の持ち時間より少し長い）。 */
export const PARADIS_INPUT_REJECTION_RECENT_MS = 15_000;

const MAX_TOKENS = 256;
const MAX_MESSAGE_LENGTH = 600;

interface IRejection {
	readonly message: string;
	readonly at: number;
}

export class ParadisInputRejectionLog {
	private readonly rejections = new Map<string, IRejection>();

	constructor(private readonly now: () => number = Date.now) { }

	record(token: string, message: string): void {
		this.rejections.delete(token);
		if (this.rejections.size >= MAX_TOKENS) {
			const oldest = this.rejections.keys().next();
			if (!oldest.done) {
				this.rejections.delete(oldest.value);
			}
		}
		this.rejections.set(token, { message: message.slice(0, MAX_MESSAGE_LENGTH), at: this.now() });
	}

	/** 直近の拒否の理由。`since` より前、または古すぎるものは返さない。 */
	recent(token: string, since: number): string | undefined {
		const rejection = this.rejections.get(token);
		if (rejection === undefined || rejection.at < since || this.now() - rejection.at > PARADIS_INPUT_REJECTION_RECENT_MS) {
			return undefined;
		}
		return rejection.message;
	}

	forget(token: string): void {
		this.rejections.delete(token);
	}
}

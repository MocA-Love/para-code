/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// para-browser のツール呼び出しを、タブごとに 1 本ずつ流すための列。
//
// para-browser の案内（PARADIS_BROWSER_MCP_INSTRUCTIONS）は「別のタブへの呼び出しは並行に、同じタブへの呼び出しは
// 1 本ずつ」と約束している。内蔵 chrome-devtools-mcp の道具は子プロセスがタブごとで、子の中の toolMutex が
// 1 本ずつにしていたが、Para の道具（click_by・fill_by・wait_until・get_text など）には列が無く、同じタブへ
// 同時に届くと交互に動いていた。Codex は `supports_parallel_tool_calls` が無いと 1 本ずつ送るので表に出な
// かったが、それを有効にすると同じタブへも並行に届く。そこで呼び出しの入口で、使うタブ（tab_id を省いた
// 呼び出しは、その時点のペインの既定のタブ）の鍵ごとに先着順で 1 本ずつ通す。

/**
 * 鍵ごとの先着順の列。同じ鍵の `run` は前のものが終わってから始まり、違う鍵は並行に走る。
 * 待っている間に `signal` が止まれば、列から抜けて `AbortError` で返す（前の呼び出しは止めない）。
 */
export class ParadisToolCallLanes {

	private readonly _tails = new Map<string, Promise<void>>();

	/** 今その鍵で動いているか待っている呼び出しがあるか（テストと診断用）。 */
	isBusy(key: string): boolean {
		return this._tails.has(key);
	}

	async run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const previous = this._tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>(resolve => { release = resolve; });
		// 自分の番の終わり = 前の番の終わり + 自分の終わり。待っている途中で抜けても、後ろの呼び出しが
		// 前の呼び出しを追い越さないよう、列の末尾は前の番を待ってから開く。
		const tail = previous.then(() => mine);
		this._tails.set(key, tail);
		try {
			await waitUnlessAborted(previous, signal);
			return await operation();
		} finally {
			release();
			void tail.then(() => {
				if (this._tails.get(key) === tail) {
					this._tails.delete(key);
				}
			});
		}
	}
}

function waitUnlessAborted(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		return previous;
	}
	if (signal.aborted) {
		return Promise.reject(abortError());
	}
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener('abort', onAbort, { once: true });
		previous.then(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		});
	});
}

function abortError(): Error {
	const error = new Error('The tool call was cancelled while it waited for an earlier call on the same tab.');
	error.name = 'AbortError';
	return error;
}

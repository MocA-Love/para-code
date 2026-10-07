/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵 chrome-devtools-mcp の `fill` が、キーの抑止を用意できずに断られたときの入れ直し。
// `fill` は 1 文字ずつ Input.dispatchKeyEvent で打つので、キーの抑止（ページへ打ったキーを Para Code の
// ショートカットとして拾わない仕組み）が用意できないページでは 1 文字目から断られる。文字を入れるだけなら
// キーは要らないので、fill_by と同じ「中身を選択して Input.insertText」の経路（日付欄・select・パスワード欄の
// 扱いも fill_by の規則）で入れ直し、切り替えたことを結果の文に書く。

/** `fill` の結果が「キーの抑止を用意できなかった」で失敗したものか。 */
export function paradisFillNeedsInsertTextFallback(name: string, result: unknown): boolean {
	if (name !== 'fill') {
		return false;
	}
	const text = paradisToolErrorText(result);
	return text !== undefined && /automation key suppression could not be (?:registered|activated)/.test(text);
}

/** 入れ直しに渡す fill_by の引数（vendored の `fill` の uid と value だけ）。取れなければ undefined。 */
export function paradisFillFallbackArgs(args: unknown): { uid: string; value: string } | undefined {
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	return typeof record.uid === 'string' && record.uid.length > 0 && typeof record.value === 'string'
		? { uid: record.uid, value: record.value }
		: undefined;
}

/**
 * 入れ直しの結果に、切り替えたことを書き足す。入れ直しも失敗したら、元の `fill` の失敗の文を先に置き、
 * 入れ直しの失敗を続けて返す（エージェントがどちらの理由で止まったか読めるように）。
 */
export function paradisMergeFillFallbackResult(originalResult: unknown, fallbackResult: unknown): unknown {
	const original = paradisToolErrorText(originalResult) ?? 'fill failed';
	const fallback = isRecord(fallbackResult) ? fallbackResult : {};
	const content = Array.isArray(fallback.content) ? fallback.content : [];
	if (fallback.isError === true) {
		const reason = content.find(isTextPart)?.text ?? 'unknown error';
		return {
			content: [{ type: 'text', text: `${original}\nfill then tried to enter the text the way fill_by does (select the old content, then insert the text), but that failed too: ${reason}` }],
			isError: true,
		};
	}
	const note = 'fill could not prepare its keystrokes on this page (automation key suppression was unavailable), so it entered the text the way fill_by does instead: it selected the old content and inserted the text (date, time, select and password fields follow fill_by\'s rules).';
	return { ...fallback, content: [{ type: 'text', text: note }, ...content] };
}

function paradisToolErrorText(result: unknown): string | undefined {
	if (!isRecord(result) || result.isError !== true || !Array.isArray(result.content)) {
		return undefined;
	}
	const texts = result.content.filter(isTextPart).map(part => part.text);
	return texts.length > 0 ? texts.join('\n') : undefined;
}

function isTextPart(value: unknown): value is { type: 'text'; text: string } {
	return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

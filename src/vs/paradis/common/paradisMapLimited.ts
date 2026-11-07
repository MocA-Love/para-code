/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `items` を同時に `limit` 件までで処理し、結果を元の順で返す。SSH の接続先のように 1 件ごとに往復する読み取りを、
 * 一度に投げすぎずに重ねるために使う。1 件でも失敗したら、その失敗で拒否する（走っている分は止めない）。
 */
export async function paradisMapLimited<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, () => worker()));
	return results;
}

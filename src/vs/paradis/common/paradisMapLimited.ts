/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `items` を同時に `limit` 件まで（少なくとも 1 件）で処理し、結果を元の順で返す。SSH の接続先のように 1 件ごとに
 * 往復する読み取りを、一度に投げすぎずに重ねるために使う。1 件でも失敗したら、新しく取りかからずに走っている分を
 * 待ってから、最初の失敗で拒否する。
 */
export async function paradisMapLimited<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failure: { readonly error: unknown } | undefined;
	const worker = async (): Promise<void> => {
		while (next < items.length && failure === undefined) {
			const index = next++;
			try {
				results[index] = await run(items[index], index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
	if (failure !== undefined) {
		throw failure.error;
	}
	return results;
}

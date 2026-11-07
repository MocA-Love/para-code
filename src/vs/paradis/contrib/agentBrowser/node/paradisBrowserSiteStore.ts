/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// サイトメモ（E4）とサイトの手順（E3）の置き場。スペース（リポジトリ）とオリジンの組ごとに、項目の一覧を 1 つの
// JSON ファイルへ書く。読み書きのたびにファイルが変わっていないかを確かめ、変わっていれば読み直すので、Para Code が
// 2 つ（ステーブルとベータ）動いていても、書く直前に読み直して足し、互いの項目を消さない（同じ瞬間の書き込みは後勝ち）。

import { promises as fs } from 'fs';
import { basename } from '../../../../base/common/path.js';
import { paradisWriteFileAtomic } from '../../../node/paradisWriteFileAtomic.js';

/** 1 つのファイルに持つ組（スペース × オリジン）の上限。古い組から消す。 */
const MAX_KEYS = 2000;
/** ファイルの大きさの上限（JSON の文字数、約 8 MiB）。項目を足して越えるときは書かない。 */
const MAX_FILE_CHARS = 8 * 1024 * 1024;

/** 置き場のファイルが上限に達していて、項目を足せない。 */
export class ParadisBrowserSiteStoreFullError extends Error {
	constructor() {
		super(`The store is full (about ${MAX_FILE_CHARS / 1024 / 1024} MiB). Delete old items first.`);
	}
}

/** 利用者の暦の日付（YYYY-MM-DD）。 */
export function paradisLocalDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * スペースとオリジンの組ごとの一覧を持つ JSON ファイル。`field` はファイルの中の欄の名前（`notes` / `recipes`）。
 */
export class ParadisBrowserSiteStore<T> {
	private writing: Promise<unknown> = Promise.resolve();
	/**
	 * 最後に読んだ・書いた中身と、そのときのファイルの印（inode・更新時刻・大きさ）。印が同じなら読み直さない
	 * （書き込みは一時ファイルの rename なので、別のプロセスが書けば inode が変わる）。
	 */
	private cached: { readonly stamp: string; readonly map: ReadonlyMap<string, T[]> } | undefined;

	constructor(private readonly filePath: string, private readonly field: string, private readonly maxFileChars: number = MAX_FILE_CHARS) { }

	private static key(space: string, origin: string): string {
		return `${space}\n${origin}`;
	}

	private async stamp(): Promise<string | undefined> {
		try {
			const stat = await fs.stat(this.filePath);
			return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			return undefined;
		}
	}

	/**
	 * 中身を読む。返す Map は呼んだ側で変えてよい（覚えている中身とは別の Map）。
	 *
	 * ファイルが無いときだけ空とみなす。読めない・形が壊れているときは、`forUpdate` なら投げる
	 * （空とみなして書き戻すと、既存の全件を消す）。一覧を見るだけなら空として返す。どちらも覚えない。
	 */
	private async load(forUpdate: boolean = false): Promise<Map<string, T[]>> {
		const stamp = await this.stamp();
		if (stamp !== undefined && this.cached?.stamp === stamp) {
			return new Map(this.cached.map);
		}
		let map: Map<string, T[]>;
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
			const items = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[this.field] : undefined;
			map = new Map(Object.entries(typeof items === 'object' && items !== null ? items : {}).filter((entry): entry is [string, T[]] => Array.isArray(entry[1])));
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
				this.cached = undefined;
				if (forUpdate) {
					throw new Error(`Could not read ${basename(this.filePath)}; it was left as it is. Fix or remove the file and try again.`);
				}
				return new Map();
			}
			map = new Map();
		}
		// 読んでいる間に書き換えられたかもしれないので、読む前の印で覚える（次は印が違うので読み直す）
		this.cached = stamp !== undefined ? { stamp, map: new Map(map) } : undefined;
		return map;
	}

	private async save(map: Map<string, T[]>, grew: boolean): Promise<void> {
		const text = JSON.stringify({ version: 1, [this.field]: Object.fromEntries(map) });
		if (grew && text.length > this.maxFileChars) {
			// 消す・減らす書き込みは上限を越えていても通す（越えた置き場を小さくできるように）
			throw new ParadisBrowserSiteStoreFullError();
		}
		// 書いた後の印は、別のプロセスがすぐ後に書いたものと見分けられないので覚えない（次の読みで読み直す）
		this.cached = undefined;
		await paradisWriteFileAtomic(this.filePath, text, { newFileMode: 0o600, createParentMode: 0o777 });
	}

	async list(space: string, origin: string): Promise<readonly T[]> {
		return (await this.load()).get(ParadisBrowserSiteStore.key(space, origin)) ?? [];
	}

	/**
	 * 組の一覧を読み直して変える。読み直し・変更・書き戻しは 1 つずつ順に動かす（このプロセスの中で、書き込みどうしが
	 * 追い越さないように）。`items` を返すと書き戻す（空なら組ごと消す）。書き込んだ組は、いちばん新しい組になる。
	 * 組が大きくなる書き込みでファイルが上限を越えるときは {@link ParadisBrowserSiteStoreFullError} を投げる。
	 */
	update<R>(space: string, origin: string, change: (items: readonly T[]) => { readonly value: R; readonly items?: readonly T[] }): Promise<R> {
		const key = ParadisBrowserSiteStore.key(space, origin);
		const run = async () => {
			const map = await this.load(true);
			const before = map.get(key) ?? [];
			const { value, items } = change(before);
			if (items !== undefined) {
				map.delete(key);
				if (items.length > 0) {
					map.set(key, [...items]);
				}
				while (map.size > MAX_KEYS) {
					map.delete(map.keys().next().value!);
				}
				await this.save(map, JSON.stringify(items).length > JSON.stringify(before).length);
			}
			return value;
		};
		const next = this.writing.then(run, run);
		this.writing = next.catch(() => undefined);
		return next;
	}
}

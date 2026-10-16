/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Excel・Word のビューアで、読んで解析した結果をウィンドウ（renderer）の中で覚えておく。
//
// VS Code はタブを裏へ回すとエディタの入力を外す（`clearInput`）ので、同じブック・文書へタブを戻すと、
// 読み込みと解析を最初からやり直していた（Excel は中央値で 1 秒ほど）。ファイルごとに 1 件、読んだときの
// etag（更新時刻と大きさから作られる）と一緒に覚え、次に開くときは etag を渡して読む。ファイルが
// 変わっていなければ `IFileService.readFile` は中身を送らずに FILE_NOT_MODIFIED_SINCE を投げるので、
// stat の 1 往復だけで覚えた結果を使う（画像ビューアの `ParadisImageCache` と同じ方法）。
//
// 仕組みの限界: 更新時刻と大きさがどちらも同じまま中身だけが変わったファイル（同じミリ秒の中で同じ
// 大きさに書き換えたもの、更新時刻を戻すツールで書いたもの）は、前の結果が出る。開いている間の変更は
// ファイルの見張りが知らせるので、ビューアはそのとき覚えた分を捨てる（{@link ParadisOfficeOpenCache.delete}）。

import { Schemas } from '../../../../base/common/network.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationResult, IFileContent, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';

/**
 * etag が変わらないあいだ読み直さないで済むスキーム。`git:` は ref ごとに中身が変わりうるのに etag が
 * 当てにならないので覚えない（画像ビューアと同じ集合）。
 */
const CACHEABLE_SCHEMES = new Set<string>([Schemas.file, Schemas.vscodeRemote, Schemas.vscodeUserData]);

/** 覚える上限。 */
export interface IParadisOfficeOpenCacheLimits {
	/** 覚える件数の上限。 */
	readonly maxEntries: number;
	/** 覚えるものの大きさ（見積もり）の合計の上限。半分を超える 1 件は覚えない。 */
	readonly maxBytes: number;
	/** ビューアが 1 つも使わなくなってから、覚えている分を全部手放すまで。 */
	readonly idleMs: number;
}

interface IParadisOfficeOpenCacheEntry<T> {
	readonly etag: string;
	value: T;
	bytes: number;
}

/** 最近開いたものから残す（LRU）。件数と大きさの見積もりの合計で古いものを追い出す。 */
export class ParadisOfficeOpenCache<T> {

	/** 挿入順＝古い順。使ったら末尾へ移す。 */
	private readonly _entries = new Map<string, IParadisOfficeOpenCacheEntry<T>>();
	private _totalBytes = 0;

	private _users = 0;
	private _idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly _limits: IParadisOfficeOpenCacheLimits) { }

	/**
	 * 結果を表示しているあいだ持つ。全部が手放してから `idleMs` たったら、覚えている分を全部手放す
	 * （Excel・Word のタブを全部閉じた後まで、大きな解析結果をメモリに残し続けない）。
	 */
	acquire(): IDisposable {
		this._users++;
		if (this._idleTimer !== undefined) {
			clearTimeout(this._idleTimer);
			this._idleTimer = undefined;
		}
		let released = false;
		return toDisposable(() => {
			if (released) {
				return;
			}
			released = true;
			if (--this._users === 0) {
				this._idleTimer = setTimeout(() => {
					this._idleTimer = undefined;
					this.clear();
				}, this._limits.idleMs);
			}
		});
	}

	/** そのファイルについて覚えている etag と値。使ったものは新しい側へ移す。 */
	get(resource: URI): { readonly etag: string; readonly value: T } | undefined {
		const key = resource.toString();
		const entry = this._entries.get(key);
		if (!entry) {
			return undefined;
		}
		this._entries.delete(key);
		this._entries.set(key, entry);
		return { etag: entry.etag, value: entry.value };
	}

	/** 覚える。同じファイルの前の分は置き換える。覚えられないスキーム、etag の無いもの、大きすぎるものは覚えない。 */
	set(resource: URI, etag: string | undefined, value: T, bytes: number): void {
		const key = resource.toString();
		this._delete(key);
		if (!etag || !CACHEABLE_SCHEMES.has(resource.scheme) || bytes > this._limits.maxBytes / 2) {
			return;
		}
		this._entries.set(key, { etag, value, bytes });
		this._totalBytes += bytes;
		this._evict(key);
	}

	/**
	 * 覚えている値を後から書き換える（表示の後に届いた変換結果を足すとき）。`change` は今の値を受け取り、
	 * 書き換えた値を返す。別の版に置き換わっていたなど、書き換えないときは `undefined` を返す。
	 */
	update(resource: URI, change: (value: T) => T | undefined, bytes?: number): void {
		const key = resource.toString();
		const entry = this._entries.get(key);
		if (!entry) {
			return;
		}
		const value = change(entry.value);
		if (value === undefined) {
			return;
		}
		entry.value = value;
		if (bytes !== undefined) {
			this._totalBytes += bytes - entry.bytes;
			entry.bytes = bytes;
			if (bytes > this._limits.maxBytes / 2) {
				this._delete(key);
			} else {
				this._evict(key);
			}
		}
	}

	/** そのファイルの分を手放す（ファイルが変わった・消えたとき）。 */
	delete(resource: URI): void {
		this._delete(resource.toString());
	}

	clear(): void {
		this._entries.clear();
		this._totalBytes = 0;
	}

	get totalBytes(): number {
		return this._totalBytes;
	}

	/** 覚えているファイル（古い順）。テストで確かめる。 */
	get resources(): readonly string[] {
		return [...this._entries.keys()];
	}

	private _evict(keep: string): void {
		for (const key of [...this._entries.keys()]) {
			if (this._entries.size <= this._limits.maxEntries && this._totalBytes <= this._limits.maxBytes) {
				break;
			}
			if (key !== keep) {
				this._delete(key);
			}
		}
	}

	private _delete(key: string): void {
		const entry = this._entries.get(key);
		if (entry) {
			this._entries.delete(key);
			this._totalBytes -= entry.bytes;
		}
	}
}

/** {@link readParadisOfficeFile} の結果。覚えた値が使えたか、読み直した中身か。 */
export type ParadisOfficeOpenRead<T> =
	| { readonly kind: 'cached'; readonly value: T }
	| { readonly kind: 'read'; readonly content: IFileContent };

/**
 * ファイルを読む。覚えている etag を渡し、変わっていなければ中身を読まずに覚えた値を返す。
 * 読み直したときは、呼び出し側が解析してから `cache.set(resource, content.etag, …)` で覚える。
 */
export async function readParadisOfficeFile<T>(fileService: Pick<IFileService, 'readFile'>, resource: URI, cache: ParadisOfficeOpenCache<T>, maxBytes: number): Promise<ParadisOfficeOpenRead<T>> {
	const cached = cache.get(resource);
	try {
		const content = await fileService.readFile(resource, { etag: cached?.etag, limits: { size: maxBytes } });
		return { kind: 'read', content };
	} catch (error) {
		if (cached && toFileOperationResult(error) === FileOperationResult.FILE_NOT_MODIFIED_SINCE) {
			return { kind: 'cached', value: cached.value };
		}
		// 読めなくなった（消えた・大きくなりすぎた）ファイルの前の結果は、もう使わない。
		cache.delete(resource);
		throw error;
	}
}

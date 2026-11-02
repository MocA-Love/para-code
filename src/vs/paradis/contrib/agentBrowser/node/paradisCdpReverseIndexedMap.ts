/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 値から鍵を引ける Map（CDP プロキシの台帳: 子 → 親、セッション → ターゲット）。
 *
 * 子孫やターゲットのセッションを探すたびに台帳を全部なめていた（上限 4096 なので最悪で約 4096² 回）のを、
 * 値ごとの鍵の一覧で引けるようにする。{@link keysOf} が返す順は、台帳を頭からなめて値の合うものを集めた順と同じ
 * （Map は鍵を最初に入れた順に並び、値を替えても並びは変わらない。その順を鍵ごとの通し番号で持つ）。
 */
export class ParadisReverseIndexedMap<K, V> implements ReadonlyMap<K, V> {

	private readonly forward = new Map<K, V>();
	private readonly reverse = new Map<V, Set<K>>();
	/** 鍵を最初に入れた順（Map の並び）。 */
	private readonly order = new Map<K, number>();
	private nextOrder = 0;

	get size(): number {
		return this.forward.size;
	}

	has(key: K): boolean {
		return this.forward.has(key);
	}

	get(key: K): V | undefined {
		return this.forward.get(key);
	}

	set(key: K, value: V): this {
		if (this.forward.has(key)) {
			const previous = this.forward.get(key) as V;
			if (previous === value) {
				return this;
			}
			this.removeReverse(key, previous);
		} else {
			this.order.set(key, this.nextOrder++);
		}
		this.forward.set(key, value);
		let keys = this.reverse.get(value);
		if (!keys) {
			keys = new Set();
			this.reverse.set(value, keys);
		}
		keys.add(key);
		return this;
	}

	delete(key: K): boolean {
		if (!this.forward.has(key)) {
			return false;
		}
		this.removeReverse(key, this.forward.get(key) as V);
		this.forward.delete(key);
		this.order.delete(key);
		return true;
	}

	clear(): void {
		this.forward.clear();
		this.reverse.clear();
		this.order.clear();
	}

	/** 値が `value` の鍵（台帳の並びの順。あとで台帳を変えても変わらない写し）。 */
	keysOf(value: V): K[] {
		const keys = this.reverse.get(value);
		if (!keys) {
			return [];
		}
		return [...keys].sort((left, right) => (this.order.get(left) as number) - (this.order.get(right) as number));
	}

	/** 値が `value` の鍵が 1 つでもあるか。 */
	hasValue(value: V): boolean {
		return this.reverse.has(value);
	}

	private removeReverse(key: K, value: V): void {
		const keys = this.reverse.get(value);
		keys?.delete(key);
		if (keys?.size === 0) {
			this.reverse.delete(value);
		}
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		this.forward.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
	}

	entries(): MapIterator<[K, V]> {
		return this.forward.entries();
	}

	keys(): MapIterator<K> {
		return this.forward.keys();
	}

	values(): MapIterator<V> {
		return this.forward.values();
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.forward[Symbol.iterator]();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメント（サイドカー）の保存係。shared process に 1 つだけ置き、サイドカーを書くのはここだけにする。
// 同じ資料への読み書きは順に並べ（読んだ後で前の書き込みを消さないように）、書くときは一時ファイルから置き換える。
// 起動時にフォルダのサイドカーを全部読み、メモリに写しを持つ（届け待ち・未回答の数・ID からの引き当てに使う。台帳から
// 外した資料のコメントも漏らさない）。

import { createHash } from 'crypto';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { paradisDocKey } from '../common/paradisAgentDocs.js';
import {
	IParadisDocCommentDraft,
	IParadisDocCommentSidecar,
	IParadisDocCommentThread,
	IParadisDocCommentsChange,
	PARADIS_DOC_COMMENT_MAX_THREADS,
	ParadisDocCommentPlace,
	paradisNewDocCommentThread,
	paradisParseDocCommentSidecar,
	paradisReadDocCommentTarget,
	paradisSerializeDocCommentSidecar,
	paradisWithDocCommentPlaces,
} from '../common/paradisDocComments.js';

/** サイドカーのファイルの読み書き（テストでは差し替える）。`name` はフォルダの中のファイル名。 */
export interface IParadisDocCommentsStorage {
	read(name: string): Promise<string | undefined>;
	write(name: string, text: string): Promise<void>;
	/** フォルダのサイドカーのファイル名（起動時に全部読む）。無ければ空。 */
	list?(): Promise<readonly string[]>;
}

/** 見つかったスレッドと、その資料。 */
export interface IParadisDocCommentLocation {
	readonly hostId: string;
	readonly path: string;
	readonly thread: IParadisDocCommentThread;
}

/** サイドカーのファイル名（台帳のキーの SHA-256）。パスそのものはファイル名に出さない。 */
export function paradisDocCommentSidecarName(hostId: string, path: string): string {
	return `${createHash('sha256').update(paradisDocKey(hostId, path)).digest('hex')}.json`;
}

/** 全資料で一意なスレッドの ID。 */
function newThreadId(): string {
	return `c-${generateUuid().replace(/-/g, '').slice(0, 12)}`;
}

export class ParadisDocCommentsStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<IParadisDocCommentsChange>());
	readonly onDidChange = this._onDidChange.event;

	/** 資料ごとの、読み書きの順番待ち。 */
	private readonly _queues = new Map<string, Promise<unknown>>();
	/** 読んだ・書いたサイドカーの写し（台帳のキー → 中身）。 */
	private readonly _cache = new Map<string, IParadisDocCommentSidecar>();
	/** 起動時の読み込み（フォルダのサイドカーを全部読む）。 */
	readonly ready: Promise<void>;

	constructor(
		private readonly _storage: IParadisDocCommentsStorage,
		private readonly _onError: (error: unknown) => void,
		private readonly _now: () => number = Date.now,
		private readonly _newId: () => string = newThreadId,
	) {
		super();
		this.ready = this._loadAll();
	}

	private async _loadAll(): Promise<void> {
		let names: readonly string[] = [];
		try {
			names = await this._storage.list?.() ?? [];
		} catch (error) {
			this._onError(error);
		}
		for (const name of names) {
			let text: string | undefined;
			try {
				text = await this._storage.read(name);
			} catch (error) {
				this._onError(error);
				continue;
			}
			const target = sidecarTargetOf(text);
			// ファイル名が中身の資料のものでなければ使わない（別の資料のものが置かれていた）
			if (target === undefined || paradisDocCommentSidecarName(target.hostId, target.path) !== name) {
				continue;
			}
			const key = paradisDocKey(target.hostId, target.path);
			if (!this._cache.has(key)) {
				const sidecar = paradisParseDocCommentSidecar(text, target.hostId, target.path);
				if (sidecar.threads.length > 0) {
					this._cache.set(key, sidecar);
				}
			}
		}
	}

	get(hostId: string, path: string): Promise<IParadisDocCommentSidecar> {
		return this._enqueue(hostId, path, () => this._read(hostId, path));
	}

	/** 写しにある、コメントのある資料（起動時の読み込みの後で使う）。 */
	all(): readonly IParadisDocCommentSidecar[] {
		return [...this._cache.values()].filter(sidecar => sidecar.threads.length > 0);
	}

	/** 写しにある資料のコメント（無ければ undefined）。 */
	peek(hostId: string, path: string): IParadisDocCommentSidecar | undefined {
		return this._cache.get(paradisDocKey(hostId, path));
	}

	/** ID からスレッドを引く（写しから）。 */
	find(id: string): IParadisDocCommentLocation | undefined {
		for (const sidecar of this._cache.values()) {
			const thread = sidecar.threads.find(candidate => candidate.id === id);
			if (thread !== undefined) {
				return { hostId: sidecar.hostId, path: sidecar.path, thread };
			}
		}
		return undefined;
	}

	/**
	 * 資料のスレッドを書き換える（`update` が同じものを返したスレッドは変えない。どれも変わらなければ書かない）。
	 * @returns 書き換えた後のスレッド（ID → スレッド）
	 */
	update(hostId: string, path: string, update: (thread: IParadisDocCommentThread) => IParadisDocCommentThread): Promise<ReadonlyMap<string, IParadisDocCommentThread>> {
		return this._enqueue(hostId, path, async () => {
			const sidecar = await this._read(hostId, path);
			let changed = false;
			const threads = sidecar.threads.map(thread => {
				const next = update(thread);
				changed ||= next !== thread;
				return next;
			});
			if (changed) {
				await this._write({ ...sidecar, threads });
			}
			return new Map(threads.map(thread => [thread.id, thread]));
		});
	}

	/** ユーザーが書いたコメントを足す。上限に達していれば undefined。 */
	add(hostId: string, path: string, draft: IParadisDocCommentDraft): Promise<IParadisDocCommentThread | undefined> {
		return this._enqueue(hostId, path, async () => {
			const sidecar = await this._read(hostId, path);
			if (sidecar.threads.length >= PARADIS_DOC_COMMENT_MAX_THREADS) {
				return undefined;
			}
			const thread = paradisNewDocCommentThread(this._newId(), draft, this._now());
			await this._write({ ...sidecar, threads: [...sidecar.threads, thread] });
			return thread;
		});
	}

	/**
	 * 資料の場所が変わった（移動先を追従した）。コメントを新しい場所の資料へ移す。新しい場所に既にコメントがあれば、
	 * その後ろへ足す（上限まで）。
	 */
	move(hostId: string, from: string, to: string): Promise<void> {
		return this._enqueue(hostId, from, async () => {
			const source = await this._read(hostId, from);
			if (source.threads.length === 0 || paradisDocKey(hostId, from) === paradisDocKey(hostId, to)) {
				return;
			}
			await this._enqueue(hostId, to, async () => {
				const target = await this._read(hostId, to);
				await this._write({ ...target, threads: [...target.threads, ...source.threads].slice(0, PARADIS_DOC_COMMENT_MAX_THREADS) });
			});
			await this._write({ ...source, threads: [] });
		});
	}

	/** プレビューが当て直した結果を書く（変わった件があるときだけ書く）。 */
	setPlaces(hostId: string, path: string, places: ReadonlyMap<string, ParadisDocCommentPlace>): Promise<void> {
		if (places.size === 0) {
			return Promise.resolve();
		}
		return this._enqueue(hostId, path, async () => {
			const sidecar = await this._read(hostId, path);
			const next = paradisWithDocCommentPlaces(sidecar, places);
			if (next !== sidecar) {
				await this._write(next);
			}
		});
	}

	private async _read(hostId: string, path: string): Promise<IParadisDocCommentSidecar> {
		let text: string | undefined;
		try {
			text = await this._storage.read(paradisDocCommentSidecarName(hostId, path));
		} catch (error) {
			this._onError(error);
		}
		const sidecar = paradisParseDocCommentSidecar(text, hostId, path);
		this._remember(sidecar);
		return sidecar;
	}

	private async _write(sidecar: IParadisDocCommentSidecar): Promise<void> {
		await this._storage.write(paradisDocCommentSidecarName(sidecar.hostId, sidecar.path), paradisSerializeDocCommentSidecar(sidecar));
		this._remember(sidecar);
		this._onDidChange.fire({ hostId: sidecar.hostId, path: sidecar.path });
	}

	private _remember(sidecar: IParadisDocCommentSidecar): void {
		const key = paradisDocKey(sidecar.hostId, sidecar.path);
		if (sidecar.threads.length > 0) {
			this._cache.set(key, sidecar);
		} else {
			this._cache.delete(key);
		}
	}

	private _enqueue<T>(hostId: string, path: string, task: () => Promise<T>): Promise<T> {
		const key = paradisDocKey(hostId, path);
		const previous = this._queues.get(key) ?? Promise.resolve();
		const next = previous.then(task, task);
		const settled = next.then(() => undefined, error => this._onError(error));
		this._queues.set(key, settled);
		void settled.then(() => {
			if (this._queues.get(key) === settled) {
				this._queues.delete(key);
			}
		});
		return next;
	}
}

/** サイドカーの中身が名乗る資料（ファイル名と照らすため）。読めなければ undefined。 */
function sidecarTargetOf(text: string | undefined): IParadisDocCommentsChange | undefined {
	if (text === undefined) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as { hostId?: unknown; path?: unknown } | null;
		return parsed !== null && typeof parsed === 'object' ? paradisReadDocCommentTarget(parsed.hostId, parsed.path) : undefined;
	} catch {
		return undefined;
	}
}

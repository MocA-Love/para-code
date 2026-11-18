/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメント（サイドカー）の保存係。shared process に 1 つだけ置き、サイドカーを書くのはここだけにする。
// 同じ資料への読み書きは順に並べ（読んだ後で前の書き込みを消さないように）、書くときは一時ファイルから置き換える。

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
	paradisSerializeDocCommentSidecar,
	paradisWithDocCommentPlaces,
} from '../common/paradisDocComments.js';

/** サイドカーのファイルの読み書き（テストでは差し替える）。`name` はフォルダの中のファイル名。 */
export interface IParadisDocCommentsStorage {
	read(name: string): Promise<string | undefined>;
	write(name: string, text: string): Promise<void>;
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

	constructor(
		private readonly _storage: IParadisDocCommentsStorage,
		private readonly _onError: (error: unknown) => void,
		private readonly _now: () => number = Date.now,
		private readonly _newId: () => string = newThreadId,
	) {
		super();
	}

	get(hostId: string, path: string): Promise<IParadisDocCommentSidecar> {
		return this._enqueue(hostId, path, () => this._read(hostId, path));
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
		return paradisParseDocCommentSidecar(text, hostId, path);
	}

	private async _write(sidecar: IParadisDocCommentSidecar): Promise<void> {
		await this._storage.write(paradisDocCommentSidecarName(sidecar.hostId, sidecar.path), paradisSerializeDocCommentSidecar(sidecar));
		this._onDidChange.fire({ hostId: sidecar.hostId, path: sidecar.path });
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

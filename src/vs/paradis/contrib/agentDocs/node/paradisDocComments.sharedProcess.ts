/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の、資料のコメント（サイドカー）のフォルダと、ウィンドウから頼むチャネル 2 つ（コメントの読み書き・届け方）。
// 保存係と届け方の係は、台帳と同じ所（paradisAgentDocs.sharedProcess.ts）で作る（ツールと届け方が台帳を引くため）。
// 置き場は利用者データの `paradis-docs/comments/`。

import { promises as fs } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { paradisIsDocCommentId } from '../common/paradisAgentDocs.js';
import {
	PARADIS_DOC_DELIVERY_CLAIM_METHOD,
	PARADIS_DOC_DELIVERY_CONFIRM_METHOD,
	PARADIS_DOC_DELIVERY_FINISH_METHOD,
	PARADIS_DOC_DELIVERY_WANTED_EVENT,
	paradisReadDocDeliveryOutcome,
} from '../common/paradisDocCommentDelivery.js';
import {
	PARADIS_DOC_COMMENTS_ACT_METHOD,
	PARADIS_DOC_COMMENTS_ADD_METHOD,
	PARADIS_DOC_COMMENTS_CHANGED_EVENT,
	PARADIS_DOC_COMMENTS_GET_METHOD,
	PARADIS_DOC_COMMENTS_SET_PLACES_METHOD,
	PARADIS_DOC_COMMENT_TEXT_MAX,
	ParadisDocCommentUserAction,
	paradisReadDocCommentDraft,
	paradisReadDocCommentPlaces,
	paradisReadDocCommentTarget,
	paradisWithDocCommentUserAction,
} from '../common/paradisDocComments.js';
import { ParadisDocCommentDelivery } from './paradisDocCommentDelivery.js';
import { IParadisDocCommentsStorage, ParadisDocCommentsStore } from './paradisDocCommentsStore.js';

const NAME_PATTERN = /^[0-9a-f]{64}\.json$/;

/** サイドカーのフォルダ。読めなければ無いものとして扱い、書くときは一時ファイルから置き換える。 */
export function paradisDocCommentsFileStorage(folder: string): IParadisDocCommentsStorage {
	return {
		list: async () => {
			try {
				return (await fs.readdir(folder)).filter(name => NAME_PATTERN.test(name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return [];
				}
				throw error;
			}
		},
		read: async name => {
			if (!NAME_PATTERN.test(name)) {
				return undefined;
			}
			try {
				return await fs.readFile(join(folder, name), 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
		},
		write: async (name, text) => {
			if (!NAME_PATTERN.test(name)) {
				throw new Error('invalid sidecar name');
			}
			await fs.mkdir(folder, { recursive: true, mode: 0o700 });
			const temporary = join(folder, `.${name}-${generateUuid()}.tmp`);
			await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temporary, join(folder, name));
		},
	};
}

/** ウィンドウからの頼みを受けるチャネル。引数はここで確かめ直す（ウィンドウの値をそのまま信じない）。 */
export class ParadisDocCommentsChannel implements IServerChannel<unknown> {

	constructor(
		private readonly _store: ParadisDocCommentsStore,
		/** 「今すぐ届ける」を渡す先（届け方の係）。 */
		private readonly _deliverNow?: (id: string) => void,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		if (event === PARADIS_DOC_COMMENTS_CHANGED_EVENT) {
			return this._store.onDidChange as Event<unknown> as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, _cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const target = paradisReadDocCommentTarget(args[0], args[1]);
		if (target === undefined) {
			throw new Error('invalid document');
		}
		switch (command) {
			case PARADIS_DOC_COMMENTS_GET_METHOD:
				return await this._store.get(target.hostId, target.path) as T;
			case PARADIS_DOC_COMMENTS_ADD_METHOD: {
				const draft = paradisReadDocCommentDraft(args[2]);
				if (draft === undefined) {
					throw new Error('invalid comment');
				}
				return await this._store.add(target.hostId, target.path, draft) as T;
			}
			case PARADIS_DOC_COMMENTS_SET_PLACES_METHOD:
				await this._store.setPlaces(target.hostId, target.path, paradisReadDocCommentPlaces(args[2]));
				return undefined as T;
			case PARADIS_DOC_COMMENTS_ACT_METHOD:
				await this._act(target.hostId, target.path, args[2], args[3], args[4]);
				return undefined as T;
		}
		throw new Error(`Call not found: ${command}`);
	}

	/** カードの操作（解決・開き直し・追記・今すぐ届ける）。ID はその資料のものだけ受ける。 */
	private async _act(hostId: string, path: string, rawId: unknown, rawAction: unknown, rawText: unknown): Promise<void> {
		const action = USER_ACTIONS.has(rawAction as string) ? rawAction as ParadisDocCommentUserAction : undefined;
		if (!paradisIsDocCommentId(rawId) || action === undefined) {
			throw new Error('invalid action');
		}
		const sidecar = await this._store.get(hostId, path);
		if (!sidecar.threads.some(thread => thread.id === rawId)) {
			throw new Error('unknown comment');
		}
		if (action === 'deliverNow') {
			this._deliverNow?.(rawId);
			return;
		}
		const text = typeof rawText === 'string' && rawText.length <= PARADIS_DOC_COMMENT_TEXT_MAX ? rawText : undefined;
		if (action === 'append' && !text?.trim()) {
			throw new Error('invalid comment');
		}
		await this._store.update(hostId, path, thread => thread.id === rawId ? paradisWithDocCommentUserAction(thread, action, text, Date.now()) : thread);
	}
}

const USER_ACTIONS: ReadonlySet<string> = new Set<ParadisDocCommentUserAction>(['resolve', 'reopen', 'append', 'deliverNow']);

/** ウィンドウが持ち主のペインへ貼るためのチャネル。引数はここで確かめ直す。 */
export class ParadisDocDeliveryChannel implements IServerChannel<unknown> {

	constructor(private readonly _delivery: ParadisDocCommentDelivery) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		if (event === PARADIS_DOC_DELIVERY_WANTED_EVENT) {
			return this._delivery.onDidWant as Event<unknown> as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const value = typeof args[0] === 'string' && args[0].length > 0 && args[0].length <= 200 ? args[0] : undefined;
		if (value === undefined) {
			throw new Error('invalid argument');
		}
		switch (command) {
			case PARADIS_DOC_DELIVERY_CLAIM_METHOD:
				return await this._delivery.claim(value) as T;
			case PARADIS_DOC_DELIVERY_CONFIRM_METHOD:
				return this._delivery.confirmEnter(value) as T;
			case PARADIS_DOC_DELIVERY_FINISH_METHOD: {
				const outcome = paradisReadDocDeliveryOutcome(args[1]);
				if (outcome === undefined) {
					throw new Error('invalid outcome');
				}
				await this._delivery.finish(value, outcome);
				return undefined as T;
			}
		}
		throw new Error(`Call not found: ${command}`);
	}
}

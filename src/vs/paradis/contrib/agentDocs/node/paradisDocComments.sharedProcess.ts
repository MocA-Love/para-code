/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process に、資料のコメント（サイドカー）の保存係と、ウィンドウから頼むチャネルを置く。
// `paradis.sharedProcess.contribution.ts` から副作用 import される。置き場は利用者データの `paradis-docs/comments/`。

import { promises as fs } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisSharedProcessContributions } from '../../../common/paradisProcessContributions.js';
import {
	PARADIS_DOC_COMMENTS_ADD_METHOD,
	PARADIS_DOC_COMMENTS_CHANGED_EVENT,
	PARADIS_DOC_COMMENTS_CHANNEL,
	PARADIS_DOC_COMMENTS_GET_METHOD,
	PARADIS_DOC_COMMENTS_SET_PLACES_METHOD,
	paradisReadDocCommentDraft,
	paradisReadDocCommentPlaces,
	paradisReadDocCommentTarget,
} from '../common/paradisDocComments.js';
import { IParadisDocCommentsStorage, ParadisDocCommentsStore } from './paradisDocCommentsStore.js';

const NAME_PATTERN = /^[0-9a-f]{64}\.json$/;

/** サイドカーのフォルダ。読めなければ無いものとして扱い、書くときは一時ファイルから置き換える。 */
function sidecarFileStorage(folder: string): IParadisDocCommentsStorage {
	return {
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

	constructor(private readonly _store: ParadisDocCommentsStore) { }

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
		}
		throw new Error(`Call not found: ${command}`);
	}
}

ParadisSharedProcessContributions.register('docComments', ({ server, accessor }) => {
	const logService = accessor.get(ILogService);
	const folder = join(accessor.get(INativeEnvironmentService).userDataPath, 'paradis-docs', 'comments');
	const store = new DisposableStore();
	const comments = store.add(new ParadisDocCommentsStore(sidecarFileStorage(folder), error => logService.warn('[ParadisDocComments] could not read or write the comments of a document', error)));
	server.registerChannel(PARADIS_DOC_COMMENTS_CHANNEL, new ParadisDocCommentsChannel(comments));
	return store;
});

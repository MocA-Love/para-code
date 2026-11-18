/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップでだけ、資料のコメントの保存先（shared process の保存係へのチャネル）をビューアへ渡す
// （paradisDocCommentsBackend.ts）。Web ビルドにはこのファイルが入らないので、コメント層は出ない。

import { Event } from '../../../../base/common/event.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisSetDocCommentsBackend } from '../browser/paradisDocCommentsBackend.js';
import {
	IParadisDocCommentSidecar,
	IParadisDocCommentThread,
	IParadisDocCommentsChange,
	PARADIS_DOC_COMMENTS_ACT_METHOD,
	PARADIS_DOC_COMMENTS_ADD_METHOD,
	PARADIS_DOC_COMMENTS_CHANGED_EVENT,
	PARADIS_DOC_COMMENTS_CHANNEL,
	PARADIS_DOC_COMMENTS_GET_METHOD,
	PARADIS_DOC_COMMENTS_SET_PLACES_METHOD,
} from '../common/paradisDocComments.js';
import { ParadisDocCommentWaker } from './paradisDocCommentWake.js';

class ParadisDocCommentsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDocComments';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const channel = sharedProcessService.getChannel(PARADIS_DOC_COMMENTS_CHANNEL);
		// 起こす・渡すはターミナルとスペースのサービスを使うので、押されたときに作る（起動の早い段で作らない）
		const waker = new Lazy(() => this._register(instantiationService.createInstance(ParadisDocCommentWaker)));
		this._register(paradisSetDocCommentsBackend({
			onDidChange: channel.listen<IParadisDocCommentsChange>(PARADIS_DOC_COMMENTS_CHANGED_EVENT) as Event<IParadisDocCommentsChange>,
			get: (hostId, path) => channel.call<IParadisDocCommentSidecar>(PARADIS_DOC_COMMENTS_GET_METHOD, [hostId, path]),
			add: (hostId, path, draft) => channel.call<IParadisDocCommentThread | undefined>(PARADIS_DOC_COMMENTS_ADD_METHOD, [hostId, path, draft]),
			setPlaces: (hostId, path, places) => channel.call<void>(PARADIS_DOC_COMMENTS_SET_PLACES_METHOD, [hostId, path, Object.fromEntries(places)]),
			act: (hostId, path, id, action, text) => channel.call<void>(PARADIS_DOC_COMMENTS_ACT_METHOD, [hostId, path, id, action, ...(text !== undefined ? [text] : [])]),
			wake: (hostId, path) => waker.value.wake(hostId, path),
			handOff: (hostId, path) => waker.value.handOff(hostId, path),
		}));
	}
}

// ビューアの初回の描画（復元のタブを含む）より前に口を入れる
registerWorkbenchContribution2(ParadisDocCommentsContribution.ID, ParadisDocCommentsContribution, WorkbenchPhase.BlockStartup);

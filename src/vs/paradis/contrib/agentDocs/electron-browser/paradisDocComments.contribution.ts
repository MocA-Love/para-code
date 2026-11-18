/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップでだけ、資料のコメントの保存先（shared process の保存係へのチャネル）をビューアへ渡す
// （paradisDocCommentsBackend.ts）。Web ビルドにはこのファイルが入らないので、コメント層は出ない。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisSetDocCommentsBackend } from '../browser/paradisDocCommentsBackend.js';
import {
	IParadisDocCommentSidecar,
	IParadisDocCommentThread,
	IParadisDocCommentsChange,
	PARADIS_DOC_COMMENTS_ADD_METHOD,
	PARADIS_DOC_COMMENTS_CHANGED_EVENT,
	PARADIS_DOC_COMMENTS_CHANNEL,
	PARADIS_DOC_COMMENTS_GET_METHOD,
	PARADIS_DOC_COMMENTS_SET_PLACES_METHOD,
} from '../common/paradisDocComments.js';

class ParadisDocCommentsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDocComments';

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super();
		const channel = sharedProcessService.getChannel(PARADIS_DOC_COMMENTS_CHANNEL);
		this._register(paradisSetDocCommentsBackend({
			onDidChange: channel.listen<IParadisDocCommentsChange>(PARADIS_DOC_COMMENTS_CHANGED_EVENT) as Event<IParadisDocCommentsChange>,
			get: (hostId, path) => channel.call<IParadisDocCommentSidecar>(PARADIS_DOC_COMMENTS_GET_METHOD, [hostId, path]),
			add: (hostId, path, draft) => channel.call<IParadisDocCommentThread | undefined>(PARADIS_DOC_COMMENTS_ADD_METHOD, [hostId, path, draft]),
			setPlaces: (hostId, path, places) => channel.call<void>(PARADIS_DOC_COMMENTS_SET_PLACES_METHOD, [hostId, path, Object.fromEntries(places)]),
		}));
	}
}

// ビューアの初回の描画（復元のタブを含む）より前に口を入れる
registerWorkbenchContribution2(ParadisDocCommentsContribution.ID, ParadisDocCommentsContribution, WorkbenchPhase.BlockStartup);

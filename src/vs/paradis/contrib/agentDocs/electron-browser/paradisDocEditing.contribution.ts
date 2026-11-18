/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// デスクトップでだけ、資料の「編集中」の印の出どころ（shared process の控えへのチャネル）をビューアへ渡す
// （paradisDocEditingSource.ts）。届いた印は形を確かめ直してから渡す。

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { paradisSetDocEditingSource } from '../browser/paradisDocEditingSource.js';
import { paradisReadDocCommentTarget } from '../common/paradisDocComments.js';
import { IParadisDocEditingChange, PARADIS_DOC_EDITING_CHANGED_EVENT, PARADIS_DOC_EDITING_CHANNEL, PARADIS_DOC_EDITING_GET_METHOD, paradisReadDocEditingMark } from '../common/paradisDocEditing.js';

class ParadisDocEditingContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisDocEditing';

	constructor(@ISharedProcessService sharedProcessService: ISharedProcessService) {
		super();
		const channel = sharedProcessService.getChannel(PARADIS_DOC_EDITING_CHANNEL);
		const changes = channel.listen<IParadisDocEditingChange>(PARADIS_DOC_EDITING_CHANGED_EVENT) as Event<IParadisDocEditingChange>;
		const store = this._register(new DisposableStore());
		const read = (change: IParadisDocEditingChange | undefined): IParadisDocEditingChange | undefined => {
			const target = paradisReadDocCommentTarget(change?.hostId, change?.path);
			if (target === undefined) {
				return undefined;
			}
			const mark = paradisReadDocEditingMark(change?.mark);
			return { ...target, ...(mark !== undefined ? { mark } : {}) };
		};
		this._register(paradisSetDocEditingSource({
			onDidChange: Event.filter<IParadisDocEditingChange, undefined>(Event.map(changes, read, store), (change): change is IParadisDocEditingChange => change !== undefined, store),
			get: async (hostId, path) => paradisReadDocEditingMark(await channel.call<unknown>(PARADIS_DOC_EDITING_GET_METHOD, [hostId, path])),
		}));
	}
}

// ビューアの初回の描画（復元のタブを含む）より前に口を入れる
registerWorkbenchContribution2(ParadisDocEditingContribution.ID, ParadisDocEditingContribution, WorkbenchPhase.BlockStartup);

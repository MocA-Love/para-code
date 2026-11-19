/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメントの保存先への口。Markdown のビューアは browser 層（Web にも載る）にあり、shared process の
// チャネルを直接使えないので、デスクトップの起動時に electron-browser の contribution
// （paradisDocComments.contribution.ts）がここへ口を入れる。口が無い（Web）ときはコメント層を出さない。

import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { paradisAgentHookRemoteHostId } from '../../agentBrowser/common/paradisAgentHooks.js';
import { IParadisDocCommentDraft, IParadisDocCommentSidecar, IParadisDocCommentThread, IParadisDocCommentsChange, ParadisDocCommentPlace, ParadisDocCommentUserAction, paradisReadDocCommentTarget } from '../common/paradisDocComments.js';

/** コメントの保存先（shared process の保存係へ頼む）。 */
export interface IParadisDocCommentsBackend {
	readonly onDidChange: Event<IParadisDocCommentsChange>;
	get(hostId: string, path: string): Promise<IParadisDocCommentSidecar>;
	add(hostId: string, path: string, draft: IParadisDocCommentDraft): Promise<IParadisDocCommentThread | undefined>;
	setPlaces(hostId: string, path: string, places: ReadonlyMap<string, ParadisDocCommentPlace>): Promise<void>;
	/** カードの操作（解決・開き直し・追記・今すぐ届ける）。 */
	act(hostId: string, path: string, id: string, action: ParadisDocCommentUserAction, text?: string): Promise<void>;
	/** 終了した持ち主の会話を起こし、起動を待って届ける（カードの「起こして届ける」）。結果はウィンドウが知らせる。 */
	wake?(hostId: string, path: string): Promise<void>;
	/** 選んだペインの会話へ資料を渡す（カードの「別のエージェントに渡す」）。結果はウィンドウが知らせる。 */
	handOff?(hostId: string, path: string): Promise<void>;
}

let backend: IParadisDocCommentsBackend | undefined;

/** 保存先を入れる（デスクトップの起動時に 1 回）。 */
export function paradisSetDocCommentsBackend(value: IParadisDocCommentsBackend): IDisposable {
	backend = value;
	return toDisposable(() => {
		if (backend === value) {
			backend = undefined;
		}
	});
}

/** いまの保存先。無ければ undefined（コメント層を出さない）。 */
export function paradisDocCommentsBackend(): IParadisDocCommentsBackend | undefined {
	return backend;
}

/**
 * ファイルの URI を、台帳・サイドカーと同じ形（接続先の印と絶対パス）にする。手元のファイルと SSH 先のファイルだけ。
 * 資料（html・md）でなければ undefined。
 */
export function paradisDocCommentTargetOf(resource: URI): IParadisDocCommentsChange | undefined {
	if (resource.scheme === Schemas.file) {
		return paradisReadDocCommentTarget('', resource.fsPath);
	}
	if (resource.scheme === Schemas.vscodeRemote) {
		const hostId = paradisAgentHookRemoteHostId(resource.authority);
		return hostId !== undefined ? paradisReadDocCommentTarget(hostId, resource.path) : undefined;
	}
	return undefined;
}

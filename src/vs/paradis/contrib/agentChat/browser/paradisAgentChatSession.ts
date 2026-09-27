/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IParadisAgentChatSource } from '../common/paradisAgentChat.js';
import { IParadisAgentChatState, paradisAgentChatCursor, paradisApplyAgentChatView } from '../common/paradisAgentChatState.js';

/**
 * 1ペイン分の会話の写し。中継から差分を取りに行き、手元の写しへ当てる。
 *
 * 取りに行くのは同時に1本だけ。取りに行っている間に「変わった」と言われたら、終わってから
 * もう1回だけ取りに行く（知らせが立て続けに来ても IPC を積み上げない）。
 */
export class ParadisAgentChatSession extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _state: IParadisAgentChatState | undefined;
	/** 一度でも取りに行って答えが返ったか（読み込み中の表示と「会話が無い」表示を分ける）。 */
	private _loaded = false;
	private _inFlight: Promise<void> | undefined;
	private _dirty = false;

	constructor(
		readonly token: string,
		private readonly source: IParadisAgentChatSource,
		private readonly logService: ILogService,
	) {
		super();
	}

	get state(): IParadisAgentChatState | undefined {
		return this._state;
	}

	get loaded(): boolean {
		return this._loaded;
	}

	/** 最新の会話を取りに行く。取りに行っている最中なら、終わったあとにもう1回だけ取りに行く。 */
	refresh(): Promise<void> {
		if (this._inFlight !== undefined) {
			this._dirty = true;
			return this._inFlight;
		}
		this._inFlight = this.fetch().finally(() => {
			this._inFlight = undefined;
			if (this._dirty && !this._store.isDisposed) {
				this._dirty = false;
				void this.refresh();
			}
		});
		return this._inFlight;
	}

	private async fetch(): Promise<void> {
		try {
			let view = await this.source.getAgentChat(this.token, paradisAgentChatCursor(this._state));
			if (this._store.isDisposed) {
				return;
			}
			let next = view === undefined ? undefined : paradisApplyAgentChatView(this._state, view);
			if (view !== undefined && next === undefined) {
				// 手元と噛み合わない差分だった（読み取りが始め直された等）。起点なしで全量を取り直す。
				view = await this.source.getAgentChat(this.token, undefined);
				if (this._store.isDisposed) {
					return;
				}
				next = view === undefined ? undefined : paradisApplyAgentChatView(undefined, view);
			}
			const changed = !this._loaded || !sameState(this._state, next);
			this._state = next;
			this._loaded = true;
			if (changed) {
				this._onDidChange.fire();
			}
		} catch (error) {
			this.logService.trace('[paradisAgentChat] refresh failed', String(error));
		}
	}
}

/** 画面を描き直す必要があるほど変わったか。本文は rev で、それ以外は値で比べる。 */
function sameState(a: IParadisAgentChatState | undefined, b: IParadisAgentChatState | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	if (a.epoch !== b.epoch || a.rev !== b.rev || a.messages.length !== b.messages.length || a.busy !== b.busy || a.agent !== b.agent) {
		return false;
	}
	return JSON.stringify([a.live, a.interaction, a.info, a.pendingQuestions, a.truncated]) === JSON.stringify([b.live, b.interaction, b.info, b.pendingQuestions, b.truncated]);
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

/**
 * そのペインが今チャット表示で見えているか。チャット表示に切り替えていて、エージェントの会話（ペインのトークン）がある
 * ペイン。エディタのターミナルの入れ物に `paradis-agent-chat-active` を付けるのと同じ判定。
 */
export function paradisAgentChatActive(chatMode: boolean, token: string | undefined): boolean {
	return chatMode && token !== undefined;
}

/** チャット表示で見えているペインの一覧を持ち、出入りしたペインを知らせる。 */
export class ParadisAgentChatActiveTracker extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<number>());
	/** 見えているかが変わったペイン（ターミナルのインスタンスの ID）。 */
	readonly onDidChange: Event<number> = this._onDidChange.event;
	private active = new Set<number>();

	isActive(instanceId: number): boolean {
		return this.active.has(instanceId);
	}

	/** 候補（チャット表示に切り替えているペイン）を判定し直し、変わったペインを知らせる。 */
	update(candidates: Iterable<number>, isActive: (instanceId: number) => boolean): void {
		const next = new Set<number>();
		for (const instanceId of candidates) {
			if (isActive(instanceId)) {
				next.add(instanceId);
			}
		}
		const previous = this.active;
		this.active = next;
		for (const instanceId of previous) {
			if (!next.has(instanceId)) {
				this._onDidChange.fire(instanceId);
			}
		}
		for (const instanceId of next) {
			if (!previous.has(instanceId)) {
				this._onDidChange.fire(instanceId);
			}
		}
	}
}

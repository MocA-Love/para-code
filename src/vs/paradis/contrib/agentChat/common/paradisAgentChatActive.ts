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

/**
 * そのペインでチャット表示を使えるか。`paradis.agentChat.enabled` をオフにしていても、控えたペイン（Bot の会話のペイン。
 * `pinChatMode`）は使う。Bot の会話はいつも吹き出しで見せるため（オフのままだとターミナルの TUI だけが見え、切り替えの口も出ない）。
 */
export function paradisAgentChatUsable(settingEnabled: boolean, pinned: boolean): boolean {
	return settingEnabled || pinned;
}

/** 設定をオフにしたときにチャット表示を閉じるペイン（控えたペインはチャット表示のまま残す）。 */
export function paradisAgentChatClosedOnDisable(chatMode: Iterable<number>, pinned: ReadonlySet<number>): number[] {
	return [...chatMode].filter(instanceId => !pinned.has(instanceId));
}

/** 中継に見張らせるペイン（`watchAgentChat` に渡すトークン）。設定がオフなら、控えたペインの分だけ。 */
export function paradisAgentChatWatchedTokens(settingEnabled: boolean, panes: readonly { readonly instanceId: number; readonly token: string }[], pinned: ReadonlySet<number>): string[] {
	return panes.filter(pane => paradisAgentChatUsable(settingEnabled, pinned.has(pane.instanceId))).map(pane => pane.token);
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

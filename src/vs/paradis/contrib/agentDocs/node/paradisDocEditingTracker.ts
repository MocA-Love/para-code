/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process で、資料の「編集中」の印を hook から控え、ウィンドウへ知らせる（Q663-5）。出す・消す条件は
// paradisDocEditing.ts の純関数が決める。ここは控えと時間切れと、ターンの終わりの知らせ（会話の記録から。
// Esc で止めたときなど hook が来ない場合）だけを持つ。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import type { IParadisAgentHookEvent } from '../../agentBrowser/node/paradisAgentHookBus.js';
import { paradisHookAgentKindForTranscript } from '../../agentBrowser/node/paradisAgentHookOwnership.js';
import { paradisReadDocCommentTarget } from '../common/paradisDocComments.js';
import {
	IParadisDocEditingChange,
	IParadisDocEditingMark,
	PARADIS_DOC_EDITING_CHANGED_EVENT,
	PARADIS_DOC_EDITING_GET_METHOD,
	PARADIS_DOC_EDITING_TIMEOUT_MS,
	paradisDocEditingActionOf,
} from '../common/paradisDocEditing.js';

interface IEntry {
	readonly hostId: string;
	readonly path: string;
	readonly token: string;
	readonly toolUseId?: string;
	readonly mark: IParadisDocEditingMark;
	readonly timer: IDisposable;
}

/** 時間切れの口（テストで差し替える）。 */
export type ParadisDocEditingTimer = (callback: () => void, ms: number) => IDisposable;

function defaultTimer(callback: () => void, ms: number): IDisposable {
	const handle = setTimeout(callback, ms);
	return toDisposable(() => clearTimeout(handle));
}

export class ParadisDocEditingTracker extends Disposable {

	/** 資料（接続先の印＋パス）→ 印。同じ資料は最後の 1 つだけ。 */
	private readonly _entries = new Map<string, IEntry>();
	/** ペイン → 最後に分かったエージェントの種類（TerminalExit などは種類を載せない）。 */
	private readonly _paneAgents = new Map<string, string>();

	private readonly _onDidChange = this._register(new Emitter<IParadisDocEditingChange>());
	readonly onDidChange: Event<IParadisDocEditingChange> = this._onDidChange.event;

	constructor(
		hookEvents: Event<IParadisAgentHookEvent>,
		turnEnded: Event<{ readonly token: string }>,
		awaitingUser: Event<{ readonly token: string }>,
		private readonly _timer: ParadisDocEditingTimer = defaultTimer,
		private readonly _timeoutMs: number = PARADIS_DOC_EDITING_TIMEOUT_MS,
	) {
		super();
		this._register(hookEvents(event => this.handleHook(event)));
		this._register(turnEnded(({ token }) => this._endPane(token)));
		this._register(awaitingUser(({ token }) => this._endPane(token)));
		this._register(toDisposable(() => {
			for (const entry of this._entries.values()) {
				entry.timer.dispose();
			}
			this._entries.clear();
		}));
	}

	/** その資料のいまの印。 */
	get(hostId: string, path: string): IParadisDocEditingMark | undefined {
		return this._entries.get(keyOf(hostId, path))?.mark;
	}

	handleHook(event: IParadisAgentHookEvent): void {
		const kind = event.agentKind ?? (event.transcriptPath !== undefined ? paradisHookAgentKindForTranscript(event.transcriptPath) : undefined) ?? this._paneAgents.get(event.token);
		if (kind !== undefined && !event.ownerUnverified) {
			this._paneAgents.set(event.token, kind);
		}
		const action = paradisDocEditingActionOf(event, kind);
		if (event.event === 'TerminalExit') {
			this._paneAgents.delete(event.token);
		}
		switch (action?.type) {
			case 'endPane':
				this._endPane(event.token);
				return;
			case 'end':
				for (const [key, entry] of this._entries) {
					const sameTool = action.toolUseId !== undefined && entry.toolUseId !== undefined
						? action.toolUseId === entry.toolUseId
						: entry.token === event.token && entry.hostId === action.hostId && entry.path === action.path;
					if (sameTool) {
						this._delete(key);
					}
				}
				return;
			case 'start': {
				const key = keyOf(action.hostId, action.path);
				this._delete(key, false);
				const mark: IParadisDocEditingMark = { id: generateUuid(), tool: action.tool, ...(action.source !== undefined ? { source: action.source } : {}), at: event.at };
				const timer = this._timer(() => {
					if (this._entries.get(key)?.mark === mark) {
						this._delete(key);
					}
				}, this._timeoutMs);
				this._entries.set(key, { hostId: action.hostId, path: action.path, token: event.token, ...(action.toolUseId !== undefined ? { toolUseId: action.toolUseId } : {}), mark, timer });
				this._onDidChange.fire({ hostId: action.hostId, path: action.path, mark });
				return;
			}
		}
	}

	private _endPane(token: string): void {
		for (const [key, entry] of this._entries) {
			if (entry.token === token) {
				this._delete(key);
			}
		}
	}

	private _delete(key: string, notify = true): void {
		const entry = this._entries.get(key);
		if (!entry) {
			return;
		}
		entry.timer.dispose();
		this._entries.delete(key);
		if (notify) {
			this._onDidChange.fire({ hostId: entry.hostId, path: entry.path });
		}
	}
}

function keyOf(hostId: string, path: string): string {
	return `${hostId}\n${path}`;
}

/** ウィンドウが印を読むチャネル。引数はここで確かめ直す。 */
export class ParadisDocEditingChannel implements IServerChannel<unknown> {

	constructor(private readonly _tracker: ParadisDocEditingTracker) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		if (event === PARADIS_DOC_EDITING_CHANGED_EVENT) {
			return this._tracker.onDidChange as Event<unknown> as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command !== PARADIS_DOC_EDITING_GET_METHOD) {
			throw new Error(`Call not found: ${command}`);
		}
		const args = Array.isArray(arg) ? arg : [];
		const target = paradisReadDocCommentTarget(args[0], args[1]);
		if (target === undefined) {
			throw new Error('invalid document');
		}
		return this._tracker.get(target.hostId, target.path) as T;
	}
}

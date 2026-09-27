/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CDP ゲートウェイで、Para Code がページへ入れている isolated world をエージェントから隠す。
//
// Para Code はページの main world とは別の world でコードを動かしている（Design Mode の要素選択
// world、upstream の preload の world 999 など）。ページの JS からは見えないが、CDP には
// `Runtime.executionContextCreated` で isDefault:false のコンテキストとして現れ、`Runtime.evaluate` の
// `contextId` などで中へ入れてしまう。中の関数を差し替えられると、Design Mode の選択結果を偽造して
// 「ユーザーの発言」として別のペインへ送らせることができる。そこで:
//
//  - isDefault:false のコンテキストは隠す。ただし、このクライアント自身が `Page.createIsolatedWorld` /
//    `Page.addScriptToEvaluateOnNewDocument` の worldName で作らせた world（puppeteer が使う）は見せる。
//    名前の無い world と Electron の world の名前は、クライアントが要求しても見せない
//  - コンテキストを指す引数（contextId / executionContextId / uniqueContextId）は、見せたコンテキスト
//    のものだけ通す（番号は連番で推測できるので、隠したものを拒むだけでは足りない）
//  - objectId は V8 の「isolate.context.object」の形なら、隠したコンテキストのものを拒む
//  - 隠したコンテキストのスクリプト（`Debugger.scriptParsed`）と、そこで止まった `Debugger.paused`、
//    そこからのコンソール出力・例外は届けない。止まった場合はこちらで再開させる
//
// セッション（フラット化した子セッションの sessionId、ページ直結なら ''）ごとに状態を持つ。

/** クライアントが要求しても見せない world の名前（Electron が自分の world に付ける名前）。 */
const RESERVED_WORLD_NAMES: ReadonlySet<string> = new Set(['', 'Electron Isolated Context']);

/** 1セッションで覚えておく数の上限（壊れたクライアントで膨らまないように）。 */
const MAX_TRACKED_IDS = 10_000;

const CONTEXT_DENIED_MESSAGE = 'This execution context is not available on the Para Code CDP gateway (Para Code keeps its own isolated worlds hidden from agents). Use the page\'s default context or an isolated world you created with Page.createIsolatedWorld.';
const SCRIPT_DENIED_MESSAGE = 'This script belongs to a Para Code isolated world and is not available on the Para Code CDP gateway.';

/** V8 の RemoteObjectId（isolate.context.object）。 */
const OBJECT_ID_PATTERN = /^-?\d+\.(?<context>\d+)\.\d+$/;

interface ISessionState {
	readonly visibleContextIds: Set<number>;
	readonly visibleUniqueIds: Set<string>;
	readonly hiddenContextIds: Set<number>;
	readonly hiddenUniqueIds: Set<string>;
	readonly hiddenScriptIds: Set<string>;
	readonly requestedWorldNames: Set<string>;
	/** Page.createIsolatedWorld の要求 id（応答の executionContextId を見せる）。 */
	readonly pendingCreateWorld: Set<number>;
}

export type ParadisIsolatedWorldEventVerdict = 'forward' | 'drop' | 'resume';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedAdd<T>(set: Set<T>, value: T): void {
	if (set.size < MAX_TRACKED_IDS) {
		set.add(value);
	}
}

export class ParadisCdpIsolatedWorldFilter {

	private readonly _sessions = new Map<string, ISessionState>();

	private _state(sessionKey: string): ISessionState {
		let state = this._sessions.get(sessionKey);
		if (!state) {
			state = {
				visibleContextIds: new Set(),
				visibleUniqueIds: new Set(),
				hiddenContextIds: new Set(),
				hiddenUniqueIds: new Set(),
				hiddenScriptIds: new Set(),
				requestedWorldNames: new Set(),
				pendingCreateWorld: new Set(),
			};
			this._sessions.set(sessionKey, state);
		}
		return state;
	}

	forgetSession(sessionKey: string): void {
		this._sessions.delete(sessionKey);
	}

	/**
	 * クライアント → ブラウザのコマンドを調べる。通してよければ undefined、拒むならその理由。
	 * worldName の要求と Page.createIsolatedWorld の要求 id もここで覚える。
	 */
	checkClientCommand(sessionKey: string, id: number, method: string, params: unknown): string | undefined {
		const state = this._state(sessionKey);
		const record = isRecord(params) ? params : undefined;
		if (record) {
			for (const key of ['contextId', 'executionContextId'] as const) {
				const value = record[key];
				if (value !== undefined && (typeof value !== 'number' || !state.visibleContextIds.has(value))) {
					return CONTEXT_DENIED_MESSAGE;
				}
			}
			const uniqueContextId = record.uniqueContextId;
			if (uniqueContextId !== undefined && (typeof uniqueContextId !== 'string' || !state.visibleUniqueIds.has(uniqueContextId))) {
				return CONTEXT_DENIED_MESSAGE;
			}
			const objectId = record.objectId;
			if (typeof objectId === 'string') {
				const context = OBJECT_ID_PATTERN.exec(objectId)?.groups?.context;
				if (context !== undefined && state.hiddenContextIds.has(Number(context))) {
					return CONTEXT_DENIED_MESSAGE;
				}
			}
			const scriptId = typeof record.scriptId === 'string'
				? record.scriptId
				: isRecord(record.location) && typeof record.location.scriptId === 'string' ? record.location.scriptId : undefined;
			if (scriptId !== undefined && state.hiddenScriptIds.has(scriptId)) {
				return SCRIPT_DENIED_MESSAGE;
			}
			if ((method === 'Page.createIsolatedWorld' || method === 'Page.addScriptToEvaluateOnNewDocument') && typeof record.worldName === 'string' && !RESERVED_WORLD_NAMES.has(record.worldName)) {
				boundedAdd(state.requestedWorldNames, record.worldName);
			}
		}
		if (method === 'Page.createIsolatedWorld') {
			boundedAdd(state.pendingCreateWorld, id);
		}
		return undefined;
	}

	/** ブラウザ → クライアントの応答を見る（作らせた isolated world のコンテキストを見せる）。 */
	observeResponse(sessionKey: string, id: unknown, result: unknown): void {
		const state = this._sessions.get(sessionKey);
		if (!state || typeof id !== 'number' || !state.pendingCreateWorld.delete(id)) {
			return;
		}
		if (isRecord(result) && typeof result.executionContextId === 'number') {
			state.hiddenContextIds.delete(result.executionContextId);
			boundedAdd(state.visibleContextIds, result.executionContextId);
		}
	}

	/** ブラウザ → クライアントのイベントを見る。 */
	filterEvent(sessionKey: string, method: string, params: unknown): ParadisIsolatedWorldEventVerdict {
		const state = this._state(sessionKey);
		const record = isRecord(params) ? params : undefined;
		switch (method) {
			case 'Runtime.executionContextCreated': {
				const context = isRecord(record?.context) ? record.context : undefined;
				if (!context || typeof context.id !== 'number') {
					return 'forward';
				}
				const auxData = isRecord(context.auxData) ? context.auxData : undefined;
				const name = typeof context.name === 'string' ? context.name : '';
				const hidden = auxData?.isDefault === false && (RESERVED_WORLD_NAMES.has(name) || !state.requestedWorldNames.has(name)) && !state.visibleContextIds.has(context.id);
				const uniqueId = typeof context.uniqueId === 'string' ? context.uniqueId : undefined;
				if (hidden) {
					boundedAdd(state.hiddenContextIds, context.id);
					if (uniqueId !== undefined) {
						boundedAdd(state.hiddenUniqueIds, uniqueId);
					}
					return 'drop';
				}
				boundedAdd(state.visibleContextIds, context.id);
				if (uniqueId !== undefined) {
					boundedAdd(state.visibleUniqueIds, uniqueId);
				}
				return 'forward';
			}
			case 'Runtime.executionContextDestroyed': {
				const id = record?.executionContextId;
				const uniqueId = record?.executionContextUniqueId;
				if (typeof id === 'number' && state.hiddenContextIds.delete(id)) {
					if (typeof uniqueId === 'string') {
						state.hiddenUniqueIds.delete(uniqueId);
					}
					return 'drop';
				}
				if (typeof id === 'number') {
					state.visibleContextIds.delete(id);
				}
				if (typeof uniqueId === 'string') {
					state.visibleUniqueIds.delete(uniqueId);
				}
				return 'forward';
			}
			case 'Runtime.executionContextsCleared':
				state.visibleContextIds.clear();
				state.visibleUniqueIds.clear();
				state.hiddenContextIds.clear();
				state.hiddenUniqueIds.clear();
				return 'forward';
			case 'Debugger.scriptParsed':
			case 'Debugger.scriptFailedToParse': {
				const auxData = isRecord(record?.executionContextAuxData) ? record.executionContextAuxData : undefined;
				const contextId = record?.executionContextId;
				const inHidden = (typeof contextId === 'number' && state.hiddenContextIds.has(contextId))
					|| (auxData?.isDefault === false && !(typeof contextId === 'number' && state.visibleContextIds.has(contextId)));
				if (inHidden) {
					if (typeof record?.scriptId === 'string') {
						boundedAdd(state.hiddenScriptIds, record.scriptId);
					}
					return 'drop';
				}
				return 'forward';
			}
			case 'Debugger.paused': {
				const frames = Array.isArray(record?.callFrames) ? record.callFrames : [];
				const top = isRecord(frames[0]) ? frames[0] : undefined;
				const location = isRecord(top?.location) ? top.location : undefined;
				return typeof location?.scriptId === 'string' && state.hiddenScriptIds.has(location.scriptId) ? 'resume' : 'forward';
			}
			case 'Runtime.consoleAPICalled': {
				const contextId = record?.executionContextId;
				return typeof contextId === 'number' && state.hiddenContextIds.has(contextId) ? 'drop' : 'forward';
			}
			case 'Runtime.exceptionThrown': {
				const details = isRecord(record?.exceptionDetails) ? record.exceptionDetails : undefined;
				const contextId = details?.executionContextId;
				return typeof contextId === 'number' && state.hiddenContextIds.has(contextId) ? 'drop' : 'forward';
			}
			default:
				return 'forward';
		}
	}
}

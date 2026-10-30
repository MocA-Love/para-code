/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.userScripts（P9b）の main 側。Tampermonkey などのユーザースクリプトの拡張機能が使う。Electron に無いので、登録を
// main が持ち、注入は拡張機能を入れるセッションの frame の preload（../electron-browser/paradisUserScriptsPreload.ts）が
// main に聞いて行う。
//  - 使えるのは、利用者がその場所で「ユーザースクリプトを許可」した拡張機能だけ（Chrome の拡張機能ごとの設定と同じ。既定はオフ）。
//    オフの間は、詰め物が chrome.userScripts を出さず、main も呼び出しを断る
//  - 入れるのは、その場所の利用者のタブ（拡張機能のタブの一覧に出す、知らせ済みのタブ）の http・https の文書だけ。エージェントの
//    タブ（エージェントが開いたタブとその子）、エージェントと共有中のタブ、SSH 先のトンネルを通すセッション、Chrome ウェブストアには
//    入れない。新しいタブは、エージェントのものかが分かるまで（最長 3 秒）入れない
//  - 何を動かすかは、送り主のフレーム（preload の本文ではない）から main が決める
//  - messaging を許した world からのメッセージは、拡張機能の runtime.onUserScriptMessage・onUserScriptConnect へ届ける
//    （worker が止まっていれば起こす）。送り主（タブ・URL）は main が送り主のフレームから作る
//  - 登録は場所ごと・拡張機能ごとに保存する（拡張機能の worker が起きる前の最初のページでも document_start で動かすため）

import * as electron from 'electron';
import type { WebContents, WebFrameMain } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, normalize, sep } from '../../../../base/common/path.js';
import { paradisIsExtensionPageHeld } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { PARADIS_SHIM_USER_SCRIPTS_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import {
	IParadisRegisteredUserScript,
	IParadisUserScriptRegistrations,
	IParadisUserScriptWorldConfig,
	PARADIS_USER_SCRIPTS_CALL,
	PARADIS_USER_SCRIPTS_EVENT,
	PARADIS_USER_SCRIPTS_QUERY,
	PARADIS_USER_SCRIPTS_RECHECK,
	ParadisUserScriptsError,
	paradisConfigureUserScriptWorld,
	paradisEffectiveUserScriptWorld,
	paradisIsUserScriptTargetUrl,
	paradisParseUserScriptRegistrations,
	paradisRegisterUserScripts,
	paradisUpdateUserScripts,
	paradisUserScriptApplies,
	paradisUserScriptFilterIds,
} from '../common/paradisBrowserExtensionUserScripts.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { paradisChromeFrameId, paradisMatchesUrlPattern } from './paradisBrowserExtensionTabs.js';

/**
 * USER_SCRIPT の world の番号の始め。0（ページ）・999（Electron の preload）・Chromium の拡張機能の content script の world
 * （1 << 20 から数える）と重ならず、Blink の上限（1 << 29）より下。
 */
const FIRST_WORLD_NUMBER = 1 << 28;
const LAST_WORLD_NUMBER = (1 << 29) - 1;
/** 1 つのメッセージの上限（Chrome と同じ 64 MiB、JSON の文字で数える）。 */
const MAX_MESSAGE_CHARS = 64 * 1024 * 1024;
/** 返事を待つ上限（来なければ「返事の前に閉じた」とする）。 */
const RESPONSE_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_MESSAGES = 1_000;
const MAX_PORTS = 1_000;
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/** 拡張機能の管理から渡すもの（テストでは偽物）。 */
export interface IParadisUserScriptsEnvironment {
	/** そのセッションの場所（SSH 先のトンネルを通すセッション・拡張機能を入れないセッションは undefined）。 */
	placeOfSession(session: unknown): string | undefined;
	/** 拡張機能に見せる利用者のタブか（エージェントのタブではないと分かって知らせたタブ）。 */
	isUserTab(contents: WebContents): boolean;
	isEnabledIn(place: string, extensionId: string): boolean;
	/** userScripts の権限があるか（manifest と、後から許したもの）。 */
	hasPermission(place: string, extension: IParadisApiExtension): boolean;
	/** 送り主のタブ（Chrome の形）。 */
	describeTab(extension: IParadisApiExtension, contents: WebContents): Record<string, unknown> | undefined;
}

interface IState {
	/** 場所 → 「ユーザースクリプトを許可」した拡張機能の id。 */
	allowed: Record<string, string[]>;
	/** 場所 → 拡張機能の id → 登録。 */
	registrations: Record<string, Record<string, IParadisUserScriptRegistrations>>;
}

/** 入れてよいフレーム。 */
interface IFrameContext {
	readonly place: string;
	readonly url: string;
	readonly origin: string;
	readonly top: boolean;
}

interface ILoadedExtension extends IParadisApiExtension {
	readonly path: string;
	readonly name: string;
}

type ExtensionSession = ParadisApiSession & { readonly extensions: { getExtension(id: string): ILoadedExtension | null } };

interface IPendingMessage {
	readonly session: unknown;
	readonly extensionId: string;
	readonly resolve: (reply: { readonly value?: unknown; readonly error?: string; readonly closed?: boolean }) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface IPort {
	readonly session: unknown;
	readonly extensionId: string;
	readonly contents: WebContents;
	readonly processId: number;
	readonly routingId: number;
	readonly world: number;
}

type FrameLike = Pick<WebFrameMain, 'url' | 'parent' | 'frameTreeNodeId' | 'processId' | 'routingId'> & { isDestroyed?(): boolean; send?(channel: string, ...args: unknown[]): void };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializedLength(value: unknown): number | undefined {
	try {
		const json = JSON.stringify(value ?? null);
		return typeof json === 'string' ? json.length : undefined;
	} catch {
		return undefined;
	}
}

export class ParadisBrowserExtensionUserScripts {

	private _state: IState = { allowed: {}, registrations: {} };
	private _saving: Promise<void> = Promise.resolve();
	private readonly _worldNumbers = new Map<string, number>();
	private _nextWorldNumber = FIRST_WORLD_NUMBER;
	private readonly _pending = new Map<string, IPendingMessage>();
	private readonly _ports = new Map<string, IPort>();
	private readonly _attached = new WeakSet<object>();
	/** 拡張機能のフォルダ・js の file → 中身（注入の問いは同期で答えるので、先に読んでおく）。 */
	private readonly _files = new Map<string, string>();
	private readonly _warming = new Set<string>();
	private _disposed = false;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _path: string,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		private readonly _environment: IParadisUserScriptsEnvironment,
	) {
		this._register();
		this._host.onDidCloseContext((session, extensionId, connection) => {
			// worker が止まった・拡張機能を外した: そのポートを切り、返事を待っているメッセージを閉じる
			if (connection === 'worker' || connection === undefined) {
				this._closeFor(port => port.session === session && port.extensionId === extensionId, NO_RECEIVER);
				for (const [requestId, pending] of [...this._pending]) {
					if (pending.session === session && pending.extensionId === extensionId) {
						this._settle(requestId, { closed: true });
					}
				}
			}
		});
	}

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const state: IState = { allowed: {}, registrations: {} };
			if (isRecord(raw) && isRecord(raw.allowed)) {
				for (const [place, ids] of Object.entries(raw.allowed)) {
					if (Array.isArray(ids)) {
						state.allowed[place] = ids.filter((id): id is string => typeof id === 'string');
					}
				}
			}
			if (isRecord(raw) && isRecord(raw.registrations)) {
				for (const [place, byExtension] of Object.entries(raw.registrations)) {
					if (isRecord(byExtension)) {
						state.registrations[place] = Object.fromEntries(Object.entries(byExtension).map(([id, value]) => [id, paradisParseUserScriptRegistrations(value)]));
					}
				}
			}
			this._state = state;
		} catch {
			this._state = { allowed: {}, registrations: {} };
		}
	}

	dispose(): void {
		this._disposed = true;
		for (const requestId of [...this._pending.keys()]) {
			this._settle(requestId, { closed: true });
		}
		this._ports.clear();
	}

	/** 利用者がその場所で「ユーザースクリプトを許可」したか。 */
	isAllowed(place: string, extensionId: string): boolean {
		return (this._state.allowed[place] ?? []).includes(extensionId);
	}

	/** 「ユーザースクリプトを許可」した場所。 */
	allowedPlaces(extensionId: string): string[] {
		return Object.entries(this._state.allowed).filter(([, ids]) => ids.includes(extensionId)).map(([place]) => place);
	}

	/** 「ユーザースクリプトを許可」を切り替える（管理画面から）。その場所の拡張機能の文脈へ知らせる。 */
	async setAllowed(place: string, extensionId: string, allowed: boolean): Promise<void> {
		const list = (this._state.allowed[place] ?? []).filter(id => id !== extensionId);
		if (allowed) {
			list.push(extensionId);
		}
		this._state.allowed[place] = list;
		await this._save();
		if (!allowed) {
			this._closeFor(port => port.extensionId === extensionId && this._environment.placeOfSession(port.session) === place, NO_RECEIVER);
		}
		this._host.emitToPlace(place, extensionId, PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onAllowedChanged', [allowed]);
	}

	/** 拡張機能を外した: 許可と登録を忘れる。 */
	async forgetExtension(extensionId: string): Promise<void> {
		for (const place of Object.keys(this._state.allowed)) {
			this._state.allowed[place] = this._state.allowed[place].filter(id => id !== extensionId);
		}
		for (const place of Object.keys(this._state.registrations)) {
			delete this._state.registrations[place][extensionId];
		}
		this._closeFor(port => port.extensionId === extensionId, NO_RECEIVER);
		await this._save();
	}

	/** これから作られるすべての WebContents に受け手を立てる（同期の問いは受け手が無いと renderer が止まる）。 */
	listen(): void {
		const app = electron.app;
		if (!app) {
			return;
		}
		app.on('web-contents-created', (_event, contents) => this.attach(contents));
		for (const contents of electron.webContents?.getAllWebContents() ?? []) {
			this.attach(contents);
		}
	}

	/** 1 つの WebContents に受け手を立てる（テストからも呼ぶ）。 */
	attach(contents: WebContents): void {
		if (this._attached.has(contents)) {
			return;
		}
		this._attached.add(contents);
		contents.ipc.on(PARADIS_USER_SCRIPTS_QUERY, event => {
			event.returnValue = this._disposed ? undefined : this.answer(contents, event.senderFrame);
		});
		contents.ipc.on(PARADIS_USER_SCRIPTS_RECHECK, event => {
			event.returnValue = !this._disposed && this._frameContext(contents, event.senderFrame) !== undefined;
		});
		contents.ipc.handle(PARADIS_USER_SCRIPTS_CALL, (event, request: unknown) => this.handleCall(contents, event.senderFrame, request));
		// 文書が替わったフレーム・閉じたタブのポートは切る
		contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
			this._closeFor(port => port.contents === contents && (isMainFrame || (port.processId === processId && port.routingId === routingId)), undefined, false);
		});
		contents.once('destroyed', () => this._closeFor(port => port.contents === contents, undefined, false));
	}

	/** そのフレームが、ユーザースクリプトを入れてよいものなら、その場所と URL。 */
	private _frameContext(contents: WebContents, frame: FrameLike | null | undefined): IFrameContext | undefined {
		try {
			if (!frame || frame.isDestroyed?.() || contents.isDestroyed()) {
				return undefined;
			}
			const url = frame.url;
			if (!paradisIsUserScriptTargetUrl(url)) {
				return undefined;
			}
			const place = this._environment.placeOfSession(contents.session);
			// 利用者のタブだけ（エージェントのタブ・まだエージェントのものか分からない新しいタブ・拡張機能の窓は除く）。
			// エージェントと共有中のタブにも入れない
			if (place === undefined || !this._environment.isUserTab(contents) || paradisIsExtensionPageHeld(contents)) {
				return undefined;
			}
			return { place, url, origin: new URL(url).origin, top: frame.parent === null };
		} catch {
			return undefined;
		}
	}

	private _activeExtension(session: unknown, place: string, extensionId: string): ILoadedExtension | undefined {
		if (!this.isAllowed(place, extensionId) || !this._environment.isEnabledIn(place, extensionId)) {
			return undefined;
		}
		const extension = (session as ExtensionSession).extensions.getExtension(extensionId);
		return extension && this._environment.hasPermission(place, extension) ? extension : undefined;
	}

	private _worldNumber(extensionId: string, worldId: string | undefined, origin: string): number | undefined {
		const key = `${extensionId}\u0000${worldId ?? ''}\u0000${origin}`;
		let number = this._worldNumbers.get(key);
		if (number === undefined) {
			if (this._nextWorldNumber > LAST_WORLD_NUMBER) {
				return undefined;
			}
			number = this._nextWorldNumber++;
			this._worldNumbers.set(key, number);
		}
		return number;
	}

	/** 拡張機能のフォルダの中のファイルのパス（外を指すものは undefined）。 */
	private _filePath(root: string, file: string): string | undefined {
		if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..')) {
			return undefined;
		}
		const base = normalize(root);
		const path = normalize(join(base, file));
		return path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) ? path : undefined;
	}

	/**
	 * その拡張機能の登録が使う js の file を読んでおく（拡張機能を読み込んだとき・登録が変わったとき）。読み込み直すと中身が
	 * 変わりうるので、毎回読み直す。
	 */
	async warm(extensionId: string, root: string): Promise<void> {
		const files = new Set<string>();
		for (const byExtension of Object.values(this._state.registrations)) {
			for (const script of byExtension[extensionId]?.scripts ?? []) {
				for (const source of script.js) {
					if (source.file !== undefined) {
						files.add(source.file);
					}
				}
			}
		}
		await Promise.all([...files].map(async file => {
			const path = this._filePath(root, file);
			const key = `${root}\u0000${file}`;
			if (!path) {
				this._files.delete(key);
				return;
			}
			try {
				this._files.set(key, await fs.readFile(path, 'utf8'));
			} catch {
				this._files.delete(key);
			}
		}));
	}

	/** 読んでおいた js の file（まだなら読み始め、今回は入れない）。 */
	private _readFile(extensionId: string, root: string, file: string): string | undefined {
		const key = `${root}\u0000${file}`;
		const text = this._files.get(key);
		if (text === undefined && !this._warming.has(key)) {
			this._warming.add(key);
			void this.warm(extensionId, root).finally(() => this._warming.delete(key));
		}
		return text;
	}

	/** preload の問いへの答え（そのフレームで動かすもの）。 */
	answer(contents: WebContents, frame: FrameLike | null | undefined): unknown {
		const context = this._frameContext(contents, frame);
		if (!context) {
			return undefined;
		}
		const worlds = new Map<number, Record<string, unknown>>();
		const scripts: Record<string, unknown>[] = [];
		for (const [extensionId, registrations] of Object.entries(this._state.registrations[context.place] ?? {})) {
			const extension = this._activeExtension(contents.session, context.place, extensionId);
			if (!extension) {
				continue;
			}
			for (const script of registrations.scripts) {
				if (!paradisUserScriptApplies(script, context.url, context.top, paradisMatchesUrlPattern)) {
					continue;
				}
				let world: number | 'MAIN' = 'MAIN';
				if (script.world === 'USER_SCRIPT') {
					const number = this._worldNumber(extensionId, script.worldId, context.origin);
					if (number === undefined) {
						continue;
					}
					world = number;
					const config = paradisEffectiveUserScriptWorld(registrations.worlds, script.worldId);
					worlds.set(number, { world: number, extensionId, ...(script.worldId !== undefined ? { worldId: script.worldId } : {}), csp: config.csp, messaging: config.messaging, name: `${extension.name} (user scripts)` });
				}
				script.js.forEach((source, index) => {
					const code = source.code ?? (source.file !== undefined ? this._readFile(extensionId, extension.path, source.file) : undefined);
					if (code !== undefined) {
						const url = source.file !== undefined ? `chrome-extension://${extensionId}/${source.file.replace(/^\/+/, '')}` : `chrome-extension://${extensionId}/__user_script__/${encodeURIComponent(script.id)}/${index}`;
						scripts.push({ runAt: script.runAt, world, code, url });
					}
				});
			}
		}
		return scripts.length > 0 ? { worlds: [...worlds.values()], scripts } : undefined;
	}

	/**
	 * world からの呼び出しの送り主を確かめる。そのフレームに入れてよく、拡張機能が許されて有効で、その world の登録が
	 * このフレームに当たり、world の番号が合い、messaging を許した world のときだけ。
	 */
	private _caller(contents: WebContents, frame: FrameLike | null | undefined, request: Record<string, unknown>): { readonly context: IFrameContext; readonly extension: ILoadedExtension; readonly world: number; readonly worldId: string | undefined } | undefined {
		const context = this._frameContext(contents, frame);
		const extensionId = request.extensionId;
		const worldId = request.worldId;
		if (!context || !frame || typeof extensionId !== 'string' || (worldId !== undefined && typeof worldId !== 'string') || typeof request.world !== 'number') {
			return undefined;
		}
		const extension = this._activeExtension(contents.session, context.place, extensionId);
		const registrations = this._state.registrations[context.place]?.[extensionId];
		if (!extension || !registrations) {
			return undefined;
		}
		const applies = registrations.scripts.some(script => script.world === 'USER_SCRIPT' && script.worldId === worldId && paradisUserScriptApplies(script, context.url, context.top, paradisMatchesUrlPattern));
		if (!applies || this._worldNumbers.get(`${extensionId}\u0000${worldId ?? ''}\u0000${context.origin}`) !== request.world || !paradisEffectiveUserScriptWorld(registrations.worlds, worldId).messaging) {
			return undefined;
		}
		return { context, extension, world: request.world, worldId };
	}

	private _sender(contents: WebContents, frame: FrameLike, extension: ILoadedExtension, context: IFrameContext, worldId: string | undefined): Record<string, unknown> {
		const tab = this._environment.describeTab(extension, contents);
		return {
			id: extension.id,
			url: context.url,
			origin: context.origin,
			frameId: paradisChromeFrameId(frame as WebFrameMain),
			...(tab ? { tab } : {}),
			...(worldId !== undefined ? { userScriptWorldId: worldId } : {}),
		};
	}

	/** world からの 1 回の呼び出し（sendMessage・connect・ポート）。 */
	async handleCall(contents: WebContents, frame: FrameLike | null | undefined, request: unknown): Promise<unknown> {
		if (this._disposed || !isRecord(request) || !frame) {
			return { error: NO_RECEIVER };
		}
		const caller = this._caller(contents, frame, request);
		if (!caller) {
			// 共有が始まった・エージェントのタブと分かった・許可を外したフレームのポートは切る
			if (typeof request.portId === 'string' && this._ports.get(request.portId)?.contents === contents) {
				this._closePort(request.portId, NO_RECEIVER, true);
			}
			return { error: NO_RECEIVER };
		}
		const session = contents.session as unknown as ParadisApiSession;
		const extensionId = caller.extension.id;
		const emit = (args: unknown[]) => this._host.emitToWorkerWhenListening(session, extensionId, PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', args);
		switch (request.op) {
			case 'sendMessage': {
				const length = serializedLength(request.message);
				if (length === undefined || length > MAX_MESSAGE_CHARS) {
					return { error: 'Message length exceeded maximum allowed length.' };
				}
				if (this._pending.size >= MAX_PENDING_MESSAGES) {
					return { error: NO_RECEIVER };
				}
				const requestId = randomUUID();
				const reply = new Promise<{ readonly value?: unknown; readonly error?: string; readonly closed?: boolean }>(resolve => {
					const timer = setTimeout(() => this._settle(requestId, { closed: true }), RESPONSE_TIMEOUT_MS);
					this._pending.set(requestId, { session, extensionId, resolve, timer });
				});
				emit(['message', requestId, request.message ?? null, this._sender(contents, frame, caller.extension, caller.context, caller.worldId)]);
				return reply;
			}
			case 'connect': {
				const portId = request.portId;
				if (typeof portId !== 'string' || portId.length === 0 || portId.length > 100 || this._ports.has(portId) || this._ports.size >= MAX_PORTS) {
					return { error: NO_RECEIVER };
				}
				const name = typeof request.name === 'string' ? request.name.slice(0, 1_000) : '';
				this._ports.set(portId, { session, extensionId, contents, processId: frame.processId, routingId: frame.routingId, world: caller.world });
				emit(['connect', portId, name, this._sender(contents, frame, caller.extension, caller.context, caller.worldId)]);
				return {};
			}
			case 'postMessage': {
				const port = typeof request.portId === 'string' ? this._ports.get(request.portId) : undefined;
				if (!port || port.contents !== contents || port.processId !== frame.processId || port.routingId !== frame.routingId || port.extensionId !== extensionId) {
					return { error: NO_RECEIVER };
				}
				const length = serializedLength(request.message);
				if (length === undefined || length > MAX_MESSAGE_CHARS) {
					return { error: 'Message length exceeded maximum allowed length.' };
				}
				emit(['portMessage', request.portId, request.message ?? null]);
				return {};
			}
			case 'disconnect': {
				const port = typeof request.portId === 'string' ? this._ports.get(request.portId) : undefined;
				if (port && port.contents === contents && port.processId === frame.processId && port.routingId === frame.routingId) {
					this._ports.delete(request.portId as string);
					emit(['portDisconnect', request.portId]);
				}
				return {};
			}
		}
		return { error: NO_RECEIVER };
	}

	private _settle(requestId: string, reply: { readonly value?: unknown; readonly error?: string; readonly closed?: boolean }): void {
		const pending = this._pending.get(requestId);
		if (!pending) {
			return;
		}
		this._pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(reply);
	}

	/** ポートを切る。`toWorker` なら worker へ、`toFrame` ならフレームへも知らせる。 */
	private _closePort(portId: string, error: string | undefined, toWorker: boolean, toFrame = true): void {
		const port = this._ports.get(portId);
		if (!port) {
			return;
		}
		this._ports.delete(portId);
		if (toWorker) {
			this._host.emitToWorkerWhenListening(port.session as ParadisApiSession, port.extensionId, PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, 'onUserScriptEvent', ['portDisconnect', portId]);
		}
		if (toFrame) {
			this._frameOf(port)?.send?.(PARADIS_USER_SCRIPTS_EVENT, { world: port.world, kind: 'disconnect', portId, ...(error !== undefined ? { error } : {}) });
		}
	}

	/** 当てはまるポートを切る（フレームの側が終わったときは worker へだけ知らせる）。 */
	private _closeFor(matches: (port: IPort) => boolean, error: string | undefined, toFrame = true): void {
		for (const [portId, port] of [...this._ports]) {
			if (matches(port)) {
				this._closePort(portId, error, true, toFrame);
			}
		}
	}

	private _frameOf(port: IPort): FrameLike | undefined {
		try {
			const frame = electron.webFrameMain?.fromId(port.processId, port.routingId);
			return frame && !frame.isDestroyed() ? frame : undefined;
		} catch {
			return undefined;
		}
	}

	/** worker からポートへ: フレームがまだ入れてよいものか確かめてから届ける。 */
	private _toPort(caller: IParadisExtensionApiCaller, portId: string, kind: 'message' | 'disconnect', message?: unknown): void {
		const port = this._ports.get(portId);
		if (!port || port.session !== caller.session || port.extensionId !== caller.extension.id) {
			return;
		}
		const frame = this._frameOf(port);
		const context = frame ? this._frameContext(port.contents, frame) : undefined;
		if (!frame || !context || !this._activeExtension(port.contents.session, context.place, port.extensionId)) {
			this._closePort(portId, NO_RECEIVER, true);
			return;
		}
		if (kind === 'disconnect') {
			this._ports.delete(portId);
			frame.send?.(PARADIS_USER_SCRIPTS_EVENT, { world: port.world, kind: 'disconnect', portId, ...(typeof message === 'string' ? { error: message } : {}) });
			return;
		}
		frame.send?.(PARADIS_USER_SCRIPTS_EVENT, { world: port.world, kind: 'message', portId, message });
	}

	private _registrations(caller: IParadisExtensionApiCaller): IParadisUserScriptRegistrations {
		return this._state.registrations[caller.place]?.[caller.extension.id] ?? { scripts: [], worlds: [] };
	}

	private async _setRegistrations(caller: IParadisExtensionApiCaller, next: IParadisUserScriptRegistrations): Promise<void> {
		const byExtension = this._state.registrations[caller.place] ?? {};
		byExtension[caller.extension.id] = next;
		this._state.registrations[caller.place] = byExtension;
		await this._save();
	}

	/** 利用者が許していなければ断る（詰め物は chrome.userScripts を出さないが、main でも確かめる）。 */
	private _requireAllowed(caller: IParadisExtensionApiCaller): void {
		if (!this.isAllowed(caller.place, caller.extension.id)) {
			throw new ParadisExtensionApiError('The userScripts API is only available when "Allow User Scripts" is turned on for this extension in Para Code.');
		}
	}

	private _register(): void {
		const run = async <T>(caller: IParadisExtensionApiCaller, change: (current: IParadisUserScriptRegistrations) => { readonly next?: IParadisUserScriptRegistrations; readonly value: T }): Promise<T> => {
			this._requireAllowed(caller);
			let result: { readonly next?: IParadisUserScriptRegistrations; readonly value: T };
			try {
				result = change(this._registrations(caller));
			} catch (error) {
				throw error instanceof ParadisUserScriptsError ? new ParadisExtensionApiError(error.message) : error;
			}
			if (result.next) {
				await this._setRegistrations(caller, result.next);
				const loaded = (caller.session as ExtensionSession).extensions.getExtension(caller.extension.id);
				if (loaded) {
					await this.warm(caller.extension.id, loaded.path);
				}
			}
			return result.value;
		};
		const one = (args: readonly unknown[]) => args.length === 1 ? [args[0]] as [unknown] : undefined;
		const optional = (args: readonly unknown[]) => args.length <= 1 ? [args[0]] as [unknown] : undefined;
		const copy = (script: IParadisRegisteredUserScript) => JSON.parse(JSON.stringify(script)) as IParadisRegisteredUserScript;
		this._host.registerNamespace(PARADIS_SHIM_USER_SCRIPTS_NAMESPACE, {
			permission: 'userScripts',
			methods: {
				state: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => ({ allowed: this.isAllowed(caller.place, caller.extension.id) })),
				register: paradisDefineExtensionMethod(one, (caller, scripts) => run(caller, current => ({ next: { ...current, scripts: paradisRegisterUserScripts(current.scripts, scripts) }, value: undefined }))),
				update: paradisDefineExtensionMethod(one, (caller, scripts) => run(caller, current => ({ next: { ...current, scripts: paradisUpdateUserScripts(current.scripts, scripts) }, value: undefined }))),
				unregister: paradisDefineExtensionMethod(optional, (caller, filter) => run(caller, current => {
					const ids = paradisUserScriptFilterIds(filter);
					const missing = ids ? [...ids].find(id => !current.scripts.some(script => script.id === id)) : undefined;
					if (missing !== undefined) {
						throw new ParadisUserScriptsError(`Nonexistent script ID '${missing}'`);
					}
					return { next: { ...current, scripts: ids ? current.scripts.filter(script => !ids.has(script.id)) : [] }, value: undefined };
				})),
				getScripts: paradisDefineExtensionMethod(optional, (caller, filter) => run(caller, current => {
					const ids = paradisUserScriptFilterIds(filter);
					return { value: current.scripts.filter(script => !ids || ids.has(script.id)).map(copy) };
				})),
				configureWorld: paradisDefineExtensionMethod(one, (caller, config) => run(caller, current => ({ next: { ...current, worlds: paradisConfigureUserScriptWorld(current.worlds, config) }, value: undefined }))),
				getWorldConfigurations: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => run(caller, current => ({ value: current.worlds.map(world => ({ ...world })) }))),
				resetWorldConfiguration: paradisDefineExtensionMethod(optional, (caller, worldId) => run(caller, current => {
					if (worldId !== undefined && typeof worldId !== 'string') {
						throw new ParadisUserScriptsError('Invalid arguments');
					}
					return { next: { ...current, worlds: current.worlds.filter((world: IParadisUserScriptWorldConfig) => world.worldId !== worldId) }, value: undefined };
				})),
				// worker・拡張機能のページから: メッセージの返事、ポートへのメッセージ、ポートを切る
				respond: paradisDefineExtensionMethod(args => args.length === 2 && typeof args[0] === 'string' && isRecord(args[1]) ? [args[0], args[1]] as [string, Record<string, unknown>] : undefined, (caller, requestId, reply) => {
					const pending = this._pending.get(requestId);
					if (!pending || pending.session !== caller.session || pending.extensionId !== caller.extension.id) {
						return;
					}
					const length = serializedLength(reply.value);
					if (length === undefined || length > MAX_MESSAGE_CHARS) {
						this._settle(requestId, { error: 'Message length exceeded maximum allowed length.' });
						return;
					}
					this._settle(requestId, typeof reply.error === 'string' ? { error: reply.error } : reply.closed === true ? { closed: true } : { value: reply.value });
				}),
				portPost: paradisDefineExtensionMethod(args => args.length === 2 && typeof args[0] === 'string' ? [args[0], args[1]] as [string, unknown] : undefined, (caller, portId, message) => {
					const length = serializedLength(message);
					if (length === undefined || length > MAX_MESSAGE_CHARS) {
						throw new ParadisExtensionApiError('Message length exceeded maximum allowed length.');
					}
					this._toPort(caller, portId, 'message', message ?? null);
				}),
				portDisconnect: paradisDefineExtensionMethod(args => (args.length === 1 || args.length === 2) && typeof args[0] === 'string' && (args[1] === undefined || typeof args[1] === 'string') ? [args[0], args[1]] as [string, string | undefined] : undefined, (caller, portId, error) => this._toPort(caller, portId, 'disconnect', error)),
			},
			events: ['onAllowedChanged', 'onUserScriptEvent'],
		});
	}

	private _save(): Promise<void> {
		const state = JSON.stringify(this._state);
		this._saving = this._saving.then(async () => {
			await fs.mkdir(dirname(this._path), { recursive: true });
			await fs.writeFile(`${this._path}.tmp`, state);
			await fs.rename(`${this._path}.tmp`, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension user scripts', error));
		return this._saving;
	}
}

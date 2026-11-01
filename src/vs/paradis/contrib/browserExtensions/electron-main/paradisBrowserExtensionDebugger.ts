/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.debugger（Q529）。利用者が管理画面で「デバッガーの接続を許可」をオンにした拡張機能（場所ごと。既定はオフ）だけが、
// 利用者のタブへ CDP でつなげる。
//
// 前提: つなぐ先の webContents.debugger は Electron の信頼済みのクライアントで、Chrome が拡張機能の debugger にかける制限
// （ファイル・ほかのタブ・ブラウザ全体へ届く命令の制限、ほかの拡張機能の world を隠すこと）は 1 つも効かない。そこで Para Code が
// 次のように絞る。
//  - つなぐのはタブの BrowserView の debugger の、そのタブのページだけの CDP セッション（Target.attachToTarget）
//  - 送れる命令は許可リスト（ALLOWED_METHODS）だけ。Claude 1.0.104 が実際に使うものから決めた。引数も確かめる
//  - 届けるイベントも許可リスト（ALLOWED_EVENTS）だけで、ページ本体の world（auxData.isDefault）とページ本体の frame の分に絞る。
//    同じタブには Para Code の preload の world と、ほかの拡張機能の content script の world・iframe がある（Linux の Electron 43 で、
//    拡張機能のセッションから見えて evaluate できることを確かめた）
//  - エージェントのタブと、エージェントと共有中のタブには、設定（allowWhileShared）がオンでもつながせない（Q530）。
//    つないでいる途中で共有が始まった・エージェントのタブだと分かったら外す
//  - そのタブの URL へのサイトの権限（または activeTab）が要る。権限の外・ストア・ほかの拡張機能のページへ移り始めたら、移る前に外す
//  - つないでいる間は worker を止めない（Chrome と同じ）

import type { WebContents } from 'electron';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ICDPConnection } from '../../../../platform/browserView/common/cdp/types.js';
import { paradisIsExtensionPageHeld, paradisOnDidChangeExtensionPageHold } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { paradisIsChromeWebStoreUrl } from '../common/paradisBrowserExtensionWebStore.js';
import { IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { IParadisTabView, ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';

/** chrome.debugger に要る main の口。 */
export interface IParadisDebuggerEnvironment {
	/** その拡張機能に、この場所で「デバッガーの接続を許可」しているか。 */
	isAllowed(extensionId: string, place: string): boolean;
	/** タブのページへの CDP セッションを開く（タブの BrowserView の debugger）。 */
	attach(viewId: string): Promise<ICDPConnection>;
}

interface IAttachment {
	readonly tabId: number;
	readonly extensionId: string;
	readonly session: ParadisApiSession;
	readonly place: string;
	readonly contents: WebContents;
	readonly connection: ICDPConnection;
	readonly disposables: DisposableStore;
	/** ページ本体の frame の id（ページの target の id と同じ）。 */
	readonly mainFrameId: string;
	/** ページ本体の world の id。 */
	readonly pageContexts: Set<number>;
	/** 届けたリクエストの id（応答と失敗は、これだけ届ける）。 */
	readonly requests: Set<string>;
	/** その URL を拡張機能に見せてよいか（http(s) で、サイトの権限の内側）。 */
	canUseUrl(url: string): boolean;
}

/**
 * 送ってよい命令（Claude 1.0.104 が使うものから、要るだけ）。値は引数を確かめて、送る形に直す関数（断るときは投げる）。
 * Emulation.setFocusEmulationEnabled は Claude が使うが、ページのセッションからでも Para Code の端末の設定に効くので入れない。
 */
const ALLOWED_METHODS: Readonly<Record<string, (params: Record<string, unknown>, attachment: IAttachment) => Record<string, unknown>>> = {
	'Page.enable': () => ({}),
	'Page.getFrameTree': () => ({}),
	'Page.captureScreenshot': params => params,
	'Page.handleJavaScriptDialog': params => params,
	'Runtime.enable': () => ({}),
	// ページ本体の world だけ（world を指す引数は受けない）。コンソールの道具（copy() はクリップボードへ書く）も渡さない
	'Runtime.evaluate': params => {
		if (params.contextId !== undefined || params.uniqueContextId !== undefined || params.includeCommandLineAPI === true) {
			throw new ParadisExtensionApiError('Para Code lets extensions use only the page\'s own execution context');
		}
		return params;
	},
	'Network.enable': () => ({}),
	'Network.disable': () => ({}),
	'Input.dispatchMouseEvent': params => params,
	// 編集の命令（commands。貼り付けはクリップボードを読む）は渡さない
	'Input.dispatchKeyEvent': ({ commands: _commands, ...params }) => params,
	'Input.insertText': params => params,
	'Input.cancelDragging': () => ({}),
};

/** 届けてよいイベント。値は、ページ本体の world・frame の分か（届けないなら false）。 */
const ALLOWED_EVENTS: Readonly<Record<string, (params: Record<string, unknown>, attachment: IAttachment) => boolean>> = {
	'Page.frameNavigated': (params, attachment) => isRecord(params.frame) && params.frame.id === attachment.mainFrameId && params.frame.parentId === undefined,
	'Page.javascriptDialogOpening': (params, attachment) => params.frameId === undefined || params.frameId === attachment.mainFrameId,
	'Page.javascriptDialogClosed': (params, attachment) => params.frameId === undefined || params.frameId === attachment.mainFrameId,
	'Runtime.consoleAPICalled': (params, attachment) => attachment.pageContexts.has(params.executionContextId as number),
	'Runtime.exceptionThrown': (params, attachment) => isRecord(params.exceptionDetails) && attachment.pageContexts.has(params.exceptionDetails.executionContextId as number),
	// ページ本体の frame のリクエストで、拡張機能が読めるサイトのものだけ。応答と失敗は、届けたリクエストのものだけ
	'Network.requestWillBeSent': (params, attachment) => {
		const url = isRecord(params.request) ? params.request.url : undefined;
		const shown = params.frameId === attachment.mainFrameId && typeof url === 'string' && attachment.canUseUrl(url);
		if (shown) {
			attachment.requests.add(params.requestId as string);
		}
		return shown;
	},
	'Network.responseReceived': (params, attachment) => attachment.requests.has(params.requestId as string),
	'Network.loadingFailed': (params, attachment) => {
		const shown = attachment.requests.delete(params.requestId as string);
		return shown;
	},
};

/** 送った命令の答えを、拡張機能に見せる形にする（Page.getFrameTree はページ本体の frame だけ。iframe の URL を見せない）。 */
function answerFor(method: string, result: unknown): unknown {
	if (method === 'Page.getFrameTree' && isRecord(result) && isRecord(result.frameTree)) {
		return { frameTree: { frame: result.frameTree.frame } };
	}
	return result;
}

/** ページ本体の world を覚える（Runtime.executionContextCreated の auxData.isDefault のもの）。イベントは届けない。 */
function notePageContexts(method: string, params: Record<string, unknown>, attachment: IAttachment): void {
	if (method === 'Runtime.executionContextCreated' && isRecord(params.context) && isRecord(params.context.auxData) && params.context.auxData.isDefault === true && params.context.auxData.frameId === attachment.mainFrameId) {
		attachment.pageContexts.add(params.context.id as number);
	} else if (method === 'Runtime.executionContextDestroyed') {
		attachment.pageContexts.delete(params.executionContextId as number);
	} else if (method === 'Runtime.executionContextsCleared') {
		attachment.pageContexts.clear();
	}
}

/** 拡張機能に開いてよい URL か（http(s) と about:blank で、サイトの権限の内側）。 */
function isPageUrl(url: string): boolean {
	return /^https?:/i.test(url) || url === 'about:blank' || url === '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ParadisBrowserExtensionDebugger implements IDisposable {

	private readonly _disposables = new DisposableStore();
	/** タブ（WebContents の id）→ つないでいる拡張機能（Chrome と同じく、1 つのタブには 1 つの拡張機能だけ）。 */
	private readonly _attachments = new Map<number, IAttachment>();

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _environment: IParadisDebuggerEnvironment,
	) {
		this._disposables.add(paradisOnDidChangeExtensionPageHold((contents, isHeld) => {
			if (isHeld) {
				this._detachWhere(attachment => attachment.contents === contents, 'canceled_by_user');
			}
		}));
		this._disposables.add(_tabs.onDidBecomeAgentTab(contents => this._detachWhere(attachment => attachment.contents === contents, 'canceled_by_user')));
		// 拡張機能を外した
		this._disposables.add(_host.onDidCloseContext((session, extensionId, connection) => {
			if (connection === undefined) {
				this._detachWhere(attachment => attachment.session === session && attachment.extensionId === extensionId, undefined);
			}
		}));
		this._register();
	}

	dispose(): void {
		this._detachWhere(() => true, undefined);
		this._disposables.dispose();
	}

	/** 「デバッガーの接続を許可」をオフにした: その場所でつないでいるものを外す。 */
	revoke(extensionId: string, place: string): void {
		this._detachWhere(attachment => attachment.extensionId === extensionId && attachment.place === place, 'canceled_by_user');
	}

	/** 当てはまるものを外す。`reason` があれば拡張機能へ onDetach で知らせる（自分で外したときは知らせない。Chrome と同じ）。 */
	private _detachWhere(predicate: (attachment: IAttachment) => boolean, reason: string | undefined): void {
		for (const attachment of [...this._attachments.values()]) {
			if (predicate(attachment)) {
				this._detach(attachment, reason);
			}
		}
	}

	private _detach(attachment: IAttachment, reason: string | undefined): void {
		if (this._attachments.get(attachment.tabId) !== attachment) {
			return;
		}
		this._attachments.delete(attachment.tabId);
		attachment.disposables.dispose();
		attachment.connection.dispose();
		if (reason !== undefined) {
			this._host.emit({ session: attachment.session, extensionId: attachment.extensionId }, 'debugger', 'onDetach', [{ tabId: attachment.tabId }, reason]);
		}
	}

	/** つないでよいタブか（だめなら理由を投げる）。 */
	private _requireAttachable(caller: IParadisExtensionApiCaller, tabId: number): IParadisTabView {
		if (!this._environment.isAllowed(caller.extension.id, caller.place)) {
			throw new ParadisExtensionApiError('Para Code lets this extension attach a debugger only after "Allow Debugger Access" is turned on in the extension manager');
		}
		// 利用者のタブだけ（エージェントのタブ・拡張機能の窓は見えない）
		const view = this._tabs.userViewOf(caller, tabId);
		if (!view) {
			throw new ParadisExtensionApiError(`No tab with given id ${tabId}.`);
		}
		this._requirePage(caller, view.webContents);
		return view;
	}

	private _requirePage(caller: IParadisExtensionApiCaller, contents: WebContents): void {
		if (contents.isDestroyed() || paradisIsExtensionPageHeld(contents) || !this._tabs.isAnnouncedUserTab(contents)) {
			throw new ParadisExtensionApiError('Para Code does not let extensions attach a debugger to a tab that is shared with an agent');
		}
		const url = contents.getURL();
		if (paradisIsChromeWebStoreUrl(url)) {
			throw new ParadisExtensionApiError('The extensions gallery cannot be scripted.');
		}
		if (url.startsWith('chrome-extension://') && !url.startsWith(`chrome-extension://${caller.extension.id}/`)) {
			throw new ParadisExtensionApiError('Cannot access a chrome-extension:// URL of different extension');
		}
		if (!this._canUseUrl(caller, contents, url)) {
			throw new ParadisExtensionApiError(`Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`);
		}
	}

	/** つないだタブで、その URL を見せてよいか（http(s) はサイトの権限の内側だけ。about:blank と空のタブはよい）。 */
	private _canUseUrl(caller: IParadisExtensionApiCaller, contents: WebContents, url: string): boolean {
		return isPageUrl(url) && !paradisIsChromeWebStoreUrl(url) && (url === '' || url === 'about:blank' || this._tabs.hasHostAccess(caller, contents, url));
	}

	private async _attach(caller: IParadisExtensionApiCaller, tabId: number): Promise<void> {
		const view = this._requireAttachable(caller, tabId);
		if (this._attachments.has(tabId)) {
			throw new ParadisExtensionApiError(`Another debugger is already attached to the tab with id: ${tabId}.`);
		}
		const connection = await this._environment.attach(view.id);
		// つないでいる間に、共有が始まった・別の拡張機能がつないだ・許可が外れたら、開いたものを閉じる
		try {
			this._requireAttachable(caller, tabId);
			if (this._attachments.has(tabId)) {
				throw new ParadisExtensionApiError(`Another debugger is already attached to the tab with id: ${tabId}.`);
			}
		} catch (error) {
			connection.dispose();
			throw error;
		}
		const contents = view.webContents;
		const disposables = new DisposableStore();
		// Chrome と同じく、つないでいる間は worker を止めない（外すとき disposables で離す。拡張機能を外した・タブを閉じたときも _detach を通る）
		const keepAlive = this._host.keepWorkerAlive(caller.session, caller.extension.id);
		if (keepAlive) {
			disposables.add(toDisposable(() => keepAlive.end()));
		}
		const attachment: IAttachment = {
			tabId, extensionId: caller.extension.id, session: caller.session, place: caller.place, contents, connection, disposables,
			mainFrameId: connection.targetId, pageContexts: new Set(), requests: new Set(),
			canUseUrl: url => this._canUseUrl(caller, contents, url),
		};
		this._attachments.set(tabId, attachment);
		const target = { session: caller.session, extensionId: caller.extension.id };
		disposables.add(connection.onEvent(event => {
			const params = isRecord(event.params) ? event.params : {};
			notePageContexts(event.method, params, attachment);
			const allowed = Object.prototype.hasOwnProperty.call(ALLOWED_EVENTS, event.method) ? ALLOWED_EVENTS[event.method] : undefined;
			if (allowed?.(params, attachment)) {
				this._host.emit(target, 'debugger', 'onEvent', [{ tabId }, event.method, event.params]);
			}
		}));
		disposables.add(connection.onClose(() => this._detach(attachment, 'target_closed')));
		disposables.add(view.onDidClose(() => this._detach(attachment, 'target_closed')));
		// 権限の外・ストア・ほかの拡張機能のページへ移り始めたら、移る前に外す（移った先の最初の文書とリクエストを見せない）
		const onStartNavigation = (details: { readonly url?: string; readonly isMainFrame?: boolean; readonly isSameDocument?: boolean }) => {
			if (details.isMainFrame !== false && details.isSameDocument !== true && typeof details.url === 'string' && !this._canUseUrl(caller, contents, details.url)) {
				this._detach(attachment, 'target_closed');
			}
		};
		// 移った後にも確かめる（共有が始まっていた・activeTab が切れたなど）
		const onNavigate = () => {
			try {
				this._requirePage(caller, contents);
			} catch {
				this._detach(attachment, 'target_closed');
			}
		};
		contents.on('did-start-navigation', onStartNavigation as never);
		contents.on('did-navigate', onNavigate);
		disposables.add(toDisposable(() => {
			if (!contents.isDestroyed()) {
				contents.off('did-start-navigation', onStartNavigation as never);
				contents.off('did-navigate', onNavigate);
			}
		}));
	}

	private _requireAttached(caller: IParadisExtensionApiCaller, tabId: number): IAttachment {
		const attachment = this._attachments.get(tabId);
		if (!attachment || attachment.extensionId !== caller.extension.id || attachment.session !== caller.session) {
			throw new ParadisExtensionApiError(`Debugger is not attached to the tab with id: ${tabId}.`);
		}
		return attachment;
	}

	private async _sendCommand(caller: IParadisExtensionApiCaller, tabId: number, method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
		const attachment = this._requireAttached(caller, tabId);
		const prepare = Object.prototype.hasOwnProperty.call(ALLOWED_METHODS, method) ? ALLOWED_METHODS[method] : undefined;
		if (!prepare) {
			throw new ParadisExtensionApiError(`Para Code does not let extensions use ${method}`);
		}
		const sent = prepare(params ?? {}, attachment);
		try {
			return answerFor(method, await attachment.connection.sendCommand(method, sent));
		} catch (error) {
			throw new ParadisExtensionApiError(error instanceof Error ? error.message : JSON.stringify(error));
		}
	}

	private _register(): void {
		const debuggee = (value: unknown): value is { tabId: number } => isRecord(value) && typeof value.tabId === 'number' && Number.isInteger(value.tabId) && value.tabId >= 0;
		const tabOf = (value: unknown): number => {
			if (!debuggee(value)) {
				throw new ParadisExtensionApiError('Para Code supports only a tab (tabId) as the debugger target');
			}
			return value.tabId;
		};
		this._host.registerNamespace('debugger', {
			permission: 'debugger',
			methods: {
				attach: paradisDefineExtensionMethod(args => args.length <= 2 && isRecord(args[0]) && (args[1] === undefined || typeof args[1] === 'string') ? [args[0]] as [Record<string, unknown>] : undefined, (caller, target) => this._attach(caller, tabOf(target))),
				detach: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, target) => {
					this._detach(this._requireAttached(caller, tabOf(target)), undefined);
				}),
				sendCommand: paradisDefineExtensionMethod(args => args.length <= 3 && isRecord(args[0]) && typeof args[1] === 'string' && (args[2] === undefined || args[2] === null || isRecord(args[2])) ? [args[0], args[1], args[2] ?? undefined] as [Record<string, unknown>, string, Record<string, unknown> | undefined] : undefined, (caller, target, method, params) => this._sendCommand(caller, tabOf(target), method, params)),
				// 見せるのは、つなげるかもしれない利用者のタブだけ（URL とタイトルは tabs と同じ決まりで）
				getTargets: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => this._tabs.visibleTabIds(caller).map(tabId => {
					const tab = this._tabs.describeTab(caller.extension, this._tabs.electronSessionOf(caller), tabId) ?? {};
					return { type: 'page', id: String(tabId), tabId, attached: this._attachments.has(tabId), title: typeof tab.title === 'string' ? tab.title : '', url: typeof tab.url === 'string' ? tab.url : '' };
				})),
			},
			events: ['onEvent', 'onDetach'],
		});
	}
}

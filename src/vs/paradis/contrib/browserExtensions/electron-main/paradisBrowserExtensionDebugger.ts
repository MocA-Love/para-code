/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.debugger（Q529）。利用者が管理画面で「デバッガーの接続を許可」をオンにした拡張機能（場所ごと。既定はオフ）だけが、
// 利用者のタブへ CDP でつなげる。
//  - つなぐのはタブの BrowserView の debugger の、そのタブのページだけの CDP セッション（Target.attachToTarget）。
//    ほかのタブ・Para Code の中身には届かない。Target・Browser など、ページの外へ届く domain の命令は断る
//  - エージェントのタブと、エージェントと共有中のタブには、設定（allowWhileShared）がオンでもつながせない（Q530）。
//    つないでいる途中で共有が始まった・エージェントのタブだと分かったら外す
//  - そのタブの URL へのサイトの権限（または activeTab）が要る。ストアと、ほかの拡張機能のページにはつながせない

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
}

/** ページの外（ほかのタブ・ブラウザ全体・パソコン）へ届く domain。拡張機能には送らせない。 */
const BLOCKED_DOMAINS = new Set(['Target', 'Browser', 'SystemInfo', 'Tethering', 'Storage', 'ServiceWorker', 'BackgroundService', 'Cast']);
/** ファイルを読み書きする命令（Chrome もファイルへの許可の無い拡張機能には断る）。 */
const BLOCKED_METHODS = new Set(['Page.setDownloadBehavior', 'DOM.setFileInputFiles', 'Page.addCompilationCache']);

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
		if (url !== '' && url !== 'about:blank' && !url.startsWith(`chrome-extension://${caller.extension.id}/`) && !this._tabs.hasHostAccess(caller, contents)) {
			throw new ParadisExtensionApiError(`Cannot access contents of url "${url}". Extension manifest must request permission to access this host.`);
		}
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
		const attachment: IAttachment = { tabId, extensionId: caller.extension.id, session: caller.session, place: caller.place, contents, connection, disposables };
		this._attachments.set(tabId, attachment);
		const target = { session: caller.session, extensionId: caller.extension.id };
		disposables.add(connection.onEvent(event => this._host.emit(target, 'debugger', 'onEvent', [{ tabId }, event.method, event.params])));
		disposables.add(connection.onClose(() => this._detach(attachment, 'target_closed')));
		disposables.add(view.onDidClose(() => this._detach(attachment, 'target_closed')));
		// 別のページへ移って、そのページにつなげなくなったら外す（ストア・ほかの拡張機能のページ・サイトの権限の外）
		const onNavigate = () => {
			try {
				this._requirePage(caller, contents);
			} catch {
				this._detach(attachment, 'target_closed');
			}
		};
		contents.on('did-navigate', onNavigate);
		disposables.add(toDisposable(() => {
			if (!contents.isDestroyed()) {
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
		const domain = method.split('.')[0];
		if (BLOCKED_DOMAINS.has(domain) || BLOCKED_METHODS.has(method)) {
			throw new ParadisExtensionApiError(`Para Code does not let extensions use ${method}`);
		}
		if (method === 'Page.navigate') {
			const url = typeof params?.url === 'string' ? params.url : '';
			if (!/^https?:/i.test(url) && url !== 'about:blank') {
				throw new ParadisExtensionApiError(`Cannot navigate to ${url}`);
			}
		}
		try {
			return await attachment.connection.sendCommand(method, params ?? {});
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

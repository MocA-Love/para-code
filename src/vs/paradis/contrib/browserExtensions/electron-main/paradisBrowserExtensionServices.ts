/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/api/notifications.ts, src/main/browser/extensions/api/cookies.ts, src/main/browser/extensions/api/downloads.ts, src/main/browser/extensions/api/downloads-save-as.ts, src/main/browser/extensions/api/management.ts

// chrome.notifications・chrome.cookies・chrome.downloads・chrome.management（P5c）。
//
// 利用者の秘密に関わるもの（cookies・downloads）は、P1〜P4 と同じく「呼び出し元と同じセッション（場所）のものだけ」:
//  - cookies は呼び出し元のセッションの cookie だけ。エージェントのタブ（Agent）・使い捨てのタブは別のセッション（in-memory）
//    なので見えない。ほかのプロファイル・ワークスペースのセッションも見えない。さらに、拡張機能がサイトの権限を持つ cookie
//    だけを渡す（Chrome と同じ）
//  - downloads は、その拡張機能が downloads.download で始めたものだけを知らせる（search・ほかのダウンロードの一覧は無い）。
//    エージェントのダウンロード・利用者のほかのダウンロードは見えない。始めるタブは、その場所の利用者のタブ（エージェントの
//    タブは選ばない）。保存先は Para Code のダウンロードの自動保存（paradisConfigureBrowserDownloads）のまま
//  - 同じセッションのエージェントのタブ（open_browser_profile で開いたもの）とは cookie を共有する。これは P4b の残り
//    （D3 A）と同じで、拡張機能はそのプロファイルのページをもともと読める
// management は、その場所の一覧と、ほかの拡張機能をその場所で有効・無効にすることだけ（Orca と同じ範囲。削除は無い）。
// 自分自身は切り替えられない。有効にするのは利用者の操作の中からだけ。

import type { Cookie, DownloadItem, Session, WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { basename, dirname, join, normalize, sep } from '../../../../base/common/path.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import type { IParadisLoadedExtension } from './paradisBrowserExtensionActions.js';
import { paradisMatchesUrlPattern, type ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';
import type { ParadisBrowserExtensionPermissions } from './paradisBrowserExtensionPermissions.js';

/** OS の通知（テストでは偽物）。 */
export interface IParadisExtensionNotification {
	on(event: 'click' | 'close' | 'failed', listener: () => void): void;
	on(event: 'action', listener: (index: number) => void): void;
	show(): void;
	close(): void;
	removeAllListeners(): void;
}

/** 通知の中身。 */
export interface IParadisExtensionNotificationOptions {
	readonly title: string;
	readonly body: string;
	readonly silent: boolean;
	readonly requireInteraction: boolean;
	/** 拡張機能の中の絵（絶対パス）。 */
	readonly iconPath?: string;
	readonly buttons: readonly string[];
}

/** その場所の、インストールした拡張機能 1 つ（management が見せるもの）。 */
export interface IParadisManagedExtension {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly source: 'unpacked';
	readonly enabled: boolean;
	readonly permissions: readonly string[];
	readonly hostPermissions: readonly string[];
}

/** これらに要る、main のほかの部分（拡張機能の管理が渡す）。 */
export interface IParadisServicesEnvironment {
	/** OS の通知を作る（通知が使えなければ undefined）。 */
	createNotification(options: IParadisExtensionNotificationOptions): IParadisExtensionNotification | undefined;
	/** 保存のダイアログ（取り消したら undefined）。 */
	chooseSavePath(owner: WebContents, defaultName: string): Promise<string | undefined>;
	/** その場所のインストールした拡張機能。 */
	listInstalled(place: string): readonly IParadisManagedExtension[];
	/** その場所で有効・無効にする。 */
	setEnabled(id: string, place: string, enabled: boolean): Promise<void>;
	/** 自動保存のフォルダの中で、ダウンロードの名前を替える（同じ名前があれば番号を付ける。will-download の中で同期に）。 */
	renameDownload(item: DownloadItem, directory: string, filename: string): void;
	/** そのセッションに今読み込んでいる拡張機能（manifest の description・icons に使う）。 */
	loadedIn(session: Session, id: string): IParadisLoadedExtension | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 拡張機能自身のページか（URL の origin は chrome-extension: では "null" になるので、スキームと host で比べる）。 */
function isPageOf(url: URL, extensionId: string): boolean {
	return url.protocol === 'chrome-extension:' && url.host === extensionId;
}

/** 通知の絵は拡張機能の中のものだけ（ウェブやほかの拡張機能のものは使わない）。 */
export function paradisNotificationIconPath(extension: Pick<IParadisLoadedExtension, 'id' | 'path'>, iconUrl: unknown): string | undefined {
	if (typeof iconUrl !== 'string' || iconUrl.length === 0) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(iconUrl, `chrome-extension://${extension.id}/`);
	} catch {
		return undefined;
	}
	if (!isPageOf(url, extension.id)) {
		return undefined;
	}
	let relative: string;
	try {
		relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
	} catch {
		return undefined;
	}
	const root = normalize(extension.path);
	const absolute = normalize(join(root, relative));
	return relative.length > 0 && !relative.includes('\0') && absolute.startsWith(root.endsWith(sep) ? root : root + sep) ? absolute : undefined;
}

/** cookie が送られる URL（サイトの権限の確かめに使う）。 */
export function paradisCookieUrl(cookie: Pick<Cookie, 'domain' | 'path' | 'secure'>): string {
	return `${cookie.secure ? 'https' : 'http'}://${(cookie.domain ?? '').replace(/^\./, '')}${cookie.path ?? '/'}`;
}

/** Chrome の形の cookie（ストアは 1 つで "0"）。 */
export function paradisChromeCookie(cookie: Cookie): Record<string, unknown> {
	return {
		name: cookie.name, value: cookie.value, domain: cookie.domain ?? '', hostOnly: cookie.hostOnly ?? false, path: cookie.path ?? '/',
		secure: cookie.secure ?? false, httpOnly: cookie.httpOnly ?? false, sameSite: cookie.sameSite, session: cookie.session ?? false,
		...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}), storeId: '0',
	};
}

/** downloads.download の filename: ダウンロードのフォルダからの相対で、親へ戻れない。 */
export function paradisDownloadFilename(raw: unknown): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw !== 'string' || raw.trim() === '' || /^([\\/]|[A-Za-z]:)/.test(raw) || raw.split(/[\\/]/).some(segment => segment === '..' || segment === '.') || raw.includes('\0')) {
		throw new ParadisExtensionApiError('Invalid filename');
	}
	return raw;
}

/** 自動保存のフォルダの隣の、拡張機能のダウンロードのフォルダ（「Paracode」なら「Paracode (extensions)」）。 */
export function paradisExtensionDownloadsFolder(autoSaveFolder: string): string {
	return join(dirname(autoSaveFolder), `${basename(autoSaveFolder)} (extensions)`);
}

/** Chrome の downloads.download が断るヘッダー（Fetch の forbidden request header と同じ）。 */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
	'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'access-control-request-private-network',
	'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer', 'set-cookie', 'te',
	'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via',
]);

/** downloads.download の headers。送ってはいけないヘッダー（Cookie・Origin・Host・Proxy-*・Sec-* など）は断る。 */
export function paradisDownloadHeaders(raw: unknown): Record<string, string> {
	if (raw === undefined) {
		return {};
	}
	if (!Array.isArray(raw) || raw.length > 100) {
		throw new ParadisExtensionApiError('Invalid headers');
	}
	const headers: Record<string, string> = {};
	for (const header of raw) {
		if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || /[\r\n\0]/.test(header.value)) {
			throw new ParadisExtensionApiError('Invalid headers');
		}
		const name = header.name.toLowerCase();
		if (FORBIDDEN_HEADERS.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) {
			throw new ParadisExtensionApiError(`Unsafe request header name: ${header.name}`);
		}
		headers[header.name] = header.value;
	}
	return headers;
}

const COOKIE_CAUSES: Readonly<Record<string, string>> = { explicit: 'explicit', overwrite: 'overwrite', expired: 'expired', evicted: 'evicted', 'expired-overwrite': 'expired_overwrite' };
const WILL_DOWNLOAD_TIMEOUT_MS = 15_000;

/** 文字のまま受ける鍵（cookies の引数）。 */
function optionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === 'string';
}

export class ParadisBrowserExtensionServices {

	private readonly _notifications = new WeakMap<object, Map<string, Map<string, { notification: IParadisExtensionNotification | undefined; options: Record<string, unknown> }>>>();
	private readonly _observedCookieSessions = new WeakSet<Session>();
	private _nextDownloadId = 1;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _permissions: ParadisBrowserExtensionPermissions,
		private readonly _environment: IParadisServicesEnvironment,
	) {
		this._registerNotifications();
		this._registerCookies();
		this._registerDownloads();
		this._registerManagement();
	}

	/** 拡張機能を外した（そのセッションの、その拡張機能の通知を閉じる）。 */
	forgetExtension(session: object, extensionId: string): void {
		const shown = this._notifications.get(session)?.get(extensionId);
		this._notifications.get(session)?.delete(extensionId);
		for (const entry of shown?.values() ?? []) {
			entry.notification?.removeAllListeners();
			entry.notification?.close();
		}
	}

	// --- notifications ---

	private _shown(caller: IParadisExtensionApiCaller) {
		let byExtension = this._notifications.get(caller.session);
		if (!byExtension) {
			byExtension = new Map();
			this._notifications.set(caller.session, byExtension);
		}
		let shown = byExtension.get(caller.extension.id);
		if (!shown) {
			shown = new Map();
			byExtension.set(caller.extension.id, shown);
		}
		return shown;
	}

	private _notificationEmit(caller: IParadisExtensionApiCaller, event: string, args: readonly unknown[]): void {
		this._host.emit({ session: caller.session, extensionId: caller.extension.id }, 'notifications', event, args);
	}

	private _show(caller: IParadisExtensionApiCaller, id: string, entry: { notification: IParadisExtensionNotification | undefined; options: Record<string, unknown> }): void {
		const { options } = entry;
		const loaded = this._environment.loadedIn(this._tabs.electronSessionOf(caller), caller.extension.id);
		const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
		const notification = this._environment.createNotification({
			title: text(options.title, 300),
			body: [text(options.message, 2_000), text(options.contextMessage, 300)].filter(Boolean).join('\n'),
			silent: options.silent === true,
			requireInteraction: options.requireInteraction === true,
			...(loaded ? { iconPath: paradisNotificationIconPath(loaded, options.iconUrl) } : {}),
			buttons: Array.isArray(options.buttons) ? options.buttons.slice(0, 2).map(button => isRecord(button) ? text(button.title, 100) : '') : [],
		});
		entry.notification = notification;
		if (!notification) {
			return;
		}
		notification.on('click', () => {
			this._shown(caller).delete(id);
			notification.removeAllListeners();
			// 利用者が押した（permissions.request などを、この後の少しの間だけ許す）
			this._permissions.noteUserGesture(caller.session, caller.extension.id);
			this._notificationEmit(caller, 'onClicked', [id]);
		});
		notification.on('action', index => {
			this._permissions.noteUserGesture(caller.session, caller.extension.id);
			this._notificationEmit(caller, 'onButtonClicked', [id, index]);
		});
		notification.on('close', () => {
			if (this._shown(caller).get(id) === entry) {
				this._shown(caller).delete(id);
				this._notificationEmit(caller, 'onClosed', [id, true]);
			}
		});
		notification.on('failed', () => {
			if (this._shown(caller).get(id) === entry) {
				this._shown(caller).delete(id);
			}
		});
		notification.show();
	}

	private _detach(entry: { notification: IParadisExtensionNotification | undefined }): void {
		const notification = entry.notification;
		entry.notification = undefined;
		notification?.removeAllListeners();
		notification?.close();
	}

	private _create(caller: IParadisExtensionApiCaller, requestedId: string, options: Record<string, unknown>): string {
		if (typeof options.type !== 'string' || !['basic', 'image', 'list', 'progress'].includes(options.type) || typeof options.title !== 'string' || typeof options.message !== 'string') {
			throw new ParadisExtensionApiError('Some of the required properties are missing: type, title and message.');
		}
		const id = requestedId || randomUUID();
		const shown = this._shown(caller);
		const previous = shown.get(id);
		if (previous) {
			this._detach(previous);
		}
		if (shown.size >= 100 && !previous) {
			throw new ParadisExtensionApiError('Too many notifications');
		}
		const entry = { notification: undefined, options };
		shown.set(id, entry);
		this._show(caller, id, entry);
		return id;
	}

	private _registerNotifications(): void {
		const idAndOptions = (args: readonly unknown[]): [string, Record<string, unknown>] | undefined => {
			if (args.length === 1 && isRecord(args[0])) {
				return ['', args[0]];
			}
			return args.length === 2 && typeof args[0] === 'string' && args[0].length <= 500 && isRecord(args[1]) ? [args[0], args[1]] : undefined;
		};
		const idOnly = (args: readonly unknown[]): [string] | undefined => args.length === 1 && typeof args[0] === 'string' ? [args[0]] : undefined;
		this._host.registerNamespace('notifications', {
			permission: 'notifications',
			methods: {
				create: paradisDefineExtensionMethod(idAndOptions, (caller, id, options) => this._create(caller, id, options)),
				update: paradisDefineExtensionMethod(args => args.length === 2 && typeof args[0] === 'string' && isRecord(args[1]) ? [args[0], args[1]] as [string, Record<string, unknown>] : undefined, (caller, id, options) => {
					const entry = this._shown(caller).get(id);
					if (!entry) {
						return false;
					}
					this._detach(entry);
					entry.options = { ...entry.options, ...options };
					this._show(caller, id, entry);
					return true;
				}),
				clear: paradisDefineExtensionMethod(idOnly, (caller, id) => {
					const shown = this._shown(caller);
					const entry = shown.get(id);
					if (!entry) {
						return false;
					}
					shown.delete(id);
					this._detach(entry);
					this._notificationEmit(caller, 'onClosed', [id, false]);
					return true;
				}),
				getAll: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => Object.fromEntries([...this._shown(caller).keys()].map(id => [id, true]))),
				getPermissionLevel: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => 'granted'),
			},
			events: ['onClicked', 'onButtonClicked', 'onClosed', 'onPermissionLevelChanged'],
		});
	}

	// --- cookies ---

	private _hostPatterns(caller: IParadisExtensionApiCaller): readonly string[] {
		return this._permissions.hostPatterns(caller.extension, caller.place);
	}

	private _requireHost(caller: IParadisExtensionApiCaller, url: string): void {
		if (!this._hostPatterns(caller).some(pattern => paradisMatchesUrlPattern(pattern, url))) {
			throw new ParadisExtensionApiError(`No host permissions for cookies at url: "${url}".`);
		}
	}

	private _checkStore(storeId: unknown): void {
		if (storeId !== undefined && storeId !== '0') {
			throw new ParadisExtensionApiError(`Invalid cookie store id: "${storeId}".`);
		}
	}

	private async _findCookie(session: Session, url: string, name: string): Promise<Record<string, unknown> | null> {
		const cookies = await session.cookies.get({ url, name });
		// Chrome はいちばん詳しい（パスの長い）ものを返す
		const best = cookies.sort((a, b) => (b.path ?? '').length - (a.path ?? '').length)[0];
		return best ? paradisChromeCookie(best) : null;
	}

	/**
	 * cookies.onChanged: そのサイトの権限を持つ拡張機能にだけ届ける。見張りは拡張機能を読み込むセッションを付けたときに立てる
	 * （受け手を付けたときから届くように）。
	 */
	observeCookies(session: Session, apiSession: object, place: string): void {
		if (this._observedCookieSessions.has(session)) {
			return;
		}
		this._observedCookieSessions.add(session);
		session.cookies.on('changed', (_event, cookie, cause, removed) => {
			const url = paradisCookieUrl(cookie);
			for (const extension of session.extensions.getAllExtensions() as unknown as IParadisApiExtension[]) {
				const permissions = Array.isArray(extension.manifest.permissions) ? extension.manifest.permissions : [];
				if ((permissions.includes('cookies') || this._permissions.granted(extension.id, place).permissions.includes('cookies')) && this._permissions.hostPatterns(extension, place).some(pattern => paradisMatchesUrlPattern(pattern, url))) {
					this._host.emit({ session: apiSession as IParadisExtensionApiCaller['session'], extensionId: extension.id }, 'cookies', 'onChanged', [{ removed, cookie: paradisChromeCookie(cookie), cause: COOKIE_CAUSES[cause] ?? 'explicit' }]);
				}
			}
		});
	}

	private _registerCookies(): void {
		const details = (required: readonly string[]) => (args: readonly unknown[]): [Record<string, unknown>] | undefined => {
			const [value] = args;
			return args.length === 1 && isRecord(value) && required.every(key => typeof value[key] === 'string') && optionalString(value, 'storeId') ? [value] : undefined;
		};
		this._host.registerNamespace('cookies', {
			permission: 'cookies',
			methods: {
				get: paradisDefineExtensionMethod(details(['url', 'name']), async (caller, value) => {
					this._checkStore(value.storeId);
					this._requireHost(caller, value.url as string);
					return this._findCookie(this._tabs.electronSessionOf(caller), value.url as string, value.name as string);
				}),
				getAll: paradisDefineExtensionMethod(details([]), async (caller, value) => {
					this._checkStore(value.storeId);
					const filter: Record<string, unknown> = {};
					for (const key of ['url', 'name', 'domain', 'path'] as const) {
						if (typeof value[key] === 'string') {
							filter[key] = value[key];
						}
					}
					for (const key of ['secure', 'session'] as const) {
						if (typeof value[key] === 'boolean') {
							filter[key] = value[key];
						}
					}
					const cookies = await this._tabs.electronSessionOf(caller).cookies.get(filter);
					const patterns = this._hostPatterns(caller);
					return cookies.filter(cookie => patterns.some(pattern => paradisMatchesUrlPattern(pattern, paradisCookieUrl(cookie)))).map(paradisChromeCookie);
				}),
				set: paradisDefineExtensionMethod(details(['url']), async (caller, value) => {
					this._checkStore(value.storeId);
					const url = value.url as string;
					this._requireHost(caller, url);
					const name = typeof value.name === 'string' ? value.name : '';
					const optional: Record<string, unknown> = {};
					for (const key of ['domain', 'path'] as const) {
						if (typeof value[key] === 'string') {
							optional[key] = value[key];
						}
					}
					for (const key of ['secure', 'httpOnly'] as const) {
						if (typeof value[key] === 'boolean') {
							optional[key] = value[key];
						}
					}
					if (typeof value.expirationDate === 'number' && Number.isFinite(value.expirationDate)) {
						optional.expirationDate = value.expirationDate;
					}
					if (typeof value.sameSite === 'string' && ['no_restriction', 'lax', 'strict', 'unspecified'].includes(value.sameSite)) {
						optional.sameSite = value.sameSite;
					}
					const session = this._tabs.electronSessionOf(caller);
					try {
						await session.cookies.set({ url, name, value: typeof value.value === 'string' ? value.value : '', ...optional });
					} catch (error) {
						throw new ParadisExtensionApiError(`Failed to parse or set cookie named "${name}". ${error instanceof Error ? error.message : ''}`.trim());
					}
					return this._findCookie(session, url, name);
				}),
				remove: paradisDefineExtensionMethod(details(['url', 'name']), async (caller, value) => {
					this._checkStore(value.storeId);
					this._requireHost(caller, value.url as string);
					await this._tabs.electronSessionOf(caller).cookies.remove(value.url as string, value.name as string);
					return { url: value.url, name: value.name, storeId: '0' };
				}),
				// タブは拡張機能に見せるタブだけ（エージェントのタブは入らない）
				getAllCookieStores: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => [{ id: '0', tabIds: this._tabs.visibleTabIds(caller) }]),
			},
			events: ['onChanged'],
		});
	}

	// --- downloads ---

	private _describeDownload(id: number, item: DownloadItem, extensionId: string): Record<string, unknown> {
		const state = item.getState();
		return {
			id, url: item.getURLChain()[0] ?? item.getURL(), finalUrl: item.getURL(), referrer: '', filename: item.getSavePath(), incognito: false, danger: 'safe',
			mime: item.getMimeType(), startTime: new Date(item.getStartTime() * 1000).toISOString(),
			state: state === 'completed' ? 'complete' : state === 'progressing' ? 'in_progress' : 'interrupted',
			paused: item.isPaused(), canResume: item.canResume(), bytesReceived: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), fileSize: item.getTotalBytes(), exists: true, byExtensionId: extensionId,
		};
	}

	private _downloadUrl(caller: IParadisExtensionApiCaller, raw: string): string {
		let url: URL;
		try {
			url = new URL(raw, `chrome-extension://${caller.extension.id}/`);
		} catch {
			throw new ParadisExtensionApiError('Invalid URL');
		}
		if (!isPageOf(url, caller.extension.id) && !['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
			throw new ParadisExtensionApiError('Invalid URL');
		}
		return url.href;
	}

	private async _download(caller: IParadisExtensionApiCaller, options: Record<string, unknown>): Promise<number> {
		if (typeof options.url !== 'string' || options.url.length === 0) {
			throw new ParadisExtensionApiError('Invalid URL');
		}
		if (options.method !== undefined && options.method !== 'GET') {
			throw new ParadisExtensionApiError('Para Code downloads only with GET');
		}
		const saveAs = options.saveAs === true;
		if (!saveAs && options.conflictAction !== undefined && options.conflictAction !== 'uniquify') {
			throw new ParadisExtensionApiError('Para Code saves downloads only with conflictAction "uniquify"');
		}
		const filename = paradisDownloadFilename(options.filename);
		const url = this._downloadUrl(caller, options.url);
		const headers = paradisDownloadHeaders(options.headers);
		// 保存の画面は、利用者の操作の中だけで出す（拡張機能が勝手にダイアログを出し続けないように）
		if (saveAs && !this._permissions.hasUserGesture(caller)) {
			throw new ParadisExtensionApiError('saveAs needs a user gesture');
		}
		// 始めるのは、その場所の利用者の前のタブ（エージェントのタブは選ばない）
		const owner = this._tabs.activeEditorTab(caller)?.webContents;
		if (!owner || owner.isDestroyed()) {
			throw new ParadisExtensionApiError('Open a browser tab to download into');
		}
		let savePath: string | undefined;
		if (saveAs) {
			savePath = await this._environment.chooseSavePath(owner, filename ?? (() => {
				try {
					return decodeURIComponent(new URL(url).pathname.split('/').at(-1) || 'download');
				} catch {
					return 'download';
				}
			})());
			if (savePath === undefined) {
				throw new ParadisExtensionApiError('Download canceled by the user');
			}
		}
		const session = owner.session;
		const id = this._nextDownloadId++;
		const started = new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => {
				session.removeListener('will-download', onWillDownload);
				reject(new ParadisExtensionApiError('The download did not start'));
			}, WILL_DOWNLOAD_TIMEOUT_MS);
			// Para Code の自動保存（先に登録してある will-download）が保存先を決めた後に、名前・保存先を合わせる
			const onWillDownload = (_event: unknown, item: DownloadItem, contents: WebContents) => {
				if (contents !== owner || (item.getURLChain()[0] ?? item.getURL()) !== url) {
					return;
				}
				clearTimeout(timer);
				session.removeListener('will-download', onWillDownload);
				if (savePath !== undefined) {
					item.setSavePath(savePath);
				} else {
					// 拡張機能のダウンロードは、自動保存のフォルダの隣の別のフォルダへ置く（エージェントの read_download が読む
					// 自動保存のフォルダには入れない）。名前は Orca と同じく最後の部分だけ使い、同じ名前があれば番号を付ける
					const current = item.getSavePath();
					if (current) {
						const folder = dirname(current);
						this._environment.renameDownload(item, paradisExtensionDownloadsFolder(folder), basename((filename ?? basename(current)).replace(/\\/g, '/')));
					}
				}
				this._track(caller, id, item);
				resolve(id);
			};
			session.on('will-download', onWillDownload);
		});
		owner.downloadURL(url, { headers });
		return started;
	}

	private _track(caller: IParadisExtensionApiCaller, id: number, item: DownloadItem): void {
		const emit = (event: string, args: readonly unknown[]) => this._host.emit({ session: caller.session, extensionId: caller.extension.id }, 'downloads', event, args);
		emit('onCreated', [this._describeDownload(id, item, caller.extension.id)]);
		const stateOf = () => {
			const state = item.getState();
			return state === 'completed' ? 'complete' : state === 'progressing' ? 'in_progress' : 'interrupted';
		};
		let previous = stateOf();
		const report = () => {
			const current = stateOf();
			if (current !== previous) {
				emit('onChanged', [{ id, state: { previous, current } }]);
				previous = current;
			}
		};
		item.on('updated', report);
		item.once('done', () => {
			item.removeListener('updated', report);
			report();
		});
	}

	private _registerDownloads(): void {
		this._host.registerNamespace('downloads', {
			permission: 'downloads',
			methods: {
				download: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => this._download(caller, options)),
			},
			events: ['onCreated', 'onChanged'],
		});
	}

	// --- management ---

	private _describeManaged(caller: IParadisExtensionApiCaller, installed: IParadisManagedExtension): Record<string, unknown> {
		const loaded = this._environment.loadedIn(this._tabs.electronSessionOf(caller), installed.id);
		const manifest = loaded?.manifest ?? {};
		const string = (key: string) => typeof manifest[key] === 'string' ? manifest[key] as string : undefined;
		const options = isRecord(manifest.options_ui) && typeof manifest.options_ui.page === 'string' ? manifest.options_ui.page : string('options_page');
		const icons = isRecord(manifest.icons) ? Object.entries(manifest.icons).flatMap(([size, path]) => typeof path === 'string' && Number.parseInt(size, 10) > 0 ? [{ size: Number.parseInt(size, 10), url: `chrome-extension://${installed.id}/${path.replace(/^\/+/, '')}` }] : []) : [];
		return {
			id: installed.id, name: installed.name, shortName: string('short_name') ?? installed.name, description: string('description') ?? '', version: installed.version,
			mayDisable: true, enabled: installed.enabled, ...(installed.enabled ? {} : { disabledReason: 'unknown' }), isApp: false, type: 'extension', offlineEnabled: false,
			optionsUrl: options ? `chrome-extension://${installed.id}/${options.replace(/^\/+/, '')}` : '',
			...(string('homepage_url') ? { homepageUrl: string('homepage_url') } : {}), ...(icons.length > 0 ? { icons } : {}),
			permissions: [...installed.permissions], hostPermissions: [...installed.hostPermissions],
			// Chrome はフォルダから入れたものを開発用として出す
			installType: 'development',
		};
	}

	private _managed(caller: IParadisExtensionApiCaller, id: string): Record<string, unknown> {
		const installed = this._environment.listInstalled(caller.place).find(entry => entry.id === id);
		if (!installed) {
			throw new ParadisExtensionApiError(`Failed to find extension with id ${id}.`);
		}
		return this._describeManaged(caller, installed);
	}

	private async _setEnabled(caller: IParadisExtensionApiCaller, id: string, enabled: boolean): Promise<void> {
		if (id === caller.extension.id) {
			throw new ParadisExtensionApiError('An extension cannot enable or disable itself');
		}
		const target = this._environment.listInstalled(caller.place).find(entry => entry.id === id);
		if (!target) {
			throw new ParadisExtensionApiError(`Failed to find extension with id ${id}.`);
		}
		if (target.enabled === enabled) {
			return;
		}
		// Chrome: ほかの拡張機能を有効にするのは利用者の操作の中からだけ
		if (enabled && !this._permissions.hasUserGesture(caller)) {
			throw new ParadisExtensionApiError('This function must be called during a user gesture');
		}
		await this._environment.setEnabled(id, caller.place, enabled);
	}

	private _registerManagement(): void {
		this._host.registerNamespace('management', {
			permission: 'management',
			methods: {
				getAll: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => this._environment.listInstalled(caller.place).map(installed => this._describeManaged(caller, installed))),
				get: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'string' ? [args[0]] as [string] : undefined, (caller, id) => this._managed(caller, id)),
				setEnabled: paradisDefineExtensionMethod(args => args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'boolean' ? [args[0], args[1]] as [string, boolean] : undefined, (caller, id, enabled) => this._setEnabled(caller, id, enabled)),
			},
			events: [],
		});
	}
}

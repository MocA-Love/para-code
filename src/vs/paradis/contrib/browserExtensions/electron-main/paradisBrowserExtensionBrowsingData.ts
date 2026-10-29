/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.browsingData（P9a）。拡張機能が動いているセッション（その場所の内蔵ブラウザのセッション）のデータだけを、
// Electron の session.clearData で消す。
//  - エージェントのセッション（Agent の場所）・ほかの場所（ほかのプロファイル・ワークスペース）のセッションのデータには触れない
//    （呼び出し元のセッションしか見ない。拡張機能はエージェントのセッションに入らない）
//  - 拡張機能のデータ（chrome-extension:// の origin）は消さない（Chrome の originTypes の既定 unprotectedWeb と同じ）。
//    originTypes.extension を求められたら断る
//  - 期間（since）は Electron の clearData に無い。0（すべての期間）以外は、頼まれたより多く消さないよう断る
//  - Para Code に無いデータ（履歴・フォームの自動入力・パスワード・ダウンロードの一覧など）は、消したことにせず断る

import { IParadisExtensionApiCaller, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';

/** Chrome の DataTypeSet の名前 → Electron の clearData の dataTypes。 */
const DATA_TYPES: Readonly<Record<string, string | undefined>> = {
	cache: 'cache',
	cookies: 'cookies',
	fileSystems: 'fileSystems',
	indexedDB: 'indexedDB',
	localStorage: 'localStorage',
	serviceWorkers: 'serviceWorkers',
	webSQL: 'webSQL',
};

/** Para Code に無い・消せないデータ（求められたら断る）。 */
const UNSUPPORTED_TYPES = new Set(['appcache', 'cacheStorage', 'downloads', 'formData', 'history', 'passwords', 'pluginData', 'serverBoundCertificates']);

/** remove<種類> の名前 → DataTypeSet の名前。 */
const SINGLE_METHODS: Readonly<Record<string, string>> = {
	removeAppcache: 'appcache', removeCache: 'cache', removeCacheStorage: 'cacheStorage', removeCookies: 'cookies', removeDownloads: 'downloads',
	removeFileSystems: 'fileSystems', removeFormData: 'formData', removeHistory: 'history', removeIndexedDB: 'indexedDB', removeLocalStorage: 'localStorage',
	removePasswords: 'passwords', removePluginData: 'pluginData', removeServiceWorkers: 'serviceWorkers', removeWebSQL: 'webSQL',
};

/** 消すために要るセッションの一部（テストでは偽物）。 */
export interface IParadisBrowsingDataSession {
	clearData(options: { dataTypes?: string[]; origins?: string[]; excludeOrigins?: string[] }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 拡張機能の求め（RemovalOptions と DataTypeSet）から、Electron の clearData に渡すものを作る。断るときは投げる。 */
export function paradisBrowsingDataRemoval(options: unknown, dataToRemove: unknown, extensionOrigins: readonly string[]): { readonly dataTypes: string[]; readonly origins?: string[]; readonly excludeOrigins?: string[] } {
	const removal = isRecord(options) ? options : {};
	const since = removal.since;
	if (since !== undefined && since !== 0) {
		throw new ParadisExtensionApiError('Para Code can only remove browsing data from all time (since: 0)');
	}
	const originTypes = isRecord(removal.originTypes) ? removal.originTypes : {};
	if (originTypes.extension === true) {
		throw new ParadisExtensionApiError('Para Code does not let browser extensions remove the data of extensions');
	}
	const wanted = isRecord(dataToRemove) ? Object.entries(dataToRemove).filter(([, value]) => value === true).map(([name]) => name) : [];
	const unsupported = wanted.filter(name => UNSUPPORTED_TYPES.has(name) || (DATA_TYPES[name] === undefined && !UNSUPPORTED_TYPES.has(name)));
	if (unsupported.length > 0) {
		throw new ParadisExtensionApiError(`Para Code cannot remove this browsing data: ${unsupported.join(', ')}`);
	}
	const dataTypes = wanted.map(name => DATA_TYPES[name]!).filter((name, index, all) => all.indexOf(name) === index);
	const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined;
	const origins = strings(removal.origins);
	const excluded = strings(removal.excludeOrigins);
	if (origins && excluded) {
		throw new ParadisExtensionApiError('origins and excludeOrigins cannot be used together');
	}
	if (origins) {
		const normalized = origins.map(origin => {
			try {
				return new URL(origin).origin;
			} catch {
				throw new ParadisExtensionApiError(`Invalid origin: ${origin}`);
			}
		});
		// 拡張機能の origin を名指ししても消さない
		const web = normalized.filter(origin => !origin.startsWith('chrome-extension:'));
		if (web.length === 0) {
			throw new ParadisExtensionApiError('Para Code does not let browser extensions remove the data of extensions');
		}
		return { dataTypes, origins: web };
	}
	// 拡張機能のデータは、名指しされなくても消さない
	return { dataTypes, excludeOrigins: [...new Set([...(excluded ?? []), ...extensionOrigins])] };
}

/** chrome.browsingData を登録する。`extensionOrigins` はそのセッションに入っている拡張機能の origin（消さない）。 */
export function paradisRegisterBrowsingDataApis(host: ParadisExtensionApiHost, extensionOrigins: (caller: IParadisExtensionApiCaller) => readonly string[]): void {
	const remove = async (caller: IParadisExtensionApiCaller, options: unknown, dataToRemove: unknown) => {
		const removal = paradisBrowsingDataRemoval(options, dataToRemove, extensionOrigins(caller));
		if (removal.dataTypes.length === 0) {
			return;
		}
		// 呼び出し元のセッション（その場所の内蔵ブラウザのセッション）だけ
		await (caller.session as unknown as IParadisBrowsingDataSession).clearData(removal);
	};
	const methods: Record<string, ReturnType<typeof paradisDefineExtensionMethod>> = {
		remove: paradisDefineExtensionMethod(args => args.length === 2 ? [args[0], args[1]] as [unknown, unknown] : undefined, (caller, options, dataToRemove) => remove(caller, options, dataToRemove)),
		settings: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => ({
			options: { since: 0, originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false } },
			dataToRemove: {},
			dataRemovalPermitted: Object.fromEntries([...Object.keys(DATA_TYPES), ...UNSUPPORTED_TYPES].map(name => [name, DATA_TYPES[name] !== undefined])),
		})),
	};
	for (const [method, type] of Object.entries(SINGLE_METHODS)) {
		methods[method] = paradisDefineExtensionMethod(args => args.length === 1 ? [args[0]] as [unknown] : undefined, (caller, options) => remove(caller, options, { [type]: true }));
	}
	host.registerNamespace('browsingData', { permission: 'browsingData', methods, events: [] });
}

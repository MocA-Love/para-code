/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の、設定キー・main との通り道・台帳の形と純粋な操作。
// 設計: リポジトリ直下の browser-extensions-design.html（Q480、P3 土台）。
//
//  - 既定はオフの試験的な設定（D1）。切り替えは再起動で効く
//  - インストールした一覧は全プロファイルで共有し、有効にするかはプロファイルごとに持つ（D2）。
//    通常のタブ（Global）とワークスペースのタブ（Workspace）は「既定」の 1 つとして扱う
//  - エージェントのタブ（Agent）と使い捨てのタブ（Ephemeral）には入れない。SSH 先のページを開いている
//    ワークスペースのセッション（トンネル経由）にも入れない（D8）

/** 試験的な設定のキー（既定 false、再起動で効く）。 */
export const PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING = 'paradis.browser.extensions.enabled';

/** main の拡張機能の管理の channel。 */
export const PARADIS_BROWSER_EXTENSIONS_CHANNEL = 'paradisBrowserExtensions';

/** 管理画面を開くコマンド。 */
export const PARADIS_MANAGE_BROWSER_EXTENSIONS_COMMAND_ID = 'paradis.browserExtensions.manage';

/** 通常のタブとワークスペースのタブ（「既定」）のプロファイルのキー。 */
export const PARADIS_DEFAULT_EXTENSION_PROFILE = 'default';

/** 名前付きプロファイルのキーの接頭辞（後ろはプロファイルの id）。 */
const NAMED_PROFILE_PREFIX = 'profile:';

/** 名前付きプロファイルのキー。 */
export function paradisNamedExtensionProfile(profileId: string): string {
	return `${NAMED_PROFILE_PREFIX}${profileId}`;
}

/** プロファイルのキーとして正しい形か。 */
export function paradisIsExtensionProfileKey(value: unknown): value is string {
	return value === PARADIS_DEFAULT_EXTENSION_PROFILE || (typeof value === 'string' && /^profile:[0-9a-f]{12}$/.test(value));
}

/** Chromium の拡張機能の id（a〜p の 32 文字）か。 */
export function paradisIsExtensionId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

/** 入手の経路。P3 はフォルダから読み込むものだけ（ストアは P7）。 */
export type ParadisBrowserExtensionSource = 'unpacked';

/** インストールした拡張機能 1 つ（台帳の 1 行）。 */
export interface IParadisInstalledBrowserExtension {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly manifestVersion: number;
	readonly source: ParadisBrowserExtensionSource;
	/** 利用者が選んだ元のフォルダ（再読み込みに使う）。 */
	readonly sourcePath: string;
	/** Para Code が読み込む写し（Para Code が持つフォルダ）。 */
	readonly path: string;
	readonly installedAt: number;
}

/** 台帳（main が JSON で保存する）。 */
export interface IParadisBrowserExtensionsLedger {
	readonly version: 1;
	readonly extensions: readonly IParadisInstalledBrowserExtension[];
	/** プロファイルのキー → 有効にした拡張機能の id。 */
	readonly enabled: Readonly<Record<string, readonly string[]>>;
	/** 削除したが、保存データ（chrome.storage など）をまだ消していない id。次に読み込む前に消す。 */
	readonly removed: readonly string[];
}

/** 空の台帳。 */
export const PARADIS_EMPTY_EXTENSIONS_LEDGER: IParadisBrowserExtensionsLedger = { version: 1, extensions: [], enabled: {}, removed: [] };

/** 台帳に置ける拡張機能の数の上限。 */
export const PARADIS_MAX_INSTALLED_EXTENSIONS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 保存してあった JSON を台帳として読む。壊れた行は捨てる。 */
export function paradisParseExtensionsLedger(raw: unknown): IParadisBrowserExtensionsLedger {
	if (!isRecord(raw) || raw.version !== 1) {
		return PARADIS_EMPTY_EXTENSIONS_LEDGER;
	}
	const extensions: IParadisInstalledBrowserExtension[] = [];
	for (const entry of Array.isArray(raw.extensions) ? raw.extensions : []) {
		if (!isRecord(entry) || !paradisIsExtensionId(entry.id) || entry.source !== 'unpacked'
			|| typeof entry.name !== 'string' || typeof entry.version !== 'string' || typeof entry.manifestVersion !== 'number'
			|| typeof entry.sourcePath !== 'string' || typeof entry.path !== 'string' || typeof entry.installedAt !== 'number'
			|| extensions.some(existing => existing.id === entry.id) || extensions.length >= PARADIS_MAX_INSTALLED_EXTENSIONS) {
			continue;
		}
		extensions.push({ id: entry.id, name: entry.name, version: entry.version, manifestVersion: entry.manifestVersion, source: 'unpacked', sourcePath: entry.sourcePath, path: entry.path, installedAt: entry.installedAt });
	}
	const enabled: Record<string, string[]> = {};
	if (isRecord(raw.enabled)) {
		for (const [profile, ids] of Object.entries(raw.enabled)) {
			if (paradisIsExtensionProfileKey(profile) && Array.isArray(ids)) {
				enabled[profile] = [...new Set(ids.filter((id): id is string => paradisIsExtensionId(id) && extensions.some(extension => extension.id === id)))];
			}
		}
	}
	const removed = Array.isArray(raw.removed) ? [...new Set(raw.removed.filter(paradisIsExtensionId))].slice(-PARADIS_MAX_INSTALLED_EXTENSIONS) : [];
	return { version: 1, extensions, enabled, removed };
}

/** 拡張機能を足す（同じ id なら置き換える）。足したプロファイルでは有効にする。 */
export function paradisLedgerWithExtension(ledger: IParadisBrowserExtensionsLedger, extension: IParadisInstalledBrowserExtension, enableIn: string | undefined): IParadisBrowserExtensionsLedger {
	const extensions = [...ledger.extensions.filter(existing => existing.id !== extension.id), extension];
	const ledgerWithExtension = { ...ledger, extensions, removed: ledger.removed.filter(id => id !== extension.id) };
	return enableIn !== undefined ? paradisLedgerWithEnabled(ledgerWithExtension, extension.id, enableIn, true) : ledgerWithExtension;
}

/** プロファイルで有効・無効にする。 */
export function paradisLedgerWithEnabled(ledger: IParadisBrowserExtensionsLedger, id: string, profile: string, enabled: boolean): IParadisBrowserExtensionsLedger {
	if (!ledger.extensions.some(extension => extension.id === id)) {
		return ledger;
	}
	const current = ledger.enabled[profile] ?? [];
	const next = enabled ? [...new Set([...current, id])] : current.filter(existing => existing !== id);
	return { ...ledger, enabled: { ...ledger.enabled, [profile]: next } };
}

/** 削除する。全プロファイルで無効にし、保存データを次に消す印を付ける。 */
export function paradisLedgerWithoutExtension(ledger: IParadisBrowserExtensionsLedger, id: string): IParadisBrowserExtensionsLedger {
	if (!ledger.extensions.some(extension => extension.id === id)) {
		return ledger;
	}
	const enabled: Record<string, readonly string[]> = {};
	for (const [profile, ids] of Object.entries(ledger.enabled)) {
		enabled[profile] = ids.filter(existing => existing !== id);
	}
	return {
		version: 1,
		extensions: ledger.extensions.filter(extension => extension.id !== id),
		enabled,
		removed: [...ledger.removed.filter(existing => existing !== id), id].slice(-PARADIS_MAX_INSTALLED_EXTENSIONS),
	};
}

/** プロファイルで有効な拡張機能。 */
export function paradisEnabledExtensions(ledger: IParadisBrowserExtensionsLedger, profile: string): IParadisInstalledBrowserExtension[] {
	const ids = new Set(ledger.enabled[profile] ?? []);
	return ledger.extensions.filter(extension => ids.has(extension.id));
}

/** manifest.json から読んだ、一覧に出す情報。 */
export interface IParadisExtensionManifestSummary {
	readonly name: string;
	readonly version: string;
	readonly manifestVersion: number;
	/** manifest の key（あれば id はこれから決まる）。 */
	readonly key?: string;
}

/** `__MSG_name__` を `_locales/<default_locale>/messages.json` の値で置き換える。 */
function localized(value: string, messages: unknown): string {
	const match = /^__MSG_(?<name>[A-Za-z0-9_@]+)__$/.exec(value);
	if (!match?.groups || !isRecord(messages)) {
		return value;
	}
	const wanted = match.groups.name.toLowerCase();
	for (const [key, entry] of Object.entries(messages)) {
		if (key.toLowerCase() === wanted && isRecord(entry) && typeof entry.message === 'string') {
			return entry.message;
		}
	}
	return value;
}

/**
 * manifest.json を読む。拡張機能として足りないところがあれば、その理由（利用者に見せる日本語は呼び出し側で
 * 付ける）を返す。
 */
export function paradisReadExtensionManifest(manifest: unknown, messages?: unknown): IParadisExtensionManifestSummary | { readonly error: 'notObject' | 'manifestVersion' | 'name' | 'version' } {
	if (!isRecord(manifest)) {
		return { error: 'notObject' };
	}
	const manifestVersion = manifest.manifest_version;
	if (manifestVersion !== 2 && manifestVersion !== 3) {
		return { error: 'manifestVersion' };
	}
	if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
		return { error: 'name' };
	}
	if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
		return { error: 'version' };
	}
	return {
		name: localized(manifest.name, messages).slice(0, 200),
		version: manifest.version,
		manifestVersion,
		...(typeof manifest.key === 'string' && manifest.key.length > 0 ? { key: manifest.key } : {}),
	};
}

/** 管理画面に出す、拡張機能 1 つの状態。 */
export interface IParadisBrowserExtensionView extends IParadisInstalledBrowserExtension {
	/** 有効にしているプロファイルのキー。 */
	readonly enabledIn: readonly string[];
	/** 直近の読み込みの失敗（無ければ undefined）。 */
	readonly loadError?: string;
}

/** 管理画面に出す状態。 */
export interface IParadisBrowserExtensionsState {
	/** 試験的な設定が今の起動で効いているか（切り替えは再起動で効く）。 */
	readonly active: boolean;
	/** 設定の値（再起動の後に効く値）。 */
	readonly setting: boolean;
	readonly extensions: readonly IParadisBrowserExtensionView[];
}

/** フォルダから足した結果。 */
export type IParadisAddExtensionResult =
	| { readonly ok: true; readonly extension: IParadisInstalledBrowserExtension }
	| { readonly ok: false; readonly reason: 'inactive' | 'notFolder' | 'noManifest' | 'invalidManifest' | 'tooMany' | 'failed'; readonly detail?: string };

/** main の拡張機能の管理（{@link PARADIS_BROWSER_EXTENSIONS_CHANNEL}）。 */
export interface IParadisBrowserExtensionsMainService {
	getState(): Promise<IParadisBrowserExtensionsState>;
	/** 展開済みのフォルダから足し、`profile` で有効にする。 */
	addUnpacked(folder: string, profile: string): Promise<IParadisAddExtensionResult>;
	/** フォルダから読み込み直す（元のフォルダの今の中身で写しを作り直す）。 */
	reloadUnpacked(id: string): Promise<IParadisAddExtensionResult>;
	setEnabled(id: string, profile: string, enabled: boolean): Promise<void>;
	remove(id: string): Promise<void>;
}

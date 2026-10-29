/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Event } from '../../../../base/common/event.js';

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
	/**
	 * ページの中身を読み書きできるか（content script・nativeMessaging・任意のサイトへの scripting を持つ）。
	 * 共有の確認で「拡張機能が入力した値はエージェントからも読める」と知らせるのに使う。
	 */
	readonly touchesPages: boolean;
}

/** 台帳（main が JSON で保存する）。 */
export interface IParadisBrowserExtensionsLedger {
	readonly version: 1;
	readonly extensions: readonly IParadisInstalledBrowserExtension[];
	/** プロファイルのキー → 有効にした拡張機能の id。 */
	readonly enabled: Readonly<Record<string, readonly string[]>>;
	/**
	 * 削除した拡張機能の、保存データ（chrome.storage・IndexedDB・Local Storage・CacheStorage）を消す印。
	 * セッション（Global・各ワークスペース・各プロファイル）ごとに保存先が違うので、消し終えた保存先を
	 * `cleared` に足していく。入れ直しても印は残し、まだ消していない保存先では読み込む前に消す。
	 */
	readonly removed: readonly IParadisRemovedExtensionData[];
}

/** 削除した拡張機能の保存データを消す印。 */
export interface IParadisRemovedExtensionData {
	readonly id: string;
	/** 消し終えたセッションの保存先（`Session.storagePath`）。 */
	readonly cleared: readonly string[];
}

/** 1 つの印に覚える保存先の数の上限（古いものから忘れる。忘れた保存先はもう一度消すだけ）。 */
const MAX_CLEARED_PATHS = 1_000;

/** 空の台帳。 */
export const PARADIS_EMPTY_EXTENSIONS_LEDGER: IParadisBrowserExtensionsLedger = { version: 1, extensions: [], enabled: {}, removed: [] };

/** 台帳に置ける拡張機能の数の上限。 */
export const PARADIS_MAX_INSTALLED_EXTENSIONS = 200;

/** フォルダから写すときのファイル数の上限（node_modules を含む開発中の拡張機能も入るように多めにとる）。 */
export const PARADIS_MAX_EXTENSION_FILES = 20_000;

/** フォルダから写すときの大きさの上限（バイト）。 */
export const PARADIS_MAX_EXTENSION_BYTES = 200 * 1024 * 1024;

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
		// touchesPages が無い行（P3 の版で足したもの）は、知らせ損ねないよう読み書きできる側に倒す
		extensions.push({ id: entry.id, name: entry.name, version: entry.version, manifestVersion: entry.manifestVersion, source: 'unpacked', sourcePath: entry.sourcePath, path: entry.path, installedAt: entry.installedAt, touchesPages: entry.touchesPages !== false });
	}
	const enabled: Record<string, string[]> = {};
	if (isRecord(raw.enabled)) {
		for (const [profile, ids] of Object.entries(raw.enabled)) {
			if (paradisIsExtensionProfileKey(profile) && Array.isArray(ids)) {
				enabled[profile] = [...new Set(ids.filter((id): id is string => paradisIsExtensionId(id) && extensions.some(extension => extension.id === id)))];
			}
		}
	}
	const removed: IParadisRemovedExtensionData[] = [];
	for (const entry of Array.isArray(raw.removed) ? raw.removed : []) {
		const id = isRecord(entry) ? entry.id : entry;
		if (!paradisIsExtensionId(id) || removed.some(existing => existing.id === id)) {
			continue;
		}
		const cleared = isRecord(entry) && Array.isArray(entry.cleared) ? [...new Set(entry.cleared.filter((path): path is string => typeof path === 'string'))].slice(-MAX_CLEARED_PATHS) : [];
		removed.push({ id, cleared });
	}
	return { version: 1, extensions, enabled, removed: removed.slice(-PARADIS_MAX_INSTALLED_EXTENSIONS) };
}

/**
 * 拡張機能を足す（同じ id なら置き換える）。足したプロファイルでは有効にする。
 * 前に削除した id でも、保存データを消す印は外さない（まだ消していない保存先では、読み込む前に消す）。
 */
export function paradisLedgerWithExtension(ledger: IParadisBrowserExtensionsLedger, extension: IParadisInstalledBrowserExtension, enableIn: string | undefined): IParadisBrowserExtensionsLedger {
	const extensions = [...ledger.extensions.filter(existing => existing.id !== extension.id), extension];
	const ledgerWithExtension = { ...ledger, extensions };
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
		// 消し終えた保存先も数え直す（入れ直した後に溜まったデータがあるかもしれないため）
		removed: [...ledger.removed.filter(existing => existing.id !== id), { id, cleared: [] }].slice(-PARADIS_MAX_INSTALLED_EXTENSIONS),
	};
}

/** その保存先で、読み込む前に保存データを消す必要があるか。 */
export function paradisNeedsDataClear(ledger: IParadisBrowserExtensionsLedger, id: string, storagePath: string): boolean {
	const mark = ledger.removed.find(entry => entry.id === id);
	return mark !== undefined && !mark.cleared.includes(storagePath);
}

/** その保存先で保存データを消し終えた。 */
export function paradisLedgerWithDataCleared(ledger: IParadisBrowserExtensionsLedger, id: string, storagePath: string): IParadisBrowserExtensionsLedger {
	if (!paradisNeedsDataClear(ledger, id, storagePath)) {
		return ledger;
	}
	return {
		...ledger,
		removed: ledger.removed.map(entry => entry.id === id ? { id, cleared: [...entry.cleared, storagePath].slice(-MAX_CLEARED_PATHS) } : entry),
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
	/** ページの中身を読み書きできるか（{@link IParadisInstalledBrowserExtension.touchesPages}）。 */
	readonly touchesPages: boolean;
}

/**
 * manifest から、ページの中身を読み書きできる拡張機能かを決める。content script を持つ、nativeMessaging
 * （パスワード管理のアプリとの連携など）・debugger・userScripts を持つ、scripting などとサイトへの権限を
 * 併せ持つ、のどれか。後から求める権限（optional_permissions・optional_host_permissions）も数える。
 */
function touchesPages(manifest: Record<string, unknown>): boolean {
	const list = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
	// 後から求める権限（optional_*）も、求められたら持つので数える
	const permissions = [...list(manifest.permissions), ...list(manifest.optional_permissions)];
	const hostPermissions = [
		...list(manifest.host_permissions),
		...list(manifest.optional_host_permissions),
		...permissions.filter(permission => permission.includes('://') || permission === '<all_urls>'),
	];
	const contentScripts = Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0;
	return contentScripts
		|| permissions.includes('nativeMessaging')
		// debugger（CDP でページを操作できる）と userScripts（任意のスクリプトをページへ入れられる）はそれだけで足りる
		|| permissions.includes('debugger')
		|| permissions.includes('userScripts')
		|| ((permissions.includes('scripting') || permissions.includes('tabs') || permissions.includes('activeTab')) && (hostPermissions.length > 0 || permissions.includes('activeTab')));
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
		touchesPages: touchesPages(manifest),
		...(typeof manifest.key === 'string' && manifest.key.length > 0 ? { key: manifest.key } : {}),
	};
}

/** 管理画面に出す、拡張機能 1 つの状態。 */
export interface IParadisBrowserExtensionView extends IParadisInstalledBrowserExtension {
	/** 有効にしているプロファイルのキー。 */
	readonly enabledIn: readonly string[];
	/** 直近の読み込みの失敗（無ければ undefined）。 */
	readonly loadError?: string;
	/** UTF-8 でないため、Para Code の足す API（storage.sync など）を入れられなかったページ。 */
	readonly pagesWithoutApis?: readonly string[];
}

/** あるページのセッションに今入っている、利用者が入れた拡張機能。 */
export interface IParadisViewBrowserExtension {
	readonly id: string;
	readonly name: string;
	readonly touchesPages: boolean;
}

/** {@link IParadisBrowserExtensionsMainService.getShareExtensions} の答え。 */
export interface IParadisShareExtensions {
	/** 試験的な設定が今の起動で効いているか（効いていなければ拡張機能は入らない）。 */
	readonly active: boolean;
	readonly extensions: readonly IParadisViewBrowserExtension[];
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
	| { readonly ok: false; readonly reason: 'inactive' | 'notFolder' | 'noManifest' | 'invalidManifest' | 'tooMany' | 'linkOutside' | 'hardLink' | 'nameClash' | 'reservedName' | 'changed' | 'tooLarge' | 'restartNeeded' | 'failed'; readonly detail?: string };

/** main の拡張機能の管理（{@link PARADIS_BROWSER_EXTENSIONS_CHANNEL}）。 */
export interface IParadisBrowserExtensionsMainService {
	getState(): Promise<IParadisBrowserExtensionsState>;
	/** 展開済みのフォルダから足し、`profile` で有効にする。 */
	addUnpacked(folder: string, profile: string): Promise<IParadisAddExtensionResult>;
	/** フォルダから読み込み直す（元のフォルダの今の中身で写しを作り直す）。 */
	reloadUnpacked(id: string): Promise<IParadisAddExtensionResult>;
	setEnabled(id: string, profile: string, enabled: boolean): Promise<void>;
	remove(id: string): Promise<void>;
	/**
	 * 共有の確認に使う、そのページに入っている（入りうる）拡張機能。`viewId` のビューが main にあれば、その
	 * セッションに今入っているもの。無い（まだ開いていないタブ・これから開くプロファイル）ときは、
	 * `fallbackProfile` で有効にしてあるもの。
	 */
	getShareExtensions(viewId: string | undefined, fallbackProfile: string | undefined): Promise<IParadisShareExtensions>;
	/** 拡張機能が tabs.update({ active: true }) などでタブを前に出したい（そのウィンドウの workbench が開く）。 */
	readonly onDidRequestActivateTab: Event<IParadisActivateTabRequest>;
}

/** タブを前に出す求め。 */
export interface IParadisActivateTabRequest {
	readonly windowId: number;
	readonly viewId: string;
}

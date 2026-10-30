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

/**
 * 入手の経路。`unpacked` はフォルダから読み込んだもの（開発用）、`webstore` は Chrome ウェブストアから落とし、main がストアの
 * 署名を確かめて入れたもの（P7）。`webstore` を書くのは main がストアの署名を確かめたときだけ（manifest の中身や拡張機能の
 * 申告では決めない）。ネイティブメッセージングで、ほかのブラウザに登録されたホストを使えるのは `webstore` だけ。
 */
export type ParadisBrowserExtensionSource = 'unpacked' | 'webstore';

/** インストールした拡張機能 1 つ（台帳の 1 行）。 */
export interface IParadisInstalledBrowserExtension {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly manifestVersion: number;
	readonly source: ParadisBrowserExtensionSource;
	/** 利用者が選んだ元のフォルダ（再読み込みに使う）。ストアから入れたものは、Para Code が入れたフォルダ（`path` と同じ）。 */
	readonly sourcePath: string;
	/** Para Code が読み込む写し（Para Code が持つフォルダ）。 */
	readonly path: string;
	readonly installedAt: number;
	/**
	 * ページの中身を読み書きできるか（content script・nativeMessaging・任意のサイトへの scripting を持つ）。
	 * 共有の確認で「拡張機能が入力した値はエージェントからも読める」と知らせるのに使う。
	 */
	readonly touchesPages: boolean;
	/**
	 * manifest に key の無い拡張機能へ、足したときに作った乱数の key（base64）。id はこれで決まる（写しの
	 * 場所＝利用者のホームの場所からは決めない。場所から決めると、利用者・PC ごとに違いずっと変わらない id に
	 * なり、サイトをまたいで同じ人を見分ける印になりうるため）。無ければ、前の版で足した拡張機能（id は写しの
	 * 場所から決まる）。
	 */
	readonly generatedKey?: string;
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
	/** プロファイルのキー → ツールバーに出す（ピン留めした）拡張機能の id（ピン留めした順）。 */
	readonly pinned: Readonly<Record<string, readonly string[]>>;
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
export const PARADIS_EMPTY_EXTENSIONS_LEDGER: IParadisBrowserExtensionsLedger = { version: 1, extensions: [], enabled: {}, removed: [], pinned: {} };

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
		// ストアの行は、古い版（P7 より前）が読めるよう `source: 'unpacked'` と `webstore: true` で書く（paradisSerializeExtensionsLedger）
		const source: ParadisBrowserExtensionSource = entry.webstore === true ? 'webstore' : 'unpacked';
		extensions.push({ id: entry.id, name: entry.name, version: entry.version, manifestVersion: entry.manifestVersion, source, sourcePath: entry.sourcePath, path: entry.path, installedAt: entry.installedAt, touchesPages: entry.touchesPages !== false, ...(typeof entry.generatedKey === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(entry.generatedKey) ? { generatedKey: entry.generatedKey } : {}) });
	}
	const byProfile = (value: unknown): Record<string, string[]> => {
		const result: Record<string, string[]> = {};
		if (isRecord(value)) {
			for (const [profile, ids] of Object.entries(value)) {
				if (paradisIsExtensionProfileKey(profile) && Array.isArray(ids)) {
					result[profile] = [...new Set(ids.filter((id): id is string => paradisIsExtensionId(id) && extensions.some(extension => extension.id === id)))];
				}
			}
		}
		return result;
	};
	const enabled = byProfile(raw.enabled);
	// pinned が無い台帳（P5 より前の版）は、どれもピン留めしていないとして読む
	const pinned = byProfile(raw.pinned);
	const removed: IParadisRemovedExtensionData[] = [];
	for (const entry of Array.isArray(raw.removed) ? raw.removed : []) {
		const id = isRecord(entry) ? entry.id : entry;
		if (!paradisIsExtensionId(id) || removed.some(existing => existing.id === id)) {
			continue;
		}
		const cleared = isRecord(entry) && Array.isArray(entry.cleared) ? [...new Set(entry.cleared.filter((path): path is string => typeof path === 'string'))].slice(-MAX_CLEARED_PATHS) : [];
		removed.push({ id, cleared });
	}
	return { version: 1, extensions, enabled, removed: removed.slice(-PARADIS_MAX_INSTALLED_EXTENSIONS), pinned };
}

/**
 * 台帳を保存する形にする。ストアの行は `source: 'unpacked'` と `webstore: true` で書く。P7 より前の版は `source` が
 * `unpacked` でない行を捨て、その後に台帳を書くと、有効・ピン留めの記録ごと消える。この形なら古い版でもフォルダから
 * 読み込んだ拡張機能として動き続ける（古い版が台帳を書き直すと `webstore` の印は消え、開発用の扱いに下がる。安全な側）。
 */
export function paradisSerializeExtensionsLedger(ledger: IParadisBrowserExtensionsLedger): unknown {
	return { ...ledger, extensions: ledger.extensions.map(extension => extension.source === 'webstore' ? { ...extension, source: 'unpacked', webstore: true } : extension) };
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

/** ツールバーにピン留めする・外す（ピン留めは後ろに足す）。 */
export function paradisLedgerWithPinned(ledger: IParadisBrowserExtensionsLedger, id: string, profile: string, pinned: boolean): IParadisBrowserExtensionsLedger {
	if (!ledger.extensions.some(extension => extension.id === id)) {
		return ledger;
	}
	const current = ledger.pinned[profile] ?? [];
	const next = pinned ? (current.includes(id) ? current : [...current, id]) : current.filter(existing => existing !== id);
	return { ...ledger, pinned: { ...ledger.pinned, [profile]: next } };
}

/** プロファイルでピン留めした拡張機能の id（ピン留めした順）。 */
export function paradisPinnedExtensionIds(ledger: IParadisBrowserExtensionsLedger, profile: string): readonly string[] {
	return ledger.pinned[profile] ?? [];
}

/** 削除する。全プロファイルで無効にしてピン留めも外し、保存データを次に消す印を付ける。 */
export function paradisLedgerWithoutExtension(ledger: IParadisBrowserExtensionsLedger, id: string): IParadisBrowserExtensionsLedger {
	if (!ledger.extensions.some(extension => extension.id === id)) {
		return ledger;
	}
	const without = (map: Readonly<Record<string, readonly string[]>>) => {
		const result: Record<string, readonly string[]> = {};
		for (const [profile, ids] of Object.entries(map)) {
			result[profile] = ids.filter(existing => existing !== id);
		}
		return result;
	};
	const enabled = without(ledger.enabled);
	return {
		version: 1,
		extensions: ledger.extensions.filter(extension => extension.id !== id),
		enabled,
		pinned: without(ledger.pinned),
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

/**
 * 拡張機能の新しいタブのページ（manifest の chrome_url_overrides.newtab、P9c）の URL。拡張機能の中のページでなければ undefined。
 * 置き換えるのは内蔵ブラウザの新しいタブだけ（Para Code のエディタの新しいタブには使わない）。
 */
export function paradisNewTabOverrideUrl(extensionId: string, manifest: unknown): string | undefined {
	const overrides = manifest !== null && typeof manifest === 'object' ? (manifest as { chrome_url_overrides?: unknown }).chrome_url_overrides : undefined;
	const page = overrides !== null && typeof overrides === 'object' ? (overrides as { newtab?: unknown }).newtab : undefined;
	if (typeof page !== 'string' || page.trim().length === 0 || page.length > 2_048) {
		return undefined;
	}
	const base = `chrome-extension://${extensionId}/`;
	let url: URL;
	try {
		url = new URL(page.trim().replace(/^\/+/, ''), base);
	} catch {
		return undefined;
	}
	// 拡張機能の外（ほかの拡張機能・ウェブのページ）を指すものは使わない
	return url.protocol === 'chrome-extension:' && url.host === extensionId ? url.href : undefined;
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
	/** UTF-8 でない、または書き換えられない形式のため、Para Code の足す API（storage.sync など）を入れられなかったページ。 */
	readonly pagesWithoutApis?: readonly string[];
	/** 確かめて置いてある、次の起動で使うストアの更新の版（使っている最中には替えない）。 */
	readonly nextVersion?: string;
	/**
	 * userScripts を求める拡張機能だけ: 「ユーザースクリプトを許可」した場所のキー（Chrome の拡張機能ごとの設定と同じ。
	 * 既定はどこでもオフ）。
	 */
	readonly userScripts?: { readonly allowedIn: readonly string[] };
	/** 新しく権限を求めるため、確かめるまで入れずに保留にしているストアの更新。 */
	readonly pendingUpdate?: { readonly version: string; readonly permissions: readonly string[]; readonly hostPermissions: readonly string[] };
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
	| { readonly ok: false; readonly reason: 'inactive' | 'notFolder' | 'noManifest' | 'invalidManifest' | 'tooMany' | 'linkOutside' | 'hardLink' | 'nameClash' | 'reservedName' | 'changed' | 'tooLarge' | 'restartNeeded' | 'failed' | ParadisWebStoreFailure; readonly detail?: string };

/**
 * ストアから足せなかった理由。`invalidInput`: リンクか id として読めない。`cancelled`: 確認で取り消した。`busy`: 同じ拡張機能を
 * 入れている途中。`alreadyAdded`: その場所で入っている。`sameIdUnpacked`: 同じ id をフォルダから読み込んである。
 * `sameIdWebStore`: 同じ id をストアから入れてある（フォルダからは足せない）。`webStoreFailed`: 落とす・確かめるのに失敗した。
 * `noPrompt`: 確認を出せない（ウィンドウが無いなど）。
 */
export type ParadisWebStoreFailure = 'invalidInput' | 'cancelled' | 'busy' | 'alreadyAdded' | 'sameIdUnpacked' | 'sameIdWebStore' | 'webStoreFailed' | 'noPrompt';

/** main の拡張機能の管理（{@link PARADIS_BROWSER_EXTENSIONS_CHANNEL}）。 */
export interface IParadisBrowserExtensionsMainService {
	getState(): Promise<IParadisBrowserExtensionsState>;
	/** 展開済みのフォルダから足し、`profile` で有効にする。 */
	addUnpacked(folder: string, profile: string): Promise<IParadisAddExtensionResult>;
	/**
	 * Chrome ウェブストアのリンクか id から落とし、ストアの署名を確かめ、確認のダイアログで権限を見せてから足す。`profile` で有効に
	 * する。`profileLabel` は確認に出す場所の名前（画面に出すだけ）。外と話すのはこの呼び出しのときだけ。
	 */
	addFromWebStore(input: string, profile: string, profileLabel: string): Promise<IParadisAddExtensionResult>;
	/** 保留にしたストアの更新を、新しく求めるものを main のダイアログで確かめてから入れる。 */
	approveWebStoreUpdate(id: string): Promise<IParadisAddExtensionResult>;
	/** フォルダから読み込み直す（元のフォルダの今の中身で写しを作り直す）。 */
	reloadUnpacked(id: string): Promise<IParadisAddExtensionResult>;
	setEnabled(id: string, profile: string, enabled: boolean): Promise<void>;
	/** 「ユーザースクリプトを許可」を切り替える（userScripts を求める拡張機能だけ。`profile` の場所で）。 */
	setUserScriptsAllowed(id: string, profile: string, allowed: boolean): Promise<void>;
	/**
	 * 内蔵ブラウザの新しいタブ（URL の無いタブ）を、拡張機能の新しいタブのページ（chrome_url_overrides.newtab）にする。
	 * 置き換えたら true（置き換える拡張機能が無い・エージェントのタブなどでは false）。
	 */
	openNewTabPage(viewId: string): Promise<boolean>;
	remove(id: string): Promise<void>;
	/**
	 * 共有の確認に使う、そのページに入っている（入りうる）拡張機能。`viewId` のビューが main にあれば、その
	 * セッションに今入っているもの。無い（まだ開いていないタブ・これから開くプロファイル）ときは、
	 * `fallbackProfile` で有効にしてあるもの。
	 */
	getShareExtensions(viewId: string | undefined, fallbackProfile: string | undefined): Promise<IParadisShareExtensions>;
	/** 拡張機能が tabs.update({ active: true }) などでタブを前に出したい（そのウィンドウの workbench が開く）。 */
	readonly onDidRequestActivateTab: Event<IParadisActivateTabRequest>;
	/** そのタブ（ビュー）のツールバーに出す拡張機能のボタン。拡張機能が入らないタブなら undefined。 */
	getToolbar(viewId: string): Promise<IParadisBrowserExtensionToolbar | undefined>;
	/** ツールバーのボタンが変わった（バッジ・絵・ピン留め・読み込み）。renderer は見ているタブの分を取り直す。 */
	readonly onDidChangeToolbar: Event<void>;
	/**
	 * ボタンを押した: ポップアップを出す（もう一度押すと閉じる）か、ポップアップが無ければ action.onClicked を出す。
	 * `anchor` はボタンのあるウィンドウとその中の位置（CSS のピクセル）。`popupOnly` は action.openPopup の答え。
	 */
	activateAction(viewId: string, extensionId: string, anchor: IParadisToolbarAnchor, popupOnly: boolean): Promise<IParadisActionResult>;
	/** そのタブの場所（プロファイル）でピン留めする・外す。 */
	setPinned(viewId: string, extensionId: string, pinned: boolean): Promise<void>;
	/** そのタブの場所で拡張機能のオプションのページを開く。 */
	openOptions(viewId: string, extensionId: string): Promise<IParadisActionResult>;
	/** action.openPopup: ボタンの位置は workbench しか知らないので、そのタブのボタンから activateAction を呼んでもらう。 */
	readonly onDidRequestPopup: Event<IParadisPopupRequest>;
	/** ツールバーのボタンの右クリックに出す、その拡張機能の `action` の項目（chrome.contextMenus）。無ければ undefined。 */
	getActionMenu(viewId: string, extensionId: string): Promise<IParadisActionMenu | undefined>;
	/** その項目を押した（`token` は getActionMenu の答えのもの。1 回きり）。 */
	runActionMenuItem(token: string, extensionId: string, key: string): Promise<boolean>;
	/** 拡張機能のショートカット（workbench がページから届いたキーと比べる）。 */
	getCommands(): Promise<readonly IParadisBrowserExtensionCommand[]>;
	/** 利用者がそのタブでショートカットを押した（_execute_action 以外）。 */
	runCommand(viewId: string, extensionId: string, name: string): Promise<IParadisActionResult>;
}

/** ツールバーのボタンの右クリックの、拡張機能の項目。 */
export interface IParadisActionMenu {
	readonly token: string;
	readonly items: readonly IParadisActionMenuItem[];
}

/** 右クリックの項目 1 つ（common/paradisBrowserExtensionMenus.ts の IParadisVisibleMenuItem と同じ形）。 */
export interface IParadisActionMenuItem {
	readonly key: string;
	readonly title: string;
	readonly type: 'normal' | 'checkbox' | 'radio' | 'separator';
	readonly checked: boolean;
	readonly enabled: boolean;
	readonly children: readonly IParadisActionMenuItem[];
}

/** 拡張機能のショートカット 1 つ。 */
export interface IParadisBrowserExtensionCommand {
	readonly extensionId: string;
	readonly extensionName: string;
	readonly name: string;
	readonly description: string;
	/** 見せ方（macOS は「⇧⌘Y」）。 */
	readonly shortcut: string;
	readonly binding: { readonly key: string; readonly control: boolean; readonly meta: boolean; readonly alt: boolean; readonly shift: boolean };
}

/** ボタンの位置（ボタンのあるウィンドウの中、CSS のピクセル）。 */
export interface IParadisToolbarAnchor {
	/** ボタンのあるウィンドウ（BrowserWindow の id。タブは補助ウィンドウへ移ることがあるので、ボタンの側で決める）。 */
	readonly windowId: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** ボタンを押した結果。 */
export type IParadisActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** ツールバーのボタン 1 つ。 */
export interface IParadisToolbarAction {
	readonly extensionId: string;
	readonly name: string;
	/** ホバーの文（拡張機能が決める。無ければ名前）。 */
	readonly title: string;
	readonly iconDataUrl?: string;
	readonly badgeText: string;
	/** 拡張機能が決めた色（無ければテーマの色）。 */
	readonly badgeBackgroundColor?: string;
	readonly badgeTextColor?: string;
	readonly enabled: boolean;
	readonly hasPopup: boolean;
	readonly pinned: boolean;
	readonly hasOptionsPage: boolean;
}

/** タブのツールバー。 */
export interface IParadisBrowserExtensionToolbar {
	/** 場所（`default` / `profile:<id>`）。ピン留めはここごと（D2）。 */
	readonly place: string;
	/** ピン留めしたものがピン留めした順に先、残りは名前の順。 */
	readonly actions: readonly IParadisToolbarAction[];
}

/** action.openPopup の求め。 */
export interface IParadisPopupRequest {
	readonly requestId: number;
	readonly viewId: string;
	readonly extensionId: string;
}

/** タブを前に出す求め。 */
export interface IParadisActivateTabRequest {
	readonly windowId: number;
	readonly viewId: string;
}

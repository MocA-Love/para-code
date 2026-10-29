/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの Chrome 拡張機能（試験的）の main 側。台帳を保存し、内蔵ブラウザのセッションへ読み込む。
//
//  - 試験的な設定（paradis.browser.extensions.enabled）が起動の時点でオンのときだけ働く（切り替えは再起動で効く）
//  - 拡張機能は、利用者が選んだフォルダを Para Code が持つフォルダへ写してから読み込む（元のフォルダが消えても
//    動き、後の P4 で写しに詰め物を足せるように）。写しの場所は元のフォルダごとに決まる
//  - どのセッションへ入れるか（paradisBrowserExtensions.ts の paradisInstallBrowserExtensions から渡る）:
//    Global・Workspace は「既定」、名前付きプロファイルはそのプロファイル。Agent・Ephemeral には入れない。
//    Workspace のセッションが SSH 先のページのためにトンネルを通している間は外す（D8）
//  - 削除した拡張機能の保存データ（chrome.storage.local）は、Chromium が終了まで開いたままなので、次に
//    セッションを読み込むときに消す

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import type { BrowserWindow, Session } from 'electron';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { join, sep } from '../../../../base/common/path.js';
import { hasKey } from '../../../../base/common/types.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { BrowserViewStorageScope } from '../../../../platform/browserView/common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisAddExtensionResult,
	IParadisBrowserExtensionsLedger,
	IParadisActivateTabRequest,
	IParadisBrowserExtensionsMainService,
	IParadisBrowserExtensionsState,
	IParadisInstalledBrowserExtension,
	IParadisShareExtensions,
	IParadisViewBrowserExtension,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
	PARADIS_DEFAULT_EXTENSION_PROFILE,
	PARADIS_EMPTY_EXTENSIONS_LEDGER,
	PARADIS_MAX_EXTENSION_BYTES,
	PARADIS_MAX_EXTENSION_FILES,
	PARADIS_MAX_INSTALLED_EXTENSIONS,
	paradisEnabledExtensions,
	paradisIsExtensionId,
	paradisIsExtensionProfileKey,
	paradisLedgerWithDataCleared,
	paradisLedgerWithEnabled,
	paradisLedgerWithExtension,
	paradisLedgerWithoutExtension,
	paradisNeedsDataClear,
	paradisParseExtensionsLedger,
	paradisReadExtensionManifest,
} from '../common/paradisBrowserExtensions.js';
import { paradisIsPrivateExtensionFile, paradisPrepareExtensionCopy } from './paradisBrowserExtensionCopyRewrite.js';
import { ParadisApiSession, ParadisExtensionApiHost } from './paradisBrowserExtensionApiHost.js';
import { ParadisBrowserExtensionRuntimeState, ParadisExtensionLoadKind, paradisDecideRuntimeLifecycleEvents, paradisRegisterRuntimeApis } from './paradisBrowserExtensionRuntime.js';
import { ParadisBrowserExtensionSyncStore, paradisRegisterStorageApis } from './paradisBrowserExtensionStorageApis.js';
import { paradisBrowserExtensionContentScriptSource, paradisBrowserExtensionShimSource } from '../common/paradisBrowserExtensionShimSource.js';
import { IParadisTabEnvironment, ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';

/** タブ・ウィンドウの API に要る main のもの（無ければ tabs・windows・webNavigation は使えない）。 */
export interface IParadisBrowserExtensionTabsOptions {
	readonly environment: IParadisTabEnvironment;
	readonly createPopout: (session: Session, url: string, options: { readonly width?: number; readonly height?: number; readonly left?: number; readonly top?: number; readonly focused: boolean }) => BrowserWindow;
}
import { paradisProfileIdFromSessionId } from '../../browserProfiles/common/paradisBrowserProfileId.js';

/** 拡張機能を読み込むセッションの持ち主（BrowserSession の一部）。 */
export interface IParadisExtensionSessionOwner {
	readonly id: string;
	readonly storageScope: BrowserViewStorageScope;
	readonly remote?: {
		readonly isRemote: boolean;
		readonly onDidStart: Event<void>;
		readonly onDidStop: Event<void>;
	};
}

/** 管理に使う Electron の Session の一部（テストでは偽物を渡す）。 */
export type ParadisExtensionSession = Pick<Session, 'storagePath' | 'clearStorageData'> & ParadisApiSession & {
	readonly extensions: Pick<Session['extensions'], 'loadExtension' | 'removeExtension' | 'getExtension' | 'getAllExtensions'>;
};

/** セッションの持ち主から、拡張機能のプロファイルのキーを決める。入れないセッションなら undefined。 */
export function paradisExtensionProfileForSession(owner: IParadisExtensionSessionOwner): string | undefined {
	switch (owner.storageScope) {
		case BrowserViewStorageScope.Global:
		case BrowserViewStorageScope.Workspace:
			return PARADIS_DEFAULT_EXTENSION_PROFILE;
		case BrowserViewStorageScope.Profile: {
			const profileId = paradisProfileIdFromSessionId(owner.id);
			return profileId !== undefined ? `profile:${profileId}` : undefined;
		}
		default:
			// Agent（エージェントのタブ）と Ephemeral（使い捨て）には入れない
			return undefined;
	}
}

/** Chromium の拡張機能の id（SHA-256 の先頭 16 バイトを 0〜f → a〜p に置き換えた 32 文字）。 */
function chromiumExtensionId(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode('a'.charCodeAt(0) + parseInt(digit, 16)));
}

/**
 * manifest の key（base64 の公開鍵）があればそこから、無ければ読み込むフォルダの場所から、id を決める
 * （Chromium の crx_file::id_util::GenerateId / GenerateIdForPath と同じ）。`folder` は realpath 済みの絶対パス
 * （Electron は読み込む前に MakeAbsoluteFilePath で realpath にする）。Windows では UTF-16 のバイト列で、
 * ドライブ文字を大文字にそろえる（MaybeNormalizePath）。
 */
export function paradisPredictExtensionId(folder: string, key: string | undefined, platform: NodeJS.Platform = process.platform): string {
	if (key !== undefined) {
		return chromiumExtensionId(Buffer.from(key, 'base64'));
	}
	if (platform === 'win32') {
		const normalized = /^[a-z]:/.test(folder) ? folder[0].toUpperCase() + folder.slice(1) : folder;
		return chromiumExtensionId(Buffer.from(normalized, 'utf16le'));
	}
	return chromiumExtensionId(Buffer.from(folder, 'utf8'));
}

/** フォルダを写し終えた拡張機能。 */
interface ICopiedExtension {
	readonly ok: true;
	readonly path: string;
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly manifestVersion: number;
	readonly touchesPages: boolean;
}

/** 写すもの 1 つ（`relative` は写し先のフォルダからの相対パス）。`dev`・`ino` は調べたときの値。 */
interface ICopyItem {
	readonly kind: 'folder' | 'file';
	readonly source: string;
	readonly relative: string;
	readonly dev: bigint;
	readonly ino: bigint;
}

type CopyFailure = Extract<IParadisAddExtensionResult, { ok: false }>;
type CopyPlan = { readonly ok: true; readonly items: readonly ICopyItem[] } | CopyFailure;

/**
 * 写し先で同じ名前として扱われうるか比べるためのキー。macOS の APFS（既定）は大文字小文字と Unicode の
 * 正規化の違いを区別しないので、違う名前が黙って上書きされないよう、揃えた形で重なりを調べる。
 */
function collisionKey(relative: string): string {
	return relative.normalize('NFD').toLowerCase();
}

/**
 * 拡張機能のフォルダから写すものを決める。シンボリックリンクは実体を写すが、実体が元のフォルダの外にあれば
 * 断る（写しを元のフォルダから切り離し、外のファイルが web_accessible_resources 経由で読めないように）。
 * ハードリンク（リンク数が 2 以上のファイル）は外のファイルと同じ中身でありうるので断る。写し先で名前が
 * 重なるもの（大文字小文字・Unicode の正規化だけが違う）も断る。`.git` は写さない。ファイル数と大きさが
 * 上限を超えたら断る。
 */
export async function paradisPlanExtensionCopy(root: string, limits = { files: PARADIS_MAX_EXTENSION_FILES, bytes: PARADIS_MAX_EXTENSION_BYTES }): Promise<CopyPlan> {
	const items: ICopyItem[] = [];
	const names = new Set<string>();
	let files = 0;
	let bytes = 0;
	const inside = (path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
	const walk = async (folder: string, relative: string, ancestors: ReadonlySet<string>): Promise<CopyFailure | undefined> => {
		for (const dirent of await fs.readdir(folder, { withFileTypes: true })) {
			if (dirent.name === '.git') {
				continue;
			}
			const path = join(folder, dirent.name);
			const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
			let source = path;
			if (dirent.isSymbolicLink()) {
				try {
					source = await fs.realpath(path);
				} catch {
					continue; // 壊れたリンクは写さない（Chrome でも読めない）
				}
				if (!inside(source)) {
					return { ok: false, reason: 'linkOutside', detail: childRelative };
				}
			}
			const stat = await fs.stat(source, { bigint: true });
			if (!stat.isDirectory() && !stat.isFile()) {
				continue;
			}
			if (stat.isDirectory() && ancestors.has(source)) {
				continue; // 自分の親を指すリンク（輪）はたどらない
			}
			// Para Code が写しに書くファイルと同じ名前は断る（詰め物やトークンを拡張機能のもので上書きされないように）
			if (paradisIsPrivateExtensionFile(childRelative)) {
				return { ok: false, reason: 'reservedName', detail: childRelative };
			}
			const key = collisionKey(childRelative);
			if (names.has(key)) {
				return { ok: false, reason: 'nameClash', detail: childRelative };
			}
			names.add(key);
			if (stat.isDirectory()) {
				items.push({ kind: 'folder', source, relative: childRelative, dev: stat.dev, ino: stat.ino });
				const failure = await walk(source, childRelative, new Set([...ancestors, source]));
				if (failure) {
					return failure;
				}
			} else {
				if (stat.nlink > 1n) {
					return { ok: false, reason: 'hardLink', detail: childRelative };
				}
				files++;
				bytes += Number(stat.size);
				if (files > limits.files) {
					return { ok: false, reason: 'tooLarge', detail: 'files' };
				}
				if (bytes > limits.bytes) {
					return { ok: false, reason: 'tooLarge', detail: 'bytes' };
				}
				items.push({ kind: 'file', source, relative: childRelative, dev: stat.dev, ino: stat.ino });
			}
		}
		return undefined;
	};
	const failure = await walk(root, '', new Set([root]));
	return failure ?? { ok: true, items };
}

/**
 * 決めたとおりに `target` へ写す。ファイルは開いた fd が調べたときと同じもの（dev・inode）で、リンク数が 1 の
 * ときだけ読む。写した後にも元の場所を lstat し直し、調べたときと違えば（途中で差し替えられた）断る。
 * 写し先には新しく作るだけで、既にある名前は上書きしない。
 */
export async function paradisCopyExtensionFiles(items: readonly ICopyItem[], target: string): Promise<CopyFailure | undefined> {
	const same = (stat: { readonly dev: bigint; readonly ino: bigint }, item: ICopyItem) => stat.dev === item.dev && stat.ino === item.ino;
	for (const item of items) {
		const destination = join(target, item.relative);
		if (item.kind === 'folder') {
			const stat = await fs.stat(item.source, { bigint: true });
			if (!stat.isDirectory() || !same(stat, item)) {
				return { ok: false, reason: 'changed', detail: item.relative };
			}
			await fs.mkdir(destination);
			continue;
		}
		const handle = await fs.open(item.source, 'r');
		try {
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile() || !same(stat, item) || stat.nlink > 1n) {
				return { ok: false, reason: 'changed', detail: item.relative };
			}
			await fs.writeFile(destination, await handle.readFile(), { flag: 'wx' });
		} finally {
			await handle.close();
		}
		const after = await fs.lstat(item.source, { bigint: true });
		if (!after.isFile() || !same(after, item)) {
			return { ok: false, reason: 'changed', detail: item.relative };
		}
	}
	return undefined;
}

/** 写している途中のフォルダの名前に入る印。 */
const TEMPORARY_COPY_MARK = '.tmp-';

interface ISessionEntry {
	readonly session: ParadisExtensionSession;
	readonly profile: string;
	readonly isRemote: () => boolean;
}

export class ParadisBrowserExtensionsManager implements Omit<IParadisBrowserExtensionsMainService, 'onDidRequestActivateTab'>, IDisposable {

	private readonly _disposables = new DisposableStore();
	private readonly _sessions = new Set<ISessionEntry>();
	private readonly _loadErrors = new Map<string, string>();
	private _ledger: IParadisBrowserExtensionsLedger = PARADIS_EMPTY_EXTENSIONS_LEDGER;
	private readonly _ready: Promise<void>;
	/** 台帳を書く順番（同時に書かない）。 */
	private _saving: Promise<void> = Promise.resolve();
	/** 起動の時点の設定の値（切り替えは再起動で効く）。 */
	readonly active: boolean;
	/** 詰め物の呼び出しを受ける main 側（P4）。 */
	private readonly _apiHost: ParadisExtensionApiHost;
	/** tabs・windows・webNavigation（P4b）。 */
	private readonly _tabs: ParadisBrowserExtensionTabs | undefined;
	private readonly _syncStore: ParadisBrowserExtensionSyncStore;
	private readonly _runtimeState: ParadisBrowserExtensionRuntimeState;
	/** この起動で詰め物を書き込んだ写し（写しのパス → 失敗の文。成功なら undefined）。 */
	private readonly _prepared = new Map<string, Promise<string | undefined>>();
	/** 詰め物を入れられなかったページ（UTF-8 でないもの）。管理画面で知らせる。 */
	private readonly _notes = new Map<string, readonly string[]>();

	constructor(
		private readonly _root: string,
		private readonly _readSetting: () => boolean,
		private readonly _logService: Pick<ILogService, 'warn'>,
		/** 内蔵ブラウザのビューの id から、そのセッションを引く（共有の確認に使う）。 */
		private readonly _sessionForView: (viewId: string) => ParadisExtensionSession | undefined = () => undefined,
		tabsOptions?: IParadisBrowserExtensionTabsOptions,
	) {
		this.active = _readSetting();
		this._apiHost = new ParadisExtensionApiHost(_logService);
		this._syncStore = new ParadisBrowserExtensionSyncStore(join(_root, 'sync-storage'), _logService);
		this._runtimeState = new ParadisBrowserExtensionRuntimeState(join(_root, 'runtime-state.json'), _logService);
		paradisRegisterStorageApis(this._apiHost, this._syncStore);
		this._tabs = tabsOptions && this.active ? new ParadisBrowserExtensionTabs(this._apiHost, tabsOptions.environment, _logService, tabsOptions.createPopout) : undefined;
		const tabs = this._tabs;
		paradisRegisterRuntimeApis(this._apiHost, tabs ? caller => tabs.openOptionsPage(caller) : undefined);
		this._ready = this.active ? this._loadLedger() : Promise.resolve();
	}

	dispose(): void {
		this._disposables.dispose();
		this._tabs?.dispose();
		this._apiHost.dispose();
		void this._syncStore.flush();
	}

	private get _ledgerPath(): string {
		return join(this._root, 'ledger.json');
	}

	private async _loadLedger(): Promise<void> {
		try {
			this._ledger = paradisParseExtensionsLedger(JSON.parse(await fs.readFile(this._ledgerPath, 'utf8')));
		} catch {
			this._ledger = PARADIS_EMPTY_EXTENSIONS_LEDGER;
		}
		await fs.mkdir(this._root, { recursive: true }).catch(() => { /* reported when saving */ });
		await this._runtimeState.load();
		// 削除の途中に落ちて残った storage.sync の中身を片付ける
		await this._syncStore.forgetExtensionsExcept(new Set(this._ledger.extensions.map(extension => extension.id)));
		// 前の起動で写している途中に落ちて残ったフォルダを片付ける
		const unpacked = join(this._root, 'unpacked');
		for (const name of await fs.readdir(unpacked).catch(() => [])) {
			if (name.includes(TEMPORARY_COPY_MARK)) {
				await fs.rm(join(unpacked, name), { recursive: true, force: true }).catch(() => { /* best effort */ });
			}
		}
	}

	private _save(): Promise<void> {
		const ledger = this._ledger;
		this._saving = this._saving.then(async () => {
			await fs.mkdir(this._root, { recursive: true });
			const temporary = `${this._ledgerPath}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(ledger, undefined, '\t'));
			await fs.rename(temporary, this._ledgerPath);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extensions ledger', error));
		return this._saving;
	}

	/** 内蔵ブラウザのセッションができた（BrowserSession.configure から）。 */
	attach(session: ParadisExtensionSession, owner: IParadisExtensionSessionOwner): Promise<void> {
		const profile = paradisExtensionProfileForSession(owner);
		if (!this.active || profile === undefined) {
			return Promise.resolve();
		}
		const remote = owner.storageScope === BrowserViewStorageScope.Workspace ? owner.remote : undefined;
		const entry: ISessionEntry = { session, profile, isRemote: () => remote?.isRemote === true };
		this._sessions.add(entry);
		// 詰め物の呼び出しの受け手は、拡張機能を読み込む前に立てる（worker は読み込んですぐ動き出す）
		this._disposables.add(this._apiHost.attachSession(session, profile));
		if (this._tabs) {
			this._disposables.add(this._tabs.attachSession({ session, electronSession: session as unknown as Session, browserSessionId: owner.id }));
		}
		if (remote) {
			// SSH 先のページのためにトンネルを通している間は、拡張機能を入れない（D8）
			this._disposables.add(remote.onDidStart(() => this._unloadAll(entry)));
			this._disposables.add(remote.onDidStop(() => void this._loadAll(entry, 'other')));
		}
		return this._ready.then(async () => {
			// 削除した拡張機能の保存データで、このセッションでまだ消していないものを消す
			for (const { id } of this._ledger.removed) {
				await this._ensureDataCleared(entry, id);
			}
			if (!entry.isRemote()) {
				await this._loadAll(entry, 'startup');
			}
		});
	}

	/** この起動の中で削除した id（chrome.storage を消せないので、再起動まで入れ直させない）。 */
	private readonly _removedThisRun = new Set<string>();

	/** 消している途中の保存データ（同じ保存先・同じ id を二重に消さない）。 */
	private readonly _clearing = new Map<string, Promise<void>>();

	/**
	 * 削除した拡張機能の保存データを、このセッションでまだ消していなければ消す。読み込む前に必ず通す
	 * （削除の後に入れ直したとき、古いデータを渡さないため）。
	 */
	private _ensureDataCleared(entry: ISessionEntry, id: string): Promise<void> {
		const storagePath = entry.session.storagePath;
		if (!storagePath || !paradisNeedsDataClear(this._ledger, id, storagePath)) {
			return Promise.resolve();
		}
		const key = `${storagePath}\n${id}`;
		let clearing = this._clearing.get(key);
		if (!clearing) {
			clearing = (async () => {
				// 消せなかった保存先は「消し終えた」にしない（次に読み込む前・次の起動でもう一度消す）
				if (await this._clearData(entry.session, id)) {
					this._ledger = paradisLedgerWithDataCleared(this._ledger, id, storagePath);
					await this._save();
				}
			})().finally(() => this._clearing.delete(key));
			this._clearing.set(key, clearing);
		}
		return clearing;
	}

	/**
	 * 拡張機能の保存データを消す。IndexedDB・Local Storage・CacheStorage などは拡張機能の origin ごとに
	 * Chromium に消させ、chrome.storage（origin に属さないフォルダ）はファイルを消す。
	 */
	private async _clearData(session: ParadisExtensionSession, id: string): Promise<boolean> {
		let cleared = true;
		try {
			await session.clearStorageData({ origin: `chrome-extension://${id}` });
		} catch (error) {
			cleared = false;
			this._logService.warn('[paradis] could not clear the storage of a removed browser extension', error);
		}
		const storagePath = session.storagePath;
		if (storagePath) {
			for (const folder of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']) {
				try {
					// force: 無いフォルダは消し終えたとみなす。それ以外の失敗（権限など）は消せなかったとする
					await fs.rm(join(storagePath, folder, id), { recursive: true, force: true });
				} catch (error) {
					cleared = false;
					this._logService.warn('[paradis] could not remove the chrome.storage data of a removed browser extension', error);
				}
			}
		}
		return cleared;
	}

	private async _loadAll(entry: ISessionEntry, kind: ParadisExtensionLoadKind): Promise<void> {
		for (const extension of paradisEnabledExtensions(this._ledger, entry.profile)) {
			await this._load(entry, extension, kind);
		}
	}

	/** 写しに詰め物を書く（起動ごと、写しごとに 1 回。同じ写しを使うセッションが重なっても 1 回だけ書く）。 */
	private _prepare(extension: IParadisInstalledBrowserExtension): Promise<string | undefined> {
		let preparing = this._prepared.get(extension.path);
		if (!preparing) {
			preparing = paradisPrepareExtensionCopy(extension.path, this._apiHost.tokenFor(extension.id), paradisBrowserExtensionShimSource(), paradisBrowserExtensionContentScriptSource())
				.then(prepared => {
					if (prepared.skippedPages.length > 0) {
						this._notes.set(extension.id, prepared.skippedPages);
					} else {
						this._notes.delete(extension.id);
					}
					return undefined;
				}, (error: unknown) => error instanceof Error ? error.message : String(error));
			this._prepared.set(extension.path, preparing);
		}
		return preparing;
	}

	/** Electron が出さない runtime.onInstalled・onStartup を出す（読み込んだ後）。 */
	private async _fireRuntimeLifecycle(entry: ISessionEntry, loaded: { readonly id: string; readonly version: string; readonly manifest: unknown }, kind: ParadisExtensionLoadKind): Promise<void> {
		const storagePath = entry.session.storagePath;
		if (!storagePath) {
			return;
		}
		const current = { extensionVersion: loaded.version, chromiumVersion: process.versions.chrome ?? '' };
		const background = (loaded.manifest as { background?: { service_worker?: unknown } } | undefined)?.background;
		if (typeof background?.service_worker === 'string') {
			for (const { event, args } of paradisDecideRuntimeLifecycleEvents(this._runtimeState.read(storagePath, loaded.id), current, kind)) {
				this._apiHost.emitToWorkerWhenListening(entry.session, loaded.id, 'runtime', event, args);
			}
		}
		// 出した後に記録する（記録の前に落ちたら、次は出し直す。出し損ねるよりよい）
		await this._runtimeState.update(storagePath, loaded.id, current);
	}

	private async _load(entry: ISessionEntry, extension: IParadisInstalledBrowserExtension, kind: ParadisExtensionLoadKind): Promise<void> {
		if (entry.isRemote() || entry.session.extensions.getExtension(extension.id)) {
			return;
		}
		await this._ensureDataCleared(entry, extension.id);
		if (entry.isRemote() || entry.session.extensions.getExtension(extension.id)) {
			return;
		}
		const prepareError = await this._prepare(extension);
		if (prepareError !== undefined) {
			this._loadErrors.set(extension.id, prepareError);
			return;
		}
		try {
			const loaded = await entry.session.extensions.loadExtension(extension.path, { allowFileAccess: false });
			if (loaded.id !== extension.id) {
				entry.session.extensions.removeExtension(loaded.id);
				this._loadErrors.set(extension.id, `unexpected extension id ${loaded.id}`);
				return;
			}
			// 読み込みの途中でトンネルが始まった・無効にされた・削除されたときは外す
			if (entry.isRemote() || !(this._ledger.enabled[entry.profile] ?? []).includes(extension.id)) {
				entry.session.extensions.removeExtension(loaded.id);
				return;
			}
			this._loadErrors.delete(extension.id);
			await this._fireRuntimeLifecycle(entry, loaded, kind);
		} catch (error) {
			this._loadErrors.set(extension.id, error instanceof Error ? error.message : String(error));
		}
	}

	private _unload(entry: ISessionEntry, id: string): void {
		this._tabs?.closePopoutsOf(entry.session as unknown as Session, id);
		try {
			if (entry.session.extensions.getExtension(id)) {
				entry.session.extensions.removeExtension(id);
			}
		} catch (error) {
			this._logService.warn('[paradis] could not unload a browser extension', error);
		}
	}

	private _unloadAll(entry: ISessionEntry): void {
		for (const extension of this._ledger.extensions) {
			this._unload(entry, extension.id);
		}
	}

	async getShareExtensions(viewId: string | undefined, fallbackProfile: string | undefined): Promise<IParadisShareExtensions> {
		await this._ready;
		if (!this.active) {
			return { active: false, extensions: [] };
		}
		const describe = ({ id, name, touchesPages }: IParadisInstalledBrowserExtension): IParadisViewBrowserExtension => ({ id, name, touchesPages });
		const session = typeof viewId === 'string' ? this._sessionForView(viewId) : undefined;
		if (session) {
			// 開いているページ: そのセッションに今入っているものに、そのセッションの場所で有効にしてあるものを足す。
			// 開いたばかりのタブ（再起動の後の共有の戻しなど）では読み込みが終わる前に聞かれるので、入っている
			// ものだけでは知らせ損ねる。SSH 先のページのためにトンネルを通している間は入らないので足さない（D8）。
			// 同梱の React DevTools など、台帳に無いものは数えない
			const entry = [...this._sessions].find(candidate => candidate.session === session);
			const enabled = entry && !entry.isRemote() ? new Set(this._ledger.enabled[entry.profile] ?? []) : new Set<string>();
			return { active: true, extensions: this._ledger.extensions.filter(extension => enabled.has(extension.id) || session.extensions.getExtension(extension.id)).map(describe) };
		}
		// まだ開いていないページ・これから開くプロファイル: 有効にしてあるもの
		return { active: true, extensions: paradisIsExtensionProfileKey(fallbackProfile) ? paradisEnabledExtensions(this._ledger, fallbackProfile).map(describe) : [] };
	}

	async getState(): Promise<IParadisBrowserExtensionsState> {
		await this._ready;
		return {
			active: this.active,
			setting: this._readSetting(),
			extensions: this._ledger.extensions.map(extension => ({
				...extension,
				enabledIn: Object.entries(this._ledger.enabled).filter(([, ids]) => ids.includes(extension.id)).map(([profile]) => profile),
				...(this._loadErrors.has(extension.id) ? { loadError: this._loadErrors.get(extension.id) } : {}),
				...(this._notes.has(extension.id) ? { pagesWithoutApis: this._notes.get(extension.id) } : {}),
			})),
		};
	}

	/** 元のフォルダを Para Code の持つフォルダへ写し、manifest を読む。 */
	private async _copyFromFolder(folder: string): Promise<ICopiedExtension | Extract<IParadisAddExtensionResult, { ok: false }>> {
		let real: string;
		try {
			real = await fs.realpath(folder);
			if (!(await fs.stat(real)).isDirectory()) {
				return { ok: false, reason: 'notFolder' };
			}
		} catch {
			return { ok: false, reason: 'notFolder' };
		}
		let manifestRaw: unknown;
		try {
			manifestRaw = JSON.parse(await fs.readFile(join(real, 'manifest.json'), 'utf8'));
		} catch {
			return { ok: false, reason: 'noManifest' };
		}
		let messages: unknown;
		const defaultLocale = typeof (manifestRaw as { default_locale?: unknown } | undefined)?.default_locale === 'string' ? (manifestRaw as { default_locale: string }).default_locale : undefined;
		if (defaultLocale !== undefined && /^[A-Za-z_-]{1,20}$/.test(defaultLocale)) {
			messages = await fs.readFile(join(real, '_locales', defaultLocale, 'messages.json'), 'utf8').then(text => JSON.parse(text), () => undefined);
		}
		const manifest = paradisReadExtensionManifest(manifestRaw, messages);
		if (hasKey(manifest, { error: true })) {
			return { ok: false, reason: 'invalidManifest', detail: manifest.error };
		}
		const copy = join(this._root, 'unpacked', createHash('sha256').update(real).digest('hex').slice(0, 16));
		try {
			const plan = await paradisPlanExtensionCopy(real);
			if (!plan.ok) {
				return plan;
			}
			// 別の場所に写し終えてから置き換える（途中で失敗しても前の写しは壊さない。途中で落ちて残った
			// `<hash>.tmp-*` は次の起動で片付ける）
			const temporary = `${copy}${TEMPORARY_COPY_MARK}${Date.now().toString(36)}`;
			await fs.mkdir(temporary, { recursive: true });
			try {
				const failure = await paradisCopyExtensionFiles(plan.items, temporary);
				if (failure) {
					await fs.rm(temporary, { recursive: true, force: true }).catch(() => { /* best effort */ });
					return failure;
				}
				await fs.rm(copy, { recursive: true, force: true });
				await fs.rename(temporary, copy);
			} catch (error) {
				await fs.rm(temporary, { recursive: true, force: true }).catch(() => { /* best effort */ });
				throw error;
			}
		} catch (error) {
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		let realCopy: string;
		try {
			realCopy = await fs.realpath(copy);
		} catch (error) {
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, path: realCopy, id: paradisPredictExtensionId(realCopy, manifest.key), name: manifest.name, version: manifest.version, manifestVersion: manifest.manifestVersion, touchesPages: manifest.touchesPages };
	}

	async addUnpacked(folder: string, profile: string): Promise<IParadisAddExtensionResult> {
		await this._ready;
		if (!this.active) {
			return { ok: false, reason: 'inactive' };
		}
		if (typeof folder !== 'string' || folder.length === 0 || !paradisIsExtensionProfileKey(profile)) {
			return { ok: false, reason: 'notFolder' };
		}
		const copied = await this._copyFromFolder(folder);
		if (!copied.ok) {
			return copied;
		}
		if (this._removedThisRun.has(copied.id)) {
			await fs.rm(copied.path, { recursive: true, force: true }).catch(() => { /* best effort */ });
			return { ok: false, reason: 'restartNeeded' };
		}
		const existing = this._ledger.extensions.find(extension => extension.id === copied.id);
		if (!existing && this._ledger.extensions.length >= PARADIS_MAX_INSTALLED_EXTENSIONS) {
			return { ok: false, reason: 'tooMany' };
		}
		// 同じ id の古い版が読み込まれていれば外してから読み込み直す
		for (const entry of this._sessions) {
			this._unload(entry, copied.id);
		}
		if (existing && existing.path !== copied.path) {
			// 同じ key の拡張機能を別のフォルダから足した。前のフォルダの写しは使わなくなる
			await fs.rm(existing.path, { recursive: true, force: true }).catch(() => { /* already gone */ });
		}
		const extension: IParadisInstalledBrowserExtension = {
			id: copied.id, name: copied.name, version: copied.version, manifestVersion: copied.manifestVersion,
			source: 'unpacked', sourcePath: folder, path: copied.path, installedAt: existing?.installedAt ?? Date.now(), touchesPages: copied.touchesPages,
		};
		this._ledger = paradisLedgerWithExtension(this._ledger, extension, profile);
		await this._save();
		// 写しを作り直したので、詰め物も書き直す
		this._prepared.delete(extension.path);
		await this._applyEnablement(extension.id, existing ? 'reload' : 'other');
		return { ok: true, extension };
	}

	async reloadUnpacked(id: string): Promise<IParadisAddExtensionResult> {
		await this._ready;
		const existing = this._ledger.extensions.find(extension => extension.id === id);
		if (!this.active) {
			return { ok: false, reason: 'inactive' };
		}
		if (!existing) {
			return { ok: false, reason: 'notFolder' };
		}
		const copied = await this._copyFromFolder(existing.sourcePath);
		if (!copied.ok) {
			return copied;
		}
		for (const entry of this._sessions) {
			this._unload(entry, id);
		}
		if (copied.id !== id) {
			// manifest の key を変えると別の拡張機能になる。写しは作り直したので、元の id では読み込めない印を残す
			this._loadErrors.set(id, 'id changed');
			return { ok: false, reason: 'invalidManifest', detail: 'id changed' };
		}
		const extension: IParadisInstalledBrowserExtension = { ...existing, name: copied.name, version: copied.version, manifestVersion: copied.manifestVersion, path: copied.path, touchesPages: copied.touchesPages };
		this._ledger = paradisLedgerWithExtension(this._ledger, extension, undefined);
		await this._save();
		this._prepared.delete(extension.path);
		await this._applyEnablement(id, 'reload');
		return { ok: true, extension };
	}

	/** 今の台帳のとおりに、各セッションへ読み込む・外す。 */
	private async _applyEnablement(id: string, kind: ParadisExtensionLoadKind): Promise<void> {
		const extension = this._ledger.extensions.find(candidate => candidate.id === id);
		for (const entry of this._sessions) {
			const wanted = extension !== undefined && (this._ledger.enabled[entry.profile] ?? []).includes(id);
			if (wanted) {
				await this._load(entry, extension, kind);
			} else {
				this._unload(entry, id);
			}
		}
	}

	async setEnabled(id: string, profile: string, enabled: boolean): Promise<void> {
		await this._ready;
		if (!this.active || !paradisIsExtensionId(id) || !paradisIsExtensionProfileKey(profile) || typeof enabled !== 'boolean') {
			return;
		}
		this._ledger = paradisLedgerWithEnabled(this._ledger, id, profile, enabled);
		await this._save();
		await this._applyEnablement(id, 'other');
	}

	async remove(id: string): Promise<void> {
		// 待つ前に印を付ける（削除の途中に同じ id を足されて、古いデータを渡さないため）
		const marked = this.active && paradisIsExtensionId(id) && !this._removedThisRun.has(id);
		if (marked) {
			this._removedThisRun.add(id);
		}
		await this._ready;
		const existing = this._ledger.extensions.find(extension => extension.id === id);
		if (!this.active || !existing) {
			if (marked) {
				this._removedThisRun.delete(id);
			}
			return;
		}
		for (const entry of this._sessions) {
			this._unload(entry, id);
		}
		this._ledger = paradisLedgerWithoutExtension(this._ledger, id);
		this._loadErrors.delete(id);
		await this._save();
		await fs.rm(existing.path, { recursive: true, force: true }).catch(() => { /* already gone */ });
		this._prepared.delete(existing.path);
		// storage.sync（main が持つ）と、最後に読み込んだ版（入れ直したら install から出す）も消す
		await this._syncStore.forgetExtension(id);
		await this._runtimeState.forgetExtension(id);
		// IndexedDB・Local Storage・CacheStorage は今あるセッションからすぐ消す。chrome.storage は Chromium が
		// 終了まで開いたままで、ファイルを消しても中身が残る（Electron 43 で実測）ので、どのセッションも
		// 「消し終えた」にはせず、次の起動で読み込む前にもう一度まとめて消す
		for (const entry of this._sessions) {
			await this._clearData(entry.session, id);
		}
	}
}

/** main に 1 つの管理（channel の登録の前にできたセッションは、登録の時点で渡す）。 */
let manager: ParadisBrowserExtensionsManager | undefined;
const pendingSessions: Array<{ readonly session: ParadisExtensionSession; readonly owner: IParadisExtensionSessionOwner }> = [];

/** 内蔵ブラウザのセッションができた（paradisInstallBrowserExtensions から）。 */
export function paradisAttachBrowserExtensionSession(session: ParadisExtensionSession, owner: IParadisExtensionSessionOwner): void {
	if (manager) {
		void manager.attach(session, owner);
	} else if (pendingSessions.length < 1_000) {
		pendingSessions.push({ session, owner });
	}
}

/** main の起動で拡張機能の管理を作り、channel を立てる（paradisRegisterBrowserProfiles から）。 */
export function paradisRegisterBrowserExtensions(
	channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	instantiationService: IInstantiationService,
	/**
	 * ビューの id からそのセッションを引く。browserViewMainService は browserSession.ts を読むので、ここから
	 * 読むと読み込みが輪になる（browserSession.ts → このファイル）。呼び出し側（プロファイルの main）から渡す。
	 */
	sessionForView: (viewId: string) => ParadisExtensionSession | undefined,
	/**
	 * タブ・ウィンドウの口を作る（試験的な設定がオンのときだけ呼ぶ。オフの人には BrowserView の購読もさせない）。
	 * タブを前に出すことだけは、ここで workbench への知らせにする。
	 */
	createTabs?: () => { readonly environment: Omit<IParadisTabEnvironment, 'activateTab'> & IDisposable; readonly createPopout: IParadisBrowserExtensionTabsOptions['createPopout'] },
): IDisposable {
	const disposables = new DisposableStore();
	const onDidRequestActivateTab = disposables.add(new Emitter<IParadisActivateTabRequest>());
	const created = instantiationService.invokeFunction(accessor => {
		const configurationService = accessor.get(IConfigurationService);
		const tabs = createTabs && configurationService.getValue<boolean>(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING) === true ? createTabs() : undefined;
		if (tabs) {
			disposables.add(tabs.environment);
		}
		return new ParadisBrowserExtensionsManager(
			join(accessor.get(IEnvironmentMainService).userDataPath, 'paradis-browser-extensions'),
			() => configurationService.getValue<boolean>(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING) === true,
			accessor.get(ILogService),
			sessionForView,
			tabs ? {
				environment: { ...tabs.environment, activateTab: (windowId, viewId) => onDidRequestActivateTab.fire({ windowId, viewId }) },
				createPopout: tabs.createPopout,
			} : undefined,
		);
	});
	disposables.add(created);
	manager = created;
	for (const { session, owner } of pendingSessions.splice(0)) {
		void created.attach(session, owner);
	}
	// renderer に見せるのは管理画面の 5 つだけ（attach・dispose は main の中からだけ呼ぶ）
	const exposed: IParadisBrowserExtensionsMainService = {
		getState: () => created.getState(),
		addUnpacked: (folder, profile) => created.addUnpacked(folder, profile),
		reloadUnpacked: id => created.reloadUnpacked(id),
		setEnabled: (id, profile, enabled) => created.setEnabled(id, profile, enabled),
		remove: id => created.remove(id),
		getShareExtensions: (viewId, fallbackProfile) => created.getShareExtensions(viewId, fallbackProfile),
		onDidRequestActivateTab: onDidRequestActivateTab.event,
	};
	channelHost.registerChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL, ProxyChannel.fromService(exposed, disposables));
	return disposables;
}

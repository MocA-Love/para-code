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
import type { Session } from 'electron';
import type { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { dirname, join } from '../../../../base/common/path.js';
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
	IParadisBrowserExtensionsMainService,
	IParadisBrowserExtensionsState,
	IParadisInstalledBrowserExtension,
	PARADIS_BROWSER_EXTENSIONS_CHANNEL,
	PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING,
	PARADIS_DEFAULT_EXTENSION_PROFILE,
	PARADIS_EMPTY_EXTENSIONS_LEDGER,
	PARADIS_MAX_INSTALLED_EXTENSIONS,
	paradisEnabledExtensions,
	paradisIsExtensionId,
	paradisIsExtensionProfileKey,
	paradisLedgerWithEnabled,
	paradisLedgerWithExtension,
	paradisLedgerWithoutExtension,
	paradisParseExtensionsLedger,
	paradisReadExtensionManifest,
} from '../common/paradisBrowserExtensions.js';
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
export type ParadisExtensionSession = Pick<Session, 'storagePath'> & {
	readonly extensions: Pick<Session['extensions'], 'loadExtension' | 'removeExtension' | 'getExtension'>;
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
}

interface ISessionEntry {
	readonly session: ParadisExtensionSession;
	readonly profile: string;
	readonly isRemote: () => boolean;
}

export class ParadisBrowserExtensionsManager implements IParadisBrowserExtensionsMainService, IDisposable {

	private readonly _disposables = new DisposableStore();
	private readonly _sessions = new Set<ISessionEntry>();
	private readonly _loadErrors = new Map<string, string>();
	private _ledger: IParadisBrowserExtensionsLedger = PARADIS_EMPTY_EXTENSIONS_LEDGER;
	private readonly _ready: Promise<void>;
	/** 台帳を書く順番（同時に書かない）。 */
	private _saving: Promise<void> = Promise.resolve();
	/** 起動の時点の設定の値（切り替えは再起動で効く）。 */
	readonly active: boolean;

	constructor(
		private readonly _root: string,
		private readonly _readSetting: () => boolean,
		private readonly _logService: Pick<ILogService, 'warn'>,
	) {
		this.active = _readSetting();
		this._ready = this.active ? this._loadLedger() : Promise.resolve();
	}

	dispose(): void {
		this._disposables.dispose();
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
		if (remote) {
			// SSH 先のページのためにトンネルを通している間は、拡張機能を入れない（D8）
			this._disposables.add(remote.onDidStart(() => this._unloadAll(entry)));
			this._disposables.add(remote.onDidStop(() => void this._loadAll(entry)));
		}
		return this._ready.then(async () => {
			await this._removeLeftoverData(session);
			if (!entry.isRemote()) {
				await this._loadAll(entry);
			}
		});
	}

	/** 削除した拡張機能の保存データを消す（Chromium は終了まで開いたままなので、次の読み込みの前に）。 */
	private async _removeLeftoverData(session: ParadisExtensionSession): Promise<void> {
		const storagePath = session.storagePath;
		if (!storagePath) {
			return;
		}
		for (const id of this._ledger.removed) {
			for (const folder of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']) {
				await fs.rm(join(storagePath, folder, id), { recursive: true, force: true }).catch(() => { /* already gone */ });
			}
		}
	}

	private async _loadAll(entry: ISessionEntry): Promise<void> {
		for (const extension of paradisEnabledExtensions(this._ledger, entry.profile)) {
			await this._load(entry, extension);
		}
	}

	private async _load(entry: ISessionEntry, extension: IParadisInstalledBrowserExtension): Promise<void> {
		if (entry.isRemote() || entry.session.extensions.getExtension(extension.id)) {
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
		} catch (error) {
			this._loadErrors.set(extension.id, error instanceof Error ? error.message : String(error));
		}
	}

	private _unload(entry: ISessionEntry, id: string): void {
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

	async getState(): Promise<IParadisBrowserExtensionsState> {
		await this._ready;
		return {
			active: this.active,
			setting: this._readSetting(),
			extensions: this._ledger.extensions.map(extension => ({
				...extension,
				enabledIn: Object.entries(this._ledger.enabled).filter(([, ids]) => ids.includes(extension.id)).map(([profile]) => profile),
				...(this._loadErrors.has(extension.id) ? { loadError: this._loadErrors.get(extension.id) } : {}),
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
			await fs.rm(copy, { recursive: true, force: true });
			await fs.mkdir(dirname(copy), { recursive: true });
			await fs.cp(real, copy, { recursive: true, dereference: false, errorOnExist: false });
		} catch (error) {
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		let realCopy: string;
		try {
			realCopy = await fs.realpath(copy);
		} catch (error) {
			return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, path: realCopy, id: paradisPredictExtensionId(realCopy, manifest.key), name: manifest.name, version: manifest.version, manifestVersion: manifest.manifestVersion };
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
		const existing = this._ledger.extensions.find(extension => extension.id === copied.id);
		if (!existing && this._ledger.extensions.length >= PARADIS_MAX_INSTALLED_EXTENSIONS) {
			return { ok: false, reason: 'tooMany' };
		}
		// 同じ id の古い版が読み込まれていれば外してから読み込み直す
		for (const entry of this._sessions) {
			this._unload(entry, copied.id);
		}
		const extension: IParadisInstalledBrowserExtension = {
			id: copied.id, name: copied.name, version: copied.version, manifestVersion: copied.manifestVersion,
			source: 'unpacked', sourcePath: folder, path: copied.path, installedAt: existing?.installedAt ?? Date.now(),
		};
		this._ledger = paradisLedgerWithExtension(this._ledger, extension, profile);
		await this._save();
		await this._applyEnablement(extension.id);
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
		const extension: IParadisInstalledBrowserExtension = { ...existing, name: copied.name, version: copied.version, manifestVersion: copied.manifestVersion, path: copied.path };
		this._ledger = paradisLedgerWithExtension(this._ledger, extension, undefined);
		await this._save();
		await this._applyEnablement(id);
		return { ok: true, extension };
	}

	/** 今の台帳のとおりに、各セッションへ読み込む・外す。 */
	private async _applyEnablement(id: string): Promise<void> {
		const extension = this._ledger.extensions.find(candidate => candidate.id === id);
		for (const entry of this._sessions) {
			const wanted = extension !== undefined && (this._ledger.enabled[entry.profile] ?? []).includes(id);
			if (wanted) {
				await this._load(entry, extension);
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
		await this._applyEnablement(id);
	}

	async remove(id: string): Promise<void> {
		await this._ready;
		const existing = this._ledger.extensions.find(extension => extension.id === id);
		if (!this.active || !existing) {
			return;
		}
		for (const entry of this._sessions) {
			this._unload(entry, id);
		}
		this._ledger = paradisLedgerWithoutExtension(this._ledger, id);
		this._loadErrors.delete(id);
		await this._save();
		await fs.rm(existing.path, { recursive: true, force: true }).catch(() => { /* already gone */ });
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
): IDisposable {
	const disposables = new DisposableStore();
	const created = instantiationService.invokeFunction(accessor => {
		const configurationService = accessor.get(IConfigurationService);
		return new ParadisBrowserExtensionsManager(
			join(accessor.get(IEnvironmentMainService).userDataPath, 'paradis-browser-extensions'),
			() => configurationService.getValue<boolean>(PARADIS_BROWSER_EXTENSIONS_ENABLED_SETTING) === true,
			accessor.get(ILogService),
		);
	});
	disposables.add(created);
	manager = created;
	for (const { session, owner } of pendingSessions.splice(0)) {
		void created.attach(session, owner);
	}
	channelHost.registerChannel(PARADIS_BROWSER_EXTENSIONS_CHANNEL, ProxyChannel.fromService(created, disposables));
	return disposables;
}

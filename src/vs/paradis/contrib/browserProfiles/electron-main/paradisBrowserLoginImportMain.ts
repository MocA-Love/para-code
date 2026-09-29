/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 他ブラウザからのログイン取り込みの electron-main 側。読む（node 層）・鍵を取る（キーチェーン）・
// 取り込み先の Electron セッションへ書く、をまとめる。channel は既存の
// paradisRegisterBrowserProfiles から一緒に登録され、app.ts への追加変更は増やさない。
//
// 安全の決め事（このファイルで守っていること）:
//  - 鍵を読むのは importCookies のときだけ。列挙（listSources/listDomains）では読まない
//    ＝キーチェーンの確認ダイアログを不用意に出さない。
//  - キーチェーンへは書き込まない（読み取りのみ）。
//  - 導出鍵は取り込みの最後に fill(0)、鍵の元にした（連結後の）パスワード Buffer も導出直後に fill(0)
//    で潰す。ただし `execFile` が内部で持つ連結前の stdout チャンクは触れないので消せない。復号後の
//    Cookie の値は JS 文字列になり GC まで残る（プロセス内・main のみ・外へは件数しか出さない）。
//  - 取り込み先は名前付きプロファイルの partition だけ。さらに main 側でも台帳と照合し、
//    実在すること・エージェントが作ったものでないことを確かめてから書く。

import { session } from 'electron';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { join } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IApplicationStorageMainService } from '../../../../platform/storage/electron-main/storageMainService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import {
	IParadisBrowserLoginImportMainService,
	IParadisImportDomainListing,
	IParadisImportRequest,
	IParadisImportResult,
	IParadisImportSourceListing,
	ParadisImportBrowserId,
	paradisCookieHostToDomain,
	PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL,
} from '../common/paradisBrowserLoginImport.js';
import { paradisBrowserProfilePartition, PARADIS_BROWSER_PROFILE_SCOPE } from '../common/paradisBrowserProfileId.js';
import { paradisDeserializeProfiles, PARADIS_BROWSER_PROFILES_STORAGE_KEY } from '../common/paradisBrowserProfileModel.js';
import {
	IParadisChromiumEnvironment,
	paradisBrowserCatalogEntry,
	paradisChromiumUserDataRoot,
	paradisCleanupCookieImportScratch,
	paradisCopyCookieDb,
	paradisDecryptCookieValueV10,
	paradisDefaultChromiumEnvironment,
	paradisDeriveMacCookieKey,
	paradisGroupCookieDomains,
	paradisReadCookieDatabase,
	paradisResolveBrowsers,
	paradisToImportableCookie,
} from '../node/paradisChromiumCookies.js';

/** macOS の Safe Storage パスワードを取り出す口。テストと本番で差し替える。 */
export interface IParadisSafeStoragePasswordProvider {
	/** キーチェーンから Safe Storage パスワードを Buffer で読む。確認ダイアログはここで出る。 */
	getPassword(service: string, account: string): Promise<Buffer | undefined>;
}

/**
 * キーチェーンの確認ダイアログに答えてもらうのを待つ上限。放置されたら「許可されなかった」として終わらせ、
 * 取り込みのために写した Cookie の DB を消す（待ち続けると写しが残り、取り込みも終わらない）。
 */
const KEYCHAIN_PROMPT_TIMEOUT_MS = 3 * 60_000;

/** `/usr/bin/security` でキーチェーンから読む本番実装（macOS のみ）。書き込みはしない。 */
class ParadisSecurityCommandPasswordProvider implements IParadisSafeStoragePasswordProvider {
	getPassword(service: string, account: string): Promise<Buffer | undefined> {
		return new Promise(resolve => {
			// encoding を指定しないと stdout は Buffer。文字列化を避け、使い終わったら潰せるようにする。
			execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', service, '-a', account], { encoding: 'buffer', timeout: KEYCHAIN_PROMPT_TIMEOUT_MS }, (error, stdout) => {
				if (error || !Buffer.isBuffer(stdout)) {
					resolve(undefined);
					return;
				}
				// 末尾の改行を落とす。
				const end = stdout.length > 0 && stdout[stdout.length - 1] === 0x0a ? stdout.length - 1 : stdout.length;
				resolve(end > 0 ? stdout.subarray(0, end) : undefined);
			});
		});
	}
}

export class ParadisBrowserLoginImportMainService implements IParadisBrowserLoginImportMainService {

	private readonly _env: IParadisChromiumEnvironment;

	constructor(
		private readonly _userDataPath: string,
		private readonly _logService: ILogService,
		private readonly _applicationStorageMainService: IApplicationStorageMainService,
		private readonly _passwordProvider: IParadisSafeStoragePasswordProvider = new ParadisSecurityCommandPasswordProvider(),
		env?: IParadisChromiumEnvironment,
	) {
		this._env = env ?? paradisDefaultChromiumEnvironment();
	}

	async listSources(): Promise<IParadisImportSourceListing> {
		try {
			return { browsers: await paradisResolveBrowsers(this._env) };
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] could not enumerate browsers', error);
			return { browsers: [] };
		}
	}

	async listDomains(browserId: ParadisImportBrowserId, sourceDirectory: string): Promise<IParadisImportDomainListing> {
		const needsKeychainConsent = this._env.platform === 'darwin';
		if (this._env.platform !== 'darwin') {
			return { domains: [], needsKeychainConsent, unsupportedReason: this._unsupportedPlatformReason() };
		}
		const dbPath = await this._cookieDbPath(browserId, sourceDirectory);
		if (!dbPath) {
			return { domains: [], needsKeychainConsent, unsupportedReason: localize('paradis.loginImport.noCookies', "選んだプロファイルの Cookie が見つかりませんでした。") };
		}
		let copy: { readonly path: string; readonly dispose: () => Promise<void> } | undefined;
		try {
			copy = await paradisCopyCookieDb(dbPath, this._userDataPath);
			const { rows } = await paradisReadCookieDatabase(copy.path);
			const groups = paradisGroupCookieDomains(rows);
			const domains = [...groups.entries()]
				// 取り込める候補が 0 件のドメイン（Partitioned だけ・SameSite=None 非Secure だけ等）は一覧に出さない。
				// 取り込めない理由付き（Google 等）は情報として残す。
				.filter(([, info]) => !info.importable || info.count > 0)
				.map(([domain, info]) => ({ domain, cookieCount: info.count, importable: info.importable, ...(info.reason ? { reason: info.reason } : {}) }))
				.sort((a, b) => a.domain.localeCompare(b.domain));
			return { domains, needsKeychainConsent };
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] could not read the cookie database', error);
			return { domains: [], needsKeychainConsent, unsupportedReason: localize('paradis.loginImport.readFailed', "Cookie を読み取れませんでした。") };
		} finally {
			await copy?.dispose();
		}
	}

	async importCookies(request: IParadisImportRequest): Promise<IParadisImportResult> {
		const empty: IParadisImportResult = { importedCookies: 0, importedDomains: 0, skipped: 0, failedDomains: [] };
		if (this._env.platform !== 'darwin') {
			return { ...empty, error: this._unsupportedPlatformReason() };
		}
		// 取り込み先は名前付きプロファイルだけ。partition を解けなければ弾く。
		const partition = paradisBrowserProfilePartition({ scope: PARADIS_BROWSER_PROFILE_SCOPE, profileId: request.destinationProfileId });
		if (!partition) {
			return { ...empty, error: localize('paradis.loginImport.destInvalid', "取り込み先は名前付きプロファイルにしてください。") };
		}
		// main 側でも台帳と照合する。renderer を信用しない。実在し、かつエージェントが作ったもので
		// ないことを確かめる（エージェント所有プロファイルへは書かない）。
		if (!(await this._isImportableDestination(request.destinationProfileId))) {
			return { ...empty, error: localize('paradis.loginImport.destNotAllowed', "取り込み先のプロファイルが見つからないか、取り込みできない種類です。") };
		}
		const catalog = paradisBrowserCatalogEntry(request.browserId);
		const dbPath = catalog ? await this._cookieDbPath(request.browserId, request.sourceDirectory) : undefined;
		if (!catalog || !dbPath) {
			return { ...empty, error: localize('paradis.loginImport.srcNotFound', "取り込み元の Cookie が見つかりませんでした。") };
		}
		const selectedDomains = new Set(request.domains);
		if (selectedDomains.size === 0) {
			return empty;
		}

		// 先に DB をコピーする。コピーに失敗したらキーチェーンの確認を出さずに終わる。
		let copy: { readonly path: string; readonly dispose: () => Promise<void> };
		try {
			copy = await paradisCopyCookieDb(dbPath, this._userDataPath);
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] could not copy the cookie database', error);
			return { ...empty, error: localize('paradis.loginImport.copyFailed', "Cookie を読み取れませんでした。") };
		}

		// 鍵はここで初めて読む（＝確認ダイアログが出る）。読めなければ「今回だけ許可」が押されなかった
		// とみなす。
		const password = await this._passwordProvider.getPassword(catalog.keychain.service, catalog.keychain.account);
		if (password === undefined) {
			await copy.dispose();
			return { ...empty, error: localize('paradis.loginImport.keychainDenied', "キーチェーンの許可が下りなかったため取り込めませんでした。もう一度お試しのうえ「許可」を押してください。") };
		}
		// 鍵の確認を待つ間に取り込み先が消えた/種類が変わったかもしれない。書き込みの直前にもう一度照合する。
		if (!(await this._isImportableDestination(request.destinationProfileId))) {
			password.fill(0);
			await copy.dispose();
			return { ...empty, error: localize('paradis.loginImport.destNotAllowed', "取り込み先のプロファイルが見つからないか、取り込みできない種類です。") };
		}
		// 復号鍵は連結後のパスワード写しから導き、その写しはすぐ潰す。ただし `execFile` が内部で
		// 保持する連結前の stdout チャンクは触れないので消せない（実態に合わせた記述）。
		const macKey = paradisDeriveMacCookieKey(password);
		password.fill(0);

		let importedCookies = 0;
		let skipped = 0;
		let sessionCookies = 0;
		const importedDomains = new Set<string>();
		const failedDomains = new Set<string>();
		try {
			const targetSession = session.fromPartition(partition.partition);
			const { schemaVersion, rows } = await paradisReadCookieDatabase(copy.path);
			for (const row of rows) {
				const domain = paradisCookieHostToDomain(row.hostKey);
				const cookie = paradisToImportableCookie(row, selectedDomains, current => paradisDecryptCookieValueV10(current.encryptedValue, macKey, current.hostKey, schemaVersion));
				if (!cookie) {
					// 選択外は集計しない。選択内で写せなかった分だけ skipped に数える。
					if (selectedDomains.has(domain)) {
						skipped++;
					}
					continue;
				}
				try {
					await targetSession.cookies.set({
						url: cookie.url,
						name: cookie.name,
						value: cookie.value,
						domain: cookie.domain,
						path: cookie.path,
						secure: cookie.secure,
						httpOnly: cookie.httpOnly,
						sameSite: cookie.sameSite,
						expirationDate: cookie.expirationDate,
					});
					importedCookies++;
					importedDomains.add(domain);
					if (cookie.expirationDate === undefined) {
						sessionCookies++;
					}
				} catch {
					// 値はログに載せない。ドメイン名だけ残す。
					this._logService.warn('[ParadisLoginImport] failed to write a cookie for a domain');
					failedDomains.add(domain);
				}
			}
			// クラッシュで取り込み分が失われないよう、ここでディスクへ流す。
			try {
				await targetSession.cookies.flushStore();
			} catch { /* ベストエフォート。 */ }
			return {
				importedCookies,
				importedDomains: importedDomains.size,
				skipped,
				failedDomains: [...failedDomains],
				...(sessionCookies > 0 ? { sessionCookies } : {}),
			};
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] import failed while reading the source database', error);
			return { ...empty, error: localize('paradis.loginImport.importReadFailed', "取り込み中に Cookie を読み取れませんでした。") };
		} finally {
			// 導出鍵と一時 DB は取り込みが終わったここで手放す。
			macKey.fill(0);
			await copy.dispose();
		}
	}

	/** 台帳を読み、その profileId が実在し、かつエージェントが作ったものでないことを確かめる。 */
	private async _isImportableDestination(profileId: string): Promise<boolean> {
		try {
			await this._applicationStorageMainService.whenReady;
			const profiles = paradisDeserializeProfiles(this._applicationStorageMainService.get(PARADIS_BROWSER_PROFILES_STORAGE_KEY, StorageScope.APPLICATION));
			const profile = profiles.find(candidate => candidate.id === profileId);
			return profile !== undefined && !profile.createdByAgent;
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] could not read the profile ledger', error);
			return false;
		}
	}

	private _unsupportedPlatformReason(): string {
		return this._env.platform === 'win32'
			? localize('paradis.loginImport.unsupported.win', "Windows からの取り込みは現在サポートしていません。")
			: localize('paradis.loginImport.unsupported.other', "このプラットフォームからの取り込みは現在サポートしていません。");
	}

	private async _cookieDbPath(browserId: ParadisImportBrowserId, sourceDirectory: string): Promise<string | undefined> {
		const catalog = paradisBrowserCatalogEntry(browserId);
		// renderer から来た sourceDirectory は列挙で返したものだけを受ける。区切り文字や `..` は拒否し、
		// さらに実在するプロファイルのディレクトリ名に含まれることを確かめる（パストラバーサル対策）。
		if (!catalog || !paradisIsSafeProfileDirectory(sourceDirectory)) {
			return undefined;
		}
		const browser = await this._resolveBrowserOrUndefined(browserId);
		if (!browser?.profiles.some(profile => profile.directory === sourceDirectory)) {
			return undefined;
		}
		const userDataRoot = paradisChromiumUserDataRoot(catalog, this._env);
		// node 層の存在確認と同じ順序（Network/Cookies → Cookies）で解く。
		for (const candidate of [join(userDataRoot, sourceDirectory, 'Network', 'Cookies'), join(userDataRoot, sourceDirectory, 'Cookies')]) {
			try {
				if ((await stat(candidate)).isFile()) {
					return candidate;
				}
			} catch {
				// 次の候補へ。
			}
		}
		return undefined;
	}

	private async _resolveBrowserOrUndefined(browserId: ParadisImportBrowserId) {
		const browsers = await paradisResolveBrowsers(this._env);
		return browsers.find(browser => browser.id === browserId);
	}
}

/** ディレクトリ名として安全か（区切り文字・`..`・空を弾く）。 */
function paradisIsSafeProfileDirectory(directory: string): boolean {
	return directory.length > 0 && !directory.includes('/') && !directory.includes('\\') && directory !== '..' && !directory.includes('..');
}

/** 既存の paradisRegisterBrowserProfiles から呼ばれる channel 登録。 */
export function paradisRegisterBrowserLoginImport(
	channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	userDataPath: string,
	logService: ILogService,
	applicationStorageMainService: IApplicationStorageMainService,
): IDisposable {
	const disposables = new DisposableStore();
	// 前回のクラッシュで残った一時コピーを掃除する（ベストエフォート）。
	void paradisCleanupCookieImportScratch(userDataPath);
	const service = new ParadisBrowserLoginImportMainService(userDataPath, logService, applicationStorageMainService);
	channelHost.registerChannel(PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL, ProxyChannel.fromService(service, disposables));
	return disposables;
}

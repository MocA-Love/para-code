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
//  - 復号した値と鍵は取り込みが終わるまでしかメモリに置かず、終わったらバッファを潰す。
//  - 取り込み先は名前付きプロファイルの partition だけ（profileId → partition が唯一の経路）。

import { session } from 'electron';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
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
import {
	IParadisChromiumEnvironment,
	paradisBrowserCatalogEntry,
	paradisChromiumUserDataRoot,
	paradisCopyCookieDb,
	paradisDecryptCookieValueV10,
	paradisDefaultChromiumEnvironment,
	paradisDeriveMacCookieKey,
	paradisGroupCookieDomains,
	paradisReadCookieRows,
	paradisResolveBrowsers,
	paradisToImportableCookie,
} from '../node/paradisChromiumCookies.js';

/** macOS の Safe Storage パスワードを取り出す口。テストと本番で差し替える。 */
export interface IParadisSafeStoragePasswordProvider {
	/** キーチェーンから Safe Storage パスワードを読む。確認ダイアログはここで出る。 */
	getPassword(service: string, account: string): Promise<string | undefined>;
}

/** `/usr/bin/security` でキーチェーンから読む本番実装（macOS のみ）。書き込みはしない。 */
class ParadisSecurityCommandPasswordProvider implements IParadisSafeStoragePasswordProvider {
	getPassword(service: string, account: string): Promise<string | undefined> {
		return new Promise(resolve => {
			execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', service, '-a', account], (error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const password = stdout.replace(/\n$/, '');
				resolve(password.length > 0 ? password : undefined);
			});
		});
	}
}

export class ParadisBrowserLoginImportMainService implements IParadisBrowserLoginImportMainService {

	private readonly _env: IParadisChromiumEnvironment;

	constructor(
		private readonly _userDataPath: string,
		private readonly _logService: ILogService,
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
			return {
				domains: [],
				needsKeychainConsent,
				unsupportedReason: this._env.platform === 'win32'
					? 'Windows からの取り込みは現在サポートしていません。'
					: 'このプラットフォームからの取り込みは現在サポートしていません。',
			};
		}
		const dbPath = await this._cookieDbPath(browserId, sourceDirectory);
		if (!dbPath) {
			return { domains: [], needsKeychainConsent, unsupportedReason: '選んだプロファイルの Cookie が見つかりませんでした。' };
		}
		const copy = await paradisCopyCookieDb(dbPath, this._userDataPath);
		try {
			const rows = await paradisReadCookieRows(copy.path);
			const groups = paradisGroupCookieDomains(rows);
			const domains = [...groups.entries()]
				.map(([domain, info]) => ({ domain, cookieCount: info.count, importable: info.importable, ...(info.reason ? { reason: info.reason } : {}) }))
				.sort((a, b) => a.domain.localeCompare(b.domain));
			return { domains, needsKeychainConsent };
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] could not read the cookie database', error);
			return { domains: [], needsKeychainConsent, unsupportedReason: 'Cookie を読み取れませんでした。' };
		} finally {
			await copy.dispose();
		}
	}

	async importCookies(request: IParadisImportRequest): Promise<IParadisImportResult> {
		const empty: IParadisImportResult = { importedCookies: 0, importedDomains: 0, skipped: 0, failedDomains: [] };
		if (this._env.platform !== 'darwin') {
			return { ...empty, error: 'このプラットフォームからの取り込みは現在サポートしていません。' };
		}
		// 取り込み先は名前付きプロファイルだけ。partition を解けなければ弾く。
		const partition = paradisBrowserProfilePartition({ scope: PARADIS_BROWSER_PROFILE_SCOPE, profileId: request.destinationProfileId });
		if (!partition) {
			return { ...empty, error: '取り込み先は名前付きプロファイルにしてください。' };
		}
		const catalog = paradisBrowserCatalogEntry(request.browserId);
		const dbPath = catalog ? await this._cookieDbPath(request.browserId, request.sourceDirectory) : undefined;
		if (!catalog || !dbPath) {
			return { ...empty, error: '取り込み元の Cookie が見つかりませんでした。' };
		}
		const selectedDomains = new Set(request.domains);
		if (selectedDomains.size === 0) {
			return empty;
		}

		// 鍵はここで初めて読む（＝確認ダイアログが出る）。読めなければ「今回だけ許可」が
		// 押されなかったとみなす。
		const password = await this._passwordProvider.getPassword(catalog.keychain.service, catalog.keychain.account);
		if (password === undefined) {
			return { ...empty, error: 'キーチェーンの許可が下りなかったため取り込めませんでした。もう一度お試しのうえ「許可」を押してください。' };
		}
		const macKey = paradisDeriveMacCookieKey(password);

		const copy = await paradisCopyCookieDb(dbPath, this._userDataPath);
		const targetSession = session.fromPartition(partition.partition);
		let importedCookies = 0;
		let skipped = 0;
		const importedDomains = new Set<string>();
		const failedDomains = new Set<string>();
		try {
			const rows = await paradisReadCookieRows(copy.path);
			for (const row of rows) {
				const domain = paradisCookieHostToDomain(row.hostKey);
				const cookie = paradisToImportableCookie(row, selectedDomains, current => paradisDecryptCookieValueV10(current.encryptedValue, macKey, current.hostKey));
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
				} catch {
					// 値はログに載せない。ドメイン名だけ残す。
					this._logService.warn('[ParadisLoginImport] failed to write a cookie for a domain');
					failedDomains.add(domain);
				}
			}
			return {
				importedCookies,
				importedDomains: importedDomains.size,
				skipped,
				failedDomains: [...failedDomains],
			};
		} catch (error) {
			this._logService.warn('[ParadisLoginImport] import failed while reading the source database', error);
			return { ...empty, error: '取り込み中に Cookie を読み取れませんでした。' };
		} finally {
			// 鍵と一時 DB は取り込みが終わったここで手放す。
			macKey.fill(0);
			await copy.dispose();
		}
	}

	private async _cookieDbPath(browserId: ParadisImportBrowserId, sourceDirectory: string): Promise<string | undefined> {
		const catalog = paradisBrowserCatalogEntry(browserId);
		if (!catalog) {
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
}

/** 既存の paradisRegisterBrowserProfiles から呼ばれる channel 登録。 */
export function paradisRegisterBrowserLoginImport(
	channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	userDataPath: string,
	logService: ILogService,
): IDisposable {
	const disposables = new DisposableStore();
	const service = new ParadisBrowserLoginImportMainService(userDataPath, logService);
	channelHost.registerChannel(PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL, ProxyChannel.fromService(service, disposables));
	return disposables;
}

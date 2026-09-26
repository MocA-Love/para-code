/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from claude-swap (MIT, Copyright (c) 2026 Onur Cetinkol): claude_swap/credentials.py, claude_swap/claude_locks.py, claude_swap/paths.py
// Portions adapted from stablyai/orca (MIT): src/main/claude-accounts/keychain.ts

// この PC の Claude Code が使っているログイン（以下「いまのログイン」）の読み書き。
//
// Claude Code の保存場所（Claude Code・claude-swap・Orca で確認）:
//  - 認証情報: macOS はキーチェーンの `Claude Code-credentials`（アカウント名は $USER。英数字と
//    `._-` 以外を含むときは `claude-code-user`）。キーチェーンが使えないときと macOS 以外は
//    `~/.claude/.credentials.json`
//  - 身元: `~/.claude.json` の `oauthAccount`（古い版は `~/.claude/.config.json`）
//
// 切り替え（{@link ParadisClaudeLiveAuth.activate}）は Claude Code 自身のロックを取ってから書く。
// Claude Code はトークン更新を `~/.claude/.oauth_refresh.lock` → `~/.claude.lock` の2つのロックの中で
// 「読む→更新→保存」するので、その途中に割り込んで書くと、更新された古いアカウントのトークンで
// 上書きし返される。ロックの中で書けば、Claude Code は取り直した新しい認証情報を見て更新をやめる。
// `~/.claude.json` の書き込みは `~/.claude.json.lock` で守る。ロックはどれも npm の proper-lockfile と
// 同じ「ディレクトリを mkdir できた者が持ち主」という方式で、持っている間は mtime を更新し続ける。
//
// `CLAUDE_CONFIG_DIR` で既定以外の場所を使っている構成には対応しない（既定の ~/.claude だけを見る）。

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { IParadisClaudeIdentity, paradisClaudeIdentityFromOauthAccount } from '../common/paradisClaudeUsage.js';
import { IParadisKeychain } from './paradisClaudeKeychain.js';

export const PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLAUDE_CODE_FALLBACK_KEYCHAIN_USER = 'claude-code-user';
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Claude Code の認証情報ロックは 60 秒で古いとみなす（生きている持ち主から奪わない）。 */
const CREDENTIALS_LOCK_STALE_MS = 60_000;
/** `~/.claude.json` のロックは 10 秒で古いとみなす（proper-lockfile の既定）。 */
const CONFIG_LOCK_STALE_MS = 10_000;
/** 持っている間に mtime を更新する間隔（Claude Code の 5 秒より少し短く）。 */
const LOCK_TOUCH_INTERVAL_MS = 3_000;
/** ロック1つあたり待つ上限。Claude Code はトークン更新の往復1回ぶんしか持たない。 */
const LOCK_TIMEOUT_MS = 9_000;

/** Claude Code のロックを待ちきれなかった。少し待てば取れる。 */
export class ParadisClaudeLockTimeoutError extends Error { }

/** `~/.claude.json` は在るのに読めない（壊れている）。上書きすると設定を失うので書かない。 */
export class ParadisClaudeConfigUnreadableError extends Error { }

export interface IParadisClaudeLiveCredentials {
	/** credentials JSON。どこにも無ければ undefined。 */
	readonly value?: string;
	readonly source: 'keychain' | 'file' | 'none';
	/** キーチェーンが読めなかった（ロック中・拒否）。値が無いのが「ログインしていない」とは限らない。 */
	readonly keychainUnavailable: boolean;
}

/** 切り替えを元に戻すための、書く前の状態。 */
export interface IParadisClaudeLiveSnapshot {
	/** macOS: キーチェーンの項目の値（無ければ undefined）。 */
	readonly keychainValue?: string;
	readonly keychainAccount?: string;
	/** `.credentials.json` の中身（無ければ undefined）。 */
	readonly credentialsFile?: string;
	/** `~/.claude.json` の生の中身（無ければ undefined）。 */
	readonly globalConfig?: string;
}

export interface IParadisClaudeLiveAuthOptions {
	readonly homedir: string;
	readonly platform: NodeJS.Platform;
	/** macOS のときだけ使う。 */
	readonly keychain: IParadisKeychain | undefined;
	/** キーチェーンのアカウント名に使う OS のユーザー名（$USER を優先）。 */
	readonly userName: string | undefined;
	readonly now?: () => number;
	/** ロック1つを待つ上限（テストで短くする）。 */
	readonly lockTimeoutMs?: number;
}

interface IConfigCache {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
	readonly oauthAccount: unknown;
}

/** proper-lockfile 互換のディレクトリロックを1つ取る。 */
async function acquireDirectoryLock(lockPath: string, staleMs: number, timeoutMs: number, now: () => number): Promise<() => Promise<void>> {
	const started = now();
	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
	while (true) {
		try {
			await fs.promises.mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}
		if (now() - started > timeoutMs) {
			throw new ParadisClaudeLockTimeoutError(`could not acquire ${path.basename(lockPath)}`);
		}
		try {
			const stat = await fs.promises.stat(lockPath);
			if (now() - stat.mtimeMs > staleMs) {
				// 持ち主がいなくなったロック。消して取り直す（取り合いに負けたら次の周回でまた待つ）。
				await fs.promises.rmdir(lockPath).catch(() => undefined);
				continue;
			}
		} catch {
			continue; // 見ている間に解放された
		}
		await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
	}
	const toucher = setInterval(() => {
		const time = new Date();
		fs.promises.utimes(lockPath, time, time).catch(() => undefined);
	}, LOCK_TOUCH_INTERVAL_MS);
	return async () => {
		clearInterval(toucher);
		await fs.promises.rmdir(lockPath).catch(() => undefined);
	};
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/** 同じディレクトリの一時ファイルに書いてから置き換える。既存のファイルの権限は保つ（新規は 0600）。 */
export async function paradisWriteFileAtomically(filePath: string, contents: string, platform: NodeJS.Platform): Promise<void> {
	let mode = 0o600;
	try {
		mode = (await fs.promises.stat(filePath)).mode & 0o777;
	} catch {
		// 新規
	}
	// 無いフォルダを作るときは本人だけが読める権限にする（認証情報の置き場所になるため）。
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.paradis-${process.pid}-${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
		await fs.promises.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
	if (platform !== 'win32') {
		await fs.promises.chmod(filePath, mode).catch(() => undefined);
	}
}

export class ParadisClaudeLiveAuth {

	private readonly now: () => number;
	private configCache: IConfigCache | undefined;

	constructor(private readonly options: IParadisClaudeLiveAuthOptions) {
		this.now = options.now ?? Date.now;
	}

	get configHome(): string {
		return path.join(this.options.homedir, '.claude');
	}

	get credentialsPath(): string {
		return path.join(this.configHome, '.credentials.json');
	}

	private get usesKeychain(): boolean {
		return this.options.platform === 'darwin' && this.options.keychain !== undefined;
	}

	/** Claude Code と同じ規則で決めたキーチェーンのアカウント名（候補を試す順に）。 */
	keychainAccountNames(): string[] {
		const raw = this.options.userName;
		const derived = raw && KEYCHAIN_ACCOUNT_PATTERN.test(raw) ? raw : CLAUDE_CODE_FALLBACK_KEYCHAIN_USER;
		return raw && raw !== derived ? [derived, raw] : [derived];
	}

	/** `~/.claude/.config.json` があればそれ（古い版）、無ければ `~/.claude.json`。 */
	async globalConfigPath(): Promise<string> {
		const legacy = path.join(this.configHome, '.config.json');
		try {
			await fs.promises.access(legacy);
			return legacy;
		} catch {
			return path.join(this.options.homedir, '.claude.json');
		}
	}

	/** いまのログインの認証情報を読む（キーチェーン → `.credentials.json`）。書き込みはしない。 */
	async readCredentials(): Promise<IParadisClaudeLiveCredentials> {
		let keychainUnavailable = false;
		if (this.usesKeychain) {
			try {
				for (const account of this.keychainAccountNames()) {
					const value = await this.options.keychain!.read(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account);
					if (value && value.trim()) {
						return { value, source: 'keychain', keychainUnavailable: false };
					}
				}
			} catch {
				keychainUnavailable = true;
			}
		}
		try {
			const file = await readFileIfExists(this.credentialsPath);
			if (file && file.trim()) {
				return { value: file, source: 'file', keychainUnavailable };
			}
		} catch {
			// 読めないファイルは「無い」と同じに扱う（キーチェーン側の結果を優先して伝える）
		}
		return { source: 'none', keychainUnavailable };
	}

	/**
	 * `~/.claude.json` の `oauthAccount` を読む。ファイルは数 MB になることがあるので、更新時刻と
	 * 大きさが変わっていなければ前回の結果を使う。
	 */
	async readOauthAccount(): Promise<unknown> {
		const configPath = await this.globalConfigPath();
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(configPath);
		} catch {
			this.configCache = undefined;
			return undefined;
		}
		const cached = this.configCache;
		if (cached && cached.path === configPath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			return cached.oauthAccount;
		}
		let oauthAccount: unknown;
		try {
			const parsed: unknown = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
			oauthAccount = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).oauthAccount : undefined;
		} catch {
			// 書きかけの瞬間を読んだ場合など。次回の読み直しに任せる（キャッシュしない）。
			return undefined;
		}
		this.configCache = { path: configPath, mtimeMs: stat.mtimeMs, size: stat.size, oauthAccount };
		return oauthAccount;
	}

	async readIdentity(): Promise<IParadisClaudeIdentity | undefined> {
		return paradisClaudeIdentityFromOauthAccount(await this.readOauthAccount());
	}

	/**
	 * Claude Code の3つのロックを Claude Code と同じ順に取り、その中で `fn` を実行する。
	 * @throws {@link ParadisClaudeLockTimeoutError} ロックを取れなかったとき（何も書いていない）
	 */
	async withLocks<T>(fn: () => Promise<T>): Promise<T> {
		const releases: (() => Promise<void>)[] = [];
		try {
			const timeoutMs = this.options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
			releases.push(await acquireDirectoryLock(path.join(this.configHome, '.oauth_refresh.lock'), CREDENTIALS_LOCK_STALE_MS, timeoutMs, this.now));
			releases.push(await acquireDirectoryLock(`${this.configHome}.lock`, CREDENTIALS_LOCK_STALE_MS, timeoutMs, this.now));
			const configPath = await this.globalConfigPath();
			releases.push(await acquireDirectoryLock(`${configPath}.lock`, CONFIG_LOCK_STALE_MS, timeoutMs, this.now));
			return await fn();
		} finally {
			for (const release of releases.reverse()) {
				await release();
			}
		}
	}

	/** 書く前の状態を控える（{@link restore} で戻すため）。キーチェーンが読めなければ投げる。 */
	async captureSnapshot(): Promise<IParadisClaudeLiveSnapshot> {
		let keychainValue: string | undefined;
		let keychainAccount: string | undefined;
		if (this.usesKeychain) {
			for (const account of this.keychainAccountNames()) {
				const value = await this.options.keychain!.read(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account);
				if (value !== undefined) {
					keychainValue = value;
					keychainAccount = account;
					break;
				}
			}
			keychainAccount ??= this.keychainAccountNames()[0];
		}
		return {
			keychainValue,
			keychainAccount,
			credentialsFile: await readFileIfExists(this.credentialsPath),
			globalConfig: await readFileIfExists(await this.globalConfigPath()),
		};
	}

	/**
	 * いまのログインを `credentialsJson` / `oauthAccount` のアカウントに書き換える。
	 * {@link withLocks} の中から、{@link captureSnapshot} の後に呼ぶこと。途中で失敗したら投げる
	 * （書いた分は呼び出し側が {@link restore} で戻す）。
	 */
	async activate(credentialsJson: string, oauthAccount: unknown, snapshot: IParadisClaudeLiveSnapshot): Promise<void> {
		// `~/.claude.json` が壊れていたら、何も書く前に止める。
		const configPath = await this.globalConfigPath();
		let config: Record<string, unknown> = {};
		if (snapshot.globalConfig !== undefined) {
			try {
				const parsed: unknown = JSON.parse(snapshot.globalConfig);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('not an object');
				}
				config = parsed as Record<string, unknown>;
			} catch {
				throw new ParadisClaudeConfigUnreadableError('the Claude global config exists but could not be parsed');
			}
		}

		if (this.usesKeychain) {
			await this.options.keychain!.write(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, snapshot.keychainAccount ?? this.keychainAccountNames()[0], credentialsJson);
			// キーチェーンだけ書き換えると、動いている Claude Code は覚えているトークンを使い続ける。
			// `.credentials.json` が既にあるなら書き直して更新時刻を変え、読み直させる（無ければ作らない）。
			if (snapshot.credentialsFile !== undefined) {
				await paradisWriteFileAtomically(this.credentialsPath, credentialsJson, this.options.platform);
			}
		} else {
			await paradisWriteFileAtomically(this.credentialsPath, credentialsJson, this.options.platform);
		}

		config.oauthAccount = oauthAccount;
		await paradisWriteFileAtomically(configPath, JSON.stringify(config, null, 2), this.options.platform);
		this.configCache = undefined;
	}

	// ---------- アカウント追加用の一時ディレクトリ ----------

	/**
	 * `CLAUDE_CONFIG_DIR`（`CLAUDE_SECURESTORAGE_CONFIG_DIR`）を指定して動かした Claude Code が使う
	 * キーチェーンのサービス名。Claude Code 2.1 以降はディレクトリの文字列（NFC）の SHA-256 の先頭
	 * 8 桁を付ける（Orca・claude-swap で確認）。
	 */
	static scopedKeychainService(configDir: string): string {
		return `${PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE}-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}`;
	}

	/** macOS の一時ディレクトリは /var → /private/var の別名がある。Claude Code が実パスで項目名を作る場合に備えて両方見る。 */
	private async configDirAliases(configDir: string): Promise<string[]> {
		const aliases = [configDir];
		try {
			const real = await fs.promises.realpath(configDir);
			if (real !== configDir) {
				aliases.push(real);
			}
		} catch {
			// 無ければ別名も無い
		}
		return aliases;
	}

	/** 一時ディレクトリに向けて `claude auth login` した結果の認証情報を読む。 */
	async readScopedCredentials(configDir: string): Promise<string | undefined> {
		if (this.usesKeychain) {
			for (const dir of await this.configDirAliases(configDir)) {
				for (const account of this.keychainAccountNames()) {
					const value = await this.options.keychain!.read(ParadisClaudeLiveAuth.scopedKeychainService(dir), account);
					if (value && value.trim()) {
						return value;
					}
				}
			}
		}
		const file = await readFileIfExists(path.join(configDir, '.credentials.json'));
		return file && file.trim() ? file : undefined;
	}

	/** 一時ディレクトリの `.claude.json`（古い版は `.config.json`）の oauthAccount を読む。 */
	async readScopedOauthAccount(configDir: string): Promise<unknown> {
		for (const name of ['.claude.json', '.config.json']) {
			const raw = await readFileIfExists(path.join(configDir, name)).catch(() => undefined);
			if (!raw) {
				continue;
			}
			try {
				const parsed: unknown = JSON.parse(raw);
				const oauthAccount = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).oauthAccount : undefined;
				if (oauthAccount && typeof oauthAccount === 'object') {
					return oauthAccount;
				}
			} catch {
				// 次の候補
			}
		}
		return undefined;
	}

	/** 一時ディレクトリ用にできたキーチェーン項目を消す（失敗しても続ける）。 */
	async deleteScopedCredentials(configDir: string): Promise<void> {
		if (!this.usesKeychain) {
			return;
		}
		for (const dir of await this.configDirAliases(configDir)) {
			for (const account of this.keychainAccountNames()) {
				await this.options.keychain!.delete(ParadisClaudeLiveAuth.scopedKeychainService(dir), account).catch(() => undefined);
			}
		}
	}

	/**
	 * macOS: いまのログインのキーチェーン項目だけを控える。古い Claude Code は `CLAUDE_CONFIG_DIR` を
	 * 指定しても既定の項目へ書くことがあるので、アカウント追加の前後で比べて戻すのに使う。
	 * macOS 以外は undefined。キーチェーンが読めなければ投げる。
	 */
	async snapshotKeychainItem(): Promise<IParadisClaudeLiveSnapshot | undefined> {
		if (!this.usesKeychain) {
			return undefined;
		}
		for (const account of this.keychainAccountNames()) {
			const value = await this.options.keychain!.read(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account);
			if (value !== undefined) {
				return { keychainValue: value, keychainAccount: account };
			}
		}
		return { keychainAccount: this.keychainAccountNames()[0] };
	}

	/** {@link snapshotKeychainItem} の状態へ、キーチェーンの項目だけを戻す。 */
	async restoreKeychainItem(snapshot: IParadisClaudeLiveSnapshot): Promise<void> {
		if (!this.usesKeychain || !snapshot.keychainAccount) {
			return;
		}
		if (snapshot.keychainValue !== undefined) {
			await this.options.keychain!.write(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, snapshot.keychainAccount, snapshot.keychainValue);
		} else {
			await this.options.keychain!.delete(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, snapshot.keychainAccount);
		}
	}

	/**
	 * {@link captureSnapshot} の状態へ戻す。できる限り全部戻し、失敗があれば最後に投げる。
	 * 既に控えと同じ中身のところ（書く前に失敗したところ）は書き直さない。
	 */
	async restore(snapshot: IParadisClaudeLiveSnapshot): Promise<void> {
		const failures: unknown[] = [];
		if (this.usesKeychain) {
			const account = snapshot.keychainAccount ?? this.keychainAccountNames()[0];
			try {
				const current = await this.options.keychain!.read(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account);
				if (current === snapshot.keychainValue) {
					// 変わっていない
				} else if (snapshot.keychainValue !== undefined) {
					await this.options.keychain!.write(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account, snapshot.keychainValue);
				} else {
					await this.options.keychain!.delete(PARADIS_CLAUDE_CODE_KEYCHAIN_SERVICE, account);
				}
			} catch (error) {
				failures.push(error);
			}
		}
		try {
			if (await readFileIfExists(this.credentialsPath) === snapshot.credentialsFile) {
				// 変わっていない
			} else if (snapshot.credentialsFile !== undefined) {
				await paradisWriteFileAtomically(this.credentialsPath, snapshot.credentialsFile, this.options.platform);
			} else {
				await fs.promises.rm(this.credentialsPath, { force: true });
			}
		} catch (error) {
			failures.push(error);
		}
		try {
			const configPath = await this.globalConfigPath();
			if (await readFileIfExists(configPath) === snapshot.globalConfig) {
				// 変わっていない
			} else if (snapshot.globalConfig !== undefined) {
				await paradisWriteFileAtomically(configPath, snapshot.globalConfig, this.options.platform);
			} else {
				await fs.promises.rm(configPath, { force: true });
			}
		} catch (error) {
			failures.push(error);
		}
		this.configCache = undefined;
		if (failures.length > 0) {
			throw new Error(`failed to restore ${failures.length} part(s) of the Claude login`);
		}
	}
}

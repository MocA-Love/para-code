/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code に登録した Claude アカウントの保存場所。
//
//  - 一覧（メールアドレス・組織・Claude Code の oauthAccount など、秘密でないもの）:
//    ユーザーデータのフォルダの `paradis-claude-accounts/accounts.json`（権限 0600）
//  - 認証情報（リフレッシュトークンを含む credentials JSON）:
//    macOS はキーチェーンの Para Code 専用の項目（サービス名 `Para Code Claude Accounts`、
//    アカウント名は登録ごとの UUID）。Windows / Linux は Electron の safeStorage で暗号化して
//    `paradis-claude-accounts/secrets/<UUID>.enc` に置く（平文のファイルにはしない、という決定）
//
// どちらもインターフェースにしてあり、テストでは一時ディレクトリとメモリ実装に差し替える。

import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { IParadisKeychain } from './paradisClaudeKeychain.js';
import { paradisWriteFileAtomically } from './paradisClaudeLiveAuth.js';

/** 登録したアカウントの認証情報の置き場所。 */
export interface IParadisClaudeSecretStore {
	read(accountId: string): Promise<string | undefined>;
	write(accountId: string, credentialsJson: string): Promise<void>;
	delete(accountId: string): Promise<void>;
}

export const PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE = 'Para Code Claude Accounts';

/** 登録 ID は自前の UUID だけ。パスやキーチェーンの名前へそのまま入るので形を確かめる。 */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function paradisIsClaudeAccountId(value: unknown): value is string {
	return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value);
}

function assertAccountId(accountId: string): void {
	if (!paradisIsClaudeAccountId(accountId)) {
		throw new Error('invalid Claude account id');
	}
}

/** macOS: キーチェーンの Para Code 専用項目。 */
export class ParadisKeychainClaudeSecretStore implements IParadisClaudeSecretStore {

	constructor(private readonly keychain: IParadisKeychain) { }

	read(accountId: string): Promise<string | undefined> {
		assertAccountId(accountId);
		return this.keychain.read(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, accountId);
	}

	write(accountId: string, credentialsJson: string): Promise<void> {
		assertAccountId(accountId);
		return this.keychain.write(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, accountId, credentialsJson);
	}

	delete(accountId: string): Promise<void> {
		assertAccountId(accountId);
		return this.keychain.delete(PARADIS_CLAUDE_ACCOUNTS_KEYCHAIN_SERVICE, accountId);
	}
}

/** main プロセスの safeStorage（'encryption' チャネル）のうち、ここで使う部分。 */
export interface IParadisClaudeEncryption {
	isEncryptionAvailable(): Promise<boolean>;
	/** 鍵の保管先。`basic_text` は固定鍵で、暗号化していないのと同じ。 */
	getKeyStorageProvider(): Promise<string>;
	encrypt(value: string): Promise<string>;
	decrypt(value: string): Promise<string>;
}

/** Windows / Linux: safeStorage で暗号化したファイル。 */
export class ParadisEncryptedFileClaudeSecretStore implements IParadisClaudeSecretStore {

	constructor(
		private readonly directory: string,
		private readonly encryption: IParadisClaudeEncryption,
		private readonly platform: NodeJS.Platform,
	) { }

	private filePath(accountId: string): string {
		assertAccountId(accountId);
		return path.join(this.directory, `${accountId}.enc`);
	}

	async read(accountId: string): Promise<string | undefined> {
		let encrypted: string;
		try {
			encrypted = await fs.promises.readFile(this.filePath(accountId), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
		return this.encryption.decrypt(encrypted);
	}

	async write(accountId: string, credentialsJson: string): Promise<void> {
		// 鍵の保管サービスが無い Linux では safeStorage が平文に落ちる。`--password-store=basic` の
		// ときも「使える」と答えるが、鍵は固定なので暗号化していないのと同じ。どちらも保存しない。
		if (!await this.encryption.isEncryptionAvailable() || await this.encryption.getKeyStorageProvider() === 'basic_text') {
			throw new Error('OS encryption is not available');
		}
		const encrypted = await this.encryption.encrypt(credentialsJson);
		await paradisWriteFileAtomically(this.filePath(accountId), encrypted, this.platform);
	}

	async delete(accountId: string): Promise<void> {
		await fs.promises.rm(this.filePath(accountId), { force: true });
	}
}

/** 登録したアカウント1件（秘密でない部分）。 */
export interface IParadisClaudeAccountRecord {
	readonly id: string;
	readonly email: string;
	readonly accountUuid?: string;
	readonly organizationUuid?: string;
	readonly organizationName?: string;
	/** 切り替えたときに `~/.claude.json` へ書く Claude Code の oauthAccount。 */
	readonly oauthAccount: unknown;
	/**
	 * いまのログインをそのまま写して登録した（ブラウザでログインし直していない）。この場合、
	 * 同じリフレッシュトークンの系列を claude-swap も持っていることがある。
	 */
	readonly copiedFromLiveLogin?: boolean;
	readonly createdAt: number;
	readonly updatedAt: number;
}

interface IParadisClaudeAccountsFile {
	readonly version: 1;
	readonly accounts: readonly IParadisClaudeAccountRecord[];
}

function isRecord(value: unknown): value is IParadisClaudeAccountRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const record = value as Record<string, unknown>;
	return paradisIsClaudeAccountId(record.id)
		&& typeof record.email === 'string'
		&& typeof record.createdAt === 'number'
		&& typeof record.updatedAt === 'number'
		&& record.oauthAccount !== null && typeof record.oauthAccount === 'object';
}

/** 一覧のファイル。読み書きは呼び出し側で直列にする。 */
export class ParadisClaudeAccountRegistry {

	constructor(
		private readonly filePath: string,
		private readonly platform: NodeJS.Platform,
	) { }

	async load(): Promise<IParadisClaudeAccountRecord[]> {
		let raw: string;
		try {
			raw = await fs.promises.readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
		const parsed = JSON.parse(raw) as Partial<IParadisClaudeAccountsFile>;
		return Array.isArray(parsed.accounts) ? parsed.accounts.filter(isRecord) : [];
	}

	async save(accounts: readonly IParadisClaudeAccountRecord[]): Promise<void> {
		const data: IParadisClaudeAccountsFile = { version: 1, accounts };
		await paradisWriteFileAtomically(this.filePath, JSON.stringify(data, null, '\t'), this.platform);
	}
}

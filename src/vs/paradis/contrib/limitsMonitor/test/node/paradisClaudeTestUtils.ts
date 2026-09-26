/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude のアカウント機能のテスト用の偽物。本物のキーチェーン・~/.claude・Anthropic の API には
// 一切触れない（HOME は一時ディレクトリ、キーチェーンはメモリ、HTTP は台本どおりに返す）。

import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../../base/common/path.js';
import { IParadisClaudeUsageWindows } from '../../common/paradisClaudeUsage.js';
import { IParadisKeychain, ParadisKeychainError } from '../../node/paradisClaudeKeychain.js';
import { IParadisClaudeOAuthClient, ParadisClaudeRefreshResult, ParadisClaudeUsageFetchResult } from '../../node/paradisClaudeOAuthClient.js';

export class ParadisMemoryKeychain implements IParadisKeychain {

	readonly items = new Map<string, string>();
	/** true の間は読み書きが「ロック中」で失敗する。 */
	locked = false;
	/** 次の write をこの回数だけ失敗させる。 */
	failWrites = 0;

	private key(service: string, account: string): string {
		return `${service}\u0000${account}`;
	}

	get(service: string, account: string): string | undefined {
		return this.items.get(this.key(service, account));
	}

	set(service: string, account: string, value: string): void {
		this.items.set(this.key(service, account), value);
	}

	async read(service: string, account: string): Promise<string | undefined> {
		if (this.locked) {
			throw new ParadisKeychainError('locked');
		}
		return this.items.get(this.key(service, account));
	}

	async write(service: string, account: string, value: string): Promise<void> {
		if (this.locked || this.failWrites > 0) {
			this.failWrites = Math.max(0, this.failWrites - 1);
			throw new ParadisKeychainError('write failed');
		}
		this.items.set(this.key(service, account), value);
	}

	async delete(service: string, account: string): Promise<void> {
		if (this.locked) {
			throw new ParadisKeychainError('locked');
		}
		this.items.delete(this.key(service, account));
	}
}

/** アクセストークンごとに返す結果を決めておく偽の API。 */
export class ParadisFakeClaudeOAuth implements IParadisClaudeOAuthClient {

	readonly usageCalls: string[] = [];
	readonly refreshCalls: string[] = [];
	readonly usageByToken = new Map<string, ParadisClaudeUsageFetchResult>();
	/** リフレッシュトークン → 結果。 */
	readonly refreshByToken = new Map<string, ParadisClaudeRefreshResult>();

	async fetchUsage(accessToken: string): Promise<ParadisClaudeUsageFetchResult> {
		this.usageCalls.push(accessToken);
		return this.usageByToken.get(accessToken) ?? { kind: 'http', status: 401 };
	}

	async refresh(credentialsJson: string): Promise<ParadisClaudeRefreshResult> {
		const refreshToken = (JSON.parse(credentialsJson) as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken ?? '';
		this.refreshCalls.push(refreshToken);
		return this.refreshByToken.get(refreshToken) ?? { kind: 'transient' };
	}
}

export function paradisTestUsage(fiveHourPercent: number, sevenDayPercent = 10): IParadisClaudeUsageWindows {
	return {
		fiveHour: { usedPercent: fiveHourPercent, resetsAt: Date.parse('2030-01-01T00:00:00Z') },
		sevenDay: { usedPercent: sevenDayPercent, resetsAt: Date.parse('2030-01-05T00:00:00Z') },
	};
}

export function paradisTestCredentials(accessToken: string, refreshToken: string, expiresAt: number): string {
	return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:inference'] } });
}

export function paradisTestOauthAccount(accountUuid: string, email: string, organizationUuid = 'org-1'): Record<string, string> {
	return { accountUuid, emailAddress: email, organizationUuid, organizationName: `${email}'s Organization` };
}

/** 一時ディレクトリに偽の HOME とユーザーデータのフォルダを作る。 */
export async function paradisCreateClaudeTestHome(): Promise<{ home: string; userData: string; dispose(): Promise<void> }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paradis-claude-test-'));
	const home = path.join(root, 'home');
	const userData = path.join(root, 'userData');
	await fs.promises.mkdir(home, { recursive: true });
	await fs.promises.mkdir(userData, { recursive: true });
	return { home, userData, dispose: () => fs.promises.rm(root, { recursive: true, force: true }) };
}

export async function paradisWriteClaudeGlobalConfig(home: string, config: object): Promise<void> {
	await fs.promises.writeFile(path.join(home, '.claude.json'), JSON.stringify(config, null, 2));
}

export async function paradisReadClaudeGlobalConfig(home: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.promises.readFile(path.join(home, '.claude.json'), 'utf8'));
}

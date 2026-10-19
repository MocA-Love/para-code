/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// claude-swap (cswap) がアカウントごとに持っている控えのログインから、リフレッシュトークンだけを読む。
//
// Para Code が控えのアカウントのトークンを更新してよいか（claude-swap と同じトークンを持っていないか）を
// 確かめるためだけに使う。読んだ値はメモリの中で比べるだけで、保存・ログ・送信はしない。claude-swap の
// データには書き込まない。
//
// claude-swap の控えの置き場所（claude_swap/credentials.py で確認）:
//  - ファイル: `<データのフォルダ>/credentials/.creds-<番号>-<メール>.enc`（中身は credentials JSON の base64）。
//    1つ前の世代は末尾に `.prev` が付く。Linux・Windows はこちらだけ
//  - macOS のキーチェーン: サービス名 `claude-swap`、アカウント名 `account-<番号>-<メール>`（1つ前は `.prev` 付き）
// どちらにあっても拾う（多めに拾うほど「同じかもしれない」側に倒れる）。

import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { paradisClaudeRefreshToken } from '../common/paradisClaudeUsage.js';
import { IParadisKeychain } from './paradisClaudeKeychain.js';

const CLAUDE_SWAP_KEYCHAIN_SERVICE = 'claude-swap';
/** sequence.json の番号。パスとキーチェーンの名前へそのまま入るので形を確かめる。 */
const SLOT_PATTERN = /^\d{1,6}$/;

export interface IParadisClaudeSwapBackupReader {
	/**
	 * claude-swap の控え（今の世代と1つ前）のリフレッシュトークン。控えが無ければ空。
	 * 読めなかった（キーチェーンが開けない・ファイルが読めない）ときは undefined。
	 */
	readRefreshTokens(dataDir: string, slot: string, email: string): Promise<readonly string[] | undefined>;
}

export class ParadisClaudeSwapBackupReader implements IParadisClaudeSwapBackupReader {

	/** @param keychain macOS のときだけ渡す。 */
	constructor(private readonly keychain: IParadisKeychain | undefined) { }

	async readRefreshTokens(dataDir: string, slot: string, email: string): Promise<readonly string[] | undefined> {
		if (!SLOT_PATTERN.test(slot) || email.length === 0 || /[\/\\]/.test(email) || email.includes('..')) {
			return undefined;
		}
		const tokens: string[] = [];
		for (const suffix of ['', '.prev']) {
			let encoded: string | undefined;
			try {
				encoded = await fs.promises.readFile(path.join(dataDir, 'credentials', `.creds-${slot}-${email}.enc${suffix}`), 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					return undefined;
				}
			}
			if (encoded !== undefined) {
				this.collect(tokens, Buffer.from(encoded.trim(), 'base64').toString('utf8'));
			}
			if (this.keychain) {
				try {
					this.collect(tokens, await this.keychain.read(CLAUDE_SWAP_KEYCHAIN_SERVICE, `account-${slot}-${email}${suffix}`));
				} catch {
					return undefined;
				}
			}
		}
		return tokens;
	}

	private collect(tokens: string[], credentialsJson: string | undefined): void {
		const refreshToken = paradisClaudeRefreshToken(credentialsJson);
		if (refreshToken !== undefined) {
			tokens.push(refreshToken);
		}
	}
}

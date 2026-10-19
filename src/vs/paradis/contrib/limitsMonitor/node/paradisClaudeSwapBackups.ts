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
// claude-swap の控えの置き場所（claude_swap/credentials.py・migrations.py で確認）:
//  - ファイル: `<データのフォルダ>/credentials/.creds-<番号>-<メール>.enc`（中身は credentials JSON の base64）。
//    1つ前の世代は末尾に `.prev` が付く。Linux・Windows はこちらだけ
//  - macOS のキーチェーン: サービス名 `claude-swap`、アカウント名 `account-<番号>-<メール>`（1つ前は `.prev` 付き）
//  - 古い版が使っていた python の keyring（サービス名 `claude-code`）。キーチェーンへの移し替えに失敗すると
//    このまま残る
//  - どれも番号の代わりに `None` の付いた古い別名（`account-None-<メール>` など）がありうる
// どこにあっても拾う（多めに拾うほど「同じかもしれない」側に倒れる）。sequence.json に載っているのに
// 1つも見つからないときは、置き場所を知らない版かもしれないので「読めなかった」とする。

import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { paradisParseClaudeOAuthBlob } from '../common/paradisClaudeUsage.js';
import { IParadisKeychain } from './paradisClaudeKeychain.js';

/** 今の版のキーチェーンのサービス名。 */
const CLAUDE_SWAP_KEYCHAIN_SERVICE = 'claude-swap';
/**
 * 古い版（python の keyring）のサービス名。python が作った項目なので、`/usr/bin/security` で読むと
 * 「キーチェーンへのアクセスを許可しますか」が出ることがある。
 */
const CLAUDE_SWAP_LEGACY_KEYCHAIN_SERVICE = 'claude-code';
/** sequence.json の番号。パスとキーチェーンの名前へそのまま入るので形を確かめる。 */
const SLOT_PATTERN = /^\d{1,6}$/;

/** claude-swap の控え1つのうち、比べるのに使う部分。 */
export interface IParadisClaudeSwapBackupToken {
	readonly refreshToken: string;
	/** アクセストークンの期限（epoch ms）。新しい世代ほど遅い。分からなければ undefined。 */
	readonly expiresAt?: number;
}

export interface IParadisClaudeSwapBackupReader {
	/**
	 * claude-swap の控え（今の世代・1つ前・古い置き場所と別名）のリフレッシュトークンと期限。
	 * 読めなかった（キーチェーンが開けない・ファイルが読めない）とき、または1つも見つからなかったときは undefined。
	 */
	readBackups(dataDir: string, slot: string, email: string): Promise<readonly IParadisClaudeSwapBackupToken[] | undefined>;
}

export class ParadisClaudeSwapBackupReader implements IParadisClaudeSwapBackupReader {

	/**
	 * 古い版のサービスの読み取りが失敗・時間切れになった（許可を求められて断られた・答えが無かった）。
	 * 控えは定期的に読み直すので、その起動の間は読みに行かない（確認が何度も出ないように）。
	 */
	private legacyServiceUnavailable = false;

	/** @param keychain macOS のときだけ渡す。 */
	constructor(private readonly keychain: IParadisKeychain | undefined) { }

	async readBackups(dataDir: string, slot: string, email: string): Promise<readonly IParadisClaudeSwapBackupToken[] | undefined> {
		if (!SLOT_PATTERN.test(slot) || email.length === 0 || /[\/\\]/.test(email) || email.includes('..')) {
			return undefined;
		}
		const backups: IParadisClaudeSwapBackupToken[] = [];
		for (const name of [slot, 'None']) {
			for (const suffix of ['', '.prev']) {
				let encoded: string | undefined;
				try {
					encoded = await fs.promises.readFile(path.join(dataDir, 'credentials', `.creds-${name}-${email}.enc${suffix}`), 'utf8');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						return undefined;
					}
				}
				if (encoded !== undefined) {
					this.collect(backups, Buffer.from(encoded.trim(), 'base64').toString('utf8'));
				}
				const keychain = this.keychain;
				if (keychain) {
					const account = `account-${name}-${email}${suffix}`;
					try {
						this.collect(backups, await keychain.read(CLAUDE_SWAP_KEYCHAIN_SERVICE, account));
					} catch {
						return undefined;
					}
					if (this.legacyServiceUnavailable) {
						// 古い置き場所を読めないので、そこに控えがあるかもしれない（同じかもしれない側に倒す）。
						return undefined;
					}
					try {
						this.collect(backups, await keychain.read(CLAUDE_SWAP_LEGACY_KEYCHAIN_SERVICE, account));
					} catch {
						this.legacyServiceUnavailable = true;
						return undefined;
					}
				}
			}
		}
		return backups.length > 0 ? backups : undefined;
	}

	private collect(backups: IParadisClaudeSwapBackupToken[], credentialsJson: string | undefined): void {
		const oauth = paradisParseClaudeOAuthBlob(credentialsJson);
		const refreshToken = oauth?.refreshToken;
		if (typeof refreshToken === 'string' && refreshToken.trim() !== '') {
			backups.push({ refreshToken, expiresAt: typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined });
		}
	}
}

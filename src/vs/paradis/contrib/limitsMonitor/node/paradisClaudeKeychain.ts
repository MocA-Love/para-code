/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from claude-swap (MIT, Copyright (c) 2026 Onur Cetinkol): claude_swap/macos_keychain.py
// Portions adapted from stablyai/orca (MIT): src/main/claude-accounts/keychain.ts

// macOS キーチェーンの generic password を `/usr/bin/security` で読み書きする。
//
// - Claude Code 自身も `security` コマンドで項目を作る。作った側と読む側が同じ `security` なので、
//   読み書きで「キーチェーンへのアクセスを許可しますか」は出ない（claude-swap の実測）。
//   Electron / Node の中からキーチェーン API を直接呼ぶと、項目のアクセス権が Para Code の
//   実行ファイルに結び付き、更新のたびに許可ダイアログが出るおそれがある
// - 書き込みは Orca（`main/macos-keychain/generic-password.ts`）と同じく、値を常に引数で渡す
//   （`security add-generic-password -U -a <account> -s <service> -X <16進>`、標準入力は繋がない）。
//   値は Orca の `-w <値>` ではなく、Claude Code 自身と同じ `-X <16進>` で渡す。キーチェーンに入る
//   バイト列はどちらも同じ（JSON の UTF-8）で、Claude Code・Orca・Para Code はどれも
//   `find-generic-password -w` で読むので、読み手から見た違いは無い。16進にしておけば、項目の中身が
//   Claude Code 自身の書いたものとバイト単位で同じになる。引数に載せた一瞬だけ、同じユーザーの
//   プロセス（ps）や EDR のログから値が見える。Claude Code も長い値は引数で書いており、露出は同じ
// - PATH 上の偽の `security` に秘密を渡さないよう、絶対パスで起動する
//
// テストではこのインターフェースをメモリ実装に差し替え、本物のキーチェーンには触れない。

import * as cp from 'child_process';

export interface IParadisKeychain {
	/** 値を返す。項目が無ければ undefined。読めない（ロック中・拒否・タイムアウト）ときは投げる。 */
	read(service: string, account: string): Promise<string | undefined>;
	/** 作るか上書きする。 */
	write(service: string, account: string, value: string): Promise<void>;
	/** 消す。もともと無ければ何もしない。 */
	delete(service: string, account: string): Promise<void>;
}

/** キーチェーンが読めない・書けない（項目が無いのとは別）。 */
export class ParadisKeychainError extends Error { }

const SECURITY_BINARY = '/usr/bin/security';
/** `security find/delete-generic-password` が「項目が無い」ときに返す終了コード（errSecItemNotFound）。 */
const NOT_FOUND_EXIT_CODE = 44;
/** ロックされたキーチェーンが解除を待ち続けても処理全体が止まらないように。正常なら 100ms もかからない。 */
const SECURITY_TIMEOUT_MS = 5_000;

/** `security` の子プロセスのうち、ここで使う部分。テストでは偽物に差し替え、本物の `security` を起動しない。 */
export interface IParadisSecurityProcess {
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'close', listener: (code: number | null) => void): unknown;
	kill(): boolean;
}

/** `child_process.spawn` のうち、ここで使う形。 */
export type ParadisSecuritySpawn = (command: string, args: readonly string[], options: cp.SpawnOptions) => IParadisSecurityProcess;

interface ISecurityResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** 本物の macOS キーチェーン。 */
export class ParadisSecurityCliKeychain implements IParadisKeychain {

	constructor(private readonly spawn: ParadisSecuritySpawn = cp.spawn) { }

	async read(service: string, account: string): Promise<string | undefined> {
		const result = await this.run(['find-generic-password', '-a', account, '-w', '-s', service]);
		if (result.code === 0) {
			// `-w` は値の後に改行を1つ付ける。それだけを落とす。
			return result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
		}
		if (result.code === NOT_FOUND_EXIT_CODE) {
			return undefined;
		}
		throw new ParadisKeychainError(`security find-generic-password failed (code ${result.code})`);
	}

	async write(service: string, account: string, value: string): Promise<void> {
		const hex = Buffer.from(value, 'utf8').toString('hex');
		const result = await this.run(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex], { ignoreStdin: true });
		if (result.code !== 0) {
			throw new ParadisKeychainError(`security add-generic-password failed (code ${result.code})`);
		}
	}

	async delete(service: string, account: string): Promise<void> {
		const result = await this.run(['delete-generic-password', '-a', account, '-s', service]);
		if (result.code === 0 || result.code === NOT_FOUND_EXIT_CODE) {
			return;
		}
		throw new ParadisKeychainError(`security delete-generic-password failed (code ${result.code})`);
	}

	/**
	 * @param options.ignoreStdin 標準入力を繋がない（引数で値を渡すとき。Claude Code と同じ）。
	 */
	private run(args: string[], options: { readonly ignoreStdin?: boolean } = {}): Promise<ISecurityResult> {
		return new Promise<ISecurityResult>((resolve, reject) => {
			let settled = false;
			let stdout = '';
			let stderr = '';
			let child: IParadisSecurityProcess;
			try {
				child = this.spawn(SECURITY_BINARY, args, { stdio: [options.ignoreStdin ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
			} catch {
				reject(new ParadisKeychainError('failed to launch security'));
				return;
			}
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					child.kill();
					reject(new ParadisKeychainError(`security timed out after ${SECURITY_TIMEOUT_MS}ms`));
				}
			}, SECURITY_TIMEOUT_MS);
			child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
			child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
			child.on('error', () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new ParadisKeychainError('failed to launch security'));
				}
			});
			child.on('close', code => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve({ code, stdout, stderr });
				}
			});
			child.stdin?.end();
		});
	}
}

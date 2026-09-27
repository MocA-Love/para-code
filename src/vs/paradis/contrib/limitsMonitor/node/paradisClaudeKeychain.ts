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
// - 書き込みは値を16進にして `security -i` の標準入力で渡す。秘密の値を引数（ps で見える）に載せない。
//   標準入力の1行は 4096 バイトまでなので、それを超える値は書かずに失敗させる（引数に落とすと、
//   同じユーザーの別のプロセスや EDR のログから読める。保存するのは `claudeAiOauth` だけなので、
//   通常はこの上限に届かない）
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

/**
 * 値が大きすぎて、標準入力（`security -i` の1行 4096 バイト）では渡せない。引数に載せる経路は
 * 使わないので書けない。Claude Code の `Claude Code-credentials` は MCP サーバーのトークン
 * （`mcpOAuth`）を含むため、数 KB になり得る。
 */
export class ParadisKeychainValueTooLargeError extends ParadisKeychainError { }

const SECURITY_BINARY = '/usr/bin/security';
/** `security find/delete-generic-password` が「項目が無い」ときに返す終了コード（errSecItemNotFound）。 */
const NOT_FOUND_EXIT_CODE = 44;
/** ロックされたキーチェーンが解除を待ち続けても処理全体が止まらないように。正常なら 100ms もかからない。 */
const SECURITY_TIMEOUT_MS = 5_000;
/** `security -i` は標準入力を 4096 バイトの行バッファで読む。余裕を 64 バイト取る。 */
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;

interface ISecurityResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** `security -i` の1行の中で値を囲む（シェルと同じ規則で読み直されるため）。 */
function quoteForSecurityStdin(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 本物の macOS キーチェーン。 */
export class ParadisSecurityCliKeychain implements IParadisKeychain {

	constructor(private readonly spawn: typeof cp.spawn = cp.spawn) { }

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
		const command = `add-generic-password -U -a ${quoteForSecurityStdin(account)} -s ${quoteForSecurityStdin(service)} -X ${hex}\n`;
		if (Buffer.byteLength(command, 'utf8') > SECURITY_STDIN_LINE_LIMIT) {
			throw new ParadisKeychainValueTooLargeError('the value is too large to pass to security through stdin');
		}
		const result = await this.run(['-i'], command);
		// `security -i` は中のコマンドが失敗しても 0 で終わることがあるので、エラー出力も見る。
		if (result.code !== 0 || /error|failed/i.test(result.stderr)) {
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

	private run(args: string[], stdin?: string): Promise<ISecurityResult> {
		return new Promise<ISecurityResult>((resolve, reject) => {
			let settled = false;
			let stdout = '';
			let stderr = '';
			let child: cp.ChildProcess;
			try {
				child = this.spawn(SECURITY_BINARY, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
			if (stdin !== undefined) {
				child.stdin?.end(stdin);
			} else {
				child.stdin?.end();
			}
		});
	}
}

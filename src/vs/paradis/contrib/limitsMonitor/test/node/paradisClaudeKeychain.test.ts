/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `security` の起動を偽物に差し替え、キーチェーンへの書き方（標準入力か引数か）を確かめる。
// 本物の `security` もキーチェーンも使わない。

import assert from 'assert';
import type * as cp from 'child_process';
import { PassThrough, Writable } from 'stream';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSecurityProcess, ParadisKeychainError, ParadisSecurityCliKeychain, PARADIS_SECURITY_STDIN_LINE_LIMIT } from '../../node/paradisClaudeKeychain.js';

interface ISecurityCall {
	readonly command: string;
	readonly args: readonly string[];
	readonly stdin: unknown;
	input: string | undefined;
}

/** 呼ばれたら決めておいた終了コードとエラー出力を返す、偽の `security`。 */
class ParadisFakeSecurityProcess implements IParadisSecurityProcess {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable | null;
	private readonly errorListeners: ((error: Error) => void)[] = [];
	private readonly closeListeners: ((code: number | null) => void)[] = [];

	constructor(private readonly call: ISecurityCall, pipeStdin: boolean, private readonly code: number, private readonly errorOutput: string) {
		if (pipeStdin) {
			let input = '';
			this.stdin = new Writable({
				write: (chunk: Buffer, _encoding, callback) => { input += chunk.toString('utf8'); callback(); },
				final: callback => { this.call.input = input; callback(); this.finish(); },
			});
		} else {
			this.stdin = null;
			setImmediate(() => this.finish());
		}
	}

	on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null) => void)): this {
		if (event === 'error') {
			this.errorListeners.push(listener as (error: Error) => void);
		} else {
			this.closeListeners.push(listener as (code: number | null) => void);
		}
		return this;
	}

	kill(): boolean {
		return true;
	}

	private finish(): void {
		this.stderr.end(this.errorOutput);
		this.stdout.end();
		setImmediate(() => this.closeListeners.forEach(listener => listener(this.code)));
	}
}

function createKeychain(code = 0, errorOutput = ''): { keychain: ParadisSecurityCliKeychain; calls: ISecurityCall[] } {
	const calls: ISecurityCall[] = [];
	const keychain = new ParadisSecurityCliKeychain((command: string, args: readonly string[], options: cp.SpawnOptions) => {
		const stdio = options.stdio as readonly unknown[];
		const call: ISecurityCall = { command, args: [...args], stdin: stdio[0], input: undefined };
		calls.push(call);
		return new ParadisFakeSecurityProcess(call, stdio[0] === 'pipe', code, errorOutput);
	});
	return { keychain, calls };
}

function hexOf(value: string): string {
	return Buffer.from(value, 'utf8').toString('hex');
}

/** `security -i` へ渡す1行（Claude Code 2.1.283 と同じ形）。 */
function stdinLine(account: string, service: string, value: string): string {
	return `add-generic-password -U -a "${account}" -s "${service}" -X "${hexOf(value)}"\n`;
}

suite('Paradis Claude keychain (security CLI)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const CLAUDE_CODE = 'Claude Code-credentials';
	const CLAUDE_CODE_SCOPED = 'Claude Code-credentials-1a2b3c4d';
	const PARA_CODE = 'Para Code Claude Accounts';
	const ACCOUNT = 'example';

	// Claude Code の項目は、Orca と同じく長さに関係なく常に引数で渡す（標準入力は繋がない）。値は Claude Code と同じ16進（-X）。
	test('always writes Claude Code items through the arguments of /usr/bin/security, short or long', async () => {
		const { keychain, calls } = createKeychain();
		const short = JSON.stringify({ claudeAiOauth: { accessToken: 'token' } });
		const long = JSON.stringify({ claudeAiOauth: { accessToken: 'token' }, mcpOAuth: { big: 'x'.repeat(3000) } });
		await keychain.write(CLAUDE_CODE, ACCOUNT, short);
		await keychain.write(CLAUDE_CODE_SCOPED, ACCOUNT, short);
		await keychain.write(CLAUDE_CODE, ACCOUNT, long);
		assert.deepStrictEqual(calls, [[CLAUDE_CODE, short], [CLAUDE_CODE_SCOPED, short], [CLAUDE_CODE, long]].map(([service, value]) => ({
			command: '/usr/bin/security',
			args: ['add-generic-password', '-U', '-a', ACCOUNT, '-s', service, '-X', hexOf(value)],
			stdin: 'ignore',
			input: undefined,
		})));
	});

	// Para Code 自身の保存分は、以前どおり標準入力で渡し、1行が 4,032 バイトを超えるときだけ引数で渡す。
	test('writes Para Code items through security -i and only an over-long line through the arguments', async () => {
		const prefixBytes = Buffer.byteLength(stdinLine(ACCOUNT, PARA_CODE, ''));
		const longest = 'a'.repeat(Math.floor((PARADIS_SECURITY_STDIN_LINE_LIMIT - prefixBytes) / 2));
		const { keychain, calls } = createKeychain();
		await keychain.write(PARA_CODE, ACCOUNT, longest);
		await keychain.write(PARA_CODE, ACCOUNT, `${longest}a`);
		assert.deepStrictEqual({ limit: PARADIS_SECURITY_STDIN_LINE_LIMIT, calls }, {
			limit: 4032,
			calls: [
				{ command: '/usr/bin/security', args: ['-i'], stdin: 'pipe', input: stdinLine(ACCOUNT, PARA_CODE, longest) },
				{ command: '/usr/bin/security', args: ['add-generic-password', '-U', '-a', ACCOUNT, '-s', PARA_CODE, '-X', hexOf(`${longest}a`)], stdin: 'ignore', input: undefined },
			],
		});
	});

	test('fails when security exits with an error on either path', async () => {
		const short = createKeychain(0, 'security: SecKeychainItemCreateFromContent: failed\n');
		const argv = createKeychain(36);
		const results = await Promise.all([
			short.keychain.write(PARA_CODE, ACCOUNT, 'small').then(() => 'written', error => error instanceof ParadisKeychainError ? 'keychain error' : 'other'),
			argv.keychain.write(CLAUDE_CODE, ACCOUNT, 'small').then(() => 'written', error => error instanceof ParadisKeychainError ? 'keychain error' : 'other'),
		]);
		assert.deepStrictEqual({ results, modes: [short.calls[0].args[0], argv.calls[0].args[0]] }, { results: ['keychain error', 'keychain error'], modes: ['-i', 'add-generic-password'] });
	});
});

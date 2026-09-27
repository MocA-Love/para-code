/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `security` の起動を偽物に差し替え、キーチェーンへの書き方（引数で渡すこと）を確かめる。
// 本物の `security` もキーチェーンも使わない。

import assert from 'assert';
import type * as cp from 'child_process';
import { PassThrough, Writable } from 'stream';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisSecurityProcess, ParadisKeychainError, ParadisSecurityCliKeychain } from '../../node/paradisClaudeKeychain.js';

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

suite('Paradis Claude keychain (security CLI)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const SERVICE = 'Claude Code-credentials';
	const ACCOUNT = 'example';

	// Orca と同じく、長さに関係なく常に引数で渡す（標準入力は繋がない）。値は Claude Code と同じ16進（-X）。
	test('always writes the value through the arguments of /usr/bin/security, short or long', async () => {
		const { keychain, calls } = createKeychain();
		const short = JSON.stringify({ claudeAiOauth: { accessToken: 'token' } });
		const long = JSON.stringify({ claudeAiOauth: { accessToken: 'token' }, mcpOAuth: { big: 'x'.repeat(3000) } });
		await keychain.write(SERVICE, ACCOUNT, short);
		await keychain.write(SERVICE, ACCOUNT, long);
		assert.deepStrictEqual(calls, [short, long].map(value => ({
			command: '/usr/bin/security',
			args: ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-X', hexOf(value)],
			stdin: 'ignore',
			input: undefined,
		})));
	});

	test('fails when security exits with an error', async () => {
		const { keychain, calls } = createKeychain(36);
		const result = await keychain.write(SERVICE, ACCOUNT, 'small').then(() => 'written', error => error instanceof ParadisKeychainError ? 'keychain error' : 'other');
		assert.deepStrictEqual({ result, mode: calls[0].args[0] }, { result: 'keychain error', mode: 'add-generic-password' });
	});
});

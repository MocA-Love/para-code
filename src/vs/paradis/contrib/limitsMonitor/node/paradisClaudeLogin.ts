/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/claude-accounts/claude-login-session.ts, src/main/claude-accounts/claude-command-process.ts

// Claude アカウントの追加・再ログインで、`claude auth login` を一時ディレクトリに向けて動かす。
//
// `CLAUDE_CONFIG_DIR`（と、Claude Code 2.1.220 以降がキーチェーンの項目名に使う
// `CLAUDE_SECURESTORAGE_CONFIG_DIR`）を一時ディレクトリにして動かすので、いまのログイン
// （~/.claude と既定のキーチェーン項目）には書かない。ログインが終わったら、そのディレクトリの
// キーチェーン項目（`Claude Code-credentials-<ハッシュ>`）と `.claude.json` から認証情報と
// oauthAccount を拾い、一時ディレクトリとその項目は消す。
//
// Claude の認証はブラウザから手元のポートへ戻ってくる方式で、その待ち受けの寿命が標準入力に
// 結び付いていることがある。標準入力は閉じずに開けたままにする（Orca と同じ）。

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import { paradisWrapWindowsScriptShim } from '../../../common/paradisWindowsScriptShim.js';
import { paradisKillChildProcessTree } from '../../../node/paradisKillChildProcess.js';

/** ブラウザでのログインを待つ上限。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
/** 出力は URL と最後の行を拾うためだけに持つ。 */
const MAX_OUTPUT_CHARS = 8_000;

/** 子プロセスへ渡さない、Claude の認証を上書きしてしまう環境変数。 */
const CLAUDE_AUTH_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];

export interface IParadisClaudeLoginRunner {
	/**
	 * `configDir` に向けて `claude auth login --claudeai` を動かし、終わるまで待つ。
	 * ログイン用の URL が出力に現れたら `onUrl` で知らせる。`signal` で中止する。
	 */
	login(configDir: string, onUrl: (url: string) => void, signal: AbortSignal): Promise<void>;
	/** `claude auth status --json` の出力（失敗しても空文字で返す）。 */
	status(configDir: string): Promise<string>;
}

/** ANSI エスケープ（CSI / OSC）を取り除く。 */
function stripAnsi(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** 出力から Claude のログイン URL を拾う。 */
export function paradisExtractClaudeLoginUrl(output: string): string | undefined {
	return /https:\/\/(?:claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/[^\s"'<>)]*/.exec(stripAnsi(output))?.[0];
}

export class ParadisClaudeCliLoginRunner implements IParadisClaudeLoginRunner {

	constructor(
		private readonly getEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly homedir: string,
		private readonly onTrace: (message: string) => void,
	) { }

	private async resolveClaude(env: NodeJS.ProcessEnv): Promise<string> {
		const isWindows = process.platform === 'win32';
		const names = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude'];
		// 相対パスの要素は除く（存在を確かめる場所と、一時ディレクトリで起動する場所で指す先がずれるため）。
		const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(dir => dir.length > 0 && path.isAbsolute(dir));
		// GUI から起動した Para Code はログインシェルの PATH を継がないことがあるので、よくある場所も見る。
		const commonDirs = isWindows
			? [path.join(this.homedir, '.local', 'bin'), path.join(this.homedir, 'AppData', 'Roaming', 'npm')]
			: [path.join(this.homedir, '.local', 'bin'), path.join(this.homedir, '.claude', 'local'), path.join(this.homedir, '.npm-global', 'bin'), path.join(this.homedir, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
		for (const dir of [...pathDirs, ...commonDirs]) {
			for (const name of names) {
				const candidate = path.join(dir, name);
				try {
					await fs.promises.access(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
					return candidate;
				} catch {
					// 次の候補
				}
			}
		}
		throw new Error('claude not found (install Claude Code first)');
	}

	private async spawnClaude(args: string[], configDir: string): Promise<cp.ChildProcess> {
		const baseEnv = await this.getEnv();
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(baseEnv)) {
			if (!CLAUDE_AUTH_ENV_KEYS.includes(process.platform === 'win32' ? key.toUpperCase() : key)) {
				env[key] = value;
			}
		}
		env.CLAUDE_CONFIG_DIR = configDir;
		env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;
		env.NO_COLOR = '1';
		const command = await this.resolveClaude(env);
		const shim = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, args) : undefined;
		return cp.spawn(shim?.file ?? command, shim?.args ?? args, {
			env,
			cwd: configDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			windowsVerbatimArguments: shim !== undefined,
		});
	}

	async login(configDir: string, onUrl: (url: string) => void, signal: AbortSignal): Promise<void> {
		const child = await this.spawnClaude(['auth', 'login', '--claudeai'], configDir);
		let output = '';
		let reportedUrl: string | undefined;
		const onData = (chunk: Buffer) => {
			output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
			const url = paradisExtractClaudeLoginUrl(output);
			if (url && url !== reportedUrl) {
				reportedUrl = url;
				onUrl(url);
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				child.stdin?.destroy();
				if (error) {
					paradisKillChildProcessTree(child, killError => this.onTrace(`failed to stop 'claude auth login': ${killError}`));
					reject(error);
				} else {
					resolve();
				}
			};
			const onAbort = () => finish(new Error('cancelled'));
			const timer = setTimeout(() => finish(new Error('timed out')), LOGIN_TIMEOUT_MS);
			signal.addEventListener('abort', onAbort);
			child.on('error', () => finish(new Error('failed to launch claude')));
			child.on('close', code => {
				if (code === 0) {
					finish();
					return;
				}
				// 出力の最後の行だけを添える（ログイン URL 以外に秘密の値は出ない）。
				const lines = stripAnsi(output).split(/\r?\n|\r/).map(line => line.trim()).filter(line => line.length > 0);
				const detail = (lines.at(-1) ?? '').slice(-200);
				finish(new Error(`claude auth login exited with code ${code}${detail ? `: ${detail}` : ''}`));
			});
			if (signal.aborted) {
				onAbort();
			}
		});
	}

	async status(configDir: string): Promise<string> {
		try {
			const child = await this.spawnClaude(['auth', 'status', '--json'], configDir);
			child.stdin?.end();
			let output = '';
			child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS); });
			return await new Promise<string>(resolve => {
				const timer = setTimeout(() => {
					paradisKillChildProcessTree(child);
					resolve('');
				}, STATUS_TIMEOUT_MS);
				child.on('error', () => { clearTimeout(timer); resolve(''); });
				child.on('close', () => { clearTimeout(timer); resolve(output); });
			});
		} catch {
			return '';
		}
	}
}

/** `claude auth status --json` の出力から、oauthAccount の代わりになる身元を拾う（oauthAccount が無いときだけ使う）。 */
export function paradisOauthAccountFromClaudeStatus(statusOutput: string): Record<string, string> | undefined {
	try {
		const parsed = JSON.parse(statusOutput) as Record<string, unknown>;
		const email = typeof parsed.email === 'string' ? parsed.email : undefined;
		if (!email) {
			return undefined;
		}
		const result: Record<string, string> = { emailAddress: email };
		const organizationUuid = typeof parsed.orgId === 'string' ? parsed.orgId : typeof parsed.organizationUuid === 'string' ? parsed.organizationUuid : undefined;
		if (organizationUuid) {
			result.organizationUuid = organizationUuid;
		}
		const organizationName = typeof parsed.orgName === 'string' ? parsed.orgName : typeof parsed.organizationName === 'string' ? parsed.organizationName : undefined;
		if (organizationName) {
			result.organizationName = organizationName;
		}
		return result;
	} catch {
		return undefined;
	}
}

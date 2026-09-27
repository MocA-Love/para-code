/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process から Claude Code / Codex の CLI を短時間だけ起こすための共通部品。
//
// - 実行ファイルの解決: GUI 起動ではログインシェルの PATH が継承されないことがあるので、
//   PATH で見つからなければ、よくあるインストール先を直接見る（limitsMonitor と同じ候補）。
// - Para Code のペイン用ランチャー（`resources/paradis/bin/codex`）は PATH から外して探す。
//   あれはターミナルの中で使う入口で、裏で CLI を起こす用途に挟む意味が無い。
// - 起動した子プロセスは、時間切れでも必ずツリーごと止める。

import * as cp from 'child_process';
import * as fs from 'fs';
import { homedir } from 'os';
import { delimiter, join } from '../../base/common/path.js';
import { findExecutable } from '../../base/node/processes.js';
import { paradisWrapWindowsScriptShim } from '../common/paradisWindowsScriptShim.js';
import { paradisKillChildProcessTree } from './paradisKillChildProcess.js';

export type ParadisAgentCliName = 'claude' | 'codex';

export interface IParadisResolveAgentCliOptions {
	/** PATH から外すディレクトリ（Para Code のペイン用ランチャーの置き場所など）。 */
	readonly excludeDirs?: readonly string[];
	/** テスト用。既定は実ファイルの有無。 */
	readonly fileExists?: (path: string) => Promise<boolean>;
	/** テスト用。既定は `os.homedir()`。 */
	readonly homeDir?: string;
	readonly platform?: NodeJS.Platform;
}

function defaultFileExists(path: string): Promise<boolean> {
	return new Promise(resolve => fs.access(path, fs.constants.F_OK, error => resolve(!error)));
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
	const normalize = (value: string) => {
		const trimmed = value.replace(/[\\/]+$/, '');
		return platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
	};
	return normalize(a) === normalize(b);
}

/**
 * CLI の実行ファイルを探す。見つからなければ undefined。
 */
export async function paradisResolveAgentCli(name: ParadisAgentCliName, env: NodeJS.ProcessEnv, options: IParadisResolveAgentCliOptions = {}): Promise<string | undefined> {
	const platform = options.platform ?? process.platform;
	const fileExists = options.fileExists ?? defaultFileExists;
	const excludeDirs = (options.excludeDirs ?? []).filter(dir => dir.length > 0);
	const pathValue = env.PATH ?? env.Path ?? '';
	const paths = pathValue.split(delimiter).filter(entry => entry.length > 0 && !excludeDirs.some(dir => samePath(entry, dir, platform)));
	const found = await findExecutable(name, undefined, paths, env, fileExists);
	if (found !== undefined) {
		return found;
	}
	const home = options.homeDir ?? homedir();
	const isWindows = platform === 'win32';
	const names = isWindows ? [`${name}.exe`, `${name}.cmd`, name] : [name];
	const candidateDirs = isWindows
		? [join(home, '.local', 'bin'), join(home, 'AppData', 'Roaming', 'npm')]
		: [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
	for (const dir of candidateDirs) {
		for (const candidate of names) {
			const fullPath = join(dir, candidate);
			if (await fileExists(fullPath)) {
				return fullPath;
			}
		}
	}
	return undefined;
}

/**
 * 裏で CLI を起こすときの環境変数。Para Code のペインに結び付く変数（`PARA_CODE_*`）は外す。
 * これが残っていると、CLI が起動した hook が「どこかのペインの出来事」として通知へ流れうる。
 */
export function paradisDetachedAgentCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith('PARA_CODE_')) {
			result[key] = value;
		}
	}
	return result;
}

/**
 * 子プロセスを起こす。Windows の .cmd/.bat シムは cmd.exe で包む
 * （包まずに spawn すると CVE-2024-27980 対策後の Node では EINVAL になる）。
 *
 * `args` は固定文字列だけを渡すこと（{@link paradisWrapWindowsScriptShim} の注意を参照）。
 */
export function paradisSpawnAgentCli(command: string, args: readonly string[], options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string }): cp.ChildProcessWithoutNullStreams {
	const shim = process.platform === 'win32' ? paradisWrapWindowsScriptShim(command, args) : undefined;
	return cp.spawn(shim?.file ?? command, shim?.args ?? [...args], {
		env: options.env,
		cwd: options.cwd,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		windowsVerbatimArguments: shim !== undefined,
	});
}

export interface IParadisRunAgentCliResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
}

export interface IParadisRunAgentCliOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd?: string;
	/** 書き込んだあと stdin を閉じる。 */
	readonly stdin?: string;
	readonly timeoutMs: number;
	/** stdout / stderr それぞれの上限。超えた分は捨てる。 */
	readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * CLI を1回だけ動かして出力を集める。起動できない・時間切れのときは例外にする。
 * 終了コードが 0 以外でも例外にはしない（呼び出し側が出力を見て判断する）。
 */
export function paradisRunAgentCli(command: string, args: readonly string[], options: IParadisRunAgentCliOptions): Promise<IParadisRunAgentCliResult> {
	return new Promise((resolve, reject) => {
		const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		let child: cp.ChildProcessWithoutNullStreams;
		try {
			child = paradisSpawnAgentCli(command, args, { env: options.env, cwd: options.cwd });
		} catch (error) {
			reject(error);
			return;
		}
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const finish = (error: Error | undefined, exitCode: number | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (error) {
				reject(error);
				return;
			}
			resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode });
		};
		const timer = setTimeout(() => {
			paradisKillChildProcessTree(child);
			finish(new Error(`${command} timed out after ${options.timeoutMs}ms`), null);
		}, options.timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdoutBytes < maxBytes) {
				stdout.push(chunk);
				stdoutBytes += chunk.length;
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderrBytes < maxBytes) {
				stderr.push(chunk);
				stderrBytes += chunk.length;
			}
		});
		child.on('error', error => finish(error, null));
		child.on('close', code => finish(undefined, code));
		// 子が先に終わると stdin への書き込みは EPIPE になる。そのときは close の結果で判断する
		child.stdin.on('error', () => { /* handled by close */ });
		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();
	});
}

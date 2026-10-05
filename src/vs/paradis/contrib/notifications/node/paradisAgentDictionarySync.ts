/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げの辞書を、このマシンの aivis-mcp（エージェントの読み上げ）へ書く。shared process（手元）と
// REH サーバー（SSH の接続先）の両方で同じものが動き、それぞれのマシンの aivis-mcp と `~/.para-code` を扱う。
//
// - aivis-mcp は `aivis-mcp --ingest` と同じ探し方（ログインシェル由来の PATH の `aivis-mcp`、Windows は cmd.exe 経由）
// - 呼ぶ前に `aivis-mcp --version` で 2.5.3 以上かを確かめる。無い・古いなら何もしない（ログだけ）
// - 最後に書いた値は `~/.para-code/agent-dictionary.json` に覚える。aivis-mcp の設定は読むだけで、書くのは CLI だけ
// - 辞書の ID はログに出さない
// - 複数のウィンドウから同時に来ても、1 本ずつ流す（毎回、覚えている値と aivis-mcp の設定を読み直して決める）

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { dirname, join } from '../../../../base/common/path.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisAgentDictionaryCurrent,
	IParadisAgentDictionaryRequest,
	IParadisAgentDictionarySyncResult,
	IParadisAgentDictionaryWritten,
	PARADIS_AGENT_DICTIONARY_MIN_VERSION,
	PARADIS_AGENT_DICTIONARY_PROVIDERS,
	ParadisAgentDictionaryStep,
	paradisAgentDictionaryArgs,
	paradisAgentDictionaryFromConfig,
	paradisApplyAgentDictionaryStep,
	paradisNormalizeAgentDictionaryRequest,
	paradisPlanAgentDictionarySteps,
} from '../common/paradisAgentDictionary.js';
import { paradisAivisVersionAtLeast, paradisParseAivisVersion } from '../common/paradisVoiceIngest.js';

/** `--version` も `--set-dictionary` も設定を 1 つ書くだけ（ロック待ちは aivis-mcp 側で 5 秒まで）。 */
const RUN_TIMEOUT_MS = 10_000;

export interface IParadisAivisMcpRunResult {
	/** 終了コード。起動できなかった（未導入など）・時間切れは undefined。 */
	readonly code: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
}

export type ParadisAivisMcpRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<IParadisAivisMcpRunResult>;

export interface IParadisAgentDictionarySyncOptions {
	readonly getEnv: () => Promise<NodeJS.ProcessEnv>;
	readonly logService: ILogService;
	readonly run?: ParadisAivisMcpRunner;
	/** aivis-mcp の今の辞書。読めなければ undefined。 */
	readonly readCurrent?: (env: NodeJS.ProcessEnv) => Promise<IParadisAgentDictionaryCurrent | undefined>;
	/** 最後に書いた値を覚えるファイル。 */
	readonly statePath?: string;
}

/** 手元（または接続先）の aivis-mcp を、引数を固定して呼ぶ（shell は使わない）。 */
export function paradisRunAivisMcp(args: readonly string[], env: NodeJS.ProcessEnv): Promise<IParadisAivisMcpRunResult> {
	return new Promise(resolve => {
		const isWindows = process.platform === 'win32';
		// 引数は呼ぶ側で形を確かめた英数字・`-`・`_` だけ（引用符や空白を含まない）
		if (args.some(arg => !/^[A-Za-z0-9_.-]+$/.test(arg))) {
			resolve({ code: undefined, stdout: '', stderr: 'unsupported argument' });
			return;
		}
		// Windows の npm のグローバルは `aivis-mcp.cmd` で、cmd.exe を通さないと起動できない（--ingest と同じ）
		const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'aivis-mcp';
		const commandArgs = isWindows ? ['/d', '/s', '/c', `"aivis-mcp ${args.join(' ')}"`] : [...args];
		execFile(command, commandArgs, { env, cwd: homedir(), timeout: RUN_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: isWindows, encoding: 'utf8' }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : undefined) : 0;
			resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
		});
	});
}

/** aivis-mcp と同じ場所（`AIVIS_CONFIG_FILE`、無ければ `~/.config/aivis-mcp/config.json`）の設定から今の辞書を読む。 */
async function readAivisMcpDictionary(env: NodeJS.ProcessEnv): Promise<IParadisAgentDictionaryCurrent | undefined> {
	const path = env.AIVIS_CONFIG_FILE || join(homedir(), '.config', 'aivis-mcp', 'config.json');
	let text: string;
	try {
		text = await fs.readFile(path, 'utf8');
	} catch (error) {
		// 設定ファイルが無い＝辞書は何も入っていない
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : undefined;
	}
	try {
		return paradisAgentDictionaryFromConfig(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export function paradisDefaultAgentDictionaryStatePath(): string {
	return join(homedir(), '.para-code', 'agent-dictionary.json');
}

export class ParadisAgentDictionarySyncService {

	private queue: Promise<unknown> = Promise.resolve();
	private readonly run: ParadisAivisMcpRunner;
	private readonly readCurrent: (env: NodeJS.ProcessEnv) => Promise<IParadisAgentDictionaryCurrent | undefined>;
	private readonly statePath: string;

	constructor(private readonly options: IParadisAgentDictionarySyncOptions) {
		this.run = options.run ?? paradisRunAivisMcp;
		this.readCurrent = options.readCurrent ?? readAivisMcpDictionary;
		this.statePath = options.statePath ?? paradisDefaultAgentDictionaryStatePath();
	}

	/** 設定に合わせて aivis-mcp の辞書を書く・消す。失敗しても reject しない。 */
	apply(raw: unknown): Promise<IParadisAgentDictionarySyncResult> {
		const request = paradisNormalizeAgentDictionaryRequest(raw);
		const next = this.queue.then(() => this.doApply(request));
		this.queue = next.catch(() => undefined);
		return next.catch(error => {
			this.options.logService.warn(`[ParadisAgentDictionary] sync failed: ${error instanceof Error ? error.message : String(error)}`);
			return { status: 'failed' };
		});
	}

	private async doApply(request: IParadisAgentDictionaryRequest): Promise<IParadisAgentDictionarySyncResult> {
		const env = await this.options.getEnv();
		let written = await this.readWritten();
		const current = await this.readCurrent(env);
		const steps = paradisPlanAgentDictionarySteps(request, written, current);
		if (steps.length === 0) {
			return { status: 'unchanged' };
		}

		// aivis-mcp を呼ばない手順（覚えている値を忘れるだけ）は先に済ませる
		const calls: ParadisAgentDictionaryStep[] = [];
		for (const step of steps) {
			if (step.kind === 'forget') {
				this.options.logService.info(`[ParadisAgentDictionary] ${step.provider}: aivis-mcp uses another dictionary now; leaving it as is`);
				written = paradisApplyAgentDictionaryStep(written, step);
			} else {
				calls.push(step);
			}
		}
		if (calls.length === 0) {
			await this.writeWritten(written);
			return { status: 'unchanged' };
		}

		const versionOutput = await this.run(['--version'], env);
		const version = versionOutput.code === 0 ? paradisParseAivisVersion(versionOutput.stdout) : undefined;
		if (!paradisAivisVersionAtLeast(version, PARADIS_AGENT_DICTIONARY_MIN_VERSION)) {
			this.options.logService.info(version
				? `[ParadisAgentDictionary] aivis-mcp ${version.join('.')} cannot take a dictionary (needs ${PARADIS_AGENT_DICTIONARY_MIN_VERSION.join('.')} or later); skipped`
				: '[ParadisAgentDictionary] aivis-mcp is not installed here; skipped');
			if (calls.length !== steps.length) {
				await this.writeWritten(written);
			}
			return { status: 'unsupported' };
		}

		let failed = false;
		for (const step of calls) {
			const args = paradisAgentDictionaryArgs(step);
			if (!args) {
				continue;
			}
			const result = await this.run(args, env);
			if (result.code === 0 && result.stdout.trim() === 'ok') {
				written = paradisApplyAgentDictionaryStep(written, step);
				this.options.logService.info(`[ParadisAgentDictionary] ${step.provider}: ${step.kind === 'set' ? 'set the dictionary' : 'cleared the dictionary'} in aivis-mcp`);
			} else {
				failed = true;
				this.options.logService.warn(`[ParadisAgentDictionary] ${step.provider}: aivis-mcp --${step.kind}-dictionary failed (exit ${result.code ?? 'none'}): ${redact(result.stderr, step)}`);
			}
		}
		await this.writeWritten(written);
		return { status: failed ? 'failed' : 'applied' };
	}

	private async readWritten(): Promise<IParadisAgentDictionaryWritten> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
			const result: { -readonly [K in keyof IParadisAgentDictionaryWritten]: string } = {};
			for (const provider of PARADIS_AGENT_DICTIONARY_PROVIDERS) {
				const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[provider] : undefined;
				if (typeof value === 'string' && value) {
					result[provider] = value;
				}
			}
			return result;
		} catch {
			return {};
		}
	}

	private async writeWritten(written: IParadisAgentDictionaryWritten): Promise<void> {
		try {
			await fs.mkdir(dirname(this.statePath), { recursive: true });
			const temp = `${this.statePath}.${process.pid}.tmp`;
			await fs.writeFile(temp, JSON.stringify(written), { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temp, this.statePath);
		} catch (error) {
			this.options.logService.warn(`[ParadisAgentDictionary] could not remember the dictionary written to aivis-mcp: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** aivis-mcp のエラーの 1 行目。辞書の ID は伏せる。 */
function redact(stderr: string, step: ParadisAgentDictionaryStep): string {
	let line = stderr.trim().split(/\r?\n/, 1)[0] ?? '';
	if (step.kind === 'set') {
		line = line.split(step.id).join('<id>');
	}
	return line.slice(0, 300);
}

export class ParadisAgentDictionarySyncChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisAgentDictionarySyncService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'apply': return this.service.apply(arg) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

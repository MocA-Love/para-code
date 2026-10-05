/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定の「音量の補正」ページのために、この PC の aivis-mcp（2.5.4 以上）の音量の表を読む・やり直す・
// 書き出す・読み込む・学習の窓を変える。shared process で動く（SSH 先の表は扱わない）。
//
// - aivis-mcp の探し方と呼び方は辞書の同期と同じ（paradisRunAivisMcp。シェルを通さず、引数は形を確かめたものだけ）
// - 呼ぶ前に `aivis-mcp --version` で 2.5.4 以上かを確かめる（結果は少しの間覚える）
// - ファイルの引数は絶対パスだけ。読み込みはファイルが、書き出しは置き場所のフォルダがあることを確かめる
// - 書き換える操作は 1 本ずつ流す
// - 失敗のログには、渡した鍵（声の ID を含む）やファイルのパスを出さない

import { promises as fs } from 'fs';
import { dirname } from '../../../../base/common/path.js';
import { Event } from '../../../../base/common/event.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisVoiceGainImportResult,
	IParadisVoiceGainList,
	PARADIS_VOICE_GAINS_MIN_VERSION,
	ParadisVoiceGainsResult,
	paradisAivisMcpErrorMessage,
	paradisExportVoiceGainsArgs,
	paradisImportVoiceGainsArgs,
	paradisListVoiceGainsArgs,
	paradisParseVoiceGainExport,
	paradisParseVoiceGainImport,
	paradisParseVoiceGainList,
	paradisResetVoiceGainArgs,
	paradisSetGainLearningArgs,
	paradisSplitVoiceGainKey,
} from '../common/paradisVoiceGains.js';
import { paradisAivisVersionAtLeast, paradisParseAivisVersion } from '../common/paradisVoiceIngest.js';
import { ParadisAivisMcpRunner, paradisRunAivisMcp } from './paradisAgentDictionarySync.js';

/** 版を覚えておく時間（aivis-mcp を上げた後、ページを開き直せば分かる長さ）。 */
const VERSION_TTL_MS = 30_000;
/** 読み込み・書き出しは表の全部を扱うので、少し長めに待つ。 */
const TRANSFER_TIMEOUT_MS = 30_000;

export interface IParadisVoiceGainsServiceOptions {
	readonly getEnv: () => Promise<NodeJS.ProcessEnv>;
	readonly logService: ILogService;
	readonly run?: (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => ReturnType<ParadisAivisMcpRunner>;
	readonly platform?: string;
	readonly now?: () => number;
}

type Unsupported = { readonly status: 'unsupported'; readonly version: string | undefined };

export class ParadisVoiceGainsService {

	private queue: Promise<unknown> = Promise.resolve();
	private version: { readonly value: readonly [number, number, number] | undefined; readonly at: number } | undefined;
	private readonly run: NonNullable<IParadisVoiceGainsServiceOptions['run']>;
	private readonly platform: string;
	private readonly now: () => number;

	constructor(private readonly options: IParadisVoiceGainsServiceOptions) {
		this.run = options.run ?? paradisRunAivisMcp;
		this.platform = options.platform ?? process.platform;
		this.now = options.now ?? Date.now;
	}

	/** 表を読む。 */
	list(): Promise<ParadisVoiceGainsResult<IParadisVoiceGainList>> {
		return this.call(paradisListVoiceGainsArgs(), undefined, paradisParseVoiceGainList, false);
	}

	/** 1 行の測定を捨てて、次の発話から測り直させる。 */
	reset(key: unknown): Promise<ParadisVoiceGainsResult<true>> {
		const args = typeof key === 'string' ? paradisResetVoiceGainArgs(key) : undefined;
		return this.call(args, undefined, okLine, true);
	}

	/** 表をファイルに書き出す（書き出した行の数）。 */
	async exportTo(path: unknown): Promise<ParadisVoiceGainsResult<number>> {
		const args = typeof path === 'string' ? paradisExportVoiceGainsArgs(path, this.platform) : undefined;
		if (!args || !(await this.isDirectory(dirname(path as string)))) {
			return { status: 'failed', message: 'invalid file' };
		}
		return this.call(args, TRANSFER_TIMEOUT_MS, paradisParseVoiceGainExport, true);
	}

	/** ファイルの表を足す。`overwrite` は受け取った値で自分の行を上書きする。 */
	async importFrom(path: unknown, overwrite: unknown): Promise<ParadisVoiceGainsResult<IParadisVoiceGainImportResult>> {
		const args = typeof path === 'string' ? paradisImportVoiceGainsArgs(path, overwrite === true, this.platform) : undefined;
		if (!args || !(await this.isFile(path as string))) {
			return { status: 'failed', message: 'invalid file' };
		}
		return this.call(args, TRANSFER_TIMEOUT_MS, paradisParseVoiceGainImport, true);
	}

	/** 学習の窓（回数・最短の秒数）を変える。 */
	setLearning(window: unknown, minSeconds: unknown): Promise<ParadisVoiceGainsResult<true>> {
		const args = paradisSetGainLearningArgs(typeof window === 'number' ? window : undefined, typeof minSeconds === 'number' ? minSeconds : undefined);
		return this.call(args, undefined, okLine, true);
	}

	private call<T>(args: string[] | undefined, timeoutMs: number | undefined, parse: (stdout: string) => T | undefined, mutates: boolean): Promise<ParadisVoiceGainsResult<T>> {
		if (!args) {
			return Promise.resolve({ status: 'failed', message: 'invalid argument' });
		}
		const task = () => this.doCall(args, timeoutMs, parse);
		if (!mutates) {
			return task();
		}
		const next = this.queue.then(task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async doCall<T>(args: string[], timeoutMs: number | undefined, parse: (stdout: string) => T | undefined): Promise<ParadisVoiceGainsResult<T>> {
		try {
			const env = await this.options.getEnv();
			const unsupported = await this.checkVersion(env);
			if (unsupported) {
				return unsupported;
			}
			const result = await this.run(args, env, timeoutMs);
			const value = result.code === 0 ? parse(result.stdout) : undefined;
			if (value === undefined) {
				const message = paradisAivisMcpErrorMessage(result.stderr) || `exit ${result.code ?? 'none'}`;
				this.options.logService.warn(`[ParadisVoiceGains] aivis-mcp ${args[0]} failed: ${redactArgs(message, args)}`);
				return { status: 'failed', message };
			}
			return { status: 'ok', value };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.logService.warn(`[ParadisVoiceGains] aivis-mcp ${args[0]} failed: ${redactArgs(message, args)}`);
			return { status: 'failed', message };
		}
	}

	/** 2.5.4 未満・未導入なら `unsupported` を返す。 */
	private async checkVersion(env: NodeJS.ProcessEnv): Promise<Unsupported | undefined> {
		if (!this.version || this.now() - this.version.at > VERSION_TTL_MS) {
			const output = await this.run(['--version'], env);
			this.version = { value: output.code === 0 ? paradisParseAivisVersion(output.stdout) : undefined, at: this.now() };
		}
		const version = this.version.value;
		if (paradisAivisVersionAtLeast(version, PARADIS_VOICE_GAINS_MIN_VERSION)) {
			return undefined;
		}
		// 未導入・古いと分かったら、次に開いたときに上げた後の版を見られるよう覚えない
		this.version = undefined;
		return { status: 'unsupported', version: version?.join('.') };
	}

	private async isFile(path: string): Promise<boolean> {
		try {
			return (await fs.stat(path)).isFile();
		} catch {
			return false;
		}
	}

	private async isDirectory(path: string): Promise<boolean> {
		try {
			return (await fs.stat(path)).isDirectory();
		} catch {
			return false;
		}
	}
}

/** ログに出すエラーから、渡した値（表の鍵＝声の ID、ファイルのパス）を伏せる。画面へ返す文はそのまま。 */
function redactArgs(message: string, args: readonly string[]): string {
	const values = args.filter(arg => !arg.startsWith('--'));
	// aivis-mcp は長い鍵を途中で切って出すので、鍵の中の声の ID も伏せる
	const voices = values.map(arg => paradisSplitVoiceGainKey(arg)?.voice).filter((voice): voice is string => !!voice && voice.length >= 4);
	return [...values, ...voices].sort((a, b) => b.length - a.length).reduce((text, value) => text.split(value).join('<arg>'), message);
}

function okLine(stdout: string): true | undefined {
	return stdout.trim() === 'ok' ? true : undefined;
}

export class ParadisVoiceGainsChannel<TContext> implements IServerChannel<TContext> {

	constructor(private readonly service: ParadisVoiceGainsService) { }

	listen<T>(_ctx: TContext, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	call<T>(_ctx: TContext, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'list': return this.service.list() as Promise<T>;
			case 'reset': return this.service.reset(args[0]) as Promise<T>;
			case 'export': return this.service.exportTo(args[0]) as Promise<T>;
			case 'import': return this.service.importFrom(args[0], args[1]) as Promise<T>;
			case 'setLearning': return this.service.setLearning(args[0], args[1]) as Promise<T>;
		}
		throw new Error(`Call not found: ${command}`);
	}
}

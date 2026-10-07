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
// - ElevenLabs の声ごとの調整も同じ流れで書く。こちらは 2.5.4 以上が要り、2.5.3 では声の調整だけを飛ばす
// - 最後に書いた値は `~/.para-code/agent-dictionary.json` に覚える。aivis-mcp の設定は読むだけで、書くのは CLI だけ
// - 辞書の ID はログに出さない
// - 複数のウィンドウから同時に来ても、1 本ずつ流す（毎回、覚えている値と aivis-mcp の設定を読み直して決める）
// - aivis-mcp を起こせなかった（見つからない・時間切れ）・書けなかったときは、少し後に最後の設定でもう一度試す。
//   起動直後は Para Code 自身の起動で重く、`--version` が時間切れになって一度きりの同期が抜け落ちていた

import { execFile, ExecFileException } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { paradisIsSafeAivisMcpPath } from '../common/paradisVoiceGains.js';
import { paradisAivisVersionAtLeast, paradisParseAivisVersion } from '../common/paradisVoiceIngest.js';
import {
	IParadisElevenLabsVoiceTuningMap,
	PARADIS_VOICE_TUNING_MIN_VERSION,
	ParadisVoiceTuningStep,
	paradisApplyVoiceTuningStep,
	paradisNormalizeVoiceTuningMap,
	paradisPlanAllVoiceTuningSteps,
	paradisVoiceTuningArgs,
	paradisVoiceTuningFromConfig,
} from '../common/paradisVoiceTuning.js';

/** `--version` も `--set-dictionary` も設定を 1 つ書くだけ（ロック待ちは aivis-mcp 側で 5 秒まで）。 */
const RUN_TIMEOUT_MS = 10_000;
/** 同期は裏で流すだけなので、マシンが重いときに備えて長めに待つ。 */
const SYNC_RUN_TIMEOUT_MS = 30_000;
/** aivis-mcp を起こせなかった・書けなかったときに、もう一度試すまでの待ち（回数もこれで決まる）。 */
const RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 5 * 60_000, 15 * 60_000];

export interface IParadisAivisMcpRunResult {
	/** 終了コード。起動できなかった（未導入など）・時間切れは undefined。 */
	readonly code: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	/** 起動できなかった・止められた理由（`not found`・`timed out after 30s` など）。パスは含めない。 */
	readonly failure?: string;
}

export type ParadisAivisMcpRunner = (args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<IParadisAivisMcpRunResult>;

/** 英数字・`-`・`_`・`.`・`:`（`--reset-gain --key` の鍵）だけの引数。 */
const PLAIN_ARG = /^[A-Za-z0-9_.:-]+$/;

export interface IParadisAgentDictionarySyncOptions {
	readonly getEnv: () => Promise<NodeJS.ProcessEnv>;
	readonly logService: ILogService;
	readonly run?: ParadisAivisMcpRunner;
	/** aivis-mcp の今の辞書。読めなければ undefined。 */
	readonly readCurrent?: (env: NodeJS.ProcessEnv) => Promise<IParadisAgentDictionaryCurrent | undefined>;
	/** aivis-mcp の今の声ごとの調整。読めなければ undefined。 */
	readonly readCurrentVoiceSettings?: (env: NodeJS.ProcessEnv) => Promise<IParadisElevenLabsVoiceTuningMap | undefined>;
	/** 最後に書いた値を覚えるファイル。 */
	readonly statePath?: string;
	/** もう一度試す予約（テスト用）。既定は setTimeout。 */
	readonly scheduleRetry?: (callback: () => Promise<void>, delayMs: number) => IDisposable;
}

/**
 * 手元（または接続先）の aivis-mcp を、引数を固定して呼ぶ（shell は使わない）。
 * 引数は呼ぶ側で形を確かめた英数字・`-`・`_`・`.`・`:` か、`paradisIsSafeAivisMcpPath` を通る絶対パスだけ。
 */
export function paradisRunAivisMcp(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number = RUN_TIMEOUT_MS): Promise<IParadisAivisMcpRunResult> {
	return new Promise(resolve => {
		const isWindows = process.platform === 'win32';
		if (args.some(arg => !PLAIN_ARG.test(arg) && !paradisIsSafeAivisMcpPath(arg, process.platform))) {
			resolve({ code: undefined, stdout: '', stderr: 'unsupported argument' });
			return;
		}
		// Windows の npm のグローバルは `aivis-mcp.cmd` で、cmd.exe を通さないと起動できない（--ingest と同じ）。
		// 空白を含むパスだけを引用符で囲む（cmd.exe が特別に読む文字はパスの検査で拒んでいる）
		const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'aivis-mcp';
		const commandArgs = isWindows ? ['/d', '/s', '/c', `"aivis-mcp ${args.map(arg => PLAIN_ARG.test(arg) ? arg : `"${arg}"`).join(' ')}"`] : [...args];
		execFile(command, commandArgs, { env, cwd: homedir(), timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: isWindows, encoding: 'utf8' }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : undefined) : 0;
			resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), failure: code === undefined && error ? paradisDescribeRunError(error, timeoutMs) : undefined });
		});
	});
}

/** execFile が起こせなかった・止めた理由。メッセージ（パスを含む）は使わない。 */
function paradisDescribeRunError(error: ExecFileException, timeoutMs: number): string {
	if (error.code === 'ENOENT') {
		return 'not found on PATH';
	}
	if (error.killed || error.signal) {
		return error.killed ? `timed out after ${timeoutMs / 1000}s` : `killed by ${error.signal}`;
	}
	return typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'could not start';
}

/** aivis-mcp と同じ場所（`AIVIS_CONFIG_FILE`、無ければ `~/.config/aivis-mcp/config.json`）の設定を読む。読めなければ undefined。 */
async function readAivisMcpConfig(env: NodeJS.ProcessEnv): Promise<unknown | undefined> {
	const path = env.AIVIS_CONFIG_FILE || join(homedir(), '.config', 'aivis-mcp', 'config.json');
	let text: string;
	try {
		text = await fs.readFile(path, 'utf8');
	} catch (error) {
		// 設定ファイルが無い＝何も入っていない
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** aivis-mcp の設定から今の辞書を読む。 */
async function readAivisMcpDictionary(env: NodeJS.ProcessEnv): Promise<IParadisAgentDictionaryCurrent | undefined> {
	const config = await readAivisMcpConfig(env);
	return config === undefined ? undefined : paradisAgentDictionaryFromConfig(config);
}

/** aivis-mcp の設定から今の声ごとの調整を読む。 */
async function readAivisMcpVoiceSettings(env: NodeJS.ProcessEnv): Promise<IParadisElevenLabsVoiceTuningMap | undefined> {
	const config = await readAivisMcpConfig(env);
	return config === undefined ? undefined : paradisVoiceTuningFromConfig(config);
}

/** Para Code が最後に aivis-mcp へ書いた値（辞書と声ごとの調整）。 */
interface IParadisAgentWrittenState {
	readonly dictionaries: IParadisAgentDictionaryWritten;
	readonly voiceSettings: IParadisElevenLabsVoiceTuningMap;
}

export function paradisDefaultAgentDictionaryStatePath(): string {
	return join(homedir(), '.para-code', 'agent-dictionary.json');
}

export class ParadisAgentDictionarySyncService {

	private queue: Promise<unknown> = Promise.resolve();
	/** apply のたびに増える。もう一度試す予約は、その後に新しい設定が来ていなければだけ動かす。 */
	private generation = 0;
	private retryTimer: IDisposable | undefined;
	private readonly run: ParadisAivisMcpRunner;
	private readonly readCurrent: (env: NodeJS.ProcessEnv) => Promise<IParadisAgentDictionaryCurrent | undefined>;
	private readonly readCurrentVoiceSettings: (env: NodeJS.ProcessEnv) => Promise<IParadisElevenLabsVoiceTuningMap | undefined>;
	private readonly statePath: string;

	constructor(private readonly options: IParadisAgentDictionarySyncOptions) {
		this.run = options.run ?? paradisRunAivisMcp;
		this.readCurrent = options.readCurrent ?? readAivisMcpDictionary;
		this.readCurrentVoiceSettings = options.readCurrentVoiceSettings ?? readAivisMcpVoiceSettings;
		this.statePath = options.statePath ?? paradisDefaultAgentDictionaryStatePath();
	}

	/** 設定に合わせて aivis-mcp の辞書を書く・消す。失敗しても reject しない。 */
	apply(raw: unknown): Promise<IParadisAgentDictionarySyncResult> {
		this.retryTimer?.dispose();
		this.retryTimer = undefined;
		return this.enqueue(paradisNormalizeAgentDictionaryRequest(raw), 0, ++this.generation);
	}

	private enqueue(request: IParadisAgentDictionaryRequest, attempt: number, generation: number): Promise<IParadisAgentDictionarySyncResult> {
		const next = this.queue.then(() => this.doApply(request));
		this.queue = next.catch(() => undefined);
		return next.then(({ result, retry }) => {
			this.scheduleRetry(retry, request, attempt, generation);
			return result;
		}, error => {
			this.options.logService.warn(`[ParadisAgentDictionary] sync failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleRetry(true, request, attempt, generation);
			return { status: 'failed' as const };
		});
	}

	/** aivis-mcp を起こせなかった・書けなかったときに、同じ設定でもう一度試す（その間に新しい設定が来たら取りやめる）。 */
	private scheduleRetry(retry: boolean, request: IParadisAgentDictionaryRequest, attempt: number, generation: number): void {
		if (!retry || generation !== this.generation) {
			return;
		}
		const delay = RETRY_DELAYS_MS[attempt];
		if (delay === undefined) {
			this.options.logService.warn('[ParadisAgentDictionary] gave up syncing with aivis-mcp; it will be tried again when the setting changes or Para Code restarts');
			return;
		}
		this.options.logService.info(`[ParadisAgentDictionary] will try aivis-mcp again in ${Math.round(delay / 1000)}s`);
		const schedule = this.options.scheduleRetry ?? defaultScheduleRetry;
		this.retryTimer?.dispose();
		this.retryTimer = schedule(async () => {
			this.retryTimer = undefined;
			if (generation === this.generation) {
				await this.enqueue(request, attempt + 1, generation);
			}
		}, delay);
	}

	private async doApply(request: IParadisAgentDictionaryRequest): Promise<{ readonly result: IParadisAgentDictionarySyncResult; readonly retry: boolean }> {
		const env = await this.options.getEnv();
		const state = await this.readWritten();
		let written = state.dictionaries;
		let writtenVoices = state.voiceSettings;
		const current = await this.readCurrent(env);
		const currentVoices = await this.readCurrentVoiceSettings(env);
		const steps = paradisPlanAgentDictionarySteps(request, written, current);
		const voiceSteps = paradisPlanAllVoiceTuningSteps(request.enabled, request.voiceSettings ?? {}, writtenVoices, currentVoices);
		if (steps.length === 0 && voiceSteps.length === 0) {
			return { result: { status: 'unchanged' }, retry: false };
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
		const voiceCalls: ParadisVoiceTuningStep[] = [];
		for (const step of voiceSteps) {
			if (step.kind === 'forget') {
				this.options.logService.info('[ParadisAgentDictionary] voice settings: aivis-mcp has other values for a voice now; leaving them as is');
				writtenVoices = paradisApplyVoiceTuningStep(writtenVoices, step);
			} else {
				voiceCalls.push(step);
			}
		}
		const forgot = calls.length !== steps.length || voiceCalls.length !== voiceSteps.length;
		if (calls.length === 0 && voiceCalls.length === 0) {
			await this.writeWritten({ dictionaries: written, voiceSettings: writtenVoices });
			return { result: { status: 'unchanged' }, retry: false };
		}

		const versionOutput = await this.run(['--version'], env, SYNC_RUN_TIMEOUT_MS);
		const version = versionOutput.code === 0 ? paradisParseAivisVersion(versionOutput.stdout) : undefined;
		if (!paradisAivisVersionAtLeast(version, PARADIS_AGENT_DICTIONARY_MIN_VERSION)) {
			// 版が読めなかった（見つからない・時間切れ・異常終了）ときは、理由を出して後で試し直す。古い版なら試し直さない
			this.options.logService.info(version
				? `[ParadisAgentDictionary] aivis-mcp ${version.join('.')} cannot take a dictionary (needs ${PARADIS_AGENT_DICTIONARY_MIN_VERSION.join('.')} or later); skipped`
				: `[ParadisAgentDictionary] could not read the aivis-mcp version (${describeRunFailure(versionOutput)}); skipped`);
			if (forgot) {
				await this.writeWritten({ dictionaries: written, voiceSettings: writtenVoices });
			}
			return { result: { status: 'unsupported' }, retry: version === undefined };
		}

		let failed = false;
		let applied = false;
		for (const step of calls) {
			const args = paradisAgentDictionaryArgs(step);
			if (!args) {
				continue;
			}
			const result = await this.run(args, env, SYNC_RUN_TIMEOUT_MS);
			if (result.code === 0 && result.stdout.trim() === 'ok') {
				written = paradisApplyAgentDictionaryStep(written, step);
				applied = true;
				this.options.logService.info(`[ParadisAgentDictionary] ${step.provider}: ${step.kind === 'set' ? 'set the dictionary' : 'cleared the dictionary'} in aivis-mcp`);
			} else {
				failed = true;
				this.options.logService.warn(`[ParadisAgentDictionary] ${step.provider}: aivis-mcp --${step.kind}-dictionary failed (${result.failure ?? `exit ${result.code ?? 'none'}`}): ${redact(result.stderr, step)}`);
			}
		}

		let voicesUnsupported = false;
		if (voiceCalls.length > 0) {
			if (!paradisAivisVersionAtLeast(version, PARADIS_VOICE_TUNING_MIN_VERSION)) {
				// 2.5.3 は辞書だけ。声の調整は書かず、覚えている値もそのまま（上げたら次の同期で書く）
				voicesUnsupported = true;
				this.options.logService.info(`[ParadisAgentDictionary] aivis-mcp ${version!.join('.')} cannot take voice settings (needs ${PARADIS_VOICE_TUNING_MIN_VERSION.join('.')} or later); skipped`);
			} else {
				// 消してから書く声で、消すのに失敗したら書かない
				const failedVoices = new Set<string>();
				for (const step of voiceCalls) {
					const args = paradisVoiceTuningArgs(step);
					if (!args || failedVoices.has(step.voiceId)) {
						continue;
					}
					const result = await this.run(args, env, SYNC_RUN_TIMEOUT_MS);
					if (result.code === 0 && result.stdout.trim() === 'ok') {
						writtenVoices = paradisApplyVoiceTuningStep(writtenVoices, step);
						applied = true;
						this.options.logService.info(`[ParadisAgentDictionary] ${step.kind === 'set' ? 'set' : 'cleared'} the voice settings of a voice in aivis-mcp`);
					} else {
						failed = true;
						failedVoices.add(step.voiceId);
						this.options.logService.warn(`[ParadisAgentDictionary] aivis-mcp --${step.kind}-voice-settings failed (${result.failure ?? `exit ${result.code ?? 'none'}`}): ${redactVoice(result.stderr, step.voiceId)}`);
					}
				}
			}
		}
		await this.writeWritten({ dictionaries: written, voiceSettings: writtenVoices });
		return { result: { status: failed ? 'failed' : applied ? 'applied' : voicesUnsupported ? 'unsupported' : 'unchanged' }, retry: failed };
	}

	private async readWritten(): Promise<IParadisAgentWrittenState> {
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
			const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
			const result: { -readonly [K in keyof IParadisAgentDictionaryWritten]: string } = {};
			for (const provider of PARADIS_AGENT_DICTIONARY_PROVIDERS) {
				const value = record[provider];
				if (typeof value === 'string' && value) {
					result[provider] = value;
				}
			}
			return { dictionaries: result, voiceSettings: paradisNormalizeVoiceTuningMap(record.voiceSettings) };
		} catch {
			return { dictionaries: {}, voiceSettings: {} };
		}
	}

	private async writeWritten(state: IParadisAgentWrittenState): Promise<void> {
		try {
			await fs.mkdir(dirname(this.statePath), { recursive: true });
			const temp = `${this.statePath}.${process.pid}.tmp`;
			const content = Object.keys(state.voiceSettings).length > 0 ? { ...state.dictionaries, voiceSettings: state.voiceSettings } : state.dictionaries;
			await fs.writeFile(temp, JSON.stringify(content), { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temp, this.statePath);
		} catch (error) {
			this.options.logService.warn(`[ParadisAgentDictionary] could not remember the dictionary written to aivis-mcp: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function defaultScheduleRetry(callback: () => Promise<void>, delayMs: number): IDisposable {
	const handle = setTimeout(() => void callback(), delayMs);
	return toDisposable(() => clearTimeout(handle));
}

/** 失敗の理由（起動できなかった理由か終了コード）と、stderr の 1 行目（ホームのパスは `~` に伏せる）。 */
function describeRunFailure(result: IParadisAivisMcpRunResult): string {
	if (result.failure) {
		return result.failure;
	}
	if (result.code === 0) {
		return 'unexpected output';
	}
	const line = (result.stderr.trim().split(/\r?\n/, 1)[0] ?? '').split(homedir()).join('~').slice(0, 200);
	return line ? `exit ${result.code ?? 'none'}: ${line}` : `exit ${result.code ?? 'none'}`;
}

/** aivis-mcp のエラーの 1 行目。辞書の ID は伏せる。 */
function redact(stderr: string, step: ParadisAgentDictionaryStep): string {
	let line = (stderr.trim().split(/\r?\n/, 1)[0] ?? '').split(homedir()).join('~');
	if (step.kind === 'set') {
		line = line.split(step.id).join('<id>');
	}
	return line.slice(0, 300);
}

/** aivis-mcp のエラーの 1 行目。voice_id は伏せる。 */
function redactVoice(stderr: string, voiceId: string): string {
	return (stderr.trim().split(/\r?\n/, 1)[0] ?? '').split(homedir()).join('~').split(voiceId).join('<voice>').slice(0, 300);
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

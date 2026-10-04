/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先から届いた読み上げの MP3 を、手元の aivis-mcp のキューへ積む（`aivis-mcp --play-audio`）。
// 再生そのものは手元の aivis の worker が行うので、手元のペインの発話と重ならず、`aivis --mute` も効く。

import { spawn } from 'child_process';
import { homedir } from 'os';
import { paradisAivisSupportsPlayAudio, paradisLooksLikeMp3 } from '../common/paradisRemoteVoice.js';

/** 子プロセスの起動に使う関数（テストで差し替える）。 */
export type ParadisVoiceProcessRunner = (args: readonly string[], env: NodeJS.ProcessEnv, stdin: Uint8Array | undefined, timeoutMs: number) => Promise<{ readonly code: number | null; readonly stdout: string }>;

/** 版の確認の結果を覚えておく時間。版を上げた・入れたことに、Para Code を再起動せずに追従する。 */
const SUPPORTED_CACHE_MS = 10 * 60_000;
const UNSUPPORTED_CACHE_MS = 60_000;
const VERSION_TIMEOUT_MS = 3_000;
/** `--play-audio` がキューへ積んだ直後に標準出力へ書く印。終了コードではなく、これで積めたと判断する。 */
const QUEUED_MARKER = 'queued';
/**
 * 順番待ちに並べる上限。音声取込の枠は本文を読み終えた時点で解放するので、ここで抑えないと接続先が
 * 送り続けた MP3 が shared process に溜まる。超えた分は並ばせず、接続先に鳴らさせる。
 */
const MAX_PENDING = 4;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** タイムアウトで止めた後、終わるのを待つ上限（止める前に積んだ印を取りこぼさないため）。 */
const KILL_SETTLE_MS = 1_000;

export interface IParadisLocalVoicePlayOptions {
	/** 接続先がまだ答えを待っているか。中断されたら積まない。 */
	readonly signal: AbortSignal;
	/**
	 * この時刻（`now()` の値）を過ぎたら積まない。接続先は待ちきれないと自分で鳴らすので、
	 * 過ぎてから手元でも積むと二重に鳴る。
	 */
	readonly deadline: number;
}

export class ParadisLocalVoicePlayer {

	private supportCache: { readonly supported: boolean; readonly until: number } | undefined;
	/** 届いた順にキューへ積む（並行に起動すると順番が入れ替わる）。 */
	private tail: Promise<unknown> = Promise.resolve();
	private pendingCount = 0;
	private pendingBytes = 0;

	constructor(
		private readonly getEnv: () => Promise<NodeJS.ProcessEnv>,
		private readonly runProcess: ParadisVoiceProcessRunner = runAivisProcess,
		private readonly now: () => number = Date.now,
	) { }

	/** MP3 を手元のキューへ積む。積めたら true（手元に対応する aivis-mcp が無い・締め切りを過ぎたら false）。 */
	play(audio: Uint8Array, options: IParadisLocalVoicePlayOptions): Promise<boolean> {
		if (this.pendingCount >= MAX_PENDING || this.pendingBytes + audio.byteLength > MAX_PENDING_BYTES) {
			return Promise.resolve(false);
		}
		this.pendingCount++;
		this.pendingBytes += audio.byteLength;
		const result = this.tail.then(() => this.enqueue(audio, options)).finally(() => {
			this.pendingCount--;
			this.pendingBytes -= audio.byteLength;
		});
		this.tail = result.catch(() => undefined);
		return result;
	}

	private remaining(options: IParadisLocalVoicePlayOptions): number {
		return options.signal.aborted ? 0 : options.deadline - this.now();
	}

	private async enqueue(audio: Uint8Array, options: IParadisLocalVoicePlayOptions): Promise<boolean> {
		// 接続先の任意のバイト列を、手元のデコーダへそのまま渡さない
		if (!paradisLooksLikeMp3(audio) || this.remaining(options) <= 0) {
			return false;
		}
		try {
			const env = await this.getEnv();
			if (this.remaining(options) <= 0 || !(await this.isSupported(env, options))) {
				return false;
			}
			const timeoutMs = this.remaining(options);
			if (timeoutMs <= 0) {
				return false;
			}
			const { stdout } = await this.runProcess(['--play-audio'], env, audio, timeoutMs);
			if (stdout.includes(QUEUED_MARKER)) {
				return true;
			}
			// 消された・壊れた・worker が古い可能性があるので、次は版から確かめ直す
			this.supportCache = undefined;
			return false;
		} catch {
			this.supportCache = undefined;
			return false;
		}
	}

	private async isSupported(env: NodeJS.ProcessEnv, options: IParadisLocalVoicePlayOptions): Promise<boolean> {
		const cached = this.supportCache;
		if (cached && cached.until > this.now()) {
			return cached.supported;
		}
		let supported = false;
		try {
			const { code, stdout } = await this.runProcess(['--version'], env, undefined, Math.min(VERSION_TIMEOUT_MS, Math.max(this.remaining(options), 1)));
			supported = code === 0 && paradisAivisSupportsPlayAudio(stdout);
		} catch {
			return false;
		}
		this.supportCache = { supported, until: this.now() + (supported ? SUPPORTED_CACHE_MS : UNSUPPORTED_CACHE_MS) };
		return supported;
	}
}

/** 手元の `aivis-mcp` を、ログインシェル由来の PATH で起動する。 */
function runAivisProcess(args: readonly string[], env: NodeJS.ProcessEnv, stdin: Uint8Array | undefined, timeoutMs: number): Promise<{ readonly code: number | null; readonly stdout: string }> {
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === 'win32';
		// Windows の npm のグローバルは `aivis-mcp.cmd` で、cmd.exe を通さないと起動できない。引数は固定値だけ。
		// cwd を指定しないと cmd.exe は今のフォルダの aivis-mcp.cmd を PATH より先に拾う。
		const child = isWindows
			? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `aivis-mcp ${args.join(' ')}`], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
			// プロセスグループごと止められるよう detached で起こす（volta・asdf のシムは本体を別プロセスで起こす）
			: spawn('aivis-mcp', [...args], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
		let stdout = '';
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			timedOut = true;
			killTree(child.pid, () => child.kill());
			// 止め終わるまでに積んだ印が出ることがあるので、終わるのを少し待ってから出力で判断する
			setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve({ code: null, stdout });
				}
			}, KILL_SETTLE_MS);
		}, timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (stdout.length < 4096) {
				stdout += chunk;
			}
		});
		child.stdin?.on('error', () => { /* 子が先に終わったときの EPIPE は出力で判断する */ });
		child.once('error', error => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
		child.once('close', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ code: timedOut ? null : code, stdout });
			}
		});
		child.stdin?.end(stdin === undefined ? undefined : Buffer.from(stdin.buffer, stdin.byteOffset, stdin.byteLength));
	});
}

/** 下のプロセスまで止める（Windows は cmd.exe の下の node、POSIX はシムの下の node）。止め損ねると、後から積んで二重に鳴る。 */
function killTree(pid: number | undefined, fallback: () => void): void {
	if (pid === undefined) {
		fallback();
		return;
	}
	if (process.platform !== 'win32') {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			fallback();
		}
		return;
	}
	try {
		spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', fallback);
	} catch {
		fallback();
	}
}

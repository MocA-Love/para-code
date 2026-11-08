/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// utility process の中で、音声認識の補助プログラム（Mac の `ParadisSpeech`）を 1 回の音声入力ごとに起動し、
// renderer から届く PCM を標準入力へ流して、標準出力の JSON の行を upstream の状態と書き起こしに直す。
// 約束は ../common/paradisSpeechEngine.ts の冒頭を参照。

import type { Readable, Writable } from 'stream';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILocalTranscriptionModelStatus, ILocalTranscriptionResult, LocalTranscriptionModelState } from '../../../../platform/localTranscription/common/localTranscription.js';
import { IParadisSpeechEngine, IParadisSpeechHelperMessage, paradisParseSpeechHelperLine, paradisSpeechHelperCandidates, ParadisSpeechErrorCode, paradisSpeechErrorCode, paradisSpeechErrorMessage } from '../common/paradisSpeechEngine.js';

/** 起動した補助プログラム（child_process の ChildProcess のうち使う分。テストで差し替える）。 */
export interface IParadisSpeechHelperProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: 'error', listener: (error: Error) => void): this;
}

export interface IParadisSpeechEngineHost {
	/** 補助プログラムの場所。見つからなければ undefined。 */
	helperPath(): Promise<string | undefined>;
	spawn(file: string, args: readonly string[]): IParadisSpeechHelperProcess;
	/** 話し終わりから補助プログラムが終わるまでを待つ上限。 */
	readonly stopTimeoutMs?: number;
}

/** upstream の待ち（8 秒）より少し長く待つ。upstream が先に打ち切っても、ここは後で必ず片付く。 */
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
/** 失敗の説明に添える標準エラーの末尾の長さ。 */
const STDERR_TAIL_LENGTH = 2000;

/** 実際に使う host。 */
export function createParadisSpeechEngineHost(platform: NodeJS.Platform, appRoot: string, isDevelopment: boolean): IParadisSpeechEngineHost {
	return {
		helperPath: async () => {
			if (platform !== 'darwin') {
				return undefined;
			}
			for (const candidate of paradisSpeechHelperCandidates(appRoot, isDevelopment)) {
				if (await fs.access(candidate).then(() => true, () => false)) {
					return candidate;
				}
			}
			return undefined;
		},
		spawn: (file, args) => spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] }),
	};
}

class ParadisSpeechSession {
	committed = '';
	tentative = '';
	final: string | undefined;
	stopping = false;
	failed = false;
	downloaded = false;
	stderrTail = '';
	private pending = '';
	readonly exited: Promise<void>;
	private resolveExited!: () => void;

	constructor(readonly process: IParadisSpeechHelperProcess, readonly locale: string) {
		this.exited = new Promise(resolve => { this.resolveExited = resolve; });
	}

	markExited(): void {
		this.resolveExited();
	}

	/** 標準出力の断片から、行の終わりまで届いた分を返す。 */
	takeLines(chunk: string): string[] {
		this.pending += chunk;
		const lines = this.pending.split('\n');
		this.pending = lines.pop() ?? '';
		return lines.filter(line => line.trim().length > 0);
	}

	get text(): string {
		return this.committed + this.tentative;
	}
}

export class ParadisSpeechEngine extends Disposable implements IParadisSpeechEngine {

	private readonly _onDidChangeModelStatus = this._register(new Emitter<ILocalTranscriptionModelStatus>());
	readonly onDidChangeModelStatus = this._onDidChangeModelStatus.event;

	private readonly _onDidTranscribe = this._register(new Emitter<ILocalTranscriptionResult>());
	readonly onDidTranscribe = this._onDidTranscribe.event;

	private status: ILocalTranscriptionModelStatus = { state: LocalTranscriptionModelState.Idle };
	private session: ParadisSpeechSession | undefined;
	/** 前に準備が終わった言語。同じ言語なら、次からは待たずに Ready と答える（言語データは OS が持っている）。 */
	private readyLocale: string | undefined;
	/** start の呼び出しの番号。補助プログラムを探している間に cancel・次の start が来たら、古い方は起動しない。 */
	private startGeneration = 0;

	constructor(private readonly host: IParadisSpeechEngineHost) {
		super();
		this._register({ dispose: () => this.killSession() });
	}

	async getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		return this.status;
	}

	async start(options: { readonly locale: string }): Promise<void> {
		this.killSession();
		const generation = ++this.startGeneration;
		const helperPath = await this.host.helperPath();
		if (generation !== this.startGeneration) {
			// 探している間に取り消された・次の音声入力が始まった
			return;
		}
		if (helperPath === undefined) {
			this.fail(ParadisSpeechErrorCode.HelperMissing);
			return;
		}
		let process: IParadisSpeechHelperProcess;
		try {
			process = this.host.spawn(helperPath, ['transcribe', '--locale', options.locale]);
		} catch (error) {
			this.fail(ParadisSpeechErrorCode.Failed, error instanceof Error ? error.message : String(error));
			return;
		}
		const session = new ParadisSpeechSession(process, options.locale);
		this.session = session;
		this.setStatus(this.readyLocale === options.locale ? { state: LocalTranscriptionModelState.Ready } : { state: LocalTranscriptionModelState.Loading });

		// 補助プログラムが先に終わっても、書き込みの失敗（EPIPE）で utility process を落とさない
		process.stdin.on('error', () => { /* 終わり方は exit で見る */ });
		process.stdout.setEncoding('utf8');
		process.stdout.on('data', (chunk: string) => {
			for (const line of session.takeLines(chunk)) {
				const message = paradisParseSpeechHelperLine(line);
				if (message !== undefined) {
					this.handleMessage(session, message);
				}
			}
		});
		process.stderr.setEncoding('utf8');
		process.stderr.on('data', (chunk: string) => {
			session.stderrTail = (session.stderrTail + chunk).slice(-STDERR_TAIL_LENGTH);
		});
		process.once('error', error => {
			if (this.session === session && !session.failed) {
				session.failed = true;
				this.fail(ParadisSpeechErrorCode.Failed, error.message);
			}
			session.markExited();
		});
		process.once('exit', (code, signal) => {
			if (this.session === session && !session.failed && !session.stopping) {
				session.failed = true;
				const detail = session.stderrTail.trim().split('\n').pop() || (signal ? `signal ${signal}` : `exit ${code}`);
				this.fail(ParadisSpeechErrorCode.Failed, detail);
			}
			session.markExited();
		});
	}

	async pushAudio(chunk: VSBuffer): Promise<void> {
		const session = this.session;
		if (session === undefined || session.stopping || session.failed || session.process.stdin.writableEnded) {
			return;
		}
		session.process.stdin.write(chunk.buffer);
	}

	async stop(): Promise<string> {
		const session = this.session;
		if (session === undefined) {
			return '';
		}
		session.stopping = true;
		session.process.stdin.end();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			session.exited.then(() => false),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.host.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS); }),
		]);
		clearTimeout(timer);
		if (timedOut) {
			session.process.kill('SIGTERM');
		}
		const text = session.final ?? session.text;
		if (this.session === session) {
			this.session = undefined;
			this._onDidTranscribe.fire({ text, finalizedText: text, isFinal: true });
		}
		return text;
	}

	async cancel(): Promise<void> {
		this.killSession();
		if (this.status.state === LocalTranscriptionModelState.Downloading || this.status.state === LocalTranscriptionModelState.Loading) {
			this.setStatus({ state: LocalTranscriptionModelState.Idle });
		}
	}

	private handleMessage(session: ParadisSpeechSession, message: IParadisSpeechHelperMessage): void {
		if (this.session !== session || session.failed) {
			return;
		}
		switch (message.type) {
			case 'status':
				if (message.state === 'downloading') {
					session.downloaded = true;
					this.setStatus({ state: LocalTranscriptionModelState.Downloading, progress: message.progress });
				} else if (this.status.state !== LocalTranscriptionModelState.Ready) {
					this.setStatus({ state: LocalTranscriptionModelState.Loading });
				}
				return;
			case 'ready':
				this.readyLocale = session.locale;
				if (this.status.state !== LocalTranscriptionModelState.Ready) {
					this.setStatus({ state: LocalTranscriptionModelState.Ready, downloaded: session.downloaded });
				}
				return;
			case 'text':
				session.committed = message.committed;
				session.tentative = message.tentative;
				this._onDidTranscribe.fire({ text: session.text, finalizedText: session.committed, isFinal: false });
				return;
			case 'final':
				session.final = message.text;
				return;
			case 'error':
				session.failed = true;
				this.readyLocale = undefined;
				this.fail(paradisSpeechErrorCode(message.code), message.message);
				return;
		}
	}

	private fail(code: ParadisSpeechErrorCode, detail?: string): void {
		this.setStatus({ state: LocalTranscriptionModelState.Error, errorCode: code, error: paradisSpeechErrorMessage(code, detail) });
	}

	private setStatus(status: ILocalTranscriptionModelStatus): void {
		this.status = status;
		this._onDidChangeModelStatus.fire(status);
	}

	private killSession(): void {
		this.startGeneration++;
		const session = this.session;
		this.session = undefined;
		if (session !== undefined) {
			session.process.kill('SIGTERM');
		}
	}
}

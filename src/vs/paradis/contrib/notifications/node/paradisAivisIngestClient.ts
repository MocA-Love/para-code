/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `aivis-mcp --ingest` を shared process の常駐の子として起動し、読み上げを手元の aivis-mcp の worker 1 つへ
// 流し込む（設計 3.3・3.6 N1・N2）。鳴らすのは worker だけで、Para Code は `queued` を受け取ったら手を離す。
//
// - 起動の前に `aivis-mcp --version` で 2.5.0 以上かを確かめ、最初の枠（hello）で名乗った版も確かめる
//   （古い版は `--ingest` を知らず MCP サーバーとして標準入力を待ち続けるので、確かめずに起こさない）
// - 落ちたら 1・2・4・8 秒の間隔で起動し直す。5 回続けて失敗したら afplay に切り替える。ただし worker の
//   lock が生きている間は切り替えない（列に積んだ発話を worker が鳴らせるので、afplay で重ねない）
// - 起動し直したら hold を掛け直す。aivis-mcp の版が変わったら起動し直す
// - 書き込みは子の標準入力の drain を待つ
// - worker の `failed` が 3 回続いたら、しばらく afplay に任せる（手放した件は鳴らし直さない）

import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { connect } from 'net';
import { homedir } from 'os';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IParadisIngestOpenOptions,
	IParadisIngestStream,
	IParadisIngestTerminal,
	PARADIS_AIVIS_INGEST_MIN_VERSION,
	paradisAivisVersionAtLeast,
	paradisParseAivisVersion,
} from '../common/paradisVoiceIngest.js';
import { IParadisVoiceGainTable, paradisParseVoiceGainTable } from '../common/paradisVoiceGain.js';
import {
	IParadisIngestMessage,
	PARADIS_INGEST_MAX_AUDIO_PER_FRAME,
	PARADIS_INGEST_PROTOCOL_VERSION,
	ParadisIngestFrameDecoder,
	paradisEncodeIngestAudio,
	paradisEncodeIngestControl,
} from './paradisAivisIngestFrames.js';

/** 起動し直すまでの間隔（1 回目・2 回目・3 回目・4 回目以降）。 */
export const PARADIS_INGEST_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];
/** これだけ続けて起動に失敗したら afplay に切り替える。 */
export const PARADIS_INGEST_MAX_FAILURES = 5;
/** 名乗ってからこれだけ動き続けたら、失敗の回数を数え直す。 */
const STABLE_MS = 30_000;
/** 名乗るのを待つ上限（aivis-mcp は Redis へつながってから名乗る。Redis を起こす分も見込む）。 */
const HELLO_TIMEOUT_MS = 10_000;
/** afplay に切り替えた後、もう一度起こしてみるまで。 */
const FALLBACK_RETRY_MS = 5 * 60_000;
/** 版の確認と音量の表の取り直しの間隔。 */
const VERSION_CHECK_INTERVAL_MS = 10 * 60_000;
/** hold を延長する間隔（aivis-mcp 側の期限は 60 秒）。 */
export const PARADIS_INGEST_HOLD_RENEW_MS = 20_000;
/** worker の `failed` がこれだけ続いたら afplay に任せる。 */
export const PARADIS_INGEST_MAX_FAILED_STREAK = 3;
/** 失敗が続いて afplay に任せた後、もう一度 worker に渡してみるまで。 */
const DEGRADED_RETRY_MS = 5 * 60_000;
/** 生きているかを確かめる間隔と、返事を待つ上限。 */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
/** 止めるときに、標準入力を閉じてから終わるのを待つ上限。 */
const KILL_GRACE_MS = 2_000;
const WORKER_LOCK_KEY = 'aivis-mcp:worker-lock';

/** `--ingest` の子プロセス（テストで差し替える）。 */
export interface IParadisIngestChild {
	readonly stdin: NodeJS.WritableStream;
	readonly stdout: NodeJS.ReadableStream;
	onExit(listener: (code: number | null) => void): void;
	onError(listener: (error: Error) => void): void;
	kill(): void;
}

export type ParadisIngestSpawner = (args: readonly string[], env: NodeJS.ProcessEnv) => IParadisIngestChild;
/** `aivis-mcp --version` の出力。入っていなければ undefined。 */
export type ParadisAivisVersionProbe = (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
/** worker の lock が生きているか。 */
export type ParadisWorkerLockProbe = (env: NodeJS.ProcessEnv) => Promise<boolean>;

export type ParadisIngestClientState = 'idle' | 'checking' | 'unsupported' | 'starting' | 'ready' | 'fallback' | 'disposed';

export interface IParadisAivisIngestClientOptions {
	readonly getEnv: () => Promise<NodeJS.ProcessEnv>;
	/** 着信音として鳴らしてよいフォルダ（Para Code の着信音のフォルダとアプリの中）。 */
	readonly preludeDirs: () => readonly string[];
	readonly logService: ILogService;
	readonly spawnIngest?: ParadisIngestSpawner;
	readonly probeVersion?: ParadisAivisVersionProbe;
	readonly probeWorkerLock?: ParadisWorkerLockProbe;
	readonly now?: () => number;
}

interface IChildState {
	readonly process: IParadisIngestChild;
	readonly decoder: ParadisIngestFrameDecoder;
	readyAt: number | undefined;
	version: readonly [number, number, number] | undefined;
	/** こちらから止めた（版が変わった・名乗らない・止める）。終わりを失敗として数えるか。 */
	stopReason: 'version-change' | 'dispose' | 'unsupported' | undefined;
	helloTimer: ReturnType<typeof setTimeout> | undefined;
	pingTimer: ReturnType<typeof setTimeout> | undefined;
	pingInterval: ReturnType<typeof setInterval> | undefined;
	exited: boolean;
	readonly exitWaiters: Array<() => void>;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

class ParadisIngestStream implements IParadisIngestStream {

	readonly id = generateUuid();
	private readonly handoffDeferred = deferred<boolean>();
	private readonly finishedDeferred = deferred<IParadisIngestTerminal>();
	readonly handoff = this.handoffDeferred.promise;
	readonly finished = this.finishedDeferred.promise;
	private readonly startListeners: Array<() => void> = [];
	private ended = false;
	private aborted = false;
	private settled = false;
	private started = false;

	constructor(private readonly send: (frame: Buffer) => Promise<void>) { }

	onDidStart(listener: () => void): void {
		if (this.started) {
			listener();
			return;
		}
		this.startListeners.push(listener);
	}

	get isClosed(): boolean {
		return this.ended || this.aborted || this.settled;
	}

	async write(chunk: Uint8Array): Promise<void> {
		for (let offset = 0; offset < chunk.byteLength && !this.isClosed; offset += PARADIS_INGEST_MAX_AUDIO_PER_FRAME) {
			await this.send(paradisEncodeIngestAudio(this.id, chunk.subarray(offset, Math.min(chunk.byteLength, offset + PARADIS_INGEST_MAX_AUDIO_PER_FRAME))));
		}
	}

	async end(): Promise<void> {
		if (this.isClosed) {
			return;
		}
		this.ended = true;
		await this.send(paradisEncodeIngestControl({ type: 'end', id: this.id }));
	}

	async abort(reason: string): Promise<void> {
		if (this.aborted || this.settled) {
			return;
		}
		this.aborted = true;
		await this.send(paradisEncodeIngestControl({ type: 'abort', id: this.id, reason: reason.slice(0, 64) }));
	}

	/** aivis-mcp から届いた進み具合。終わりなら true。 */
	onStatus(status: string, reason: string | undefined, withdrawn: boolean): boolean {
		switch (status) {
			case 'queued':
				this.handoffDeferred.resolve(true);
				return false;
			case 'playing':
				this.started = true;
				for (const listener of this.startListeners.splice(0)) {
					listener();
				}
				return false;
			case 'done':
			case 'skipped':
			case 'held':
			case 'muted':
			case 'failed':
				this.settle({ status, ...(reason !== undefined ? { reason } : {}), ...(withdrawn ? { withdrawn: true } : {}) });
				return true;
			default:
				return false;
		}
	}

	settle(terminal: IParadisIngestTerminal): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.startListeners.length = 0;
		// `queued` の前に終わった件は「手放せなかった」
		this.handoffDeferred.resolve(false);
		this.finishedDeferred.resolve(terminal);
	}
}

/**
 * `aivis-mcp --ingest` の常駐の子を持つ。shared process に 1 つだけ作り、通知の読み上げと SSH 先の声が共有する。
 */
export class ParadisAivisIngestClient extends Disposable {

	private _state: ParadisIngestClientState = 'idle';
	private child: IChildState | undefined;
	private env: NodeJS.ProcessEnv | undefined;
	private failures = 0;
	private failedStreak = 0;
	private degradedUntil = 0;
	private installedVersion: readonly [number, number, number] | undefined;
	private versionChecked = false;
	private readonly versionCheckedWaiters: Array<() => void> = [];
	private readonly streams = new Map<string, ParadisIngestStream>();
	private readonly holds = new Set<string>();
	private holdTimer: ReturnType<typeof setInterval> | undefined;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private pingCounter = 0;
	private _gainTable: IParadisVoiceGainTable | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<ParadisIngestClientState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly spawnIngest: ParadisIngestSpawner;
	private readonly probeVersion: ParadisAivisVersionProbe;
	private readonly probeWorkerLock: ParadisWorkerLockProbe;
	private readonly now: () => number;

	constructor(private readonly options: IParadisAivisIngestClientOptions) {
		super();
		this.spawnIngest = options.spawnIngest ?? spawnAivisIngest;
		this.probeVersion = options.probeVersion ?? probeAivisVersion;
		this.probeWorkerLock = options.probeWorkerLock ?? probeAivisWorkerLock;
		this.now = options.now ?? Date.now;
		const versionTimer = setInterval(() => void this.checkVersion(), VERSION_CHECK_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(versionTimer)));
	}

	/** await の後に読み直す（TypeScript の絞り込みを効かせない）。 */
	private isDisposed(): boolean {
		return this._state === 'disposed';
	}

	get state(): ParadisIngestClientState {
		return this._state;
	}

	/** `gain?` で取った音量の表（取れていなければ undefined）。 */
	get gainTable(): IParadisVoiceGainTable | undefined {
		return this._gainTable;
	}

	/** 版を確かめて、2.5.0 以上なら子を起こす。2 回目以降は何もしない。 */
	start(): void {
		if (this._state !== 'idle') {
			return;
		}
		void this.checkVersion();
	}

	/** いま `open` できるか。 */
	isUsable(): boolean {
		return this._state === 'ready' && this.child?.readyAt !== undefined && !this.isDegraded();
	}

	private isDegraded(): boolean {
		if (this.failedStreak < PARADIS_INGEST_MAX_FAILED_STREAK) {
			return false;
		}
		if (this.now() >= this.degradedUntil) {
			this.failedStreak = 0;
			return false;
		}
		return true;
	}

	/**
	 * 起動中なら `timeoutMs` まで待つ。使えるようになったら true。2.5.0 が無い・afplay に切り替えた・失敗が続いた
	 * ときは待たずに false。
	 */
	whenReady(timeoutMs: number): Promise<boolean> {
		if (this.isUsable()) {
			return Promise.resolve(true);
		}
		if (this._state === 'unsupported' || this._state === 'fallback' || this._state === 'disposed' || this._state === 'idle' || this.isDegraded() || timeoutMs <= 0) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>(resolve => {
			const listener = this.onDidChangeState(() => {
				if (this.isUsable()) {
					finish(true);
				} else if (this._state !== 'checking' && this._state !== 'starting') {
					finish(false);
				}
			});
			const timer = setTimeout(() => finish(false), timeoutMs);
			const finish = (value: boolean) => {
				clearTimeout(timer);
				listener.dispose();
				resolve(value);
			};
		});
	}

	/** 手元に 2.4.0 以上（`--play-audio` か `--ingest` を持つ）の aivis-mcp があるか。`timeoutMs` まで版の確認を待つ。 */
	async hasLocalAivis(timeoutMs: number): Promise<boolean> {
		if (!this.versionChecked && this._state !== 'disposed') {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, timeoutMs);
				this.versionCheckedWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		return paradisAivisVersionAtLeast(this.installedVersion, [2, 4, 0]);
	}

	/** 流れを開く（ジョブはすぐ列に積まれる）。使えなければ undefined。 */
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined {
		if (!this.isUsable()) {
			return undefined;
		}
		const stream = new ParadisIngestStream(frame => this.send(frame));
		this.streams.set(stream.id, stream);
		const message: { type: string;[key: string]: unknown } = {
			type: 'open',
			id: stream.id,
			kind: options.kind ?? 'stream',
			priority: options.priority,
		};
		if (options.gainKey !== undefined) {
			message.gainKey = options.gainKey;
		}
		if (options.volumeDb !== undefined && Number.isFinite(options.volumeDb)) {
			message.volumeDb = Math.max(-60, Math.min(20, options.volumeDb));
		}
		if (options.tagged) {
			message.tagged = true;
		}
		if (options.prelude) {
			message.prelude = { path: options.prelude.path, volume: Math.max(0, Math.min(1, options.prelude.volume)) };
		}
		void this.send(paradisEncodeIngestControl(message));
		void stream.finished.then(terminal => this.noteTerminal(terminal));
		return stream;
	}

	/** 音声入力中などに鳴らすのを止める。掛けている間は 20 秒ごとに延長し、起動し直したら掛け直す。 */
	setHold(owner: string, active: boolean): void {
		if (this._state === 'disposed') {
			return;
		}
		if (active) {
			this.holds.add(owner);
			if (this.holdTimer === undefined) {
				this.holdTimer = setInterval(() => this.sendHolds(), PARADIS_INGEST_HOLD_RENEW_MS);
			}
		} else {
			this.holds.delete(owner);
			if (this.holds.size === 0 && this.holdTimer !== undefined) {
				clearInterval(this.holdTimer);
				this.holdTimer = undefined;
			}
		}
		if (this.child?.readyAt !== undefined) {
			void this.send(paradisEncodeIngestControl({ type: 'hold', owner, active }));
		}
	}

	private sendHolds(): void {
		if (this.child?.readyAt === undefined) {
			return;
		}
		for (const owner of this.holds) {
			void this.send(paradisEncodeIngestControl({ type: 'hold', owner, active: true }));
		}
	}

	private noteTerminal(terminal: IParadisIngestTerminal): void {
		if (terminal.reason === 'ingest-exited') {
			// 子が落ちたのは起動し直しの数え方で扱う
			return;
		}
		if (terminal.status === 'failed') {
			this.failedStreak++;
			if (this.failedStreak === PARADIS_INGEST_MAX_FAILED_STREAK) {
				this.degradedUntil = this.now() + DEGRADED_RETRY_MS;
				this.options.logService.warn(`[ParadisAivisIngest] worker failed ${this.failedStreak} times in a row (last: ${terminal.reason ?? 'unknown'}); playing with afplay for a while`);
				this._onDidChangeState.fire(this._state);
			}
		} else {
			this.failedStreak = 0;
		}
	}

	// --- 書き込み ------------------------------------------------------------------------------

	/** 今の子の標準入力へ順に書く。drain を待つ。子がいなければ捨てる。 */
	private send(frame: Buffer): Promise<void> {
		const result = this.writeChain.then(() => this.writeNow(frame));
		this.writeChain = result.catch(() => undefined);
		return result;
	}

	private writeNow(frame: Buffer): Promise<void> {
		const child = this.child;
		if (!child || child.exited) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => {
			let ok: boolean;
			try {
				ok = child.process.stdin.write(frame);
			} catch {
				resolve();
				return;
			}
			if (ok) {
				resolve();
				return;
			}
			const done = () => {
				child.process.stdin.removeListener('drain', done);
				const index = child.exitWaiters.indexOf(done);
				if (index >= 0) {
					child.exitWaiters.splice(index, 1);
				}
				resolve();
			};
			child.process.stdin.once('drain', done);
			child.exitWaiters.push(done);
		});
	}

	// --- 起動 ----------------------------------------------------------------------------------

	private setState(state: ParadisIngestClientState): void {
		if (this._state === 'disposed' || this._state === state) {
			return;
		}
		this._state = state;
		this._onDidChangeState.fire(state);
	}

	private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
		this.env ??= await this.options.getEnv().catch(() => process.env);
		return this.env;
	}

	/** 版を確かめる。初回は子を起こし、以後は版が変わっていたら起こし直す。音量の表も取り直す。 */
	private async checkVersion(): Promise<void> {
		if (this._state === 'disposed') {
			return;
		}
		const initial = this._state === 'idle';
		if (initial) {
			this.setState('checking');
		}
		const env = await this.resolveEnv();
		const output = await this.probeVersion(env).catch(() => undefined);
		if (this.isDisposed()) {
			return;
		}
		const version = output === undefined ? undefined : paradisParseAivisVersion(output);
		this.installedVersion = version;
		if (!this.versionChecked) {
			this.versionChecked = true;
			for (const waiter of this.versionCheckedWaiters.splice(0)) {
				waiter();
			}
		}
		const supported = paradisAivisVersionAtLeast(version, PARADIS_AIVIS_INGEST_MIN_VERSION);
		if (initial || this._state === 'unsupported') {
			if (supported) {
				this.failures = 0;
				this.spawnChild();
			} else {
				this.setState('unsupported');
			}
			return;
		}
		const child = this.child;
		if (child?.version && version && !sameVersion(child.version, version)) {
			this.options.logService.info(`[ParadisAivisIngest] aivis-mcp changed from ${child.version.join('.')} to ${version.join('.')}; restarting --ingest`);
			this.stopChild(child, 'version-change');
			return;
		}
		if (this.child?.readyAt !== undefined) {
			void this.send(paradisEncodeIngestControl({ type: 'gain?', requestId: `gain-${++this.pingCounter}` }));
		}
	}

	private spawnChild(): void {
		if (this._state === 'disposed') {
			return;
		}
		this.setState('starting');
		const env = this.env ?? process.env;
		const args = ['--ingest'];
		for (const dir of this.options.preludeDirs()) {
			args.push('--prelude-dir', dir);
		}
		let process_: IParadisIngestChild;
		try {
			process_ = this.spawnIngest(args, env);
		} catch (error) {
			this.options.logService.warn(`[ParadisAivisIngest] could not start aivis-mcp --ingest: ${error instanceof Error ? error.message : String(error)}`);
			this.onStartFailure();
			return;
		}
		const child: IChildState = {
			process: process_,
			decoder: new ParadisIngestFrameDecoder(),
			readyAt: undefined,
			version: undefined,
			stopReason: undefined,
			helloTimer: undefined,
			pingTimer: undefined,
			pingInterval: undefined,
			exited: false,
			exitWaiters: [],
		};
		this.child = child;
		child.helloTimer = setTimeout(() => {
			if (child.readyAt === undefined && !child.exited) {
				this.options.logService.warn('[ParadisAivisIngest] aivis-mcp --ingest did not introduce itself in time; restarting');
				this.killChild(child);
			}
		}, HELLO_TIMEOUT_MS);
		process_.stdin.on('error', () => { /* 子が先に終わったときの EPIPE は終わりの知らせで扱う */ });
		process_.stdout.on('data', (chunk: Buffer) => this.onChildData(child, chunk));
		process_.onError(error => {
			this.options.logService.trace(`[ParadisAivisIngest] aivis-mcp --ingest error: ${error.message}`);
			this.onChildExit(child, null);
		});
		process_.onExit(code => this.onChildExit(child, code));
	}

	private onChildData(child: IChildState, chunk: Buffer): void {
		if (child !== this.child || child.exited) {
			return;
		}
		let messages: IParadisIngestMessage[];
		try {
			messages = child.decoder.push(chunk);
		} catch (error) {
			this.options.logService.warn(`[ParadisAivisIngest] broken frame from aivis-mcp --ingest: ${error instanceof Error ? error.message : String(error)}`);
			this.killChild(child);
			return;
		}
		for (const message of messages) {
			this.onMessage(child, message);
		}
	}

	private onMessage(child: IChildState, message: IParadisIngestMessage): void {
		switch (message.type) {
			case 'hello':
				this.onHello(child, message);
				return;
			case 'accepted':
				if (typeof message.preludeRejected === 'string') {
					this.options.logService.info(`[ParadisAivisIngest] the ringtone was not accepted as a prelude: ${message.preludeRejected}`);
				}
				return;
			case 'status': {
				const id = typeof message.id === 'string' ? message.id : undefined;
				const stream = id === undefined ? undefined : this.streams.get(id);
				if (stream && typeof message.status === 'string') {
					const terminal = stream.onStatus(message.status, typeof message.reason === 'string' ? message.reason : undefined, message.withdrawn === true);
					if (terminal) {
						this.streams.delete(stream.id);
					}
				}
				return;
			}
			case 'gain': {
				const table = paradisParseVoiceGainTable({ entries: message.entries, defaultDb: message.defaultDb });
				if (table) {
					this._gainTable = table;
				}
				return;
			}
			case 'pong':
				if (child.pingTimer !== undefined) {
					clearTimeout(child.pingTimer);
					child.pingTimer = undefined;
				}
				return;
			case 'error':
				if (message.reason === 'unknown-stream') {
					// 終わった流れへの書き込みの行き違い（aivis-mcp の版によっては黙って捨てる）
					this.options.logService.trace('[ParadisAivisIngest] aivis-mcp --ingest did not know a stream we wrote to');
					return;
				}
				this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest reported an error: ${String(message.reason)}`);
				return;
			default:
				// hold・withdrawn など、待っていない返事
				return;
		}
	}

	private onHello(child: IChildState, message: IParadisIngestMessage): void {
		if (child.readyAt !== undefined) {
			return;
		}
		const version = typeof message.version === 'string' ? paradisParseAivisVersion(message.version) : undefined;
		if (message.protocol !== PARADIS_INGEST_PROTOCOL_VERSION || !paradisAivisVersionAtLeast(version, PARADIS_AIVIS_INGEST_MIN_VERSION)) {
			this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest speaks protocol ${String(message.protocol)} (version ${String(message.version)}); not using it`);
			this.stopChild(child, 'unsupported');
			this.setState('unsupported');
			return;
		}
		if (child.helloTimer !== undefined) {
			clearTimeout(child.helloTimer);
			child.helloTimer = undefined;
		}
		child.version = version;
		child.readyAt = this.now();
		if (this.stableTimer !== undefined) {
			clearTimeout(this.stableTimer);
		}
		this.stableTimer = setTimeout(() => {
			if (this.child === child && !child.exited) {
				this.failures = 0;
			}
		}, STABLE_MS);
		this.setState('ready');
		// 起動し直したら hold を掛け直す
		this.sendHolds();
		void this.send(paradisEncodeIngestControl({ type: 'gain?', requestId: `gain-${++this.pingCounter}` }));
		this.schedulePing(child);
	}

	private schedulePing(child: IChildState): void {
		child.pingInterval = setInterval(() => {
			if (this.child !== child || child.exited || child.pingTimer !== undefined) {
				return;
			}
			child.pingTimer = setTimeout(() => {
				this.options.logService.warn('[ParadisAivisIngest] aivis-mcp --ingest stopped answering; restarting');
				this.killChild(child);
			}, PING_TIMEOUT_MS);
			void this.send(paradisEncodeIngestControl({ type: 'ping', requestId: ++this.pingCounter }));
		}, PING_INTERVAL_MS);
	}

	private onChildExit(child: IChildState, code: number | null): void {
		if (child.exited) {
			return;
		}
		child.exited = true;
		if (child.helloTimer !== undefined) {
			clearTimeout(child.helloTimer);
		}
		if (child.pingTimer !== undefined) {
			clearTimeout(child.pingTimer);
		}
		if (child.pingInterval !== undefined) {
			clearInterval(child.pingInterval);
		}
		for (const waiter of child.exitWaiters.splice(0)) {
			waiter();
		}
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		// 行方の分からなくなった流れ。`queued` の前なら呼び出し側が afplay で鳴らし直す
		for (const stream of this.streams.values()) {
			stream.settle({ status: 'failed', reason: 'ingest-exited' });
		}
		this.streams.clear();
		if (this._state === 'disposed' || child.stopReason === 'dispose' || child.stopReason === 'unsupported') {
			return;
		}
		if (child.stopReason === 'version-change') {
			this.failures = 0;
			this.failedStreak = 0;
			this.spawnChild();
			return;
		}
		const stable = child.readyAt !== undefined && this.now() - child.readyAt >= STABLE_MS;
		if (stable) {
			this.failures = 0;
		}
		this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest exited (code ${code === null ? 'none' : code})`);
		this.onStartFailure();
	}

	private onStartFailure(): void {
		this.failures++;
		this.setState('starting');
		if (this.failures < PARADIS_INGEST_MAX_FAILURES) {
			this.scheduleRestart(PARADIS_INGEST_RESTART_DELAYS_MS[Math.min(this.failures, PARADIS_INGEST_RESTART_DELAYS_MS.length) - 1]);
			return;
		}
		void this.decideFallback();
	}

	private async decideFallback(): Promise<void> {
		const alive = await this.probeWorkerLock(this.env ?? process.env).catch(() => false);
		if (this._state === 'disposed') {
			return;
		}
		if (alive) {
			// worker は動いている。列に積んだ発話は worker が鳴らすので、afplay で重ねずに起こし直し続ける
			this.scheduleRestart(PARADIS_INGEST_RESTART_DELAYS_MS[PARADIS_INGEST_RESTART_DELAYS_MS.length - 1]);
			return;
		}
		this.options.logService.warn(`[ParadisAivisIngest] aivis-mcp --ingest failed ${this.failures} times in a row; playing with afplay for now`);
		this.setState('fallback');
		this.scheduleRestart(FALLBACK_RETRY_MS, true);
	}

	private scheduleRestart(delayMs: number, resetFailures = false): void {
		if (this.restartTimer !== undefined) {
			clearTimeout(this.restartTimer);
		}
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (resetFailures) {
				this.failures = 0;
			}
			this.spawnChild();
		}, delayMs);
	}

	/** 標準入力を閉じて終わってもらう。終わらなければ止める。 */
	private stopChild(child: IChildState, reason: NonNullable<IChildState['stopReason']>): void {
		child.stopReason = reason;
		try {
			child.process.stdin.end();
		} catch {
			// 既に閉じている
		}
		const timer = setTimeout(() => {
			if (!child.exited) {
				this.killChild(child);
			}
		}, KILL_GRACE_MS);
		(timer as { unref?: () => void }).unref?.();
	}

	private killChild(child: IChildState): void {
		try {
			child.process.kill();
		} catch {
			// 既に終わっている
		}
	}

	override dispose(): void {
		if (this._state !== 'disposed') {
			const child = this.child;
			this._state = 'disposed';
			if (this.holdTimer !== undefined) {
				clearInterval(this.holdTimer);
				this.holdTimer = undefined;
			}
			if (this.restartTimer !== undefined) {
				clearTimeout(this.restartTimer);
			}
			if (this.stableTimer !== undefined) {
				clearTimeout(this.stableTimer);
			}
			for (const waiter of this.versionCheckedWaiters.splice(0)) {
				waiter();
			}
			for (const stream of this.streams.values()) {
				stream.settle({ status: 'failed', reason: 'ingest-exited' });
			}
			this.streams.clear();
			if (child) {
				// 標準入力を閉じると aivis-mcp は書きかけの流れを中断し、自分の hold を外して終わる
				this.stopChild(child, 'dispose');
			}
		}
		super.dispose();
	}
}

function sameVersion(a: readonly number[], b: readonly number[]): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// --- 既定の実装 ---------------------------------------------------------------------------------

/** 手元の `aivis-mcp --ingest` をログインシェル由来の PATH で起こす。 */
function spawnAivisIngest(args: readonly string[], env: NodeJS.ProcessEnv): IParadisIngestChild {
	const isWindows = process.platform === 'win32';
	if (isWindows && args.some(arg => arg.includes('"'))) {
		throw new Error('unsupported argument');
	}
	// Windows の npm のグローバルは `aivis-mcp.cmd` で、cmd.exe を通さないと起動できない。/s は外側の引用符を
	// 1 組剥がすので、全体をもう 1 組の引用符で包む。cwd を指定しないと今のフォルダの aivis-mcp.cmd を先に拾う
	const child = isWindows
		? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"aivis-mcp ${args.map(arg => arg.startsWith('--') ? arg : `"${arg}"`).join(' ')}"`], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: true })
		: spawn('aivis-mcp', [...args], { env, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'] });
	return {
		stdin: child.stdin!,
		stdout: child.stdout!,
		onExit: listener => { child.once('exit', code => listener(code)); },
		onError: listener => { child.once('error', listener); },
		kill: () => {
			if (isWindows && child.pid !== undefined) {
				// cmd.exe の下の node まで止める
				spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once('error', () => child.kill());
				return;
			}
			child.kill();
		},
	};
}

function probeAivisVersion(env: NodeJS.ProcessEnv): Promise<string | undefined> {
	return new Promise(resolve => {
		const isWindows = process.platform === 'win32';
		const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'aivis-mcp';
		const args = isWindows ? ['/d', '/s', '/c', 'aivis-mcp --version'] : ['--version'];
		execFile(command, args, { env, cwd: homedir(), timeout: 3_000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
			resolve(error ? undefined : stdout);
		});
	});
}

/** aivis-mcp と同じ順（REDIS_URL → ~/.config/aivis-mcp/config.json → 既定）で Redis の URL を決める。 */
function resolveRedisUrl(env: NodeJS.ProcessEnv): string {
	if (env.REDIS_URL) {
		return env.REDIS_URL;
	}
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), '.config', 'aivis-mcp', 'config.json'), 'utf8')) as { redisUrl?: unknown };
		if (typeof settings.redisUrl === 'string' && settings.redisUrl) {
			return settings.redisUrl;
		}
	} catch {
		// 無い・読めない
	}
	return 'redis://127.0.0.1:6379';
}

function respCommand(parts: readonly string[]): string {
	return `*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

/**
 * worker の lock（`aivis-mcp:worker-lock`）が Redis にあるかを、GET 1 回だけで確かめる。読むだけで書かない。
 * つながらない・読めないときは「無い」とする（worker も Redis が無ければ動けない）。
 */
export function probeAivisWorkerLock(env: NodeJS.ProcessEnv): Promise<boolean> {
	let url: URL;
	try {
		url = new URL(resolveRedisUrl(env));
	} catch {
		return Promise.resolve(false);
	}
	if (url.protocol !== 'redis:') {
		return Promise.resolve(false);
	}
	const commands: string[][] = [];
	if (url.password) {
		commands.push(url.username ? ['AUTH', decodeURIComponent(url.username), decodeURIComponent(url.password)] : ['AUTH', decodeURIComponent(url.password)]);
	}
	const db = url.pathname.replace(/^\//, '');
	if (/^\d+$/.test(db) && db !== '0') {
		commands.push(['SELECT', db]);
	}
	commands.push(['GET', WORKER_LOCK_KEY]);
	return new Promise<boolean>(resolve => {
		const socket = connect({ host: url.hostname || '127.0.0.1', port: Number(url.port) || 6379 });
		let buffer = '';
		let settled = false;
		const finish = (value: boolean) => {
			if (!settled) {
				settled = true;
				socket.destroy();
				resolve(value);
			}
		};
		socket.setTimeout(1_000, () => finish(false));
		socket.once('error', () => finish(false));
		socket.once('connect', () => socket.write(commands.map(respCommand).join('')));
		socket.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			if (buffer.length > 64 * 1024) {
				finish(false);
				return;
			}
			const replies = parseRespReplies(buffer);
			if (replies === undefined || replies.length < commands.length) {
				return;
			}
			const last = replies[commands.length - 1];
			finish(typeof last === 'string' && last.length > 0);
		});
	});
}

/** RESP の返事を並べて読む（単純な型だけ）。読み切れていなければ undefined。 */
function parseRespReplies(text: string): Array<string | null> | undefined {
	const replies: Array<string | null> = [];
	let index = 0;
	while (index < text.length) {
		const lineEnd = text.indexOf('\r\n', index);
		if (lineEnd < 0) {
			return replies.length > 0 ? replies : undefined;
		}
		const kind = text[index];
		const line = text.slice(index + 1, lineEnd);
		if (kind === '+' || kind === ':') {
			replies.push(line);
			index = lineEnd + 2;
		} else if (kind === '-') {
			replies.push(null);
			index = lineEnd + 2;
		} else if (kind === '$') {
			const length = Number(line);
			if (length < 0) {
				replies.push(null);
				index = lineEnd + 2;
				continue;
			}
			if (text.length < lineEnd + 2 + length + 2) {
				return replies.length > 0 ? replies : undefined;
			}
			replies.push(text.slice(lineEnd + 2, lineEnd + 2 + length));
			index = lineEnd + 2 + length + 2;
		} else {
			replies.push(null);
			index = lineEnd + 2;
		}
	}
	return replies;
}

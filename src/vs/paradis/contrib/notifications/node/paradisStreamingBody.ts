/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 合成 API の応答を少しずつ読む（設計 3.3）。最初の 1 バイトまで（ElevenLabs 8 秒・Aivis 20 秒）と途切れ 8 秒で打ち切る。
// ElevenLabs は worker の「最初の音まで 10 秒」より先に諦めて afplay へ回れるよう 8 秒にする。Aivis の
// /v1/tts/synthesize は全部まとめて返すこともあるので 20 秒にする（worker が先に諦めた件は、音声の枠を 1 つも
// 書いていなければ Para Code が鳴らし直す）。
// 打ち切りは AbortController で fetch ごと止め、呼び出し側には retryable の AivisError として見せる。

import { AivisError } from './paradisAudioScheduler.js';

/** 要求を送ってから最初の 1 バイトが届くまでの上限（ElevenLabs の /stream）。 */
export const PARADIS_ELEVENLABS_FIRST_BYTE_TIMEOUT_MS = 8_000;
/** 同じく Aivis（全部まとめて返る場合も見込む）。 */
export const PARADIS_AIVIS_FIRST_BYTE_TIMEOUT_MS = 20_000;
/** 届いている途中で途切れたときの上限。 */
export const PARADIS_SYNTH_IDLE_TIMEOUT_MS = 8_000;

/** 打ち切りの時計。fetch を送る前に作り、その signal を fetch に渡す。 */
export class ParadisSynthesisTimeouts {
	readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private timedOut = false;

	constructor(
		private readonly firstByteMs: number,
		private readonly idleMs = PARADIS_SYNTH_IDLE_TIMEOUT_MS,
	) {
		this.arm(this.firstByteMs);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get didTimeOut(): boolean {
		return this.timedOut;
	}

	private arm(ms: number): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timedOut = true;
			this.controller.abort();
		}, ms);
	}

	/** 1 つ届いた。次は途切れの上限で数える。 */
	touch(): void {
		this.arm(this.idleMs);
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

/**
 * 応答の本文を少しずつ返す。打ち切り・途中の失敗は retryable の AivisError にして投げる。
 * 読み終えた・やめたら時計を止める。
 */
export async function* paradisReadSynthesisBody(response: Response, timeouts: ParadisSynthesisTimeouts, provider: string): AsyncGenerator<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		timeouts.dispose();
		return;
	}
	try {
		while (true) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch (error) {
				// allow-any-unicode-next-line
				throw new AivisError('retryable', timeouts.didTimeOut ? `${provider} API の音声が途中で届かなくなりました` : (error instanceof Error ? error.message : String(error)), undefined, undefined, error);
			}
			if (result.done) {
				return;
			}
			if (result.value.byteLength > 0) {
				timeouts.touch();
				yield result.value;
			}
		}
	} finally {
		timeouts.dispose();
		reader.cancel().catch(() => undefined);
	}
}

/** 合成済みの音声を、合成の本文と同じ形で返す（worker へ渡し直すとき）。 */
export async function* paradisBufferBody(audio: Uint8Array): AsyncGenerator<Uint8Array> {
	if (audio.byteLength > 0) {
		yield audio;
	}
}

/** 本文を全部読む（Para Code が自分で鳴らすとき）。 */
export async function paradisCollectBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > maxBytes) {
			// allow-any-unicode-next-line
			throw new AivisError('item-specific', '合成した音声が大きすぎます');
		}
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks, size);
}

/** {@link paradisTeeBody} が流し込む先（モバイルへの音声の流れ）。 */
export interface IParadisBodyTeeSink {
	write(chunk: Uint8Array): void;
	end(): void;
	abort(): void;
}

/**
 * 合成を受け取りながら、同じ断片を `openSink()` の先（モバイル）へも流す。読み終えたら end、途中で切れた・読むのを
 * やめたら abort。`openSink` は最初に読み始めた時点で 1 回だけ呼ぶ（読まれなかった合成は流れを作らない）。
 */
export async function* paradisTeeBody(body: AsyncIterable<Uint8Array>, openSink: () => IParadisBodyTeeSink | undefined): AsyncGenerator<Uint8Array> {
	const sink = openSink();
	let completed = false;
	try {
		for await (const chunk of body) {
			sink?.write(chunk);
			yield chunk;
		}
		completed = true;
	} finally {
		if (completed) {
			sink?.end();
		} else {
			sink?.abort();
		}
	}
}

/**
 * 読み上げ 1 件（スケジューラの 1 タスク）のモバイルへの流れを 1 本に絞る。合成の再試行のたびに {@link paradisTeeBody} が
 * 流れを開こうとしても、前の試行が音を流し始めてから切れていたら（モバイルでは頭が鳴っている）、そのタスクのモバイルへの
 * 配信はやめる（再試行の成功分は送らない。頭が 2 回鳴るのを防ぐ）。音を流す前に切れた試行は数えない。流し終えたら以後は開かない。
 */
export class ParadisMobileVoiceTaskGate {
	private done = false;

	constructor(private readonly open: () => IParadisBodyTeeSink | undefined) { }

	openSink(): IParadisBodyTeeSink | undefined {
		if (this.done) {
			return undefined;
		}
		const inner = this.open();
		if (inner === undefined) {
			return undefined;
		}
		let wrote = false;
		return {
			write: chunk => {
				wrote = true;
				inner.write(chunk);
			},
			end: () => {
				this.done = true;
				inner.end();
			},
			abort: () => {
				if (wrote) {
					this.done = true;
				}
				inner.abort();
			},
		};
	}
}

/** 手元の `--ingest` へ書く前に溜めておける量（これを超えるまでは本文の読み進めを止めない）。 */
export const PARADIS_LOCAL_WRITE_BUFFER_BYTES = 1024 * 1024;
/**
 * 本文を読み終えた後、手元への書き込みが終わるのを待つ上限。`--ingest` 側の見限り（20 秒）より長くし、通常は
 * そちらで書き込みが解ける。
 */
export const PARADIS_LOCAL_WRITE_CLOSE_TIMEOUT_MS = 30_000;

/**
 * 有界の列を通して、子の標準入力（`--ingest`）へ順に書く。本文の読み進め（とモバイルへの流れ）を、子の drain の待ちから
 * 切り離すためのもの。書き込みに失敗したら以後は書かず {@link failed} を立てる（読み進めは止めない）。
 */
export class ParadisBoundedLocalWriter {
	private readonly queue: Uint8Array[] = [];
	private queuedBytes = 0;
	private closed = false;
	private _failed = false;
	private _written = 0;
	private wake: (() => void) | undefined;
	private drained: (() => void) | undefined;
	private readonly pump: Promise<void>;

	constructor(private readonly write: (chunk: Uint8Array) => Promise<void>, private readonly limitBytes = PARADIS_LOCAL_WRITE_BUFFER_BYTES) {
		this.pump = this.run();
	}

	get failed(): boolean {
		return this._failed;
	}

	/** 書き終えたバイト数。 */
	get written(): number {
		return this._written;
	}

	/** 積む。溜まりすぎていれば、減るか失敗するまで待つ。 */
	async push(chunk: Uint8Array): Promise<void> {
		if (this._failed || this.closed) {
			return;
		}
		this.queue.push(chunk);
		this.queuedBytes += chunk.byteLength;
		this.wake?.();
		this.wake = undefined;
		while (this.queuedBytes > this.limitBytes && !this._failed) {
			await new Promise<void>(resolve => { this.drained = resolve; });
			this.drained = undefined;
		}
	}

	/** 書き込みをやめる（固まった書き込みを待っている push を抜けさせる）。 */
	fail(): void {
		this._failed = true;
		this.drained?.();
	}

	/**
	 * 積み終えた。`discard` なら溜まっている分は書かない。書き込みが終わるまで待つ。`timeoutMs` を過ぎても終わらなければ
	 * 書き込みをやめて（{@link failed} を立てて）戻る（止まった子の書き込みを待ち続けない）。
	 */
	async close(discard = false, timeoutMs = PARADIS_LOCAL_WRITE_CLOSE_TIMEOUT_MS): Promise<void> {
		if (discard) {
			this.queue.length = 0;
			this.queuedBytes = 0;
		}
		this.closed = true;
		this.wake?.();
		this.wake = undefined;
		this.drained?.();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finished = await Promise.race([
			this.pump.then(() => true),
			new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
		]);
		clearTimeout(timer);
		if (!finished) {
			this.queue.length = 0;
			this.queuedBytes = 0;
			this.fail();
		}
	}

	private async run(): Promise<void> {
		for (; ;) {
			if (this.queue.length === 0) {
				if (this.closed) {
					return;
				}
				await new Promise<void>(resolve => { this.wake = resolve; });
				continue;
			}
			const chunk = this.queue.shift()!;
			this.queuedBytes -= chunk.byteLength;
			this.drained?.();
			if (this._failed) {
				continue;
			}
			try {
				await this.write(chunk);
				this._written += chunk.byteLength;
			} catch {
				this._failed = true;
				this.drained?.();
			}
		}
	}
}

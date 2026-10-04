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

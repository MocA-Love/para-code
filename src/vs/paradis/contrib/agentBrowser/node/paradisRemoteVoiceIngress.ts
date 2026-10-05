/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `/paradis-mcp/mobile-voice` の本文の受け取り（設計 3.4）。ticket の確認と枠の押さえはサービス側で済ませてから呼ぶ。
//
// - chunked（Content-Length 無し。ticket に `ingress: "stream-v1"` を名乗ったときに接続先の aivis-mcp 2.5.0 が
//   送る）: 引き受けない ticket は要求のヘッダーを受けたらすぐ応答のヘッダーを返す。手元で鳴らす ticket は、最初の
//   固まりで MP3 らしさを確かめてから `X-Para-Local-Playback: accepted` を付けて返し、その先の鳴らし方
//   （`--ingest` → `--play-audio` → Para Code の列）は Para Code の責任にする。受け取りながら `--ingest` へ流し、
//   本文を受け取り終えたら応答を閉じる（鳴り終わりは待たない）。接続先が途中で切れたら `--ingest` に abort を送る
// - Content-Length 付き（古い aivis-mcp）: 全部受け取り、長さと ticket の現行性を確かめてから手元へ渡し、積めたかを
//   `localPlayback` で返す（受け取りの途中では鳴らさない）。`queued` が締め切りまでに来なければ、中断ではなく取り下げを
//   頼み、外せたときだけ「積めなかった」と返す。積めなければ接続先が自分で鳴らす
// - ticket の持ち主（ペイン）がいなくなったら、受け取りも手元への転送もやめ、鳴らし直しもしない
// - MP3 らしさは最初の固まりで確かめる。流れ 1 本 8MiB、押さえる量は受け取った分だけ増やす。1 発話 120 秒、
//   最初の音まで 10 秒、届く速さが実時間の半分を 3 秒続けて下回ったら打ち切る
// - モバイルへは、MP3 らしさを確かめた時点から受け取りながら流す（voice.stream.v1。流せない端末にはモバイルリレーが
//   終わってから 1 本で送る）。流す口が無ければ、今どおり全部受け取ってから 1 本で送る

import type * as http from 'http';
import { IParadisIngestStream, IParadisLocalVoiceOutput, IParadisVoiceRetention } from '../../notifications/common/paradisVoiceIngest.js';
import { IParadisMobileVoiceStreamWriter } from '../../mobileRelay/common/paradisMobileVoiceStream.js';
import { PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES } from '../../notifications/common/paradisNotifications.js';
import { PARADIS_REMOTE_VOICE_ACCEPTED_HEADER, PARADIS_REMOTE_VOICE_GAIN_KEY_HEADER, PARADIS_REMOTE_VOICE_MUTED_HEADER, PARADIS_REMOTE_VOICE_TAGGED_HEADER, paradisLooksLikeMp3, paradisMp3Bitrate, paradisRemoteVoiceGainKey } from '../common/paradisRemoteVoice.js';
import { IParadisLocalVoicePlayOptions } from './paradisLocalVoicePlayer.js';

/** 1 発話の上限。 */
export const PARADIS_REMOTE_VOICE_MAX_DURATION_MS = 120_000;
/** 要求を受けてから最初の音が届くまでの上限。 */
export const PARADIS_REMOTE_VOICE_FIRST_AUDIO_TIMEOUT_MS = 10_000;
/** 届く速さが実時間のこれだけを下回り続けたら打ち切る。 */
const SLOW_ARRIVAL_RATIO = 0.5;
export const PARADIS_REMOTE_VOICE_SLOW_ARRIVAL_MS = 3_000;
const ARRIVAL_CHECK_INTERVAL_MS = 500;
/** 引き受けるかを決めるために手元の aivis-mcp の版を待つ上限（応答のヘッダーを遅らせすぎない）。 */
const ACCEPT_DECISION_WAIT_MS = 1_000;
/** 起動中の `--ingest` を待つ上限。過ぎたら全部受け取ってから `--play-audio` で積む。 */
const INGEST_READY_WAIT_MS = 500;
/** ビットレートを探すのは先頭のこの大きさまで。 */
const BITRATE_PROBE_LIMIT = 64 * 1024;
/**
 * 手元の `--ingest` へ書く前に溜めておける量。書き込み（子の標準入力の drain）が遅くても、この量まではモバイルへの
 * 流れ（受け取りの読み進め）を止めない。
 */
const LOCAL_WRITE_BUFFER_BYTES = 1024 * 1024;
/** 本文を受け取り終えた後、手元への書き込みが終わるのを待つ上限（--ingest が読まなくなっても待ち続けない）。 */
const LOCAL_CLOSE_TIMEOUT_MS = 30_000;

export interface IParadisRemoteVoiceIngressDeps {
	/** 手元で鳴らす口（`--ingest`・afplay）。無ければ `--play-audio` だけで積む。 */
	readonly voiceOutput: IParadisLocalVoiceOutput | undefined;
	/** 今の `aivis-mcp --play-audio` で積む。積めたら true。 */
	readonly playViaPlayAudio: (audio: Uint8Array, options: IParadisLocalVoicePlayOptions) => Promise<boolean>;
	readonly publishMobileVoiceClip?: (audio: Uint8Array) => void;
	/** モバイルへの音声の流れを始める（あれば publishMobileVoiceClip より優先する）。 */
	readonly beginMobileVoiceStream?: (gainKey: string | undefined) => IParadisMobileVoiceStreamWriter;
	/** 受け取った分だけ押さえる量を増やす。超えたら false。 */
	readonly reserveBytes: (bytes: number) => boolean;
	/** 本文を受け取り終えた（枠を手放してよい）。 */
	readonly onBodyReceived: () => void;
	readonly isTicketCurrent: () => boolean;
	readonly now?: () => number;
	/** 打ち切りの時間（テストで縮める）。 */
	readonly limits?: { readonly maxDurationMs?: number; readonly firstAudioTimeoutMs?: number; readonly slowArrivalMs?: number; readonly acceptDecisionWaitMs?: number; readonly localCloseTimeoutMs?: number };
}

export interface IParadisRemoteVoiceRequest {
	/** 手元で鳴らす ticket か（SSH の接続先のペインからの発話で、設定がオン）。 */
	readonly localPlayback: boolean;
	/** 接続先がまだ待っているか。 */
	readonly signal: AbortSignal;
	/** Content-Length の旧方式で、手元で積むのを待つ上限。 */
	readonly enqueueDeadlineMs: number;
}

/** 受け取りの結果（テスト用）。`localPlayback` は手元で鳴らす後始末（鳴らし直しを含む）が終わったら解決する。 */
export interface IParadisRemoteVoiceResult {
	readonly outcome: 'played-locally' | 'declined' | 'rejected' | 'aborted';
	readonly localPlayback?: Promise<void>;
}

type Failure = 'too-large' | 'not-mp3' | 'first-audio-timeout' | 'max-duration' | 'slow-arrival' | 'closed' | 'length-mismatch' | 'empty' | 'revoked';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/**
 * ticket が通らなかった（知らない・期限切れ・使用済み・今の instance のものでない・持ち主がいなくなった）ときの状態。
 * aivis-mcp 2.5.1 は 401・403 を受けると、手元で鳴らす前提の発話を接続先で鳴らさない（`ticket-unavailable`）。ほかの
 * 4xx・5xx は接続先で鳴らす。
 */
export const PARADIS_VOICE_TICKET_REJECTED_STATUS = 401;

/** 音声の取込口で ticket が通らなかったことを返す（{@link PARADIS_VOICE_TICKET_REJECTED_STATUS}）。 */
export function paradisSendVoiceTicketRejected(res: http.ServerResponse): void {
	if (res.writableEnded) {
		return;
	}
	if (!res.headersSent) {
		res.writeHead(PARADIS_VOICE_TICKET_REJECTED_STATUS, JSON_HEADERS);
	}
	res.end(JSON.stringify({ error: 'Voice ticket rejected.' }));
}

/**
 * Para Code が終わるところで、音声を受け取れない（503）。aivis-mcp 2.5.1 は手元で鳴らす ticket の 404 を ticket が通らなかった
 * とみなして鳴らさないので、終了中は 503 を返して接続先で鳴らしてもらう。本文は読まないので接続は使い回させない。
 */
export function paradisSendVoiceIngressUnavailable(res: http.ServerResponse): void {
	if (res.writableEnded) {
		return;
	}
	if (!res.headersSent) {
		res.writeHead(503, { ...JSON_HEADERS, 'Connection': 'close' });
	}
	res.end(JSON.stringify({ error: 'Para Code is shutting down.' }));
}

function statusFor(failure: Failure): number {
	switch (failure) {
		case 'too-large': return 413;
		case 'not-mp3': return 415;
		case 'first-audio-timeout':
		case 'max-duration':
		case 'slow-arrival': return 408;
		// ticket が通らなかった（持ち主がいない）。接続先は鳴らさない（aivis-mcp 2.5.1 の取り決めで 401・403 は ticket-unavailable）
		case 'revoked': return PARADIS_VOICE_TICKET_REJECTED_STATUS;
		default: return 400;
	}
}

/** 本文を受け取り、手元で鳴らす・モバイルへ送る。応答を返し終えたら解決する。 */
export async function paradisReceiveRemoteVoice(req: http.IncomingMessage, res: http.ServerResponse, request: IParadisRemoteVoiceRequest, deps: IParadisRemoteVoiceIngressDeps): Promise<IParadisRemoteVoiceResult> {
	const holder: IMobileHolder = {};
	try {
		return await receiveRemoteVoice(req, res, request, deps, holder);
	} finally {
		// どの道を通っても（例外を含む）モバイルへの流れは必ず閉じる。end の後の abort は何もしない
		holder.writer?.abort();
	}
}

/** モバイルへの流れ（ticket が古くなったら・失敗したら切る）。 */
interface IMobileHolder {
	writer?: IParadisMobileVoiceStreamWriter;
}

async function receiveRemoteVoice(req: http.IncomingMessage, res: http.ServerResponse, request: IParadisRemoteVoiceRequest, deps: IParadisRemoteVoiceIngressDeps, holder: IMobileHolder): Promise<IParadisRemoteVoiceResult> {
	const now = deps.now ?? Date.now;
	const chunked = req.headers['content-length'] === undefined;
	// 接続先の aivis-mcp が名乗る声とモデル（音量の表の鍵）。無ければ表の補正は 0dB
	const gainKey = paradisRemoteVoiceGainKey(req.headers[PARADIS_REMOTE_VOICE_GAIN_KEY_HEADER.toLowerCase()]);
	// 感情タグ入りの発話（音量の覚え直しに使わない）
	const tagged = req.headers[PARADIS_REMOTE_VOICE_TAGGED_HEADER.toLowerCase()] === '1';
	// 接続先でミュート中の発話。引き受けるが手元では鳴らさない（--ingest にも afplay にも渡さない）。モバイルへは届ける
	const remoteMuted = request.localPlayback && req.headers[PARADIS_REMOTE_VOICE_MUTED_HEADER.toLowerCase()] === '1';
	// 引き受けた声を `--play-audio`、それも駄目なら Para Code の列（worker へ渡し直すか afplay）で鳴らす。ticket の
	// 持ち主（ペイン）がもういなければ鳴らさない
	const playLocalChain = async (audio: Buffer) => {
		if (remoteMuted || !deps.isTicketCurrent()) {
			return;
		}
		const queued = await deps.playViaPlayAudio(audio, { signal: new AbortController().signal, deadline: now() + request.enqueueDeadlineMs }).catch(() => false);
		if (!queued && deps.isTicketCurrent()) {
			await deps.voiceOutput?.playFallback(audio, gainKey);
		}
	};
	const declaredLength = chunked ? undefined : Number(req.headers['content-length']);
	if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES)) {
		res.writeHead(413, JSON_HEADERS);
		res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
		return { outcome: 'rejected' };
	}

	// 手元に aivis-mcp が無ければ引き受けない（接続先が自分で鳴らす）
	const wantLocal = request.localPlayback && (!chunked || remoteMuted || (deps.voiceOutput !== undefined && await deps.voiceOutput.hasLocalAivis(deps.limits?.acceptDecisionWaitMs ?? ACCEPT_DECISION_WAIT_MS)));
	if (chunked) {
		if (request.signal.aborted) {
			return { outcome: 'aborted' };
		}
		if (!wantLocal) {
			// 引き受けない。すぐに明示の拒否を返して、接続先には自分で鳴らしてもらう
			res.writeHead(202, { ...JSON_HEADERS, [PARADIS_REMOTE_VOICE_ACCEPTED_HEADER]: 'rejected' });
			res.flushHeaders();
		}
		// 引き受けるときは、MP3 らしさを確かめてから `accepted` を返す（受け取れない本文を引き受けたことにしない。2.5.0 の
		// 接続先は本文の `localPlayback` を読まない）。引き受けた後に鳴らせなくなったら、本文で `localPlayback: false` を返す
		// （2.5.1 の接続先は自分で鳴らす）
	}
	const acceptHeaders = () => {
		if (chunked && wantLocal && !res.headersSent && !res.writableEnded) {
			res.writeHead(202, { ...JSON_HEADERS, [PARADIS_REMOTE_VOICE_ACCEPTED_HEADER]: 'accepted' });
			res.flushHeaders();
		}
	};

	const chunks: Buffer[] = [];
	let size = 0;
	let headChecked = false;
	let firstAudioAt: number | undefined;
	let bitrate: { readonly kbps: number; readonly offset: number } | undefined;
	let slowSince: number | undefined;
	let failure: Failure | undefined;
	let sink: IParadisIngestStream | undefined;
	// 手元の `--ingest` へ書く列。受け取りの読み進め（とモバイルへの流れ）を、子の drain の待ちから切り離す
	const localQueue: Buffer[] = [];
	let localQueuedBytes = 0;
	let localClosed = false;
	// 手元への書き込みをやめた（書き込みに失敗した、または受け取りを打ち切った）。溜まりすぎの待ちからも抜ける
	let localFailed = false;
	// 書き込みそのものに失敗した（手元はもう渡せない）
	let localWriteError = false;
	// worker が鳴らし始めた（着信音を含む）。鳴り始めた件は Para Code が頭から鳴らし直さない
	let workerStarted = false;
	let localWake: (() => void) | undefined;
	let localDrained: (() => void) | undefined;
	let localPump: Promise<void> | undefined;
	const startLocalPump = () => {
		localPump = (async () => {
			if (wantLocal && !remoteMuted && deps.voiceOutput && deps.isTicketCurrent()) {
				sink = await deps.voiceOutput.openIngest({ priority: 'normal', ...(gainKey ? { gainKey } : {}), ...(tagged ? { tagged: true } : {}) }, INGEST_READY_WAIT_MS);
				sink?.onDidStart(() => { workerStarted = true; });
			}
			for (; ;) {
				if (localQueue.length === 0) {
					if (localClosed) {
						return;
					}
					await new Promise<void>(resolve => { localWake = resolve; });
					continue;
				}
				const chunk = localQueue.shift()!;
				localQueuedBytes -= chunk.byteLength;
				localDrained?.();
				if (sink === undefined || localFailed) {
					continue;
				}
				try {
					await sink.write(chunk);
				} catch {
					// 手元に渡せなくなった。モバイルへの流れは続け、手元は後で鳴らし直す（下の localWriteError）
					localFailed = true;
					localWriteError = true;
					localDrained?.();
				}
			}
		})();
	};
	const queueLocal = async (chunk: Buffer) => {
		localQueue.push(chunk);
		localQueuedBytes += chunk.byteLength;
		localWake?.();
		localWake = undefined;
		while (localQueuedBytes > LOCAL_WRITE_BUFFER_BYTES && !localFailed) {
			await new Promise<void>(resolve => { localDrained = resolve; });
			localDrained = undefined;
		}
	};
	/** 手元への書き込みを終える。`discard` なら溜まっている分は書かない。書き込みが止まったままなら上限で諦める。 */
	const closeLocal = async (discard: boolean, timeoutMs = deps.limits?.localCloseTimeoutMs ?? LOCAL_CLOSE_TIMEOUT_MS) => {
		if (discard) {
			localQueue.length = 0;
			localQueuedBytes = 0;
		}
		localClosed = true;
		localWake?.();
		localWake = undefined;
		localDrained?.();
		if (!localFailed && localPump) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finished = await Promise.race([
				localPump.then(() => true),
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
			]);
			clearTimeout(timer);
			if (!finished) {
				// 手元の書き込みが進まない（--ingest が読まない）。待ち続けず、手元は諦める
				localFailed = true;
				localWriteError = true;
				localQueue.length = 0;
				localQueuedBytes = 0;
			}
		}
		// 打ち切ったとき（stop）は、固まった書き込みを待たない。後始末は下の失敗の扱いが sink に対して行う
		if (localWriteError && sink !== undefined) {
			void sink.abort('write-failed');
			sink = undefined;
		}
	};
	// モバイルへの流れ。ticket が古くなったら（ペインが閉じた・ウィンドウを張り替えた）その時点で切る
	const writeMobile = (chunk: Uint8Array) => {
		if (holder.writer === undefined) {
			return;
		}
		if (!deps.isTicketCurrent()) {
			holder.writer.abort();
			holder.writer = undefined;
			return;
		}
		holder.writer.write(chunk);
	};
	const stop = (reason: Failure) => {
		failure ??= reason;
		// 固まった手元の書き込みの待ちから、受け取りの読み進めを抜けさせる
		localFailed = true;
		localDrained?.();
		// 応答のヘッダーを送る前なら、理由の分かる 4xx を返してから切る
		if (!res.headersSent && !res.writableEnded) {
			res.writeHead(statusFor(reason), { ...JSON_HEADERS, Connection: 'close' });
			res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
		}
		req.destroy();
	};
	const maxTimer = setTimeout(() => stop('max-duration'), deps.limits?.maxDurationMs ?? PARADIS_REMOTE_VOICE_MAX_DURATION_MS);
	const firstAudioTimer = setTimeout(() => stop('first-audio-timeout'), deps.limits?.firstAudioTimeoutMs ?? PARADIS_REMOTE_VOICE_FIRST_AUDIO_TIMEOUT_MS);
	const arrivalTimer = setInterval(() => {
		// ticket の持ち主（ペイン）がいなくなったら、受け取りも手元への転送もやめる
		if (!deps.isTicketCurrent()) {
			stop('revoked');
			return;
		}
		if (firstAudioAt === undefined || bitrate === undefined) {
			return;
		}
		const elapsedSeconds = (now() - firstAudioAt) / 1000;
		const receivedSeconds = Math.max(0, size - bitrate.offset) * 8 / (bitrate.kbps * 1000);
		if (elapsedSeconds > 0 && receivedSeconds / elapsedSeconds < SLOW_ARRIVAL_RATIO) {
			slowSince ??= now();
			if (now() - slowSince >= (deps.limits?.slowArrivalMs ?? PARADIS_REMOTE_VOICE_SLOW_ARRIVAL_MS)) {
				stop('slow-arrival');
			}
		} else {
			slowSince = undefined;
		}
	}, ARRIVAL_CHECK_INTERVAL_MS);

	try {
		for await (const value of req) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
			if (chunk.byteLength === 0) {
				continue;
			}
			if (firstAudioAt === undefined) {
				firstAudioAt = now();
				clearTimeout(firstAudioTimer);
			}
			size += chunk.byteLength;
			if (size > PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES || !deps.reserveBytes(chunk.byteLength)) {
				failure = 'too-large';
				break;
			}
			chunks.push(chunk);
			if (bitrate === undefined && size <= BITRATE_PROBE_LIMIT + chunk.byteLength) {
				bitrate = paradisMp3Bitrate(chunks.length === 1 ? chunk : Buffer.concat(chunks, size));
			}
			if (!headChecked) {
				if (size < 4) {
					continue;
				}
				// 接続先の任意のバイト列を、手元のデコーダへそのまま渡さない
				if (!paradisLooksLikeMp3(chunks.length === 1 ? chunk : Buffer.concat(chunks, size))) {
					failure = 'not-mp3';
					break;
				}
				headChecked = true;
				acceptHeaders();
				if (deps.beginMobileVoiceStream && deps.isTicketCurrent()) {
					holder.writer = deps.beginMobileVoiceStream(gainKey);
					for (const pending of chunks) {
						writeMobile(pending);
					}
				}
				if (chunked) {
					// 受け取りながら手元へ流すのは、引き受けた chunked だけ（旧方式は全部受け取ってから確かめて渡す）
					startLocalPump();
					for (const pending of chunks) {
						await queueLocal(pending);
					}
				}
				continue;
			}
			writeMobile(chunk);
			if (chunked) {
				await queueLocal(chunk);
			}
		}
	} catch {
		failure ??= 'closed';
	} finally {
		clearTimeout(maxTimer);
		clearTimeout(firstAudioTimer);
		clearInterval(arrivalTimer);
	}
	if (failure === undefined && request.signal.aborted) {
		failure = 'closed';
	}
	if (failure === undefined && !headChecked) {
		failure = 'empty';
	}
	if (failure === undefined && declaredLength !== undefined && size !== declaredLength) {
		failure = 'length-mismatch';
	}
	if (failure === undefined && !deps.isTicketCurrent()) {
		failure = 'revoked';
	}
	if (failure === undefined && holder.writer !== undefined) {
		// モバイルへの流れは、手元への書き込みを待たずに終える
		holder.writer.end();
		holder.writer = undefined;
	}
	if (localPump !== undefined) {
		// 壊れた・大きすぎる本文・持ち主のいない本文は手元へ書き足さない。それ以外は溜まっている分を書き切ってから終える
		await closeLocal(failure !== undefined && failure !== 'slow-arrival' && failure !== 'max-duration');
	}
	deps.onBodyReceived();

	// 届くのが遅い・長すぎる声は、引き受けた以上、受け取った分を鳴らす（壊れた・大きすぎる本文だけ捨てる）
	const playReceived = failure !== undefined && chunked && wantLocal && headChecked && (failure === 'slow-arrival' || failure === 'max-duration');
	if (failure !== undefined) {
		// 受け取った分を鳴らす件は、モバイルも届いた分で終える。それ以外は切る
		if (playReceived) {
			holder.writer?.end();
		} else {
			holder.writer?.abort();
		}
		holder.writer = undefined;
		if (playReceived && sink) {
			// worker は届いた分で終える
			void sink.end();
		} else {
			// 鳴り始める前なら worker は捨て、鳴り始めた後なら届いた分を鳴らし切る
			void sink?.abort(failure === 'closed' ? 'ssh-closed' : failure);
		}
		const received = playReceived && !sink && !workerStarted ? Buffer.concat(chunks, size) : undefined;
		chunks.length = 0;
		if (failure !== 'closed' && !res.writableEnded) {
			if (!res.headersSent) {
				res.writeHead(statusFor(failure), JSON_HEADERS);
				res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
			} else {
				res.end(JSON.stringify({ localPlayback: playReceived }));
			}
		}
		if (!req.destroyed && failure !== 'closed') {
			req.destroy();
		}
		if (playReceived) {
			return { outcome: 'played-locally', localPlayback: received ? playLocalChain(received) : undefined };
		}
		return { outcome: failure === 'closed' ? 'aborted' : 'rejected' };
	}

	await sink?.end();
	const fullAudio = Buffer.concat(chunks, size);
	chunks.length = 0;
	if (!deps.beginMobileVoiceStream && deps.isTicketCurrent()) {
		deps.publishMobileVoiceClip?.(fullAudio);
	}

	if (chunked) {
		// 鳴り終わりは待たずに応答を閉じる
		res.end(JSON.stringify({ localPlayback: wantLocal }));
		if (!wantLocal) {
			return { outcome: 'declined' };
		}
		if (remoteMuted) {
			// ミュート中の発話はモバイルへ届けただけ（接続先にも鳴らさせない）
			return { outcome: 'played-locally' };
		}
		return { outcome: 'played-locally', localPlayback: followIngest(sink, workerStarted ? undefined : fullAudio, deps, playLocalChain) };
	}

	// Content-Length の旧方式。全部受け取って長さと ticket を確かめてから手元へ渡し、積めたかどうかを返す
	// （積めなければ接続先の aivis-mcp が自分で鳴らす）
	let playedLocally = false;
	if (remoteMuted) {
		// ミュート中の発話は手元で鳴らさず、接続先にも鳴らさせない（モバイルへは届けた）
		playedLocally = true;
	} else if (request.localPlayback) {
		const deadline = now() + request.enqueueDeadlineMs;
		startLocalPump();
		await queueLocal(fullAudio);
		// 接続先が答えを待つ締め切りを越えて手元への書き込みを待たない
		await closeLocal(false, Math.max(0, deadline - now()));
		const ingestSink = sink;
		if (ingestSink) {
			await ingestSink.end();
			let timer: ReturnType<typeof setTimeout> | undefined;
			playedLocally = await Promise.race([
				ingestSink.handoff,
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - now())); }),
			]);
			clearTimeout(timer);
			if (!playedLocally) {
				// 締め切りまでに `queued` が来なかった。積まれたかもしれないので、中断ではなく取り下げを頼んでその結果で決める
				// （外せた件だけ `--play-audio` か接続先に鳴らしてもらう。外せなかった・分からない件は worker が鳴らす）
				if (ingestSink.withdraw) {
					playedLocally = (await ingestSink.withdraw()) !== true;
				} else {
					void ingestSink.abort('handoff-timeout');
				}
			}
			if (playedLocally) {
				// 手放した後に worker から取り下げられた（まだ鳴っていない）件だけ、Para Code が鳴らす
				void followIngest(ingestSink, fullAudio, deps, playLocalChain);
			}
		}
		if (!playedLocally && !request.signal.aborted && deps.isTicketCurrent()) {
			playedLocally = await deps.playViaPlayAudio(fullAudio, { signal: request.signal, deadline }).catch(() => false);
		}
	}
	if (res.writableEnded || request.signal.aborted) {
		return { outcome: 'aborted' };
	}
	const body = JSON.stringify({ localPlayback: playedLocally });
	res.writeHead(202, { ...JSON_HEADERS, 'Content-Length': Buffer.byteLength(body) });
	res.end(body);
	return { outcome: playedLocally ? 'played-locally' : 'declined' };
}

/**
 * 手元の worker へ渡した声の行方を見届ける。worker が声を鳴らせなかった（取り下げられた・最初の音を待ちきれなかった）
 * 件と、渡せなかった件だけ Para Code が鳴らす。控えは全体の枠の中でだけ持ち、worker が鳴らし始めたら捨てる。
 */
async function followIngest(sink: IParadisIngestStream | undefined, audio: Buffer | undefined, deps: IParadisRemoteVoiceIngressDeps, playLocalChain: (audio: Buffer) => Promise<void>): Promise<void> {
	let pending = audio;
	let retention: IParadisVoiceRetention | undefined;
	if (pending && sink && deps.voiceOutput?.reserveFallbackCopy) {
		retention = deps.voiceOutput.reserveFallbackCopy();
		if (!retention?.grow(pending.byteLength)) {
			// 控えの枠が足りない。鳴らし直しは諦める（worker が鳴らせば困らない）
			retention?.release();
			retention = undefined;
			pending = undefined;
		}
	}
	try {
		// worker が鳴らし始めたら、鳴らし直し用の控えは要らない
		sink?.onDidStart(() => { pending = undefined; });
		if (sink && await sink.handoff) {
			const terminal = await sink.finished;
			const nothingPlayed = terminal.status === 'failed' && (terminal.withdrawn === true || terminal.reason === 'first-audio-timeout');
			if (!nothingPlayed) {
				return;
			}
		}
		const replay = pending;
		pending = undefined;
		if (replay) {
			await playLocalChain(replay);
		}
	} finally {
		retention?.release();
	}
}

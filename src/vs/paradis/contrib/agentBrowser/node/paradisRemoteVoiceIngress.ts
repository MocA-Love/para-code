/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `/paradis-mcp/mobile-voice` の本文の受け取り（設計 3.4）。ticket の確認と枠の押さえはサービス側で済ませてから呼ぶ。
//
// - chunked（Content-Length 無し。ticket に `ingress: "stream-v1"` を名乗ったときに接続先の aivis-mcp 2.5.0 が
//   送る）: 要求のヘッダーを受けたらすぐ応答のヘッダーを返す。手元で鳴らす ticket なら
//   `X-Para-Local-Playback: accepted` を付け、その先の鳴らし方（`--ingest` → `--play-audio` → afplay）は
//   Para Code の責任にする。受け取りながら `--ingest` へ流し、本文を受け取り終えたら応答を閉じる（鳴り終わりは
//   待たない）。接続先が途中で切れたら `--ingest` に abort を送る
// - Content-Length 付き（古い aivis-mcp）: 今どおり全部受け取ってから、手元で積めたかを `localPlayback` で返す。
//   積めなければ接続先が自分で鳴らす
// - MP3 らしさは最初の固まりで確かめる。流れ 1 本 8MiB、押さえる量は受け取った分だけ増やす。1 発話 120 秒、
//   最初の音まで 10 秒、届く速さが実時間の半分を 3 秒続けて下回ったら打ち切る
// - モバイルへの配信は、今どおり全部受け取ってから 1 本で送る

import type * as http from 'http';
import { IParadisIngestStream, IParadisLocalVoiceOutput } from '../../notifications/common/paradisVoiceIngest.js';
import { PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES } from '../../notifications/common/paradisNotifications.js';
import { PARADIS_REMOTE_VOICE_ACCEPTED_HEADER, PARADIS_REMOTE_VOICE_GAIN_KEY_HEADER, paradisLooksLikeMp3, paradisMp3Bitrate, paradisRemoteVoiceGainKey } from '../common/paradisRemoteVoice.js';
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

export interface IParadisRemoteVoiceIngressDeps {
	/** 手元で鳴らす口（`--ingest`・afplay）。無ければ `--play-audio` だけで積む。 */
	readonly voiceOutput: IParadisLocalVoiceOutput | undefined;
	/** 今の `aivis-mcp --play-audio` で積む。積めたら true。 */
	readonly playViaPlayAudio: (audio: Uint8Array, options: IParadisLocalVoicePlayOptions) => Promise<boolean>;
	readonly publishMobileVoiceClip?: (audio: Uint8Array) => void;
	/** 受け取った分だけ押さえる量を増やす。超えたら false。 */
	readonly reserveBytes: (bytes: number) => boolean;
	/** 本文を受け取り終えた（枠を手放してよい）。 */
	readonly onBodyReceived: () => void;
	readonly isTicketCurrent: () => boolean;
	readonly now?: () => number;
	/** 打ち切りの時間（テストで縮める）。 */
	readonly limits?: { readonly maxDurationMs?: number; readonly firstAudioTimeoutMs?: number; readonly slowArrivalMs?: number; readonly acceptDecisionWaitMs?: number };
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

type Failure = 'too-large' | 'not-mp3' | 'first-audio-timeout' | 'max-duration' | 'slow-arrival' | 'closed' | 'length-mismatch' | 'empty';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function statusFor(failure: Failure): number {
	switch (failure) {
		case 'too-large': return 413;
		case 'not-mp3': return 415;
		case 'first-audio-timeout':
		case 'max-duration':
		case 'slow-arrival': return 408;
		default: return 400;
	}
}

/** 本文を受け取り、手元で鳴らす・モバイルへ送る。応答を返し終えたら解決する。 */
export async function paradisReceiveRemoteVoice(req: http.IncomingMessage, res: http.ServerResponse, request: IParadisRemoteVoiceRequest, deps: IParadisRemoteVoiceIngressDeps): Promise<IParadisRemoteVoiceResult> {
	const now = deps.now ?? Date.now;
	const chunked = req.headers['content-length'] === undefined;
	// 接続先の aivis-mcp が名乗る声とモデル（音量の表の鍵）。無ければ表の補正は 0dB
	const gainKey = paradisRemoteVoiceGainKey(req.headers[PARADIS_REMOTE_VOICE_GAIN_KEY_HEADER.toLowerCase()]);
	// 引き受けた声を `--play-audio`、それも駄目なら afplay で Para Code が鳴らす
	const playLocalChain = async (audio: Buffer) => {
		const queued = await deps.playViaPlayAudio(audio, { signal: new AbortController().signal, deadline: now() + request.enqueueDeadlineMs }).catch(() => false);
		if (!queued) {
			await deps.voiceOutput?.playFallback(audio, gainKey);
		}
	};
	const declaredLength = chunked ? undefined : Number(req.headers['content-length']);
	if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > PARADIS_MAX_MOBILE_VOICE_SIZE_BYTES)) {
		res.writeHead(413, JSON_HEADERS);
		res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
		return { outcome: 'rejected' };
	}

	// chunked は要求のヘッダーを受けた時点で返事をする。手元に aivis-mcp が無ければ引き受けない（接続先が自分で鳴らす）
	const wantLocal = request.localPlayback && (!chunked || (deps.voiceOutput !== undefined && await deps.voiceOutput.hasLocalAivis(deps.limits?.acceptDecisionWaitMs ?? ACCEPT_DECISION_WAIT_MS)));
	if (chunked) {
		if (request.signal.aborted) {
			return { outcome: 'aborted' };
		}
		res.writeHead(202, wantLocal ? { ...JSON_HEADERS, [PARADIS_REMOTE_VOICE_ACCEPTED_HEADER]: 'accepted' } : JSON_HEADERS);
		res.flushHeaders();
	}

	const chunks: Buffer[] = [];
	let size = 0;
	let headChecked = false;
	let firstAudioAt: number | undefined;
	let bitrate: { readonly kbps: number; readonly offset: number } | undefined;
	let slowSince: number | undefined;
	let failure: Failure | undefined;
	let sink: IParadisIngestStream | undefined;
	const stop = (reason: Failure) => {
		failure ??= reason;
		// 応答のヘッダーを送る前（Content-Length の旧方式）なら、理由の分かる 4xx を返してから切る
		if (!res.headersSent && !res.writableEnded) {
			res.writeHead(statusFor(reason), { ...JSON_HEADERS, Connection: 'close' });
			res.end(JSON.stringify({ error: 'Audio payload rejected.' }));
		}
		req.destroy();
	};
	const maxTimer = setTimeout(() => stop('max-duration'), deps.limits?.maxDurationMs ?? PARADIS_REMOTE_VOICE_MAX_DURATION_MS);
	const firstAudioTimer = setTimeout(() => stop('first-audio-timeout'), deps.limits?.firstAudioTimeoutMs ?? PARADIS_REMOTE_VOICE_FIRST_AUDIO_TIMEOUT_MS);
	const arrivalTimer = setInterval(() => {
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
				if (wantLocal && deps.voiceOutput) {
					sink = await deps.voiceOutput.openIngest(gainKey ? { priority: 'normal', gainKey } : { priority: 'normal' }, INGEST_READY_WAIT_MS);
				}
				for (const pending of chunks) {
					await sink?.write(pending);
				}
				continue;
			}
			await sink?.write(chunk);
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
	deps.onBodyReceived();

	// 届くのが遅い・長すぎる声は、引き受けた以上、受け取った分を鳴らす（壊れた・大きすぎる本文だけ捨てる）
	const playReceived = failure !== undefined && chunked && wantLocal && headChecked && (failure === 'slow-arrival' || failure === 'max-duration');
	if (failure !== undefined) {
		if (playReceived && sink) {
			// worker は届いた分で終える
			void sink.end();
		} else {
			// 鳴り始める前なら worker は捨て、鳴り始めた後なら届いた分を鳴らし切る
			void sink?.abort(failure === 'closed' ? 'ssh-closed' : failure);
		}
		const received = playReceived && !sink ? Buffer.concat(chunks, size) : undefined;
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
	if (deps.isTicketCurrent()) {
		deps.publishMobileVoiceClip?.(fullAudio);
	}

	if (chunked) {
		// 鳴り終わりは待たずに応答を閉じる
		res.end(JSON.stringify({ localPlayback: wantLocal }));
		if (!wantLocal) {
			return { outcome: 'declined' };
		}
		const ingestSink = sink;
		let audio: Buffer | undefined = fullAudio;
		// worker が鳴らし始めたら、鳴らし直し用の控えは要らない
		ingestSink?.onDidStart(() => { audio = undefined; });
		const localPlayback = (async () => {
			if (ingestSink && await ingestSink.handoff) {
				const terminal = await ingestSink.finished;
				if (!(terminal.status === 'failed' && terminal.withdrawn === true)) {
					return;
				}
			}
			const pending = audio;
			audio = undefined;
			if (pending) {
				await playLocalChain(pending);
			}
		})();
		return { outcome: 'played-locally', localPlayback };
	}

	// Content-Length の旧方式。積めたかどうかを返す（積めなければ接続先の aivis-mcp が自分で鳴らす）
	let playedLocally = false;
	if (request.localPlayback) {
		const deadline = now() + request.enqueueDeadlineMs;
		if (sink) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			playedLocally = await Promise.race([
				sink.handoff,
				new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), request.enqueueDeadlineMs); }),
			]);
			clearTimeout(timer);
			if (!playedLocally) {
				// 手放せないまま締め切りを過ぎた件は、遅れて鳴らないよう中断する
				void sink.abort('handoff-timeout');
			} else {
				// 手放した後に worker から取り下げられた（まだ鳴っていない）件だけ、Para Code が鳴らす
				const ingestSink = sink;
				let pending: Buffer | undefined = fullAudio;
				ingestSink.onDidStart(() => { pending = undefined; });
				void ingestSink.finished.then(async terminal => {
					const withdrawn = pending;
					pending = undefined;
					if (withdrawn && terminal.status === 'failed' && terminal.withdrawn === true) {
						await playLocalChain(withdrawn);
					}
				});
			}
		}
		if (!playedLocally && !request.signal.aborted) {
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

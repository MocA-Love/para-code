// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { activateVoiceSession, appendVoiceStream, endVoiceStream, startVoiceStream, voicePlaybackStats } from '../../modules/para-voice-session/index.js';

/**
 * 開発ビルド専用: 合成済みの MP3 を小分けにして、音声の流れ（voice.stream.v1）と同じ道でネイティブの再生へ流し込む。
 * 鳴り始めの遅れ・途切れ（溜めの判定）・溜めの閾値の上げ下げを、ペアリングの無いシミュレータで確かめるために使う。
 * devProbe の `__paraDev.voiceStream(base64, options)` から呼ぶ。
 */
export interface VoiceStreamHarnessOptions {
	/** 1 回に流すバイト数（既定 4096）。 */
	readonly chunkBytes?: number;
	/** 断片の間隔（既定 20ms。実時間より速く届く合成 API を真似る）。 */
	readonly intervalMs?: number;
	/** このバイト数を流したところで止まる（回線の詰まりを真似る）。 */
	readonly stallAfterBytes?: number;
	/** 止まる長さ（ms）。 */
	readonly stallMs?: number;
	readonly gainDb?: number;
	/** end を送らない（8 秒の打ち切りを確かめる）。 */
	readonly omitEnd?: boolean;
}

function decodeBase64(base64: string): Uint8Array {
	const binary = globalThis.atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return globalThis.btoa(binary);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 1 本流し込み、鳴り終わる（finished が増える）まで待って、前後の数を返す。 */
export async function runVoiceStreamHarness(base64Mp3: string, options: VoiceStreamHarnessOptions = {}): Promise<string> {
	await activateVoiceSession();
	const before = voicePlaybackStats();
	const audio = decodeBase64(base64Mp3);
	const streamId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
	const chunkBytes = options.chunkBytes ?? 4096;
	const startedAt = Date.now();
	startVoiceStream(streamId, options.gainDb ?? 0);
	let stalled = false;
	for (let offset = 0; offset < audio.length; offset += chunkBytes) {
		if (!stalled && options.stallAfterBytes !== undefined && offset >= options.stallAfterBytes) {
			stalled = true;
			await sleep(options.stallMs ?? 2000);
		}
		appendVoiceStream(streamId, encodeBase64(audio.subarray(offset, offset + chunkBytes)));
		await sleep(options.intervalMs ?? 20);
	}
	const sentMs = Date.now() - startedAt;
	if (!options.omitEnd) {
		endVoiceStream(streamId, false);
	}
	const finishedBefore = Number(before?.['finished'] ?? 0);
	for (let waited = 0; waited < 90_000; waited += 100) {
		const stats = voicePlaybackStats();
		if (Number(stats?.['finished'] ?? 0) > finishedBefore) {
			break;
		}
		await sleep(100);
	}
	return JSON.stringify({ bytes: audio.length, sentMs, totalMs: Date.now() - startedAt, before, after: voicePlaybackStats() });
}

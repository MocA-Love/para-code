/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げ 1 件を `aivis-mcp --ingest` へ渡す（設計 3.3）。ジョブを先に積み（合成の最初の音を待つ間に
// worker が着信音を鳴らす）、合成を受け取りながら流す。`queued` が返ったら手放す。`queued` の前に失敗したら、
// 受け取った音声を返して Para Code が afplay で鳴らす。手放した後でも Para Code が鳴らすのは、worker から
// 取り下げられた（withdrawn）件と、worker が最初の音を待ちきれずに諦めた（first-audio-timeout）のに、音声の枠を
// 1 つも書いていなかった件だけ（どちらも worker は何も鳴らしていない）。

import { IParadisIngestOpenOptions, IParadisIngestStream } from '../common/paradisVoiceIngest.js';
import { AivisError, AivisHandoffResult, AivisStreamingSynthesis } from './paradisAudioScheduler.js';

/** 起動中の `--ingest` を待つ上限。過ぎたら afplay で鳴らす。 */
export const PARADIS_HANDOFF_READY_WAIT_MS = 3_000;
/** 合成した音声 1 本の上限。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface IParadisVoiceIngestPort {
	whenReady(timeoutMs: number): Promise<boolean>;
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined;
}

export interface IParadisVoiceHandoffOptions {
	readonly ingest: IParadisVoiceIngestPort;
	readonly open: IParadisIngestOpenOptions;
	readonly synthesize: () => Promise<AivisStreamingSynthesis>;
	/** worker が鳴らし始めた（着信音を含む）。 */
	readonly onStarted?: () => void;
	/** 合成を全部受け取った（モバイルへ 1 本で送る）。手放した件だけ呼ぶ（afplay で鳴らす件は鳴らす側が送る）。 */
	readonly onComplete?: (audio: Buffer) => void;
	/** 手放した後に、worker が何も鳴らさなかったと分かった。Para Code が自分で鳴らす。 */
	readonly onPlayLocally: (audio: Buffer) => void;
	readonly readyWaitMs?: number;
}

/** 1 件を worker へ渡す。合成の失敗は AivisError を投げる（スケジューラが再試行する）。 */
export async function paradisHandoffVoice(options: IParadisVoiceHandoffOptions): Promise<AivisHandoffResult> {
	if (!(await options.ingest.whenReady(options.readyWaitMs ?? PARADIS_HANDOFF_READY_WAIT_MS))) {
		return { kind: 'fallback' };
	}
	const stream = options.ingest.open(options.open);
	if (!stream) {
		return { kind: 'fallback' };
	}
	if (options.onStarted) {
		stream.onDidStart(options.onStarted);
	}
	let synthesis: AivisStreamingSynthesis;
	try {
		synthesis = await options.synthesize();
	} catch (error) {
		void stream.abort('synth-failed');
		throw error;
	}

	const chunks: Buffer[] = [];
	let bytes = 0;
	let written = 0;
	// 終わりの知らせが来た時点で、音声の枠を書いていたか
	let wroteBeforeFinish: boolean | undefined;
	void stream.finished.then(() => { wroteBeforeFinish = written > 0; });
	// 合成を受け取りながら流す。受け取った分は、渡せなかったときと取り下げられたときのために控える
	const pumped = (async (): Promise<boolean> => {
		try {
			for await (const chunk of synthesis.body) {
				bytes += chunk.byteLength;
				if (bytes > MAX_AUDIO_BYTES) {
					// allow-any-unicode-next-line
					throw new AivisError('item-specific', '合成した音声が大きすぎます');
				}
				chunks.push(Buffer.from(chunk));
				await stream.write(chunk);
				written += chunk.byteLength;
			}
			await stream.end();
			return true;
		} catch {
			// 途中で切れた。まだ何も流していなければ捨ててもらい、流していれば届いた分で終えてもらう
			if (written === 0) {
				await stream.abort('synth-failed');
			} else {
				await stream.end();
			}
			return false;
		}
	})();

	if (!(await stream.handoff)) {
		// `queued` の前に失敗した（--ingest が落ちた、など）。受け取りきった音声があれば、それを afplay で鳴らす
		const complete = await pumped;
		return complete && bytes > 0 ? { kind: 'fallback', audio: Buffer.concat(chunks, bytes) } : { kind: 'fallback' };
	}

	void (async () => {
		const complete = await pumped;
		const audio = complete && bytes > 0 ? Buffer.concat(chunks, bytes) : undefined;
		chunks.length = 0;
		if (audio) {
			options.onComplete?.(audio);
		}
		const terminal = await stream.finished;
		const nothingPlayed = terminal.status === 'failed' && (terminal.withdrawn === true || (terminal.reason === 'first-audio-timeout' && wroteBeforeFinish === false));
		if (audio && nothingPlayed) {
			options.onPlayLocally(audio);
		}
	})();
	return { kind: 'released', ...(synthesis.rateLimit ? { rateLimit: synthesis.rateLimit } : {}) };
}

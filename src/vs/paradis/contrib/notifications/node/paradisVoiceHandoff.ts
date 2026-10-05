/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知の読み上げ 1 件を `aivis-mcp --ingest` へ渡す（設計 3.3）。ジョブを先に積み（合成の最初の音を待つ間に
// worker が着信音を鳴らす）、合成を受け取りながら流す。`queued` が返ったら手放す。`queued` の前に失敗したら、
// 受け取った音声を返して Para Code が鳴らす。手放した後でも Para Code が鳴らすのは、worker から取り下げられた
// （withdrawn）件と、worker が最初の音を待ちきれずに諦めた（first-audio-timeout）件だけ（どちらも worker は声を
// 鳴らしていない）。
//
// - `--ingest` が使えないとき、worker が生きているかもしれない間（起こし直している最中）は afplay で鳴らさず、
//   スケジューラに待ってもらう（`defer`）。重ならないようにするため
// - 鳴らし直し用の控えは全体の枠（{@link IParadisVoiceHandoffOptions.retention}）の中でだけ持ち、worker が鳴らし
//   始めたら（着信音を付けた件は終わるまで）捨てる
// - 手放した後に合成が最初の音の前に切れた件は、スケジューラへ知らせて再試行してもらう（worker は何も鳴らしていない）

import { IParadisIngestOpenOptions, IParadisIngestStream, IParadisVoiceRetention } from '../common/paradisVoiceIngest.js';
import { AivisError, AivisHandoffResult, AivisHandoffSettled, AivisStreamingSynthesis, toAivisError } from './paradisAudioScheduler.js';
import { ParadisBoundedLocalWriter } from './paradisStreamingBody.js';

/** 起動中の `--ingest` を待つ上限。過ぎたら afplay で鳴らす（worker が生きているかもしれない間は待ち直す）。 */
export const PARADIS_HANDOFF_READY_WAIT_MS = 3_000;
/** 合成に失敗して中断した件の、worker からの進み具合を待つ上限。 */
const PRELUDE_SETTLE_WAIT_MS = 500;
/** 合成した音声 1 本の上限。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/**
 * `queued` を待つ上限。aivis-mcp 2.5.1 は積めたか確かめられない間（Redis が応答しない）何も返さないので、待ちすぎたら
 * 取り下げを頼み、外せた件だけ Para Code が鳴らす（外せない・分からない件は worker に任せる）。
 */
export const PARADIS_HANDOFF_QUEUED_WAIT_MS = 15_000;

export interface IParadisVoiceIngestPort {
	whenReady(timeoutMs: number): Promise<boolean>;
	open(options: IParadisIngestOpenOptions): IParadisIngestStream | undefined;
	/** 渡せないとき Para Code が自分で鳴らしてよいか。無ければ鳴らしてよい。 */
	mayPlayDirectly?(): boolean;
}

export interface IParadisVoiceHandoffOptions {
	readonly ingest: IParadisVoiceIngestPort;
	readonly open: IParadisIngestOpenOptions;
	readonly synthesize: () => Promise<AivisStreamingSynthesis>;
	/** worker が鳴らし始めた（着信音を含む）。 */
	readonly onStarted?: () => void;
	/** 着信音を前置きとして受け付けてもらえなかった（着信音を付けずに積まれた）。 */
	readonly onPreludeRejected?: () => void;
	/** 合成を全部受け取った（モバイルへ 1 本で送る）。手放した件だけ呼ぶ（afplay で鳴らす件は鳴らす側が送る）。 */
	readonly onComplete?: (audio: Buffer) => void;
	/** 手放した後に、worker が声を鳴らさなかったと分かった。Para Code が鳴らす（列経由で渡し直すかは呼び出し側）。 */
	readonly onPlayLocally: (audio: Buffer) => void;
	/** 鳴らし直し用の控えの枠。無ければ上限なしで控える。枠を返さなければ控えない。 */
	readonly retention?: () => IParadisVoiceRetention | undefined;
	readonly readyWaitMs?: number;
	readonly queuedWaitMs?: number;
}

/** `queued` を待つ。待ちすぎたら取り下げを頼み、外せたときだけ false（呼び出し側が鳴らす）。 */
async function waitForQueued(stream: IParadisIngestStream, waitMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		stream.handoff,
		new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), waitMs); }),
	]);
	clearTimeout(timer);
	if (outcome !== 'timeout') {
		return outcome;
	}
	const removed = stream.withdraw ? await stream.withdraw() : undefined;
	if (removed === true) {
		// 外せた件は aivis-mcp が `withdrawn` で終える（handoff は false になる）
		return stream.handoff;
	}
	// 外せない（worker が取り出した）・分からない。worker が鳴らすとみなして手放す
	return true;
}

/** 1 件を worker へ渡す。合成の失敗は AivisError を投げる（スケジューラが再試行する）。 */
export async function paradisHandoffVoice(options: IParadisVoiceHandoffOptions): Promise<AivisHandoffResult> {
	const unavailable = (): AivisHandoffResult => options.ingest.mayPlayDirectly?.() === false ? { kind: 'defer' } : { kind: 'fallback' };
	if (!(await options.ingest.whenReady(options.readyWaitMs ?? PARADIS_HANDOFF_READY_WAIT_MS))) {
		return unavailable();
	}
	const stream = options.ingest.open(options.open);
	if (!stream) {
		return unavailable();
	}
	if (options.onStarted) {
		stream.onDidStart(options.onStarted);
	}
	if (options.onPreludeRejected) {
		stream.onDidRejectPrelude?.(options.onPreludeRejected);
	}
	let synthesis: AivisStreamingSynthesis;
	try {
		synthesis = await options.synthesize();
	} catch (error) {
		void stream.abort('synth-failed');
		if (options.open.prelude) {
			// worker が着信音を鳴らし始めたところかもしれない。進み具合（鳴り始めた・捨てた）を少し待ってから、
			// 呼び出し側が着信音を付け直すか決める（2 回鳴らさない）
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, PRELUDE_SETTLE_WAIT_MS);
				const done = () => {
					clearTimeout(timer);
					resolve();
				};
				stream.onDidStart(done);
				void stream.finished.then(done);
			});
		}
		throw error;
	}

	// 鳴らし直し用の控え。枠に収まる間だけ持つ
	const chunks: Buffer[] = [];
	let bytes = 0;
	const retention = options.retention ? options.retention() : undefined;
	let keep = options.retention === undefined || retention !== undefined;
	const dropCopy = () => {
		keep = false;
		chunks.length = 0;
		retention?.release();
	};
	if (!options.open.prelude) {
		// 声が鳴り始めたら控えは要らない（着信音を付けた件は、着信音の後に最初の音を待ちきれないことがあるので終わりまで持つ）
		stream.onDidStart(dropCopy);
	}
	// 手元への書き込みは有界の列で切り離す（子の drain が遅くても本文の読み進め＝モバイルへの流れを止めない）
	const local = new ParadisBoundedLocalWriter(chunk => stream.write(chunk));
	let bodyError: AivisError | undefined;
	// 合成を受け取りながら流す。手元への書き込みに失敗しても本文は最後まで読む（モバイルへの流れを途中で切らない）
	const pumped = (async (): Promise<boolean> => {
		let complete = false;
		try {
			for await (const chunk of synthesis.body) {
				bytes += chunk.byteLength;
				if (bytes > MAX_AUDIO_BYTES) {
					// allow-any-unicode-next-line
					throw new AivisError('item-specific', '合成した音声が大きすぎます');
				}
				if (keep) {
					if (retention && !retention.grow(chunk.byteLength)) {
						dropCopy();
					} else {
						chunks.push(Buffer.from(chunk));
					}
				}
				await local.push(chunk);
			}
			complete = true;
		} catch (error) {
			// 途中で切れた。下で、まだ何も流していなければ捨ててもらい、流していれば届いた分で終えてもらう
			bodyError = toAivisError(error);
		}
		await local.close();
		if (local.failed) {
			// 手元へ渡せなくなった（--ingest が落ちた等）。行方は stream.handoff・finished が知らせる
			await stream.abort('write-failed');
		} else if (!complete && local.written === 0) {
			await stream.abort('synth-failed');
		} else {
			await stream.end();
		}
		return complete;
	})();
	const fullAudio = (complete: boolean): Buffer | undefined => complete && keep && bytes > 0 ? Buffer.concat(chunks, bytes) : undefined;

	if (!(await waitForQueued(stream, options.queuedWaitMs ?? PARADIS_HANDOFF_QUEUED_WAIT_MS))) {
		// `queued` の前に失敗した（--ingest が落ちて、取り下げられた、など）。受け取りきった音声があれば、それを鳴らす
		const complete = await pumped;
		const audio = fullAudio(complete);
		chunks.length = 0;
		retention?.release();
		return {
			kind: 'fallback',
			...(audio ? { audio } : {}),
			...(synthesis.rateLimit ? { rateLimit: synthesis.rateLimit } : {}),
		};
	}

	// 転送が終わった（スケジューラの転送の枠を返す）。worker の終わりの知らせは、その後も控えを持ったまま待つ
	const settled = (async (): Promise<AivisHandoffSettled> => {
		const complete = await pumped;
		const audio = fullAudio(complete);
		chunks.length = 0;
		if (audio) {
			options.onComplete?.(audio);
		}
		if (!complete && local.written === 0 && bodyError !== undefined) {
			// 最初の音より前に合成が切れた。worker には何も渡っていない（中断を送った）ので、再試行してよい
			retention?.release();
			return { retry: bodyError };
		}
		void (async () => {
			try {
				const terminal = await stream.finished;
				// 取り下げられた・最初の音を待ちきれずに諦めた件は、worker が声を鳴らしていない（書いた量には関係ない）
				const nothingPlayed = terminal.status === 'failed' && (terminal.withdrawn === true || terminal.reason === 'first-audio-timeout');
				if (audio && keep && nothingPlayed) {
					options.onPlayLocally(audio);
				}
			} finally {
				retention?.release();
			}
		})();
		return {};
	})();
	return { kind: 'released', settled, ...(synthesis.rateLimit ? { rateLimit: synthesis.rateLimit } : {}) };
}

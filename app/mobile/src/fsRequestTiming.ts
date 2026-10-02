// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getAesGcmBackend, type FrameChunkTiming } from '@para/protocol';
import { recordMobileTiming, type MobileTimingAttributes, type MobileTimingRecorder } from './mobileDiagnostics.js';

/**
 * ファイルビューアが PC へ出す要求（`fsRead` / `fsXlsx` / `fsPdf` / `fsDocx` / `fsMedia`）の、
 * 送ってから結果を受け取るまでの区間を測り、1件ずつ `para.mobileFileViewer.fetch` の transaction
 * として送る。PC 側の `para.mobileFileViewer.pc` と画面側の `para.mobileFileViewer.display` とは
 * `safe_request_id`（要求の id。起動ごとの乱数 + 連番で、パスや内容は含まない）で突き合わせる。
 *
 * 区間（ms）:
 * - `safe_send_ms`: 要求の組み立て〜送出（封緘を含む）
 * - `safe_wait_first_chunk_ms`: 送出〜応答の最初のチャンクを開封し始めるまで（PC の処理 + 回線）
 * - `safe_receive_ms`: 最初のチャンク〜最後のチャンクの開封完了（残りの転送 + 開封）
 * - `safe_open_ms`: そのうちチャンクの開封（復号）にかかった時間の合計（実装は `safe_aes_backend`）
 * - `safe_handoff_ms`: 最後のチャンク〜応答の処理開始（再結合）
 * - 応答の処理: `safe_gunzip_ms` / `safe_utf8_decode_ms` / `safe_json_parse_ms` / `safe_cache_resolve_ms`、
 *   バイナリは `safe_binary_decode_ms` / `safe_base64_ms`
 *
 * チャンクと要求の対応は「fs チャネルで直前に完結した論理フレーム」で取る。FrameMux は最後の
 * チャンクを開封したその場で同期的に応答の処理を呼ぶので、取り違えは起きない。
 */

/** 測る要求の種類（PC の `ParadisMobileFileTimingKind` と同じ）。 */
const TIMED_KINDS: ReadonlySet<string> = new Set(['read', 'xlsx', 'pdf', 'docx', 'media']);
/** 結果が返らないまま残った計測の上限。要求は必ず応答・タイムアウト・切断のどれかで終わるので保険。 */
const MAX_TRACES = 16;
/** 拡張子として送ってよい形。これ以外は名前の一部が漏れうるので `other` に畳む。 */
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

export type FsRequestOutcome = 'ok' | 'not-modified' | 'error' | 'timeout' | 'disconnected' | 'renderer-changed';

/**
 * パスから拡張子だけを取り出す（パス・ファイル名は送らない）。拡張子が無ければ `none`、
 * 送ってよい形でなければ `other`。PC の `paradisMobileFileTimingExtension` と同じ規則。
 */
export function timingExtension(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) {
		return 'none';
	}
	const extension = name.slice(dot + 1).toLowerCase();
	return SAFE_EXTENSION.test(extension) ? extension : 'other';
}

/** 応答（`fsRead` 等の結果）に付いている要求の id。PC は応答へ要求の id をそのまま入れて返す。 */
export function fsResponseRequestId(response: unknown): string | undefined {
	const id = response !== null && typeof response === 'object' ? (response as { readonly id?: unknown }).id : undefined;
	return typeof id === 'string' ? id : undefined;
}

interface Trace {
	readonly kind: string;
	readonly ext: string;
	readonly startedAt: number;
	sentAt?: number;
	requestBytes?: number;
}

interface Assembly {
	/** 最初のチャンクの開封を始めた時刻。 */
	readonly firstAt: number;
	/** 最後に開封し終えた時刻。 */
	lastAt: number;
	chunks: number;
	bytes: number;
	openMs: number;
}

/** 応答1件の処理（gunzip・JSON の解析など）の区間を測る。id は解析が済むまで分からない。 */
export class FsResponseTiming {
	private readonly phases: Record<`safe_${string}_ms`, number> = {};
	private readonly values: MobileTimingAttributes = {};
	private readonly startedAt: number;
	private last: number;

	constructor(
		private readonly owner: FsRequestTimings,
		private readonly assembly: Assembly | undefined,
		private readonly now: () => number,
	) {
		this.startedAt = now();
		this.last = this.startedAt;
	}

	/** 直前の区切りからここまでを `phase` の時間として記録する。 */
	mark(phase: string): void {
		const at = this.now();
		this.phases[`safe_${phase}_ms`] = (this.phases[`safe_${phase}_ms`] ?? 0) + (at - this.last);
		this.last = at;
	}

	set(values: MobileTimingAttributes): void {
		Object.assign(this.values, values);
	}

	/** 応答の処理が済んだ。id が測っている要求のものなら1件送る。 */
	finish(id: string, outcome: FsRequestOutcome): void {
		const handoff: MobileTimingAttributes = this.assembly !== undefined ? { safe_handoff_ms: Math.max(0, this.startedAt - this.assembly.lastAt) } : {};
		this.owner.complete(id, outcome, this.assembly, { ...handoff, ...this.values, ...this.phases });
	}
}

export class FsRequestTimings {
	private readonly traces = new Map<string, Trace>();
	private assembling: Assembly | undefined;
	private completed: Assembly | undefined;

	constructor(
		private readonly record: MobileTimingRecorder = recordMobileTiming,
		private readonly now: () => number = Date.now,
	) { }

	/** 要求を組み立てる前に呼ぶ。測る種類でなければ何もしない。 */
	begin(id: string, body: { readonly t?: unknown; readonly path?: unknown }): void {
		if (typeof body.t !== 'string' || !TIMED_KINDS.has(body.t)) {
			return;
		}
		if (this.traces.size >= MAX_TRACES) {
			const oldest = this.traces.keys().next().value;
			if (oldest !== undefined) {
				this.traces.delete(oldest);
			}
		}
		this.traces.set(id, { kind: body.t, ext: timingExtension(typeof body.path === 'string' ? body.path : ''), startedAt: this.now() });
	}

	/** 要求を送り出した直後に呼ぶ。 */
	sent(id: string, requestBytes: number): void {
		const trace = this.traces.get(id);
		if (trace !== undefined) {
			trace.sentAt = this.now();
			trace.requestBytes = requestBytes;
		}
	}

	/** FrameMux がチャンクを1つ開封した（`RelayClientCallbacks.onFrameChunk`）。fs チャネルだけ数える。 */
	chunk(chunk: FrameChunkTiming): void {
		if (chunk.ch !== 'fs') {
			return;
		}
		const at = this.now();
		if (this.assembling === undefined) {
			// 次の論理フレームが始まった。前に完結したものを誰も引き取らなかったなら捨てる。
			this.completed = undefined;
			this.assembling = { firstAt: at - chunk.openMs, lastAt: at, chunks: 0, bytes: 0, openMs: 0 };
		}
		const assembly = this.assembling;
		assembly.lastAt = at;
		assembly.chunks++;
		assembly.bytes += chunk.bytes;
		assembly.openMs += chunk.openMs;
		if (!chunk.more) {
			this.completed = assembly;
			this.assembling = undefined;
		}
	}

	/** fs チャネルの応答の処理を始める。直前に完結した論理フレームのチャンクの記録を引き取る。 */
	response(): FsResponseTiming {
		const assembly = this.completed;
		this.completed = undefined;
		return new FsResponseTiming(this, assembly, this.now);
	}

	/**
	 * 応答が来ないまま終わった（タイムアウト・切断・PC 画面の再接続）。`safe_pending_chunks` は
	 * その時点で fs チャネルの再結合の途中にあったチャンク数（どの要求の応答かは区別できない）。
	 */
	abort(id: string, outcome: FsRequestOutcome): void {
		this.complete(id, outcome, undefined, this.assembling !== undefined ? { safe_pending_chunks: this.assembling.chunks } : {});
	}

	/** 接続が切れた。待っていた要求をすべて終わらせ、再結合の途中の記録も捨てる（新しい接続では続かない）。 */
	abortAll(outcome: FsRequestOutcome): void {
		for (const id of [...this.traces.keys()]) {
			this.abort(id, outcome);
		}
		this.assembling = undefined;
		this.completed = undefined;
	}

	/** @internal FsResponseTiming から呼ぶ。 */
	complete(id: string, outcome: FsRequestOutcome, assembly: Assembly | undefined, values: MobileTimingAttributes): void {
		const trace = this.traces.get(id);
		if (trace === undefined) {
			return;
		}
		this.traces.delete(id);
		const endedAt = this.now();
		const sentAt = trace.sentAt;
		this.record('mobileFileViewer', 'fetch', trace.startedAt, endedAt, {
			safe_request_id: id,
			safe_kind: trace.kind,
			safe_ext: trace.ext,
			safe_outcome: outcome,
			safe_total_ms: endedAt - trace.startedAt,
			...(sentAt !== undefined ? { safe_send_ms: sentAt - trace.startedAt, safe_request_bytes: trace.requestBytes ?? 0 } : {}),
			...(assembly !== undefined ? {
				...(sentAt !== undefined ? { safe_wait_first_chunk_ms: Math.max(0, assembly.firstAt - sentAt) } : {}),
				safe_receive_ms: assembly.lastAt - assembly.firstAt,
				safe_open_ms: assembly.openMs,
				// 開封に使った AES-GCM の実装（`native` / `noble`）。safe_open_ms を実装ごとに比べるため。
				safe_aes_backend: getAesGcmBackend().name,
				safe_chunks: assembly.chunks,
				safe_wire_bytes: assembly.bytes,
			} : {}),
			...values,
		});
	}
}

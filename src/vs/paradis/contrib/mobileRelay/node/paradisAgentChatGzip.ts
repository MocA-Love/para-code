/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * agent チャネルの大きい応答（トークの snapshot・古い発言・サブエージェントの詳細・大きい delta）を
 * gzip response v1 で送る。attach で `responseEncoding: 'json-gzip-v1'` を交渉した購読だけが対象で、
 * 古いアプリには今までどおりの JSON を送る。
 *
 * 圧縮は zlib の同期版で行う。送る前の権限確認（直列の列）と順番を崩さないため（非同期にすると、
 * 後から作った小さい delta が先に縮み終わって snapshot を追い越す）。実測で 107KB の snapshot が 0.67ms。
 */

import { gzipSync } from 'zlib';
import { PARADIS_JSON_GZIP_RESPONSE_ENCODING, paradisFrameGzipJsonResponse, paradisIsGzipJsonCandidate } from '../common/paradisMobileGzipJson.js';

/** 中身の大きさに関わらず縮める候補にする種類（いつも大きくなりうる）。 */
const ALWAYS_CANDIDATE_TYPES: ReadonlySet<string> = new Set(['snapshot', 'history', 'activity-detail']);
/** delta はふだん小さい（live の追記・付帯情報）。再接続の追いつきで大きいときだけ縮める（mux の断片 1 つ分）。 */
const LARGE_DELTA_BYTES = 16 * 1024;

export interface IParadisAgentGzipMeasure {
	readonly type: string;
	readonly rawBytes: number;
	readonly wireBytes: number;
	readonly gzipMs: number;
}

/** その種類・大きさの応答を縮める候補にするか。 */
export function paradisShouldGzipAgentOutbound(type: string, rawBytes: number): boolean {
	if (!paradisIsGzipJsonCandidate(rawBytes)) {
		return false;
	}
	return ALWAYS_CANDIDATE_TYPES.has(type) || (type === 'delta' && rawBytes >= LARGE_DELTA_BYTES);
}

/**
 * 交渉した購読なら縮めた payload を、そうでなければ（縮み方が足りない・失敗も）元の JSON をそのまま返す。
 * `measure` には縮めたときの大きさと時間を渡す（展開後の上限はモバイルの復号側が見出しの長さで確かめる）。
 */
export function paradisEncodeAgentOutboundPayload(type: string, json: Uint8Array, responseEncoding: string | undefined, measure?: (sample: IParadisAgentGzipMeasure) => void, now: () => number = () => performance.now()): Uint8Array {
	if (responseEncoding !== PARADIS_JSON_GZIP_RESPONSE_ENCODING || !paradisShouldGzipAgentOutbound(type, json.length)) {
		return json;
	}
	const startedAt = now();
	let framed: Uint8Array | undefined;
	try {
		framed = paradisFrameGzipJsonResponse(json.length, gzipSync(json));
	} catch {
		framed = undefined;
	}
	const payload = framed ?? json;
	measure?.({ type, rawBytes: json.length, wireBytes: payload.length, gzipMs: now() - startedAt });
	return payload;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { gunzipSync } from 'zlib';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisEncodeAgentOutboundPayload, paradisShouldGzipAgentOutbound } from '../../node/paradisAgentChatGzip.js';

const encoder = new TextEncoder();

function decode(payload: Uint8Array): { readonly gzip: boolean; readonly json: string } {
	const gzip = payload[0] === 0x50 && payload[1] === 0x43 && payload[2] === 0x4a && payload[3] === 0x01;
	return { gzip, json: new TextDecoder().decode(gzip ? gunzipSync(payload.subarray(12)) : payload) };
}

suite('paradisAgentChatGzip', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const snapshot = JSON.stringify({ t: 'snapshot', messages: Array.from({ length: 200 }, (_, index) => ({ rev: index, role: 'assistant', kind: 'text', text: `確認しました。次の手順に進みます ${index}` })) });

	test('compresses a snapshot only for a subscriber that negotiated json-gzip-v1, and the bytes round-trip', () => {
		const json = encoder.encode(snapshot);
		const negotiated = paradisEncodeAgentOutboundPayload('snapshot', json, 'json-gzip-v1');
		const legacy = paradisEncodeAgentOutboundPayload('snapshot', json, undefined);
		assert.deepStrictEqual({
			negotiated: { ...decode(negotiated), smaller: negotiated.length < json.length },
			legacy: { ...decode(legacy), same: legacy === json },
		}, {
			negotiated: { gzip: true, json: snapshot, smaller: true },
			legacy: { gzip: false, json: snapshot, same: true },
		});
	});

	test('leaves small deltas and live updates uncompressed and compresses only a large catch-up delta', () => {
		assert.deepStrictEqual({
			smallDelta: paradisShouldGzipAgentOutbound('delta', 4 * 1024),
			largeDelta: paradisShouldGzipAgentOutbound('delta', 64 * 1024),
			tinySnapshot: paradisShouldGzipAgentOutbound('snapshot', 200),
			detail: paradisShouldGzipAgentOutbound('activity-detail', 8 * 1024),
			history: paradisShouldGzipAgentOutbound('history', 8 * 1024),
			actionResult: paradisShouldGzipAgentOutbound('action-result', 64 * 1024),
			// 同期で縮めると shared process が止まる大きさは縮めない
			hugeSnapshot: paradisShouldGzipAgentOutbound('snapshot', 4 * 1024 * 1024 + 1),
		}, { smallDelta: false, largeDelta: true, tinySnapshot: false, detail: true, history: true, actionResult: false, hugeSnapshot: false });
	});

	test('reports the raw and wire sizes of what it compressed', () => {
		const samples: { type: string; raw: number; smaller: boolean }[] = [];
		const json = encoder.encode(snapshot);
		paradisEncodeAgentOutboundPayload('snapshot', json, 'json-gzip-v1', sample => samples.push({ type: sample.type, raw: sample.rawBytes, smaller: sample.wireBytes < sample.rawBytes }));
		paradisEncodeAgentOutboundPayload('snapshot', json, undefined, sample => samples.push({ type: sample.type, raw: sample.rawBytes, smaller: false }));
		assert.deepStrictEqual(samples, [{ type: 'snapshot', raw: json.length, smaller: true }]);
	});
});

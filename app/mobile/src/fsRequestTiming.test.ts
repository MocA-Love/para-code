// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { FsRequestTimings, fsResponseRequestId, timingExtension } from './fsRequestTiming.js';
import type { MobileTimingAttributes } from './mobileDiagnostics.js';

interface Recorded {
	readonly name: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly attributes: MobileTimingAttributes;
}

function setup() {
	let now = 0;
	const recorded: Recorded[] = [];
	const timings = new FsRequestTimings((feature, operation, startedAt, endedAt, attributes) => {
		recorded.push({ name: `${feature}.${operation}`, startedAt, endedAt, attributes });
	}, () => now);
	return { timings, recorded, at: (ms: number) => { now = ms; } };
}

describe('FsRequestTimings', () => {
	test('splits one chunked response into send, wait, receive and decode phases', () => {
		const { timings, recorded, at } = setup();
		at(1_000);
		timings.begin('p-r-1', { t: 'read', path: 'docs/page.html' });
		at(1_002);
		timings.sent('p-r-1', 300);
		// 別チャネルのチャンクは数えない
		timings.chunk({ ch: 'term', bytes: 10, more: false, openMs: 1 });
		at(5_000);
		timings.chunk({ ch: 'fs', bytes: 700, more: true, openMs: 40 });
		at(9_000);
		timings.chunk({ ch: 'fs', bytes: 200, more: false, openMs: 30 });
		at(9_001);
		const response = timings.response();
		at(9_101);
		response.mark('gunzip');
		at(9_401);
		response.mark('json_parse');
		response.set({ safe_gzip: true });
		at(9_402);
		response.finish('p-r-1', 'ok');
		// 測っていない id・2回目の完了は送らない
		timings.response().finish('p-r-1', 'ok');

		expect(recorded).toEqual([{
			name: 'mobileFileViewer.fetch',
			startedAt: 1_000,
			endedAt: 9_402,
			attributes: {
				safe_request_id: 'p-r-1',
				safe_kind: 'read',
				safe_ext: 'html',
				safe_outcome: 'ok',
				safe_total_ms: 8_402,
				safe_send_ms: 2,
				safe_request_bytes: 300,
				safe_wait_first_chunk_ms: 3_958,
				safe_receive_ms: 4_040,
				safe_open_ms: 70,
				safe_chunks: 2,
				safe_wire_bytes: 900,
				safe_handoff_ms: 1,
				safe_gzip: true,
				safe_gunzip_ms: 100,
				safe_json_parse_ms: 300,
			},
		}]);
	});

	test('reports requests that never got an answer, and ignores other request kinds', () => {
		const { timings, recorded, at } = setup();
		at(0);
		timings.begin('p-r-1', { t: 'list', path: 'src' });
		timings.begin('p-r-2', { t: 'pdf', path: 'a/b.pdf' });
		timings.begin('p-r-3', { t: 'media', path: 'movie' });
		timings.chunk({ ch: 'fs', bytes: 700, more: true, openMs: 5 });
		at(120_000);
		timings.abort('p-r-2', 'timeout');
		timings.abort('p-r-1', 'timeout');
		timings.abortAll('disconnected');

		expect(recorded.map(entry => entry.attributes)).toEqual([
			{ safe_request_id: 'p-r-2', safe_kind: 'pdf', safe_ext: 'pdf', safe_outcome: 'timeout', safe_total_ms: 120_000, safe_pending_chunks: 1 },
			{ safe_request_id: 'p-r-3', safe_kind: 'media', safe_ext: 'none', safe_outcome: 'disconnected', safe_total_ms: 120_000, safe_pending_chunks: 1 },
		]);
	});

	test('sends only the extension and reads the request id back from a response', () => {
		expect({
			extensions: ['a/page.HTML', 'Makefile', '.env', 'a.verylongextension', 'x\\y.md'].map(timingExtension),
			ids: [fsResponseRequestId({ id: 'p-r-9', t: 'read' }), fsResponseRequestId({ t: 'read' }), fsResponseRequestId(undefined)],
		}).toEqual({
			extensions: ['html', 'none', 'none', 'other', 'md'],
			ids: ['p-r-9', undefined, undefined],
		});
	});
});

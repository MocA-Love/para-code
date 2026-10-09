/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisSemanticDiagnosticsSummary, IParadisSpreadsheetService } from '../../common/paradisSpreadsheet.js';
import { ParadisOfficeSemanticWorkerQueue, type IParadisOfficeSemanticWorkerReply, type ParadisOfficeSemanticWorkerMessage } from '../../node/office/paradisOfficeSemanticWorkerQueue.js';
import { ParadisSpreadsheetChannel } from '../../node/paradisSpreadsheetChannel.js';
import {
	PARADIS_SPREADSHEET_SEMANTIC_QUEUE_BYTES,
	PARADIS_SPREADSHEET_SEMANTIC_QUEUE_DEADLINE_MS,
	PARADIS_SPREADSHEET_SEMANTIC_QUEUE_LIMIT,
	PARADIS_SPREADSHEET_SEMANTIC_RUN_DEADLINE_MS,
	ParadisSpreadsheetSemanticWorkerBackend,
	type IParadisSpreadsheetSemanticWorker,
	type IParadisSpreadsheetSemanticWorkerRun,
} from '../../node/spreadsheet/paradisSpreadsheetSemanticWorkerBackend.js';

function summary(reason: string): IParadisSemanticDiagnosticsSummary {
	return {
		available: false, terminal: false, expectedParts: 0, parsedParts: 0, expectedSheets: 0, parsedSheets: 0,
		expectedCells: 0, parsedCells: 0, unknownElements: 0, unresolvedReferences: 0, mismatchCount: 0, unavailableReason: reason,
	};
}

// The Electron renderer that runs these tests cannot start Node workers (ERR_MISSING_PLATFORM_FOR_WORKER),
// so the worker thread itself is faked here. The shared process, where the real worker runs, can.
suite('ParadisSpreadsheetSemanticWorker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('one request at a time, separate run and queue deadlines, count and byte limits answered with busy, cancellation, and no in-process retry', async () => {
		type Message = ParadisOfficeSemanticWorkerMessage<IParadisSpreadsheetSemanticWorkerRun>;
		class FakeWorker implements IParadisSpreadsheetSemanticWorker {
			readonly posted: Message[] = [];
			terminated = false;
			private readonly listeners = new Map<string, ((value: never) => void)[]>();
			postMessage(message: Message): void { this.posted.push(message); }
			on(event: string, listener: (value: never) => void): unknown {
				this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
				return this;
			}
			async terminate(): Promise<number> { this.terminated = true; return 0; }
			reply(reason: string): void {
				const last = this.posted.filter(message => message.op === 'run').at(-1)!;
				this.emit('message', { kind: 'result', id: last.id, result: summary(reason) } satisfies IParadisOfficeSemanticWorkerReply<IParadisSemanticDiagnosticsSummary> as never);
			}
			crash(error?: Error): void {
				if (error) { this.emit('error', error as never); }
				this.emit('exit', 1 as never);
			}
			private emit(event: string, value: never): void {
				for (const listener of this.listeners.get(event) ?? []) { listener(value); }
			}
		}
		const scheduled: { readonly handler: () => void; readonly delay: number; cleared: boolean }[] = [];
		const timers = {
			setTimeout: (handler: () => void, delay: number) => { const entry = { handler, delay, cleared: false }; scheduled.push(entry); return entry; },
			clearTimeout: (handle: unknown) => { if (handle) { (handle as { cleared: boolean }).cleared = true; } },
		};
		const fire = (delay: number) => {
			const entry = scheduled.find(candidate => candidate.delay === delay && !candidate.cleared)!;
			entry.cleared = true;
			entry.handler();
		};
		const workers: FakeWorker[] = [];
		let createFailures = 1;
		const backend = new ParadisSpreadsheetSemanticWorkerBackend(() => {
			if (createFailures-- > 0) { throw new Error('missing entry'); }
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		}, timers);
		const bytes = new Uint8Array([1]);
		const reason = async (promise: Promise<IParadisSemanticDiagnosticsSummary>) => (await promise).unavailableReason;
		const closing = new CancellationTokenSource();
		try {
			// 起動できなければ失敗を返し、次の依頼でもう一度起動を試す（本体では解析しない）。
			const notStarted = await reason(backend.collect(bytes, CancellationToken.None));

			// 走っている依頼は待ち行列の締め切りでは止めない。待っている依頼だけが busy で返る。
			const first = reason(backend.collect(bytes, CancellationToken.None));
			const waiting = reason(backend.collect(bytes, CancellationToken.None));
			fire(PARADIS_SPREADSHEET_SEMANTIC_QUEUE_DEADLINE_MS);
			const waitingResult = await waiting;
			workers[0].reply('first');
			const firstResult = await first;

			// 閉じたエディタの依頼は、待っていれば外し、走っていれば worker へ取り消しを送る。
			const runningClosed = reason(backend.collect(bytes, closing.token));
			const queuedClosed = reason(backend.collect(bytes, closing.token));
			closing.cancel();
			const queuedClosedResult = await queuedClosed;
			workers[0].reply('cancelled');
			const runningClosedResult = await runningClosed;

			// 実行の締め切りは、その依頼だけを失敗にして worker を止め、待っていた依頼は新しい worker で続ける。
			const hung = reason(backend.collect(bytes, CancellationToken.None));
			const next = reason(backend.collect(bytes, CancellationToken.None));
			fire(PARADIS_SPREADSHEET_SEMANTIC_RUN_DEADLINE_MS);
			const hungResult = await hung;
			workers[1].reply('next');
			const nextResult = await next;

			// worker が落ちたら、走っていた依頼は失敗（メモリ不足なら大きすぎる扱い）。本体で解析し直さない。
			const outOfMemory = reason(backend.collect(bytes, CancellationToken.None));
			workers[1].crash(Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
			// メモリ不足になった入力は覚えているので、ここからは別の入力で続ける。
			const other = new Uint8Array([2]);
			const crashed = reason(backend.collect(other, CancellationToken.None));
			workers[2].crash();

			// 待ち行列の件数とバイト数には上限があり、超えたら busy（頼み直せる）。
			const running = backend.collect(other, CancellationToken.None);
			const tooMany = Array.from({ length: PARADIS_SPREADSHEET_SEMANTIC_QUEUE_LIMIT }, () => backend.collect(other, CancellationToken.None));
			const countOverflow = await reason(backend.collect(other, CancellationToken.None));
			backend.dispose();
			const disposed = await Promise.all([running, ...tooMany].map(reason));

			deepStrictEqual({
				notStarted, waitingResult, firstResult, queuedClosedResult, runningClosedResult, hungResult, hungWorkerTerminated: workers[1] !== workers[0] && workers[0].terminated, nextResult,
				outOfMemory: await outOfMemory, crashed: await crashed, countOverflow, disposed: new Set(disposed),
				posted: workers.map(worker => worker.posted.map(message => message.op)),
			}, {
				notStarted: 'failed', waitingResult: 'busy', firstResult: 'first', queuedClosedResult: 'cancelled', runningClosedResult: 'cancelled', hungResult: 'limitExceeded', hungWorkerTerminated: true, nextResult: 'next',
				outOfMemory: 'limitExceeded', crashed: 'failed', countOverflow: 'busy', disposed: new Set(['cancelled']),
				posted: [['run', 'run', 'cancel', 'run'], ['run', 'run'], ['run'], ['run']],
			});
		} finally {
			closing.dispose();
			backend.dispose();
		}
	});

	test('remembers inputs that ran the worker out of memory and honours a per-request run deadline', async () => {
		type Message = ParadisOfficeSemanticWorkerMessage<{ readonly bytes: Uint8Array }>;
		const posted: Message[] = [];
		const listeners = new Map<string, ((value: never) => void)[]>();
		const scheduled: { readonly handler: () => void; readonly delay: number; cleared: boolean }[] = [];
		const queue = new ParadisOfficeSemanticWorkerQueue<{ readonly bytes: Uint8Array }, string>({
			createWorker: () => {
				listeners.clear();
				return {
					postMessage: message => { posted.push(message); },
					on: (event: string, listener: (value: never) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return undefined; },
					terminate: async () => 0,
				};
			},
			failure: code => code,
			runDeadlineMs: 1_000,
			queueDeadlineMs: 2_000,
			queueLimit: 4,
			queueByteLimit: 1_000,
			idleMs: 3_000,
			timers: {
				setTimeout: (handler: () => void, delay: number) => { const entry = { handler, delay, cleared: false }; scheduled.push(entry); return entry; },
				clearTimeout: (handle: unknown) => { if (handle) { (handle as { cleared: boolean }).cleared = true; } },
			},
		});
		const emit = (event: string, value: unknown) => { for (const listener of listeners.get(event) ?? []) { listener(value as never); } };
		const run = (bytes: Uint8Array, runDeadlineMs?: number) => queue.run(bytes.byteLength, () => ({ request: { bytes }, transfer: [] }), CancellationToken.None, { memoryKeys: [bytes], ...(runDeadlineMs ? { runDeadlineMs } : {}) });
		try {
			const heavy = new Uint8Array([1, 2, 3]);
			const first = run(heavy, 5_000);
			const deadlines = scheduled.filter(entry => !entry.cleared).map(entry => entry.delay);
			emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
			emit('exit', 1);
			const firstResult = await first;
			const postedBefore = posted.length;
			const again = await run(new Uint8Array([1, 2, 3]));
			const postedAfterAgain = posted.length;
			const other = run(new Uint8Array([4]));
			deepStrictEqual({ deadlines, firstResult, again, skippedTheWorker: postedAfterAgain === postedBefore, otherPosted: posted.length === postedBefore + 1 }, {
				deadlines: [5_000], firstResult: 'limitExceeded', again: 'limitExceeded', skippedTheWorker: true, otherPosted: true,
			});
			queue.dispose();
			await other;
		} finally {
			queue.dispose();
		}
	});

	test('answers busy when the waiting bytes would pass the byte limit', async () => {
		const backend = new ParadisSpreadsheetSemanticWorkerBackend(() => ({
			postMessage: () => undefined,
			on: () => undefined,
			terminate: async () => 0,
		}), { setTimeout: () => ({}), clearTimeout: () => undefined });
		try {
			const half = new Uint8Array(PARADIS_SPREADSHEET_SEMANTIC_QUEUE_BYTES / 2);
			void backend.collect(half, CancellationToken.None);
			void backend.collect(half, CancellationToken.None);
			void backend.collect(half, CancellationToken.None);
			const overflow = await backend.collect(new Uint8Array(1), CancellationToken.None);
			deepStrictEqual(overflow.unavailableReason, 'busy');
		} finally {
			backend.dispose();
		}
	});

	test('channel sends VSBuffer bytes and the token to the worker backend and never to the display service', async () => {
		const seen: string[] = [];
		let serviceCreated = false;
		const channel = new ParadisSpreadsheetChannel(async () => {
			serviceCreated = true;
			return { parseWorkbook: async () => ({ sheets: [] }) } satisfies IParadisSpreadsheetService;
		}, async () => ({
			collect: async (bytes, token) => {
				seen.push(`${bytes.byteLength}:${token === CancellationToken.None}`);
				return summary('seen');
			},
		}));
		try {
			const ok = await channel.call<IParadisSemanticDiagnosticsSummary>('', 'collectSemanticDiagnostics', [VSBuffer.fromString('abc')]);
			const invalid = await channel.call<IParadisSemanticDiagnosticsSummary>('', 'collectSemanticDiagnostics', ['YWJj']);
			const tooLarge = await channel.call<IParadisSemanticDiagnosticsSummary>('', 'collectSemanticDiagnostics', [VSBuffer.alloc(20 * 1024 * 1024 + 1)]);
			deepStrictEqual({ seen, reasons: [ok, invalid, tooLarge].map(result => result.unavailableReason), serviceCreated }, {
				seen: ['3:true'], reasons: ['seen', 'invalid', 'tooLarge'], serviceCreated: false,
			});
		} finally {
			channel.dispose();
		}
	});
});

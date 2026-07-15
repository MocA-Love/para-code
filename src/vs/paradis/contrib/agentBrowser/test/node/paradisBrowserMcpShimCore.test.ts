/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_MCP_CONNECT_TIMEOUT_MS,
	PARADIS_MCP_HEALTH_PATH,
	PARADIS_MCP_HEALTH_TIMEOUT_MS,
	PARADIS_MCP_MAX_INFLIGHT_REQUESTS,
	PARADIS_MCP_MAX_PORT_FILE_BYTES,
	PARADIS_MCP_MAX_REQUEST_BYTES,
	PARADIS_MCP_MAX_RESPONSE_BYTES,
	PARADIS_MCP_MAX_STDIN_FRAGMENTS,
	PARADIS_MCP_MAX_STDOUT_QUEUE_BYTES,
	PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
	PARADIS_MCP_OVERALL_TIMEOUT_MS,
	ParadisMcpInflightTracker,
	ParadisMcpPortFileReconciler,
	ParadisMcpStdioLineBuffer,
	ParadisMcpStdioWriter,
	IParadisMcpHttpRequestFactory,
	IParadisMcpPortFileRecord,
	isParadisMcpProcessAlive,
	paradisMcpShouldPauseStdin,
	parseParadisMcpPortFile,
	postParadisMcpRequest,
	postParadisMcpRequestOnVerifiedSocket,
	probeParadisMcpInstance,
	resolveLiveParadisMcpPortFile,
	shouldEmitParadisMcpHttpResponse,
	writeParadisMcpPortFileAtomic,
} from '../../node/paradisBrowserMcpShimCore.js';

const OLD_OWNER: IParadisMcpPortFileRecord = {
	protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
	port: 41001,
	pid: 101,
	instanceId: '11111111-1111-4111-8111-111111111111',
	serviceStartedAt: 1_000,
};

const NEW_OWNER: IParadisMcpPortFileRecord = {
	protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
	port: 41002,
	pid: 102,
	instanceId: '22222222-2222-4222-8222-222222222222',
	serviceStartedAt: 2_000,
};

interface IHealthTestRequest {
	readonly method: string | undefined;
	readonly authorization: string | undefined;
	readonly body: string;
}

async function startHealthTestServer(
	healthOwner: IParadisMcpPortFileRecord,
	closeHealthConnection: boolean = false,
): Promise<{
	readonly server: Server;
	readonly port: number;
	readonly requests: IHealthTestRequest[];
	readonly connectionCount: () => number;
}> {
	const { createServer } = await import('http');
	const requests: IHealthTestRequest[] = [];
	let connections = 0;
	const server = createServer((request, response) => {
		if (request.method === 'GET' && request.url === PARADIS_MCP_HEALTH_PATH) {
			requests.push({ method: request.method, authorization: request.headers.authorization, body: '' });
			request.resume();
			const body = JSON.stringify({
				protocolVersion: healthOwner.protocolVersion,
				instanceId: healthOwner.instanceId,
				serviceStartedAt: healthOwner.serviceStartedAt,
			});
			response.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
				...(closeHealthConnection ? { 'Connection': 'close' } : {}),
			});
			response.end(body);
			return;
		}
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			requests.push({
				method: request.method,
				authorization: request.headers.authorization,
				body: Buffer.concat(chunks).toString('utf8'),
			});
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
		});
	});
	server.on('connection', () => connections++);
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, '127.0.0.1');
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return { server, port: address.port, requests, connectionCount: () => connections };
}

async function closeHealthTestServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>(resolve => server.close(() => resolve()));
}

class FakeTimers {
	private nextHandle = 1;
	private readonly entries = new Map<number, { readonly callback: () => void; readonly delay: number }>();

	readonly setTimeout = (callback: () => void, delay: number): unknown => {
		const handle = this.nextHandle++;
		this.entries.set(handle, { callback, delay });
		return handle;
	};

	readonly clearTimeout = (handle: unknown): void => {
		this.entries.delete(handle as number);
	};

	get delays(): readonly number[] {
		return [...this.entries.values()].map(entry => entry.delay);
	}

	fire(delay: number): boolean {
		const entry = [...this.entries].find(([, value]) => value.delay === delay);
		if (entry === undefined) {
			return false;
		}
		this.entries.delete(entry[0]);
		entry[1].callback();
		return true;
	}
}

class FakeIntervals {
	private callback: (() => void) | undefined;
	clearCount = 0;

	readonly setInterval = (callback: () => void, _delay: number): unknown => {
		this.callback = callback;
		return 1;
	};

	readonly clearInterval = (_handle: unknown): void => {
		this.clearCount++;
		this.callback = undefined;
	};

	async fire(): Promise<void> {
		this.fireNow();
		await Promise.resolve();
		await Promise.resolve();
	}

	fireNow(): void {
		assert.ok(this.callback, 'interval callback is registered');
		this.callback();
	}
}

class FakeSocket extends EventEmitter {
	connecting = true;
}

class FakeResponse extends EventEmitter {
	complete = false;
	resumeCount = 0;

	constructor(readonly statusCode: number) {
		super();
	}

	resume(): this {
		this.resumeCount++;
		return this;
	}
}

class FakeStdioWritable extends EventEmitter {
	readonly writes: string[] = [];
	readonly callbacks: Array<(error?: Error | null) => void> = [];
	readonly writeResults: boolean[] = [];

	write(chunk: string, callback: (error?: Error | null) => void): boolean {
		this.writes.push(chunk);
		this.callbacks.push(callback);
		return this.writeResults.shift() ?? true;
	}

	completeNext(error?: Error): void {
		const callback = this.callbacks.shift();
		assert.ok(callback);
		callback(error);
	}
}

class FakeRequest extends EventEmitter {
	readonly socket = new FakeSocket();
	readonly headers = new Map<string, string | number>();
	destroyCount = 0;
	destroyError: Error | undefined;
	endError: Error | undefined;
	endedBody: string | undefined;
	onDestroy: ((error: Error | undefined) => void) | undefined;

	end(body: string): void {
		if (this.endError !== undefined) {
			throw this.endError;
		}
		this.endedBody = body;
	}

	setHeader(name: string, value: string | number): void {
		this.headers.set(name, value);
	}

	destroy(error?: Error): void {
		this.destroyCount++;
		this.destroyError = error;
		if (error !== undefined) {
			queueMicrotask(() => {
				this.emit('error', error);
				this.emit('close');
			});
		}
		this.onDestroy?.(error);
	}
}

function createHttpHarness(): {
	readonly request: FakeRequest;
	readonly factory: IParadisMcpHttpRequestFactory;
	respond(status?: number): FakeResponse;
} {
	const request = new FakeRequest();
	let onResponse: ((response: FakeResponse) => void) | undefined;
	return {
		request,
		factory: ((_options: unknown, callback: unknown) => {
			onResponse = callback as (response: FakeResponse) => void;
			return request;
		}) as unknown as IParadisMcpHttpRequestFactory,
		respond: (status = 200) => {
			const response = new FakeResponse(status);
			onResponse?.(response);
			return response;
		},
	};
}

suite('ParadisBrowserMcpShimCore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts only positive integer port and pid records', () => {
		assert.deepStrictEqual(parseParadisMcpPortFile(JSON.stringify(OLD_OWNER)), OLD_OWNER);
		for (const raw of [
			'not json',
			'null',
			'[]',
			'{}',
			JSON.stringify({ ...OLD_OWNER, protocolVersion: 0 }),
			JSON.stringify({ ...OLD_OWNER, port: 0 }),
			JSON.stringify({ ...OLD_OWNER, port: -1 }),
			JSON.stringify({ ...OLD_OWNER, port: 1.5 }),
			JSON.stringify({ ...OLD_OWNER, port: 65_536 }),
			JSON.stringify({ ...OLD_OWNER, pid: 0 }),
			JSON.stringify({ ...OLD_OWNER, pid: -1 }),
			JSON.stringify({ ...OLD_OWNER, pid: 1.5 }),
			JSON.stringify({ ...OLD_OWNER, pid: Number.MAX_SAFE_INTEGER + 1 }),
			JSON.stringify({ ...OLD_OWNER, instanceId: '' }),
			JSON.stringify({ ...OLD_OWNER, instanceId: 'not-a-uuid' }),
			JSON.stringify({ ...OLD_OWNER, serviceStartedAt: 0 }),
		]) {
			assert.throws(() => parseParadisMcpPortFile(raw), /Invalid MCP port file/);
		}
		assert.throws(() => parseParadisMcpPortFile('{"port":47286,"pid":123}'), /Invalid MCP port file/);
		assert.throws(() => parseParadisMcpPortFile(JSON.stringify({ ...OLD_OWNER, extra: true })), /Invalid MCP port file/);
		assert.throws(() => parseParadisMcpPortFile(' '.repeat(PARADIS_MCP_MAX_PORT_FILE_BYTES + 1)), /port file.*bytes|too large/i);
	});

	test('bounds stdio lines before newline and rejects an incomplete EOF frame', () => {
		const buffer = new ParadisMcpStdioLineBuffer();
		buffer.append('x'.repeat(PARADIS_MCP_MAX_REQUEST_BYTES));
		assert.strictEqual(buffer.takeLine(), undefined);
		assert.throws(() => buffer.append('x'), /request.*bytes|too large/i);

		const complete = new ParadisMcpStdioLineBuffer();
		complete.append(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
		assert.match(complete.takeLine() ?? '', /"method":"ping"/);
		assert.doesNotThrow(() => complete.finish());

		const incomplete = new ParadisMcpStdioLineBuffer();
		incomplete.append('{"jsonrpc":"2.0"');
		assert.throws(() => incomplete.finish(), /incomplete|EOF/i);
	});

	test('rejects a one-byte fragmentation attack after bounded pending fragments', () => {
		const buffer = new ParadisMcpStdioLineBuffer();
		for (let index = 0; index < PARADIS_MCP_MAX_STDIN_FRAGMENTS; index++) {
			buffer.append('x');
		}
		assert.throws(() => buffer.append('x'), new RegExp(`fragment capacity.*${PARADIS_MCP_MAX_STDIN_FRAGMENTS}`, 'i'));
	});

	test('releases fragmented capacity after draining a line', () => {
		const buffer = new ParadisMcpStdioLineBuffer();
		for (let index = 1; index < PARADIS_MCP_MAX_STDIN_FRAGMENTS; index++) {
			buffer.append('x');
		}
		buffer.append('\n');
		assert.strictEqual(buffer.takeLine(), 'x'.repeat(PARADIS_MCP_MAX_STDIN_FRAGMENTS - 1));
		for (let index = 0; index < PARADIS_MCP_MAX_STDIN_FRAGMENTS; index++) {
			buffer.append(index === PARADIS_MCP_MAX_STDIN_FRAGMENTS - 1 ? '\n' : 'y');
		}
		assert.strictEqual(buffer.takeLine(), 'y'.repeat(PARADIS_MCP_MAX_STDIN_FRAGMENTS - 1));
		assert.doesNotThrow(() => buffer.finish());
	});

	test('frames multiple UTF-8 lines across chunks without counting characters as bytes', () => {
		const buffer = new ParadisMcpStdioLineBuffer();
		buffer.append('  {"text":"あ');
		buffer.append('いう"}\n{"text":"えお"}\n  ');
		assert.strictEqual(buffer.takeLine(), '{"text":"あいう"}');
		assert.strictEqual(buffer.takeLine(), '{"text":"えお"}');
		assert.strictEqual(buffer.hasCompleteLine, false);
		assert.doesNotThrow(() => buffer.finish());
	});

	test('keeps independent 4 MiB line and 8 MiB pending-buffer byte caps', () => {
		const buffer = new ParadisMcpStdioLineBuffer();
		buffer.append(`${'x'.repeat(PARADIS_MCP_MAX_REQUEST_BYTES)}\n`);
		buffer.append('y'.repeat(PARADIS_MCP_MAX_REQUEST_BYTES - 1));
		assert.throws(() => buffer.append('z'), /stdin buffer.*bytes/i);
		assert.strictEqual(buffer.takeLine()?.length, PARADIS_MCP_MAX_REQUEST_BYTES);
		assert.throws(() => buffer.append('yz'), /request.*bytes/i);
	});

	test('bounds inflight work and signals capacity exactly when a tracked request settles', async () => {
		let capacitySignals = 0;
		const tracker = new ParadisMcpInflightTracker(2, () => capacitySignals++);
		let finishFirst!: () => void;
		let finishSecond!: () => void;
		const first = new Promise<void>(resolve => finishFirst = resolve);
		const second = new Promise<void>(resolve => finishSecond = resolve);
		assert.strictEqual(tracker.track(first), true);
		assert.strictEqual(tracker.track(second), true);
		assert.strictEqual(tracker.hasCapacity, false);
		assert.strictEqual(tracker.track(Promise.resolve()), false);

		finishFirst();
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(tracker.hasCapacity, true);
		assert.strictEqual(capacitySignals, 1);
		finishSecond();
		await tracker.waitForSettled();
		assert.strictEqual(tracker.size, 0);
		assert.strictEqual(PARADIS_MCP_MAX_INFLIGHT_REQUESTS, 8);
	});

	test('serializes stdout writes and retains inflight backpressure until callback and drain', async () => {
		const output = new FakeStdioWritable();
		output.writeResults.push(false, true);
		const backpressure: boolean[] = [];
		const writer = new ParadisMcpStdioWriter(output, {
			maximumQueuedBytes: 16,
			onDidChangeBackpressure: value => backpressure.push(value),
		});
		let firstSettled = false;
		const first = writer.write('first').then(() => firstSettled = true);
		const second = writer.write('second');

		assert.deepStrictEqual(output.writes, ['first']);
		assert.strictEqual(writer.isBackpressured, true);
		assert.strictEqual(paradisMcpShouldPauseStdin(true, writer.isBackpressured), true);
		output.completeNext();
		await Promise.resolve();
		assert.strictEqual(firstSettled, false, 'write callback alone must not release a backpressured request');
		output.emit('drain');
		await first;
		assert.deepStrictEqual(output.writes, ['first', 'second']);
		assert.strictEqual(writer.isBackpressured, false);
		output.completeNext();
		await second;
		await writer.end();
		assert.deepStrictEqual(backpressure, [true, false]);
	});

	test('fails closed when the aggregate stdout queue exceeds its byte cap', async () => {
		const output = new FakeStdioWritable();
		output.writeResults.push(false);
		const failures: Error[] = [];
		const writer = new ParadisMcpStdioWriter(output, {
			maximumQueuedBytes: 5,
			onError: error => failures.push(error),
		});
		const first = writer.write('abcd');
		const overflow = writer.write('ef');

		await assert.rejects(overflow, /stdout queue exceeded 5 bytes/i);
		assert.strictEqual(failures.length, 1);
		output.completeNext();
		output.emit('drain');
		await first;
		await writer.end();
		assert.strictEqual(PARADIS_MCP_MAX_STDOUT_QUEUE_BYTES >= PARADIS_MCP_MAX_RESPONSE_BYTES, true);
	});

	test('settles every active and queued stdout write on stream error or close', async () => {
		for (const terminal of ['error', 'close'] as const) {
			const output = new FakeStdioWritable();
			output.writeResults.push(false);
			const writer = new ParadisMcpStdioWriter(output, { maximumQueuedBytes: 16 });
			const first = writer.write('first');
			const second = writer.write('second');
			if (terminal === 'error') {
				output.emit('error', new Error('stdout failed'));
			} else {
				output.emit('close');
			}
			await assert.rejects(first, terminal === 'error' ? /stdout failed/ : /stdout.*closed/i);
			await assert.rejects(second, terminal === 'error' ? /stdout failed/ : /stdout.*closed/i);
			await writer.end();
		}
	});

	test('pauses stdin for either inflight saturation or stdout backpressure', () => {
		assert.strictEqual(paradisMcpShouldPauseStdin(true, false), false);
		assert.strictEqual(paradisMcpShouldPauseStdin(false, false), true);
		assert.strictEqual(paradisMcpShouldPauseStdin(true, true), true);
	});

	test('interprets PID liveness errors without treating unexpected failures as healthy', () => {
		assert.strictEqual(isParadisMcpProcessAlive(123, () => true), true);
		assert.strictEqual(isParadisMcpProcessAlive(123, () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }), false);
		assert.strictEqual(isParadisMcpProcessAlive(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
		assert.throws(
			() => isParadisMcpProcessAlive(123, () => { throw Object.assign(new Error('probe failed'), { code: 'EIO' }); }),
			/probe failed/,
		);
	});

	test('re-reads once after a stale PID and returns the live replacement', () => {
		const reads = [JSON.stringify(OLD_OWNER), JSON.stringify(NEW_OWNER)];
		const probed: number[] = [];
		const record = resolveLiveParadisMcpPortFile('/tmp/para-mcp.json', {
			readFile: () => reads.shift()!,
			isProcessAlive: pid => {
				probed.push(pid);
				return pid === 102;
			},
		});
		assert.deepStrictEqual(record, NEW_OWNER);
		assert.deepStrictEqual(probed, [101, 102]);
		assert.strictEqual(reads.length, 0);
	});

	test('rejects after at most two stale or invalid reads', () => {
		let reads = 0;
		assert.throws(() => resolveLiveParadisMcpPortFile('/tmp/para-mcp.json', {
			readFile: () => {
				reads++;
				return reads === 1 ? JSON.stringify(OLD_OWNER) : JSON.stringify({ ...NEW_OWNER, port: 0 });
			},
			isProcessAlive: () => false,
		}), /Invalid MCP port file/);
		assert.strictEqual(reads, 2);

		reads = 0;
		assert.throws(() => resolveLiveParadisMcpPortFile('/tmp/para-mcp.json', {
			readFile: () => {
				reads++;
				return JSON.stringify(reads === 1 ? OLD_OWNER : NEW_OWNER);
			},
			isProcessAlive: () => false,
		}), /not running/);
		assert.strictEqual(reads, 2);
	});

	test('connect timeout destroys once and cleans timers and listeners', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		assert.deepStrictEqual([...timers.delays].sort((a, b) => a - b), [PARADIS_MCP_CONNECT_TIMEOUT_MS, PARADIS_MCP_OVERALL_TIMEOUT_MS]);
		assert.strictEqual(timers.fire(PARADIS_MCP_HEALTH_TIMEOUT_MS), true);
		await assert.rejects(pending, /connect timeout.*5000ms/i);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.match(harness.request.destroyError?.message ?? '', /connect timeout.*5000ms/i);
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.listenerCount('error'), 0);
		assert.strictEqual(harness.request.listenerCount('close'), 0);
		assert.strictEqual(harness.request.listenerCount('socket'), 0);
	});

	test('connected requests are allowed beyond 300 seconds but stop at 310 seconds', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		harness.request.emit('socket', harness.request.socket);
		harness.request.socket.connecting = false;
		harness.request.socket.emit('connect');
		assert.strictEqual(timers.fire(300_000), false);
		assert.deepStrictEqual(timers.delays, [PARADIS_MCP_OVERALL_TIMEOUT_MS]);
		assert.strictEqual(timers.fire(PARADIS_MCP_OVERALL_TIMEOUT_MS), true);
		await assert.rejects(pending, /overall timeout.*310000ms/i);
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('response end settles once and removes all request, response, socket, and timer resources', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{"id":1}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		harness.request.socket.connecting = false;
		harness.request.emit('socket', harness.request.socket);
		const response = harness.respond(200);
		response.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'));
		response.complete = true;
		response.emit('end');
		assert.deepStrictEqual(await pending, { status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
		response.emit('close');
		assert.strictEqual(harness.request.endedBody, '{"id":1}');
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.eventNames().length, 0);
		assert.strictEqual(response.eventNames().length, 0);
		assert.strictEqual(harness.request.socket.eventNames().length, 0);
	});

	test('rejects an oversized request before allocating a socket', async () => {
		let factoryCalls = 0;
		await assert.rejects(() => postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: 'x'.repeat(PARADIS_MCP_MAX_REQUEST_BYTES + 1),
			token: 'secret',
			request: (() => { factoryCalls++; throw new Error('must not allocate'); }) as unknown as IParadisMcpHttpRequestFactory,
		}), /request.*bytes|too large/i);
		assert.strictEqual(factoryCalls, 0);
	});

	test('destroys and settles an HTTP response immediately at the explicit screenshot-safe cap', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const response = harness.respond();
		response.emit('data', Buffer.alloc(PARADIS_MCP_MAX_RESPONSE_BYTES));
		response.emit('data', Buffer.from('x'));
		await assert.rejects(pending, /response.*bytes|too large/i);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.listenerCount('socket'), 0);
	});

	test('rejects adversarially fragmented responses before chunk bookkeeping becomes quadratic', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const response = harness.respond();
		for (let index = 0; index <= 4_096; index++) {
			response.emit('data', Buffer.from('x'));
		}
		response.complete = true;
		response.emit('end');

		await assert.rejects(pending, /fragment|chunk.*capacity/i);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('an incomplete response close rejects immediately instead of waiting for the overall timeout', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const response = harness.respond();
		response.emit('close');
		queueMicrotask(() => harness.request.emit('close'));
		await assert.rejects(pending, /response closed before completion/i);
		await Promise.resolve();
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.eventNames().length, 0);
		assert.strictEqual(response.eventNames().length, 0);
	});

	test('response and request errors settle once and clean resources', async () => {
		for (const source of ['response', 'request'] as const) {
			const harness = createHttpHarness();
			const timers = new FakeTimers();
			const pending = postParadisMcpRequestOnVerifiedSocket({
				port: 41001,
				body: '{}',
				token: 'secret',
				request: harness.factory,
				setTimeout: timers.setTimeout,
				clearTimeout: timers.clearTimeout,
			});
			const response = source === 'response' ? harness.respond() : undefined;
			(source === 'response' ? response! : harness.request).emit('error', new Error(`${source} failed`));
			queueMicrotask(() => {
				if (response !== undefined) {
					harness.request.emit('error', new Error('late request transport error'));
					response.emit('close');
				}
				harness.request.emit('close');
			});
			await assert.rejects(pending, new RegExp(`${source} failed`));
			await Promise.resolve();
			assert.deepStrictEqual(timers.delays, []);
			assert.strictEqual(harness.request.eventNames().length, 0);
			assert.strictEqual(response?.eventNames().length ?? 0, 0);
		}
	});

	test('a synchronous request.end failure destroys and guards the partially created request', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		harness.request.endError = new Error('end failed');
		await assert.rejects(() => postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		}), /end failed/);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.strictEqual(harness.request.destroyError, harness.request.endError);
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.eventNames().length, 0);
	});

	test('an aborted response does not wait for the overall timeout', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const response = harness.respond();
		response.emit('aborted');
		queueMicrotask(() => {
			harness.request.emit('error', new Error('late request reset'));
			response.emit('error', new Error('late response reset'));
			response.emit('close');
			harness.request.emit('close');
		});
		await assert.rejects(pending, /response aborted/i);
		await Promise.resolve();
		assert.deepStrictEqual(timers.delays, []);
		assert.strictEqual(harness.request.eventNames().length, 0);
		assert.strictEqual(response.eventNames().length, 0);
	});

	test('overall timeout guards delayed response errors caused by request destruction', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		const response = harness.respond();
		harness.request.onDestroy = error => queueMicrotask(() => {
			response.emit('error', error ?? new Error('response destroyed'));
			response.emit('close');
		});
		assert.strictEqual(timers.fire(PARADIS_MCP_OVERALL_TIMEOUT_MS), true);
		await assert.rejects(pending, /overall timeout.*310000ms/i);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.strictEqual(harness.request.eventNames().length, 0);
		assert.strictEqual(response.eventNames().length, 0);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('a response arriving after timeout is drained and guarded through its delayed error and close', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = postParadisMcpRequestOnVerifiedSocket({
			port: 41001,
			body: '{}',
			token: 'secret',
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		assert.strictEqual(timers.fire(PARADIS_MCP_CONNECT_TIMEOUT_MS), true);
		await assert.rejects(pending, /connect timeout.*5000ms/i);
		await Promise.resolve();

		const lateResponse = harness.respond();
		assert.strictEqual(lateResponse.resumeCount, 1);
		assert.doesNotThrow(() => lateResponse.emit('error', new Error('late response error')));
		lateResponse.emit('aborted');
		lateResponse.emit('close');
		assert.strictEqual(lateResponse.eventNames().length, 0);
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('notifications and empty accepted responses do not emit stdout payloads', () => {
		assert.strictEqual(shouldEmitParadisMcpHttpResponse(202, '{"jsonrpc":"2.0"}'), false);
		assert.strictEqual(shouldEmitParadisMcpHttpResponse(200, ''), false);
		assert.strictEqual(shouldEmitParadisMcpHttpResponse(200, '   '), false);
		assert.strictEqual(shouldEmitParadisMcpHttpResponse(200, '{"jsonrpc":"2.0"}', false), false);
		assert.strictEqual(shouldEmitParadisMcpHttpResponse(200, '{"jsonrpc":"2.0"}'), true);
	});

	test('stdin completion waits for already tracked forwarding work', async () => {
		const tracker = new ParadisMcpInflightTracker();
		let finish!: () => void;
		const forwarding = new Promise<void>(resolve => finish = resolve);
		tracker.track(forwarding);
		let completed = false;
		const completion = tracker.waitForSettled().then(() => completed = true);
		await Promise.resolve();
		assert.strictEqual(completed, false);
		finish();
		await completion;
		assert.strictEqual(completed, true);
	});

	test('health timeout destroys its request and releases timer and listeners', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = probeParadisMcpInstance(OLD_OWNER, {
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		assert.strictEqual(timers.fire(PARADIS_MCP_CONNECT_TIMEOUT_MS), true);
		await assert.rejects(pending, /health timeout.*5000ms/i);
		await Promise.resolve();
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.strictEqual(harness.request.eventNames().length, 0);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('a health response arriving after timeout is drained and guarded through close', async () => {
		const harness = createHttpHarness();
		const timers = new FakeTimers();
		const pending = probeParadisMcpInstance(OLD_OWNER, {
			request: harness.factory,
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout,
		});
		assert.strictEqual(timers.fire(PARADIS_MCP_HEALTH_TIMEOUT_MS), true);
		await assert.rejects(pending, /health timeout.*5000ms/i);
		await Promise.resolve();

		const lateResponse = harness.respond();
		assert.strictEqual(lateResponse.resumeCount, 1);
		assert.doesNotThrow(() => lateResponse.emit('error', new Error('late health response error')));
		lateResponse.emit('aborted');
		lateResponse.emit('close');
		assert.strictEqual(lateResponse.eventNames().length, 0);
		assert.strictEqual(harness.request.destroyCount, 1);
		assert.deepStrictEqual(timers.delays, []);
	});

	test('live PID with a mismatched health identity receives neither bearer token nor request body', async () => {
		const fixture = await startHealthTestServer(OLD_OWNER);
		const expectedOwner = { ...NEW_OWNER, port: fixture.port, pid: process.pid };
		try {
			await assert.rejects(() => postParadisMcpRequest({
				record: expectedOwner,
				body: '{"secret":"request-body"}',
				token: 'secret-bearer-token',
			}), /health identity mismatch/i);
			assert.deepStrictEqual(fixture.requests, [{ method: 'GET', authorization: undefined, body: '' }]);
		} finally {
			await closeHealthTestServer(fixture.server);
		}
	});

	test('socket replacement after a valid health probe sends neither bearer token nor request body', async () => {
		const fixture = await startHealthTestServer(NEW_OWNER, true);
		const expectedOwner = { ...NEW_OWNER, port: fixture.port, pid: process.pid };
		try {
			await assert.rejects(() => postParadisMcpRequest({
				record: expectedOwner,
				body: '{"secret":"request-body"}',
				token: 'secret-bearer-token',
			}), /verified health socket was replaced/i);
			assert.strictEqual(fixture.connectionCount(), 1, 'replacement socket was destroyed before it connected');
			assert.deepStrictEqual(fixture.requests, [{ method: 'GET', authorization: undefined, body: '' }]);
		} finally {
			await closeHealthTestServer(fixture.server);
		}
	});

	test('standalone shim flushes a large response before naturally exiting after stdin end', async function () {
		this.timeout(20_000);
		const { createServer } = await import('http');
		const payload = 'x'.repeat(16 * 1024 * 1024);
		const responseBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { payload } });
		const server = createServer((request, response) => {
			request.resume();
			if (request.method === 'GET' && request.url === PARADIS_MCP_HEALTH_PATH) {
				const healthBody = JSON.stringify({
					protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
					instanceId: NEW_OWNER.instanceId,
					serviceStartedAt: NEW_OWNER.serviceStartedAt,
				});
				response.writeHead(200, {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(healthBody),
				});
				response.end(healthBody);
				return;
			}
			response.writeHead(200, {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(responseBody),
			});
			response.end(responseBody);
		});
		const temporaryDirectory = await fs.mkdtemp(join(tmpdir(), 'paradis-mcp-shim-'));
		let child: ChildProcessWithoutNullStreams | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.removeListener('listening', onListening);
					reject(error);
				};
				const onListening = () => {
					server.removeListener('error', onError);
					resolve();
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(0, '127.0.0.1');
			});
			const address = server.address();
			assert.ok(address && typeof address !== 'string');
			const portFile = join(temporaryDirectory, 'paradis-browser-mcp.json');
			await fs.writeFile(portFile, JSON.stringify({
				...NEW_OWNER,
				port: address.port,
				pid: process.pid,
			}));

			child = spawn(process.execPath, ['out/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js'], {
				cwd: process.cwd(),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: '1',
					PARA_CODE_MCP_PORT_FILE: portFile,
					PARA_CODE_TERMINAL_PANE_ID: 'integration-pane-token',
				},
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
			let timedOut = false;
			const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(resolve => {
				child!.once('close', (code, signal) => resolve({ code, signal }));
			});
			const timeout = setTimeout(() => {
				timedOut = true;
				child?.kill();
			}, 15_000);
			child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
			const result = await closed;
			clearTimeout(timeout);

			assert.strictEqual(timedOut, false, 'shim child timed out before closing');
			assert.deepStrictEqual(result, { code: 0, signal: null });
			assert.strictEqual(Buffer.concat(stderr).toString('utf8'), '');
			const output = Buffer.concat(stdout).toString('utf8').trim();
			const parsed = JSON.parse(output) as { result?: { payload?: unknown } };
			assert.strictEqual(parsed.result?.payload, payload);
		} finally {
			if (child !== undefined && child.exitCode === null && child.signalCode === null) {
				child.kill();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	test('publishes the port file via a same-directory temporary file and atomic rename', async () => {
		const operations: string[] = [];
		await writeParadisMcpPortFileAtomic('/state/para-mcp.json', OLD_OWNER, {
			createTemporaryPath: target => `${target}.temp`,
			writeFile: async (path, contents) => { operations.push(`write:${path}:${contents}`); },
			rename: async (from, to) => { operations.push(`rename:${from}:${to}`); },
			unlink: async path => { operations.push(`unlink:${path}`); },
		});
		assert.deepStrictEqual(operations, [
			`write:/state/para-mcp.json.temp:${JSON.stringify(OLD_OWNER)}`,
			'rename:/state/para-mcp.json.temp:/state/para-mcp.json',
		]);
	});

	test('cleans the temporary port file while preserving a publish failure', async () => {
		const operations: string[] = [];
		await assert.rejects(() => writeParadisMcpPortFileAtomic('/state/para-mcp.json', OLD_OWNER, {
			createTemporaryPath: target => `${target}.temp`,
			writeFile: async path => { operations.push(`write:${path}`); },
			rename: async (from, to) => { operations.push(`rename:${from}:${to}`); throw new Error('rename failed'); },
			unlink: async path => { operations.push(`unlink:${path}`); },
		}), /rename failed/);
		assert.deepStrictEqual(operations, [
			'write:/state/para-mcp.json.temp',
			'rename:/state/para-mcp.json.temp:/state/para-mcp.json',
			'unlink:/state/para-mcp.json.temp',
		]);
	});

	test('cleans a temporary file after write failure too', async () => {
		const operations: string[] = [];
		await assert.rejects(() => writeParadisMcpPortFileAtomic('/state/para-mcp.json', OLD_OWNER, {
			createTemporaryPath: target => `${target}.temp`,
			writeFile: async path => { operations.push(`write:${path}`); throw new Error('write failed'); },
			rename: async (from, to) => { operations.push(`rename:${from}:${to}`); },
			unlink: async path => { operations.push(`unlink:${path}`); },
		}), /write failed/);
		assert.deepStrictEqual(operations, [
			'write:/state/para-mcp.json.temp',
			'unlink:/state/para-mcp.json.temp',
		]);
	});

	test('a disposed publisher cancels before rename and removes its temporary file', async () => {
		const operations: string[] = [];
		const published = await writeParadisMcpPortFileAtomic('/state/para-mcp.json', OLD_OWNER, {
			createTemporaryPath: target => `${target}.temp`,
			writeFile: async path => { operations.push(`write:${path}`); },
			rename: async (from, to) => { operations.push(`rename:${from}:${to}`); },
			unlink: async path => { operations.push(`unlink:${path}`); },
			shouldPublish: () => false,
		});
		assert.strictEqual(published, false);
		assert.deepStrictEqual(operations, [
			'write:/state/para-mcp.json.temp',
			'unlink:/state/para-mcp.json.temp',
		]);
	});

	test('new owner reclaims an old delayed rename and old owner does not fight the newer live owner', async () => {
		const files = new Map<string, string>();
		const targetPath = '/state/para-mcp.json';
		let releaseOldWrite!: () => void;
		let oldTemporaryWritten!: () => void;
		const oldWriteReleased = new Promise<void>(resolve => releaseOldWrite = resolve);
		const oldTemporaryReady = new Promise<void>(resolve => oldTemporaryWritten = resolve);
		const oldPublish = writeParadisMcpPortFileAtomic(targetPath, OLD_OWNER, {
			createTemporaryPath: target => `${target}.old-temp`,
			writeFile: async (path, contents) => {
				files.set(path, contents);
				oldTemporaryWritten();
				await oldWriteReleased;
			},
			rename: async (from, to) => { files.set(to, files.get(from)!); },
			unlink: async path => { files.delete(path); },
		});
		await oldTemporaryReady;

		await writeParadisMcpPortFileAtomic(targetPath, NEW_OWNER, {
			createTemporaryPath: target => `${target}.new-temp`,
			writeFile: async (path, contents) => { files.set(path, contents); },
			rename: async (from, to) => { files.set(to, files.get(from)!); },
			unlink: async path => { files.delete(path); },
		});
		const newIntervals = new FakeIntervals();
		let newRepublishCount = 0;
		const newOwner = new ParadisMcpPortFileReconciler(targetPath, NEW_OWNER, {
			readFile: async path => files.get(path)!,
			isOwnerHealthy: async () => true,
			publish: async (_path, record, shouldPublish) => {
				if (!shouldPublish()) {
					return false;
				}
				newRepublishCount++;
				files.set(targetPath, JSON.stringify(record));
				return true;
			},
			setInterval: newIntervals.setInterval,
			clearInterval: newIntervals.clearInterval,
		});
		await newOwner.start();
		assert.strictEqual(newRepublishCount, 0);

		releaseOldWrite();
		await oldPublish;
		assert.deepStrictEqual(parseParadisMcpPortFile(files.get(targetPath)!), OLD_OWNER);
		await newIntervals.fire();
		await newOwner.whenIdle();
		assert.deepStrictEqual(parseParadisMcpPortFile(files.get(targetPath)!), NEW_OWNER);
		assert.strictEqual(newRepublishCount, 1);

		const oldIntervals = new FakeIntervals();
		let oldRepublishCount = 0;
		const oldOwner = new ParadisMcpPortFileReconciler(targetPath, OLD_OWNER, {
			readFile: async path => files.get(path)!,
			isOwnerHealthy: async () => true,
			publish: async () => { oldRepublishCount++; return true; },
			setInterval: oldIntervals.setInterval,
			clearInterval: oldIntervals.clearInterval,
		});
		await oldOwner.start();
		await oldIntervals.fire();
		await oldOwner.whenIdle();
		assert.strictEqual(oldRepublishCount, 0);

		newOwner.dispose();
		oldOwner.dispose();
		assert.strictEqual(newIntervals.clearCount, 1);
		assert.strictEqual(oldIntervals.clearCount, 1);
	});

	test('reconciler does not yield to a newer record whose health identity cannot be proven', async () => {
		let fixed = JSON.stringify(NEW_OWNER);
		let publishCount = 0;
		const reconciler = new ParadisMcpPortFileReconciler('/state/para-mcp.json', OLD_OWNER, {
			readFile: async () => fixed,
			isOwnerHealthy: async () => false,
			publish: async (_path, record, shouldPublish) => {
				assert.strictEqual(shouldPublish(), true);
				publishCount++;
				fixed = JSON.stringify(record);
				return true;
			},
		});
		await reconciler.start();
		assert.strictEqual(publishCount, 1);
		assert.deepStrictEqual(parseParadisMcpPortFile(fixed), OLD_OWNER);
		reconciler.dispose();
	});

	test('periodic reconciliation is single-flight and disposal clears its interval', async () => {
		const intervals = new FakeIntervals();
		let releaseRead!: () => void;
		const readGate = new Promise<void>(resolve => releaseRead = resolve);
		let readCount = 0;
		let activeReads = 0;
		let maxActiveReads = 0;
		let publishCount = 0;
		const reconciler = new ParadisMcpPortFileReconciler('/state/para-mcp.json', NEW_OWNER, {
			readFile: async () => {
				readCount++;
				activeReads++;
				maxActiveReads = Math.max(maxActiveReads, activeReads);
				if (readCount > 1) {
					await readGate;
				}
				activeReads--;
				return JSON.stringify(readCount === 1 ? NEW_OWNER : OLD_OWNER);
			},
			isOwnerHealthy: async () => true,
			publish: async () => { publishCount++; return true; },
			setInterval: intervals.setInterval,
			clearInterval: intervals.clearInterval,
		});
		await reconciler.start();
		intervals.fireNow();
		intervals.fireNow();
		await Promise.resolve();
		assert.strictEqual(readCount, 2);
		assert.strictEqual(maxActiveReads, 1);
		releaseRead();
		await reconciler.whenIdle();
		assert.strictEqual(publishCount, 1);
		reconciler.dispose();
		assert.strictEqual(intervals.clearCount, 1);
	});

	test('shared process disposal does not unlink the fixed port file', async () => {
		const source = await fs.readFile('src/vs/paradis/contrib/agentBrowser/node/paradisAgentBrowserService.ts', 'utf8');
		const dispose = source.slice(source.indexOf('\toverride dispose(): void {'), source.indexOf('\n\t}\n}', source.indexOf('\toverride dispose(): void {')));
		assert.doesNotMatch(dispose, /unlink(?:Sync)?\s*\(/);
		assert.match(source, /shouldPublish:\s*\(\)\s*=>\s*!this\._store\.isDisposed/);
	});
});

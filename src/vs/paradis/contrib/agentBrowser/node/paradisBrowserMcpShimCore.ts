/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Keep this module limited to Node built-ins: paradisBrowserMcpShim runs as a standalone node script.

import type * as http from 'http';
import { randomUUID } from 'crypto';
import { closeSync, openSync, promises as fs, readSync } from 'fs';

export const PARADIS_MCP_CONNECT_TIMEOUT_MS = 5_000;
export const PARADIS_MCP_HEALTH_TIMEOUT_MS = 5_000;
export const PARADIS_MCP_OVERALL_TIMEOUT_MS = 310_000;
export const PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION = 1;
export const PARADIS_MCP_HEALTH_PATH = '/paradis-mcp/health';
export const PARADIS_MCP_RECORD_RECONCILE_INTERVAL_MS = 1_000;
export const PARADIS_MCP_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const PARADIS_MCP_MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
export const PARADIS_MCP_MAX_PORT_FILE_BYTES = 16 * 1024;
// One standalone shim owns exactly one pane token. Match the server's per-token ingress cap so
// the shim applies flow control before the ninth request would be rejected with HTTP 429.
export const PARADIS_MCP_MAX_INFLIGHT_REQUESTS = 8;
export const PARADIS_MCP_MAX_STDIN_FRAGMENTS = 4_096;
// Preserve two maximum-size responses plus bounded serialization overhead. Exceeding this cap is
// terminal for new input, while already accepted stdout writes are still flushed in order.
export const PARADIS_MCP_MAX_STDOUT_QUEUE_BYTES = (PARADIS_MCP_MAX_RESPONSE_BYTES * 2) + PARADIS_MCP_MAX_REQUEST_BYTES;

const PARADIS_MCP_MAX_STDIN_BUFFER_BYTES = PARADIS_MCP_MAX_REQUEST_BYTES * 2;
const PARADIS_MCP_MAX_RESPONSE_CHUNKS = 4_096;

export interface IParadisMcpPortFileRecord {
	readonly protocolVersion: typeof PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION;
	readonly port: number;
	readonly pid: number;
	readonly instanceId: string;
	readonly serviceStartedAt: number;
}

export type IParadisMcpHttpRequestFactory = typeof http.request;

interface IParadisMcpPortFileResolverOptions {
	readonly readFile?: (path: string) => string;
	readonly isProcessAlive?: (pid: number) => boolean;
}

interface IParadisMcpStdinFragment {
	readonly value: string;
	offset: number;
}

export interface IParadisMcpStdioWritable {
	write(chunk: string, callback: (error?: Error | null) => void): boolean;
	once(event: 'drain', listener: () => void): unknown;
	once(event: 'error', listener: (error: Error) => void): unknown;
	once(event: 'close', listener: () => void): unknown;
	removeListener(event: 'drain', listener: () => void): unknown;
	removeListener(event: 'error', listener: (error: Error) => void): unknown;
	removeListener(event: 'close', listener: () => void): unknown;
}

export interface IParadisMcpStdioWriterOptions {
	readonly maximumQueuedBytes?: number;
	readonly onDidChangeBackpressure?: (backpressured: boolean) => void;
	readonly onError?: (error: Error) => void;
}

interface IParadisMcpStdioWrite {
	readonly value: string;
	readonly byteLength: number;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

/** Byte-bounded, ordered stdout serialization for the standalone MCP shim. */
export class ParadisMcpStdioWriter {
	private readonly maximumQueuedBytes: number;
	private readonly onDidChangeBackpressure: (backpressured: boolean) => void;
	private readonly onError: (error: Error) => void;
	private readonly queue: IParadisMcpStdioWrite[] = [];
	private readonly settlementWaiters: Array<() => void> = [];
	private active: IParadisMcpStdioWrite | undefined;
	private activeDrainListener: (() => void) | undefined;
	private queuedBytes = 0;
	private accepting = true;
	private terminalError: Error | undefined;
	private backpressured = false;
	private listenersInstalled = true;

	constructor(
		private readonly output: IParadisMcpStdioWritable,
		options: IParadisMcpStdioWriterOptions = {},
	) {
		this.maximumQueuedBytes = options.maximumQueuedBytes ?? PARADIS_MCP_MAX_STDOUT_QUEUE_BYTES;
		if (!Number.isSafeInteger(this.maximumQueuedBytes) || this.maximumQueuedBytes <= 0) {
			throw new RangeError('maximumQueuedBytes must be a positive safe integer');
		}
		this.onDidChangeBackpressure = options.onDidChangeBackpressure ?? (() => undefined);
		this.onError = options.onError ?? (() => undefined);
		this.output.once('error', this.handleOutputError);
		this.output.once('close', this.handleOutputClose);
	}

	get isBackpressured(): boolean {
		return this.backpressured;
	}

	write(value: string): Promise<void> {
		if (!this.accepting) {
			return Promise.reject(this.terminalError ?? new Error('Para Code MCP stdout writer is closed'));
		}
		const byteLength = Buffer.byteLength(value);
		if (byteLength > this.maximumQueuedBytes || this.queuedBytes + byteLength > this.maximumQueuedBytes) {
			const error = new Error(`Para Code MCP stdout queue exceeded ${this.maximumQueuedBytes} bytes`);
			this.stopAccepting(error, false);
			return Promise.reject(error);
		}
		return new Promise<void>((resolve, reject) => {
			this.queue.push({ value, byteLength, resolve, reject });
			this.queuedBytes += byteLength;
			this.pump();
		});
	}

	async end(): Promise<void> {
		this.accepting = false;
		if (!this.active && this.queue.length === 0) {
			this.finishSettlement();
			return;
		}
		await new Promise<void>(resolve => this.settlementWaiters.push(resolve));
	}

	private readonly handleOutputError = (error: Error): void => {
		this.stopAccepting(error, true);
	};

	private readonly handleOutputClose = (): void => {
		this.stopAccepting(new Error('Para Code MCP stdout closed before queued responses settled'), true);
	};

	private stopAccepting(error: Error, rejectAcceptedWrites: boolean): void {
		if (this.terminalError) {
			return;
		}
		this.accepting = false;
		this.terminalError = error;
		try {
			this.onError(error);
		} catch {
			// Output failure handling must not prevent accepted write settlement.
		}
		if (!rejectAcceptedWrites) {
			return;
		}
		if (this.activeDrainListener) {
			this.output.removeListener('drain', this.activeDrainListener);
			this.activeDrainListener = undefined;
		}
		this.setBackpressured(false);
		const accepted = this.active ? [this.active, ...this.queue] : [...this.queue];
		this.active = undefined;
		this.queue.length = 0;
		this.queuedBytes = 0;
		for (const entry of accepted) {
			entry.reject(error);
		}
		this.finishSettlement();
	}

	private pump(): void {
		if (this.active) {
			return;
		}
		const entry = this.queue.shift();
		if (!entry) {
			this.finishSettlement();
			return;
		}
		this.active = entry;
		let writeReturned = false;
		let callbackSettled = false;
		let drainSettled = false;
		const trySettle = () => {
			if (!writeReturned || !callbackSettled || !drainSettled || this.active !== entry) {
				return;
			}
			this.activeDrainListener = undefined;
			this.active = undefined;
			this.queuedBytes = Math.max(0, this.queuedBytes - entry.byteLength);
			entry.resolve();
			this.pump();
		};
		const onDrain = () => {
			if (this.active !== entry) {
				return;
			}
			drainSettled = true;
			this.activeDrainListener = undefined;
			this.setBackpressured(false);
			trySettle();
		};
		try {
			const accepted = this.output.write(entry.value, error => {
				if (error) {
					this.stopAccepting(error, true);
					return;
				}
				callbackSettled = true;
				trySettle();
			});
			drainSettled = accepted;
			if (!accepted) {
				this.activeDrainListener = onDrain;
				this.output.once('drain', onDrain);
				this.setBackpressured(true);
			}
			writeReturned = true;
			trySettle();
		} catch (error) {
			this.stopAccepting(error instanceof Error ? error : new Error(String(error)), true);
		}
	}

	private setBackpressured(value: boolean): void {
		if (this.backpressured === value) {
			return;
		}
		this.backpressured = value;
		try {
			this.onDidChangeBackpressure(value);
		} catch {
			// Flow-control diagnostics must not alter stdout delivery.
		}
	}

	private finishSettlement(): void {
		if (this.active || this.queue.length > 0) {
			return;
		}
		if (!this.accepting) {
			this.removeOutputListeners();
		}
		for (const resolve of this.settlementWaiters.splice(0)) {
			resolve();
		}
	}

	private removeOutputListeners(): void {
		if (!this.listenersInstalled) {
			return;
		}
		this.listenersInstalled = false;
		this.output.removeListener('error', this.handleOutputError);
		this.output.removeListener('close', this.handleOutputClose);
	}
}

export function paradisMcpShouldPauseStdin(inflightHasCapacity: boolean, stdoutBackpressured: boolean): boolean {
	return !inflightHasCapacity || stdoutBackpressured;
}

/** Bounded, incrementally byte-counted newline-delimited framing for the standalone stdio shim. */
export class ParadisMcpStdioLineBuffer {
	private readonly fragments = new Array<IParadisMcpStdinFragment | undefined>(PARADIS_MCP_MAX_STDIN_FRAGMENTS);
	private fragmentHead = 0;
	private fragmentCount = 0;
	private bufferedBytes = 0;
	private tailLineBytes = 0;
	private completeLineCount = 0;

	get hasCompleteLine(): boolean {
		return this.completeLineCount > 0;
	}

	get hasBufferedData(): boolean {
		return this.bufferedBytes > 0;
	}

	append(chunk: string): void {
		if (typeof chunk !== 'string') {
			throw new TypeError('Para Code MCP stdin chunk must be a string');
		}
		if (chunk.length === 0) {
			return;
		}
		const chunkBytes = Buffer.byteLength(chunk);
		if (this.bufferedBytes + chunkBytes > PARADIS_MCP_MAX_STDIN_BUFFER_BYTES) {
			throw new Error(`Para Code MCP stdin buffer exceeded ${PARADIS_MCP_MAX_STDIN_BUFFER_BYTES} bytes`);
		}
		if (this.fragmentCount >= PARADIS_MCP_MAX_STDIN_FRAGMENTS) {
			throw new Error(`Para Code MCP stdin fragment capacity exceeded ${PARADIS_MCP_MAX_STDIN_FRAGMENTS}`);
		}

		let nextTailLineBytes = this.tailLineBytes;
		let appendedCompleteLines = 0;
		let segmentStart = 0;
		while (segmentStart <= chunk.length) {
			const newlineIndex = chunk.indexOf('\n', segmentStart);
			const segmentEnd = newlineIndex < 0 ? chunk.length : newlineIndex;
			if (segmentEnd > segmentStart) {
				nextTailLineBytes += Buffer.byteLength(chunk.slice(segmentStart, segmentEnd));
				if (nextTailLineBytes > PARADIS_MCP_MAX_REQUEST_BYTES) {
					throw new Error(`Para Code MCP request exceeded ${PARADIS_MCP_MAX_REQUEST_BYTES} bytes`);
				}
			}
			if (newlineIndex < 0) {
				break;
			}
			appendedCompleteLines++;
			nextTailLineBytes = 0;
			segmentStart = newlineIndex + 1;
		}

		const tailIndex = (this.fragmentHead + this.fragmentCount) % PARADIS_MCP_MAX_STDIN_FRAGMENTS;
		this.fragments[tailIndex] = { value: chunk, offset: 0 };
		this.fragmentCount++;
		this.bufferedBytes += chunkBytes;
		this.tailLineBytes = nextTailLineBytes;
		this.completeLineCount += appendedCompleteLines;
	}

	takeLine(): string | undefined {
		if (this.completeLineCount === 0) {
			return undefined;
		}

		const parts: string[] = [];
		let lineBytes = 0;
		while (this.fragmentCount > 0) {
			const fragment = this.fragments[this.fragmentHead];
			if (!fragment) {
				throw new Error('Para Code MCP stdin fragment state is unavailable');
			}
			const newlineIndex = fragment.value.indexOf('\n', fragment.offset);
			const segmentEnd = newlineIndex < 0 ? fragment.value.length : newlineIndex;
			if (segmentEnd > fragment.offset) {
				const part = fragment.value.slice(fragment.offset, segmentEnd);
				parts.push(part);
				lineBytes += Buffer.byteLength(part);
			}
			if (newlineIndex < 0) {
				this.removeHeadFragment();
				continue;
			}

			fragment.offset = newlineIndex + 1;
			if (fragment.offset >= fragment.value.length) {
				this.removeHeadFragment();
			}
			this.completeLineCount--;
			this.bufferedBytes -= lineBytes + 1;
			return parts.join('').trim();
		}
		throw new Error('Para Code MCP stdin line state is unavailable');
	}

	finish(): void {
		if (this.hasCompleteLine) {
			throw new Error('Para Code MCP stdin reached EOF with undrained requests');
		}
		const remainder: string[] = [];
		for (let index = 0; index < this.fragmentCount; index++) {
			const fragment = this.fragments[(this.fragmentHead + index) % PARADIS_MCP_MAX_STDIN_FRAGMENTS];
			if (fragment && fragment.offset < fragment.value.length) {
				remainder.push(fragment.value.slice(fragment.offset));
			}
		}
		if (remainder.join('').trim().length > 0) {
			throw new Error('Para Code MCP stdin reached EOF with an incomplete JSON-RPC request');
		}
		this.clear();
	}

	clear(): void {
		while (this.fragmentCount > 0) {
			this.removeHeadFragment();
		}
		this.fragmentHead = 0;
		this.bufferedBytes = 0;
		this.tailLineBytes = 0;
		this.completeLineCount = 0;
	}

	private removeHeadFragment(): void {
		this.fragments[this.fragmentHead] = undefined;
		this.fragmentHead = (this.fragmentHead + 1) % PARADIS_MCP_MAX_STDIN_FRAGMENTS;
		this.fragmentCount--;
		if (this.fragmentCount === 0) {
			this.fragmentHead = 0;
		}
	}
}

function readParadisMcpPortFileBoundedSync(path: string): string {
	const file = openSync(path, 'r');
	try {
		const buffer = Buffer.allocUnsafe(PARADIS_MCP_MAX_PORT_FILE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const read = readSync(file, buffer, bytesRead, buffer.length - bytesRead, null);
			if (read === 0) {
				break;
			}
			bytesRead += read;
		}
		if (bytesRead > PARADIS_MCP_MAX_PORT_FILE_BYTES) {
			throw new Error(`Invalid MCP port file: exceeded ${PARADIS_MCP_MAX_PORT_FILE_BYTES} bytes`);
		}
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		closeSync(file);
	}
}

async function readParadisMcpPortFileBounded(path: string): Promise<string> {
	const file = await fs.open(path, 'r');
	try {
		const buffer = Buffer.allocUnsafe(PARADIS_MCP_MAX_PORT_FILE_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, null);
			if (result.bytesRead === 0) {
				break;
			}
			bytesRead += result.bytesRead;
		}
		if (bytesRead > PARADIS_MCP_MAX_PORT_FILE_BYTES) {
			throw new Error(`Invalid MCP port file: exceeded ${PARADIS_MCP_MAX_PORT_FILE_BYTES} bytes`);
		}
		return buffer.subarray(0, bytesRead).toString('utf8');
	} finally {
		await file.close();
	}
}

export interface IParadisMcpPortFileWriterOptions {
	readonly createTemporaryPath?: (targetPath: string) => string;
	readonly writeFile?: (path: string, contents: string) => Promise<void>;
	readonly rename?: (from: string, to: string) => Promise<void>;
	readonly unlink?: (path: string) => Promise<void>;
	/** Rechecked after the temporary write and immediately before the authoritative rename. */
	readonly shouldPublish?: () => boolean;
}

interface IParadisMcpVerifiedHttpRequestOptions {
	readonly port: number;
	readonly body: string;
	readonly token: string;
	readonly request?: IParadisMcpHttpRequestFactory;
	readonly agent?: http.Agent;
	readonly expectedSocket?: import('net').Socket;
	readonly overallTimeoutMs?: number;
	readonly setTimeout?: (callback: () => void, delay: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
}

interface IParadisMcpHttpRequestOptions {
	readonly record: IParadisMcpPortFileRecord;
	readonly body: string;
	readonly token: string;
}

export interface IParadisMcpHttpResponse {
	readonly status: number;
	readonly body: string;
}

export function parseParadisMcpPortFile(raw: string): IParadisMcpPortFileRecord {
	if (typeof raw !== 'string' || Buffer.byteLength(raw) > PARADIS_MCP_MAX_PORT_FILE_BYTES) {
		throw new Error(`Invalid MCP port file: exceeded ${PARADIS_MCP_MAX_PORT_FILE_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Invalid MCP port file: expected JSON object');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Invalid MCP port file: expected JSON object');
	}
	const requiredKeys = ['protocolVersion', 'port', 'pid', 'instanceId', 'serviceStartedAt'];
	const keys = Object.keys(parsed);
	if (keys.length !== requiredKeys.length || keys.some(key => !requiredKeys.includes(key))) {
		throw new Error('Invalid MCP port file: expected exact record fields');
	}
	const { protocolVersion, port, pid, instanceId, serviceStartedAt } = parsed as {
		protocolVersion?: unknown;
		port?: unknown;
		pid?: unknown;
		instanceId?: unknown;
		serviceStartedAt?: unknown;
	};
	if (protocolVersion !== PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION) {
		throw new Error(`Invalid MCP port file: protocolVersion must be ${PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION}`);
	}
	if (!Number.isSafeInteger(port) || (port as number) <= 0 || (port as number) > 65_535) {
		throw new Error('Invalid MCP port file: port must be an integer between 1 and 65535');
	}
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
		throw new Error('Invalid MCP port file: pid must be a positive integer');
	}
	if (typeof instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
		throw new Error('Invalid MCP port file: instanceId must be a UUID');
	}
	if (!Number.isSafeInteger(serviceStartedAt) || (serviceStartedAt as number) <= 0) {
		throw new Error('Invalid MCP port file: serviceStartedAt must be a positive safe integer');
	}
	return {
		protocolVersion: PARADIS_MCP_PORT_FILE_PROTOCOL_VERSION,
		port: port as number,
		pid: pid as number,
		instanceId,
		serviceStartedAt: serviceStartedAt as number,
	};
}

/** Positive means left is the deterministically newer owner. */
export function compareParadisMcpPortFileOwners(left: IParadisMcpPortFileRecord, right: IParadisMcpPortFileRecord): number {
	if (left.serviceStartedAt !== right.serviceStartedAt) {
		return left.serviceStartedAt < right.serviceStartedAt ? -1 : 1;
	}
	if (left.instanceId === right.instanceId) {
		return 0;
	}
	return left.instanceId < right.instanceId ? -1 : 1;
}

export function isParadisMcpProcessAlive(
	pid: number,
	kill: (pid: number, signal: 0) => boolean = process.kill,
): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'ESRCH') {
			return false;
		}
		if (code === 'EPERM') {
			// Windows and restricted Unix accounts can observe a live process without permission to signal it.
			return true;
		}
		throw error;
	}
}

/**
 * Resolve a live shared-process record. A stale first PID is re-read once so an atomic replacement
 * that raced the request can be observed. Parse and probe failures other than ESRCH remain explicit.
 */
export function resolveLiveParadisMcpPortFile(
	path: string,
	options: IParadisMcpPortFileResolverOptions = {},
): IParadisMcpPortFileRecord {
	const readFile = options.readFile ?? readParadisMcpPortFileBoundedSync;
	const isProcessAlive = options.isProcessAlive ?? isParadisMcpProcessAlive;
	for (let attempt = 0; attempt < 2; attempt++) {
		const record = parseParadisMcpPortFile(readFile(path));
		if (isProcessAlive(record.pid)) {
			return record;
		}
	}
	throw new Error('Para Code MCP shared process is not running');
}

/** Publish a complete record without exposing partially written JSON to concurrent shim readers. */
export async function writeParadisMcpPortFileAtomic(
	path: string,
	record: IParadisMcpPortFileRecord,
	options: IParadisMcpPortFileWriterOptions = {},
): Promise<boolean> {
	// Validate before touching the filesystem, including the upper port bound.
	const contents = JSON.stringify(parseParadisMcpPortFile(JSON.stringify(record)));
	const temporaryPath = (options.createTemporaryPath ?? (target => `${target}.${process.pid}.${randomUUID()}.tmp`))(path);
	const writeFile = options.writeFile ?? ((filePath, value) => fs.writeFile(filePath, value));
	const rename = options.rename ?? ((from, to) => fs.rename(from, to));
	const unlink = options.unlink ?? (filePath => fs.unlink(filePath));
	try {
		await writeFile(temporaryPath, contents);
		if (options.shouldPublish?.() === false) {
			try {
				await unlink(temporaryPath);
			} catch {
				// The non-authoritative random temporary file is safe to leave for later cleanup.
			}
			return false;
		}
		await rename(temporaryPath, path);
		return true;
	} catch (error) {
		try {
			await unlink(temporaryPath);
		} catch {
			// Preserve the publication failure. The random same-directory temporary path is never authoritative.
		}
		throw error;
	}
}

interface IParadisMcpHealthProbeOptions {
	readonly request?: IParadisMcpHttpRequestFactory;
	readonly agent?: http.Agent;
	readonly timeoutMs?: number;
	readonly setTimeout?: (callback: () => void, delay: number) => unknown;
	readonly clearTimeout?: (handle: unknown) => void;
}

/** Verify the unauthenticated instance identity and return the exact TCP socket that proved it. */
export async function probeParadisMcpInstance(
	record: IParadisMcpPortFileRecord,
	options: IParadisMcpHealthProbeOptions = {},
): Promise<import('net').Socket> {
	const requestFactory = options.request ?? (await import('http')).request;
	const timeoutMs = options.timeoutMs ?? PARADIS_MCP_HEALTH_TIMEOUT_MS;
	const schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
	const cancel = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
	return new Promise<import('net').Socket>((resolve, reject) => {
		let settled = false;
		let response: http.IncomingMessage | undefined;
		let responseSocket: import('net').Socket | undefined;
		let requestClosed = false;
		let responseClosed = false;
		let timer: unknown;
		let bodyLength = 0;
		const chunks: Buffer[] = [];
		const cleanup = () => {
			if (timer !== undefined) {
				cancel(timer);
				timer = undefined;
			}
			request.removeListener('error', onRequestError);
			request.removeListener('close', onRequestClose);
			response?.removeListener('data', onData);
			response?.removeListener('end', onResponseEnd);
			response?.removeListener('error', onResponseError);
			response?.removeListener('aborted', onResponseAborted);
			response?.removeListener('close', onResponseClose);
		};
		const installRequestDestroyGuard = () => {
			if (requestClosed) {
				return () => undefined;
			}
			const onDestroyedRequestError = () => undefined;
			const clearGuard = () => {
				request.removeListener('error', onDestroyedRequestError);
				request.removeListener('close', onDestroyedRequestClose);
			};
			const onDestroyedRequestClose = () => {
				requestClosed = true;
				clearGuard();
			};
			request.on('error', onDestroyedRequestError);
			request.once('close', onDestroyedRequestClose);
			return clearGuard;
		};
		const installResponseDestroyGuard = (guardedResponse: http.IncomingMessage | undefined = response) => {
			if (guardedResponse === undefined || (guardedResponse === response && responseClosed)) {
				return () => undefined;
			}
			const onDestroyedResponseError = () => undefined;
			const onDestroyedResponseAborted = () => undefined;
			const clearGuard = () => {
				guardedResponse.removeListener('error', onDestroyedResponseError);
				guardedResponse.removeListener('aborted', onDestroyedResponseAborted);
				guardedResponse.removeListener('close', onDestroyedResponseClose);
			};
			const onDestroyedResponseClose = () => {
				responseClosed = true;
				clearGuard();
			};
			guardedResponse.on('error', onDestroyedResponseError);
			guardedResponse.on('aborted', onDestroyedResponseAborted);
			guardedResponse.once('close', onDestroyedResponseClose);
			return clearGuard;
		};
		const settle = (error: Error | undefined, socket?: import('net').Socket) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error !== undefined) {
				reject(error);
			} else {
				resolve(socket!);
			}
		};
		const terminate = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			const clearRequestGuard = installRequestDestroyGuard();
			const clearResponseGuard = installResponseDestroyGuard();
			try {
				request.destroy(error);
			} catch {
				clearRequestGuard();
				clearResponseGuard();
			}
			reject(error);
		};
		const onData = (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			chunks.push(buffer);
			bodyLength += buffer.length;
			if (bodyLength > 8 * 1024) {
				terminate(new Error('Para Code MCP health response exceeded 8192 bytes'));
			}
		};
		const onResponseEnd = () => {
			if (response?.statusCode !== 200) {
				settle(new Error(`Para Code MCP health probe returned HTTP ${response?.statusCode ?? 0}`));
				return;
			}
			let health: unknown;
			try {
				health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				settle(new Error('Para Code MCP health identity mismatch'));
				return;
			}
			const value = health as { protocolVersion?: unknown; instanceId?: unknown; serviceStartedAt?: unknown };
			if (!health || typeof health !== 'object'
				|| value.protocolVersion !== record.protocolVersion
				|| value.instanceId !== record.instanceId
				|| value.serviceStartedAt !== record.serviceStartedAt) {
				settle(new Error('Para Code MCP health identity mismatch'));
				return;
			}
			if (responseSocket === undefined) {
				settle(new Error('Para Code MCP health response did not expose its TCP socket'));
				return;
			}
			settle(undefined, responseSocket);
		};
		const onRequestError = (error: Error) => terminate(error);
		const onRequestClose = () => requestClosed = true;
		const onResponseError = (error: Error) => terminate(error);
		const onResponseAborted = () => terminate(new Error('Para Code MCP health response aborted'));
		const onResponseClose = () => {
			responseClosed = true;
			if (!settled && response?.complete !== true) {
				settle(new Error('Para Code MCP health response closed before completion'));
			}
		};
		const request = requestFactory({
			host: '127.0.0.1',
			port: record.port,
			path: PARADIS_MCP_HEALTH_PATH,
			method: 'GET',
			agent: options.agent,
			headers: {
				'Accept': 'application/json',
				'Connection': 'keep-alive',
			},
		}, incoming => {
			if (settled) {
				const clearLateResponseGuard = installResponseDestroyGuard(incoming);
				try {
					incoming.resume();
				} catch {
					try {
						incoming.destroy();
					} catch {
						clearLateResponseGuard();
					}
				}
				return;
			}
			response = incoming;
			// Node clears IncomingMessage.socket before `end`; retain the exact object at callback time.
			responseSocket = incoming.socket;
			incoming.on('data', onData);
			incoming.once('end', onResponseEnd);
			incoming.once('error', onResponseError);
			incoming.once('aborted', onResponseAborted);
			incoming.once('close', onResponseClose);
		});
		request.once('error', onRequestError);
		request.once('close', onRequestClose);
		timer = schedule(() => {
			terminate(new Error(`Para Code MCP health timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		try {
			request.end();
		} catch (error) {
			terminate(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

interface IParadisMcpPortFileReconcilerOptions {
	readonly readFile?: (path: string) => Promise<string>;
	readonly isOwnerHealthy?: (record: IParadisMcpPortFileRecord) => Promise<boolean>;
	readonly publish?: (path: string, record: IParadisMcpPortFileRecord, shouldPublish: () => boolean) => Promise<boolean>;
	readonly setInterval?: (callback: () => void, delay: number) => unknown;
	readonly clearInterval?: (handle: unknown) => void;
	readonly intervalMs?: number;
	readonly onError?: (error: unknown) => void;
}

/** Periodically restores the newest healthy owner after an unavoidable cross-process rename inversion. */
export class ParadisMcpPortFileReconciler {
	private readonly readFile: (path: string) => Promise<string>;
	private readonly isOwnerHealthy: (record: IParadisMcpPortFileRecord) => Promise<boolean>;
	private readonly publish: (path: string, record: IParadisMcpPortFileRecord, shouldPublish: () => boolean) => Promise<boolean>;
	private readonly scheduleInterval: (callback: () => void, delay: number) => unknown;
	private readonly cancelInterval: (handle: unknown) => void;
	private readonly intervalMs: number;
	private readonly onError: (error: unknown) => void;
	private interval: unknown;
	private running: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly path: string,
		private readonly owner: IParadisMcpPortFileRecord,
		options: IParadisMcpPortFileReconcilerOptions = {},
	) {
		this.readFile = options.readFile ?? readParadisMcpPortFileBounded;
		this.isOwnerHealthy = options.isOwnerHealthy ?? (async record => {
			if (!isParadisMcpProcessAlive(record.pid)) {
				return false;
			}
			try {
				const socket = await probeParadisMcpInstance(record);
				return !socket.destroyed;
			} catch {
				return false;
			}
		});
		this.publish = options.publish ?? ((filePath, record, shouldPublish) => writeParadisMcpPortFileAtomic(filePath, record, { shouldPublish }));
		this.scheduleInterval = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
		this.cancelInterval = options.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
		this.intervalMs = options.intervalMs ?? PARADIS_MCP_RECORD_RECONCILE_INTERVAL_MS;
		this.onError = options.onError ?? (() => undefined);
	}

	async start(): Promise<void> {
		if (this.disposed || this.interval !== undefined) {
			return;
		}
		this.interval = this.scheduleInterval(() => {
			void this.reconcile().catch(error => this.onError(error));
		}, this.intervalMs);
		await this.reconcile();
	}

	reconcile(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		if (this.running !== undefined) {
			return this.running;
		}
		const operation = this.doReconcile();
		this.running = operation;
		void operation.then(
			() => { if (this.running === operation) { this.running = undefined; } },
			() => { if (this.running === operation) { this.running = undefined; } },
		);
		return operation;
	}

	async whenIdle(): Promise<void> {
		await this.running;
	}

	dispose(): void {
		this.disposed = true;
		if (this.interval !== undefined) {
			this.cancelInterval(this.interval);
			this.interval = undefined;
		}
	}

	private async doReconcile(): Promise<void> {
		let current: IParadisMcpPortFileRecord | undefined;
		try {
			current = parseParadisMcpPortFile(await this.readFile(this.path));
		} catch {
			current = undefined;
		}
		if (this.disposed) {
			return;
		}
		if (current !== undefined) {
			const sameOwner = compareParadisMcpPortFileOwners(current, this.owner) === 0;
			const sameRecord = sameOwner && current.port === this.owner.port && current.pid === this.owner.pid;
			if (sameRecord) {
				return;
			}
			if (compareParadisMcpPortFileOwners(current, this.owner) > 0 && await this.isOwnerHealthy(current)) {
				return;
			}
		}
		if (!this.disposed) {
			await this.publish(this.path, this.owner, () => !this.disposed);
		}
	}
}

/**
 * Forward one MCP message with independent connection and whole-response deadlines.
 * The request body and bearer token are deliberately absent from errors and logs.
 */
export async function postParadisMcpRequestOnVerifiedSocket(options: IParadisMcpVerifiedHttpRequestOptions): Promise<IParadisMcpHttpResponse> {
	const requestBodyBytes = Buffer.byteLength(options.body);
	if (requestBodyBytes > PARADIS_MCP_MAX_REQUEST_BYTES) {
		throw new Error(`Para Code MCP request exceeded ${PARADIS_MCP_MAX_REQUEST_BYTES} bytes`);
	}
	const requestFactory = options.request ?? (await import('http')).request;
	const schedule = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
	const cancel = options.clearTimeout ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));

	return new Promise<IParadisMcpHttpResponse>((resolve, reject) => {
		let settled = false;
		let connectTimer: unknown;
		let overallTimer: unknown;
		let response: http.IncomingMessage | undefined;
		let socket: import('net').Socket | undefined;
		let requestClosed = false;
		let responseClosed = false;
		let bodySent = false;
		let responseBodyBytes = 0;
		const chunks: Buffer[] = [];

		const clearConnectTimer = () => {
			if (connectTimer !== undefined) {
				cancel(connectTimer);
				connectTimer = undefined;
			}
		};
		const clearAllTimers = () => {
			clearConnectTimer();
			if (overallTimer !== undefined) {
				cancel(overallTimer);
				overallTimer = undefined;
			}
		};
		const onSocketConnect = () => clearConnectTimer();
		const onSocket = (assignedSocket: import('net').Socket) => {
			socket = assignedSocket;
			if (options.expectedSocket !== undefined && assignedSocket !== options.expectedSocket) {
				terminateWithError(new Error('Para Code MCP verified health socket was replaced before the authenticated request'));
				return;
			}
			if (!assignedSocket.connecting) {
				clearConnectTimer();
			} else {
				assignedSocket.once('connect', onSocketConnect);
			}
			if (options.expectedSocket !== undefined) {
				authorizeAndSend();
			}
		};
		const onData = (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			responseBodyBytes += buffer.length;
			if (responseBodyBytes > PARADIS_MCP_MAX_RESPONSE_BYTES) {
				terminateWithError(new Error(`Para Code MCP response exceeded ${PARADIS_MCP_MAX_RESPONSE_BYTES} bytes`));
				return;
			}
			if (chunks.length >= PARADIS_MCP_MAX_RESPONSE_CHUNKS) {
				terminateWithError(new Error(`Para Code MCP response chunk capacity exceeded ${PARADIS_MCP_MAX_RESPONSE_CHUNKS}`));
				return;
			}
			chunks.push(buffer);
		};
		const onRequestObservedClose = () => requestClosed = true;
		const onResponseObservedClose = () => {
			responseClosed = true;
			if (settled) {
				return;
			}
			if (response?.complete === true) {
				onResponseEnd();
			} else {
				settleTransportError(new Error('Para Code MCP response closed before completion'));
			}
		};
		const cleanup = () => {
			clearAllTimers();
			request.removeListener('error', onRequestError);
			request.removeListener('socket', onSocket);
			request.removeListener('close', onRequestObservedClose);
			socket?.removeListener('connect', onSocketConnect);
			response?.removeListener('data', onData);
			response?.removeListener('end', onResponseEnd);
			response?.removeListener('error', onResponseError);
			response?.removeListener('aborted', onResponseAborted);
			response?.removeListener('close', onResponseObservedClose);
		};
		const installRequestDestroyGuard = () => {
			if (requestClosed) {
				return () => undefined;
			}
			const onDestroyedRequestError = () => {
				// The destroy error is the expected terminal signal; keep guarding until close.
			};
			const clearDestroyedRequestGuard = () => {
				request.removeListener('error', onDestroyedRequestError);
				request.removeListener('close', onDestroyedRequestClose);
			};
			const onDestroyedRequestClose = () => {
				requestClosed = true;
				clearDestroyedRequestGuard();
			};
			request.on('error', onDestroyedRequestError);
			request.once('close', onDestroyedRequestClose);
			return clearDestroyedRequestGuard;
		};
		const installResponseDestroyGuard = (guardedResponse: http.IncomingMessage | undefined = response) => {
			if (guardedResponse === undefined || (guardedResponse === response && responseClosed)) {
				return () => undefined;
			}
			const onDestroyedResponseError = () => {
				// A destroyed IncomingMessage can report error after aborted; guard through close.
			};
			const onDestroyedResponseAborted = () => {
				// Close is the terminal cleanup boundary because an error may still follow aborted.
			};
			const clearDestroyedResponseGuard = () => {
				guardedResponse.removeListener('error', onDestroyedResponseError);
				guardedResponse.removeListener('aborted', onDestroyedResponseAborted);
				guardedResponse.removeListener('close', onDestroyedResponseClose);
			};
			const onDestroyedResponseClose = () => {
				responseClosed = true;
				clearDestroyedResponseGuard();
			};
			guardedResponse.on('error', onDestroyedResponseError);
			guardedResponse.on('aborted', onDestroyedResponseAborted);
			guardedResponse.once('close', onDestroyedResponseClose);
			return clearDestroyedResponseGuard;
		};
		const settle = (error: unknown, result?: IParadisMcpHttpResponse) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error !== undefined) {
				reject(error);
			} else {
				resolve(result!);
			}
		};
		const settleTransportError = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			installRequestDestroyGuard();
			installResponseDestroyGuard();
			reject(error);
		};
		const terminateWithError = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();

			// ClientRequest.destroy(error) and an active IncomingMessage both report terminal errors
			// asynchronously. Guard each emitter through close to cover error-after-aborted ordering.
			const clearDestroyedRequestGuard = installRequestDestroyGuard();
			const clearDestroyedResponseGuard = installResponseDestroyGuard();
			try {
				request.destroy(error);
			} catch {
				clearDestroyedRequestGuard();
				clearDestroyedResponseGuard();
			}
			reject(error);
		};
		const onRequestError = (error: Error) => settleTransportError(error);
		const onResponseError = (error: Error) => settleTransportError(error);
		const onResponseAborted = () => settleTransportError(new Error('Para Code MCP response aborted before completion'));
		const onResponseEnd = () => settle(undefined, {
			status: response?.statusCode ?? 0,
			body: Buffer.concat(chunks).toString('utf8'),
		});
		const authorizeAndSend = () => {
			if (settled || bodySent) {
				return;
			}
			bodySent = true;
			try {
				request.setHeader('Content-Type', 'application/json');
				request.setHeader('Accept', 'application/json, text/event-stream');
				request.setHeader('Authorization', `Bearer ${options.token}`);
				request.setHeader('Content-Length', Buffer.byteLength(options.body));
				request.end(options.body);
			} catch (error) {
				terminateWithError(error instanceof Error ? error : new Error(String(error)));
			}
		};

		const request = requestFactory(
			{
				host: '127.0.0.1',
				port: options.port,
				path: '/mcp',
				method: 'POST',
				agent: options.agent,
			},
			incoming => {
				if (settled) {
					const clearLateResponseGuard = installResponseDestroyGuard(incoming);
					try {
						incoming.resume();
					} catch {
						try {
							incoming.destroy();
						} catch {
							clearLateResponseGuard();
						}
					}
					return;
				}
				clearConnectTimer();
				response = incoming;
				const contentLength = incoming.headers?.['content-length'];
				if (typeof contentLength === 'string'
					&& /^\d+$/.test(contentLength)
					&& Number(contentLength) > PARADIS_MCP_MAX_RESPONSE_BYTES) {
					terminateWithError(new Error(`Para Code MCP response exceeded ${PARADIS_MCP_MAX_RESPONSE_BYTES} bytes`));
					return;
				}
				incoming.on('data', onData);
				incoming.once('end', onResponseEnd);
				incoming.once('error', onResponseError);
				incoming.once('aborted', onResponseAborted);
				incoming.once('close', onResponseObservedClose);
			},
		);
		request.once('error', onRequestError);
		request.once('socket', onSocket);
		request.once('close', onRequestObservedClose);
		connectTimer = schedule(
			() => terminateWithError(new Error(`Para Code MCP connect timeout after ${PARADIS_MCP_CONNECT_TIMEOUT_MS}ms`)),
			PARADIS_MCP_CONNECT_TIMEOUT_MS,
		);
		overallTimer = schedule(
			() => terminateWithError(new Error(`Para Code MCP overall timeout after ${options.overallTimeoutMs ?? PARADIS_MCP_OVERALL_TIMEOUT_MS}ms`)),
			options.overallTimeoutMs ?? PARADIS_MCP_OVERALL_TIMEOUT_MS,
		);
		if (options.expectedSocket === undefined) {
			authorizeAndSend();
		}
	});
}

/**
 * Prove the instance identity without credentials, then send the authenticated POST only when the
 * Agent assigns the exact same TCP socket. A port rebind can therefore never receive token or body.
 */
export async function postParadisMcpRequest(options: IParadisMcpHttpRequestOptions): Promise<IParadisMcpHttpResponse> {
	const record = parseParadisMcpPortFile(JSON.stringify(options.record));
	if (!isParadisMcpProcessAlive(record.pid)) {
		throw new Error('Para Code MCP shared process is not running');
	}
	const httpModule = await import('http');
	const agent = new httpModule.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
	const startedAt = Date.now();
	try {
		const verifiedSocket = await probeParadisMcpInstance(record, { request: httpModule.request, agent });
		const remainingOverallTimeoutMs = PARADIS_MCP_OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
		if (remainingOverallTimeoutMs <= 0) {
			throw new Error(`Para Code MCP overall timeout after ${PARADIS_MCP_OVERALL_TIMEOUT_MS}ms`);
		}
		return await postParadisMcpRequestOnVerifiedSocket({
			port: record.port,
			body: options.body,
			token: options.token,
			request: httpModule.request,
			agent,
			expectedSocket: verifiedSocket,
			overallTimeoutMs: remainingOverallTimeoutMs,
		});
	} finally {
		agent.destroy();
	}
}

export function shouldEmitParadisMcpHttpResponse(status: number, body: string, isRequest: boolean = true): boolean {
	return isRequest && status !== 202 && body.trim().length > 0;
}

export class ParadisMcpInflightTracker {
	private readonly inflight = new Set<Promise<void>>();

	constructor(
		private readonly maximumInflight: number = PARADIS_MCP_MAX_INFLIGHT_REQUESTS,
		private readonly onDidSettle: () => void = () => undefined,
	) {
		if (!Number.isSafeInteger(maximumInflight) || maximumInflight <= 0 || maximumInflight > PARADIS_MCP_MAX_INFLIGHT_REQUESTS) {
			throw new RangeError(`maximumInflight must be between 1 and ${PARADIS_MCP_MAX_INFLIGHT_REQUESTS}`);
		}
	}

	get size(): number {
		return this.inflight.size;
	}

	get hasCapacity(): boolean {
		return this.inflight.size < this.maximumInflight;
	}

	track(promise: Promise<void>): boolean {
		if (!this.hasCapacity) {
			return false;
		}
		this.inflight.add(promise);
		const settled = () => {
			if (!this.inflight.delete(promise)) {
				return;
			}
			try {
				this.onDidSettle();
			} catch {
				// Capacity notification must never turn a settled forwarding request into a rejection.
			}
		};
		void promise.then(
			settled,
			settled,
		);
		return true;
	}

	async waitForSettled(): Promise<void> {
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight]);
		}
	}
}

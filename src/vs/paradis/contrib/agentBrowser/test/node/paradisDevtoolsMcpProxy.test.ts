/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import { pathToFileURL } from 'url';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisDevtoolsGenerationCoordinator } from '../../node/paradisAgentBrowserService.js';
import { ParadisDevtoolsMcpProxy } from '../../node/paradisDevtoolsMcpProxy.js';
import { PARADIS_SNAPSHOT_ROOT_RECT_MARKER, paradisSnapshotRootRectOf } from '../../node/paradisDevtoolsToolAdjustments.js';
import { PARADIS_PANE_TOKEN_ENV_VAR } from '../../common/paradisAgentBrowser.js';
import { paradisAgentTabScopeKey } from '../../common/paradisAgentTabScope.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';

/** A fixed temporary folder so that no test creates or removes real folders. */
const TEST_TEMPORARY_DIRECTORY = join(tmpdir(), 'para-code-devtools-test-fixed');

interface IRecordedReport {
	readonly feature: string;
	readonly operation: string;
	readonly extra: Record<string, unknown> | undefined;
	readonly severity: string | undefined;
}

/** Captures Sentry diagnostics for the duration of `run`, restoring the no-op reporter afterwards. */
async function withRecordedReports<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly reports: IRecordedReport[] }> {
	const reports: IRecordedReport[] = [];
	configureParadisDiagnosticReporter((_scope, feature, operation, _error, extra, severity) => {
		reports.push({ feature, operation, extra, severity });
	});
	try {
		return { result: await run(), reports };
	} finally {
		configureParadisDiagnosticReporter(() => { });
	}
}

interface IFakeDevtoolsChild {
	readonly child: ChildProcessWithoutNullStreams;
	readonly killCount: number;
	readonly killSignals: readonly (NodeJS.Signals | number)[];
	emitExit(): void;
	respondToPendingToolCalls(): void;
	/** Sends a request from the child to the client (the proxy) and waits for its answer. */
	requestFromChild(method: string): Promise<unknown>;
	/** Requests and notifications the proxy sent to the child (initialize, tools/call, ...). */
	readonly requests: readonly { readonly method: string; readonly params: unknown }[];
	/** Resolves once the proxy has sent `method` to the child. */
	waitForRequest(method: string): Promise<void>;
}

interface IFakeDevtoolsSpawnOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly stdio: ['pipe', 'pipe', 'pipe'];
}

interface IFakeDevtoolsChildren {
	readonly children: readonly IFakeDevtoolsChild[];
	readonly spawn: (command: string, args: string[], options: IFakeDevtoolsSpawnOptions) => ChildProcessWithoutNullStreams;
	readonly spawnOptions: readonly IFakeDevtoolsSpawnOptions[];
	readonly hungToolCallCount: number;
	hangNextToolCalls(count: number, stderr?: string): void;
	failNextToolCall(message: string): void;
	waitForHungToolCalls(count: number): Promise<void>;
}

class CapturingLogService extends NullLogService {
	readonly messages: string[] = [];

	override debug(message: string, ...args: unknown[]): void {
		this._capture(message, args);
	}

	override warn(message: string, ...args: unknown[]): void {
		this._capture(message, args);
	}

	override error(message: string | Error, ...args: unknown[]): void {
		this._capture(message, args);
	}

	private _capture(message: string | Error, args: readonly unknown[]): void {
		this.messages.push([String(message), ...args.map(String)].join(' '));
	}
}

class ThrowingDiagnosticLogService extends NullLogService {
	throwOnDiagnostics = false;

	override debug(): void {
		this._throwIfEnabled();
	}

	override trace(): void {
		this._throwIfEnabled();
	}

	override warn(): void {
		this._throwIfEnabled();
	}

	private _throwIfEnabled(): void {
		if (this.throwOnDiagnostics) {
			throw new Error('diagnostic logger failed');
		}
	}
}

function createFakeDevtoolsChildren(options: { hangToolCalls?: number; stderrBeforeHungToolCall?: string; toolCallErrors?: readonly string[]; toolCallResults?: readonly unknown[]; toolsListResult?: unknown; ignoreKillExit?: boolean } = {}): IFakeDevtoolsChildren {
	const children: IFakeDevtoolsChild[] = [];
	const spawnOptions: IFakeDevtoolsSpawnOptions[] = [];
	let remainingHungToolCalls = options.hangToolCalls ?? 0;
	let stderrBeforeHungToolCall = options.stderrBeforeHungToolCall;
	let hungToolCallCount = 0;
	const toolCallErrors = [...(options.toolCallErrors ?? [])];
	const toolCallResults = [...(options.toolCallResults ?? [])];
	const hungToolCallWaiters: { readonly count: number; readonly resolve: () => void }[] = [];
	const resolveHungToolCallWaiters = () => {
		for (let index = hungToolCallWaiters.length - 1; index >= 0; index--) {
			if (hungToolCallCount >= hungToolCallWaiters[index].count) {
				hungToolCallWaiters.splice(index, 1)[0].resolve();
			}
		}
	};

	const spawn = (_command: string, _args: string[], spawnOptionsReceived: IFakeDevtoolsSpawnOptions): ChildProcessWithoutNullStreams => {
		spawnOptions.push(spawnOptionsReceived);
		const process = new EventEmitter();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		let killCount = 0;
		const killSignals: (NodeJS.Signals | number)[] = [];
		let exited = false;
		let stdinBuffer = '';
		const pendingToolCallIds: number[] = [];
		const requests: { readonly method: string; readonly params: unknown }[] = [];
		const childRequestWaiters = new Map<string, (result: unknown) => void>();
		const requestWaiters: { readonly method: string; readonly resolve: () => void }[] = [];
		const recordRequest = (method: string, params: unknown) => {
			requests.push({ method, params });
			for (let index = requestWaiters.length - 1; index >= 0; index--) {
				if (requestWaiters[index].method === method) {
					requestWaiters.splice(index, 1)[0].resolve();
				}
			}
		};
		let nextChildRequestId = 1;
		const respond = (id: number, result: unknown) => queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
		const respondWithError = (id: number, message: string) => queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`));

		stdin.on('data', (chunk: Buffer) => {
			stdinBuffer += chunk.toString('utf8');
			let newlineIndex: number;
			while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
				const line = stdinBuffer.slice(0, newlineIndex);
				stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
				const request = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown; result?: unknown };
				if (request.id === undefined) {
					if (request.method !== undefined) {
						recordRequest(request.method, request.params);
					}
					continue;
				}
				if (request.method === undefined) {
					// The proxy's answer to a request the child sent
					childRequestWaiters.get(String(request.id))?.(request.result);
					childRequestWaiters.delete(String(request.id));
					continue;
				}
				recordRequest(request.method, request.params);
				if (typeof request.id !== 'number') {
					continue;
				}
				if (request.method === 'tools/call' && toolCallErrors.length > 0) {
					respondWithError(request.id, toolCallErrors.shift()!);
					continue;
				}
				if (request.method === 'tools/call' && remainingHungToolCalls > 0) {
					remainingHungToolCalls--;
					if (stderrBeforeHungToolCall !== undefined) {
						stderr.write(stderrBeforeHungToolCall);
						stderrBeforeHungToolCall = undefined;
					}
					pendingToolCallIds.push(request.id);
					hungToolCallCount++;
					resolveHungToolCallWaiters();
					continue;
				}
				const result = request.method === 'tools/list'
					? options.toolsListResult ?? { tools: [{ name: 'take_snapshot' }] }
					: request.method === 'tools/call'
						? (toolCallResults.length > 0 ? toolCallResults.shift() : { content: [{ type: 'text', text: 'ok' }] })
						: {};
				respond(request.id, result);
			}
		});

		const emitExit = () => {
			if (!exited) {
				exited = true;
				process.emit('exit', null, 'SIGTERM');
			}
		};
		const child = Object.assign(process, {
			stdin,
			stdout,
			stderr,
			pid: 1000 + children.length,
			kill: (signal: NodeJS.Signals | number = 'SIGTERM') => {
				killCount++;
				killSignals.push(signal);
				if (!options.ignoreKillExit || signal === 'SIGKILL') {
					queueMicrotask(emitExit);
				}
				return true;
			},
		}) as unknown as ChildProcessWithoutNullStreams;
		children.push({
			child,
			get killCount() { return killCount; },
			get killSignals() { return killSignals; },
			emitExit,
			respondToPendingToolCalls: () => {
				for (const id of pendingToolCallIds.splice(0)) {
					respond(id, { content: [{ type: 'text', text: 'late' }] });
				}
			},
			requestFromChild: method => new Promise<unknown>(resolve => {
				const id = `child-${nextChildRequestId++}`;
				childRequestWaiters.set(id, resolve);
				stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`);
			}),
			requests,
			waitForRequest: method => requests.some(request => request.method === method)
				? Promise.resolve()
				: new Promise<void>(resolve => requestWaiters.push({ method, resolve })),
		});
		return child;
	};

	return {
		children,
		spawn,
		spawnOptions,
		get hungToolCallCount() { return hungToolCallCount; },
		hangNextToolCalls: (count, stderr) => {
			remainingHungToolCalls += count;
			stderrBeforeHungToolCall = stderr;
		},
		failNextToolCall: message => toolCallErrors.push(message),
		waitForHungToolCalls: count => hungToolCallCount >= count
			? Promise.resolve()
			: new Promise(resolve => hungToolCallWaiters.push({ count, resolve })),
	};
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(complete => resolve = complete);
	return { promise, resolve };
}

function createCountingAbortController(): { readonly signal: AbortSignal; readonly listenerCount: number; abort(): void } {
	const controller = new AbortController();
	const abortListeners = new Set<EventListenerOrEventListenerObject>();
	const signal = {
		get aborted() { return controller.signal.aborted; },
		get reason() { return controller.signal.reason; },
		onabort: null,
		throwIfAborted: () => controller.signal.throwIfAborted(),
		dispatchEvent: (event: Event) => controller.signal.dispatchEvent(event),
		addEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
			if (type === 'abort') {
				abortListeners.add(listener);
			}
			controller.signal.addEventListener(type, listener, options);
		},
		removeEventListener: (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
			if (type === 'abort') {
				abortListeners.delete(listener);
			}
			controller.signal.removeEventListener(type, listener, options);
		},
	} as unknown as AbortSignal;
	return {
		signal,
		get listenerCount() { return abortListeners.size; },
		abort: () => controller.abort(),
	};
}

suite('ParadisDevtoolsMcpProxy', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces a child when generation changes', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await proxy.tryCallTool('secret-token', 2, 'ws://two', 'take_snapshot', {});
		assert.strictEqual(fixture.children.length, 2);
		assert.strictEqual(fixture.children[0].killCount, 1);
	});

	test('asks the vendored child to redact cookie and other sensitive network headers', async () => {
		const fixture = createFakeDevtoolsChildren();
		let receivedArgs: string[] = [];
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: (command, args, options) => {
				receivedArgs = args;
				return fixture.spawn(command, args, options);
			},
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		assert.strictEqual(receivedArgs.includes('--redactNetworkHeaders=true'), true);
	});

	test('disables update checks for the vendored child', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');

		assert.strictEqual(fixture.spawnOptions[0].env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
	});

	test('rejects an older generation without replacing the newer child', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		await proxy.tryCallTool('secret-token', 2, 'ws://two', 'take_snapshot', {});

		const stale = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			isError: stale.isError,
			retryable: stale.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
			newerChildKillCount: fixture.children[1].killCount,
		}, { isError: true, retryable: true, childCount: 2, newerChildKillCount: 0 });
	});

	test('rejects an older generation after a childless generation advance', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		proxy.retire('secret-token', 2);

		const stale = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			isError: stale.isError,
			retryable: stale.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
		}, { isError: true, retryable: true, childCount: 0 });
	});

	test('does not retry after Target closed once the call has used its time while the child got ready', async () => {
		const fixture = createFakeDevtoolsChildren({
			toolCallResults: [{ content: [{ type: 'text', text: 'Error: Protocol error (Accessibility.getFullAXTree): Target closed' }], isError: true }],
		});
		// The clock reads 0 at the start, 999 after the first call, and 1000 once the child is ready again.
		const readings = [0, 999];
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 1000,
			now: () => readings.shift() ?? 1000,
		}));
		const { result } = await withRecordedReports(async () => [await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {})]);
		assert.deepStrictEqual({
			isError: (result[0] as { isError?: boolean }).isError,
			toolCalls: fixture.children[0].requests.filter(request => request.method === 'tools/call').length,
		}, { isError: true, toolCalls: 1 });
	});

	test('serves the next part of a long snapshot from the one just taken, and drops it when another tool runs', async () => {
		const longSnapshot = { content: [{ type: 'text', text: `## Latest page snapshot\n${'uid=1_1 button "x"\n'.repeat(2000)}` }] };
		const fixture = createFakeDevtoolsChildren({
			toolsListResult: { tools: [{ name: 'take_snapshot' }, { name: 'click' }] },
			toolCallResults: [longSnapshot, { content: [{ type: 'text', text: 'clicked' }] }, longSnapshot, longSnapshot],
		});
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		const call = async (name: string, args: object) => ((await proxy.tryCallTool('secret-token', 1, 'ws://one', name, args)) as { content: { text: string }[] }).content[0].text;
		const toolCalls = () => fixture.children[0].requests.filter(request => request.method === 'tools/call').length;

		await call('take_snapshot', {});
		const cached = await call('take_snapshot', { offset: 20 });
		const afterCachedPart = toolCalls();
		await call('click', { uid: '1_1' });
		await call('take_snapshot', { offset: 20 });
		const afterClick = toolCalls();
		// verbose snapshots are never kept or served from what was kept.
		await call('take_snapshot', { verbose: true });
		await call('take_snapshot', { offset: 20, verbose: true });

		assert.deepStrictEqual({
			afterCachedPart,
			cachedNote: /taken at \d{4}-\d{2}-\d{2}T/.test(cached),
			afterClick,
			afterVerbose: toolCalls(),
		}, { afterCachedPart: 1, cachedNote: true, afterClick: 3, afterVerbose: 5 });
	});

	test('turns an agent take_snapshot into the changes since its previous one only when asked, and keeps the whole page for the next part', async () => {
		const rows = Array.from({ length: 2000 }, (_, i) => `  uid=1_${i + 10} StaticText "Row ${i}"`).join('\n');
		const page = (value: string) => ({ content: [{ type: 'text', text: `## Latest page snapshot\nuid=1_0 RootWebArea "Form"\n  uid=1_1 textbox "Name" value="${value}"\n${rows}\n` }] });
		const fixture = createFakeDevtoolsChildren({
			toolsListResult: { tools: [{ name: 'take_snapshot' }] },
			toolCallResults: [page('Ann'), page('Bob'), page('Bob'), page('Cid')],
		});
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		const call = async (args: object, mode?: 'diff' | 'full') => ((await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', args, undefined, mode)) as { content: { text: string }[] }).content[0].text;

		const first = await call({}, 'diff');
		const second = await call({}, 'diff');
		const nextPart = await call({ offset: 20 }, 'diff');
		const withoutMode = await call({});
		const afterWithoutMode = await call({}, 'diff');
		assert.deepStrictEqual({
			first: first.startsWith('## Latest page snapshot\n'),
			second: second.split('\n').slice(2),
			nextPart: nextPart.includes('Row 0') || nextPart.includes('Row 1'),
			withoutMode: withoutMode.startsWith('## Latest page snapshot\n'),
			afterWithoutMode: afterWithoutMode.split('\n').slice(2),
		}, {
			first: true,
			second: ['Changed:', '~ uid=1_1 textbox "Name" value="Bob"', ''],
			nextPart: true,
			withoutMode: true,
			// the call without a mode (Para Code's own, or the setting off) does not move what the agent last saw
			afterWithoutMode: ['Changed:', '~ uid=1_1 textbox "Name" value="Cid"', ''],
		});
	});

	test('asks to measure the snapshot root only when the vendored take_snapshot knows the argument, and keeps the measurement out of the text', async () => {
		const rect = { x: 5, y: 6, width: 70, height: 80 };
		const body = '## Latest page snapshot\nuid=1_0 RootWebArea\n  uid=1_1 dialog\n    uid=1_2 textbox\n';
		const answer = { content: [{ type: 'text', text: `${PARADIS_SNAPSHOT_ROOT_RECT_MARKER}${JSON.stringify(rect)}\n${body}` }] };
		const run = async (properties: object, args: object) => {
			const fixture = createFakeDevtoolsChildren({
				toolsListResult: { tools: [{ name: 'take_snapshot', inputSchema: { type: 'object', properties } }] },
				toolCallResults: [answer],
			});
			const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
			const result = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', args) as { content: { text: string }[] };
			const sent = fixture.children[0].requests.find(request => request.method === 'tools/call')?.params as { arguments: object };
			return { sent: sent.arguments, marker: result.content[0].text.startsWith(PARADIS_SNAPSHOT_ROOT_RECT_MARKER), rect: paradisSnapshotRootRectOf(result) };
		};
		assert.deepStrictEqual({
			patched: await run({ paraCodeRootRect: { type: 'string' } }, { root: '1_1' }),
			unpatched: await run({}, { root: '1_1' }),
		}, {
			patched: { sent: { paraCodeRootRect: '1_1' }, marker: false, rect },
			// Without the PARA-PATCH the vendored tool would refuse the unknown argument, so it is not sent (and nothing is read).
			unpatched: { sent: {}, marker: true, rect: undefined },
		});
	});

	test('reports a failed tool result to Sentry as a bucket, never the text, and retries a read-only tool once after Target closed', async () => {
		const fixture = createFakeDevtoolsChildren({
			toolCallResults: [
				{ content: [{ type: 'text', text: 'Error: Protocol error (Accessibility.getFullAXTree): Target closed at /Users/alice/private' }], isError: true },
				{ content: [{ type: 'text', text: 'ok' }] },
			],
		});
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		const { result, reports } = await withRecordedReports(async () => [
			await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}),
		]);

		assert.deepStrictEqual({
			isError: result.map(r => (r as { isError?: boolean }).isError),
			reports: reports.map(r => ({ ...r, extra: { ...r.extra, ...(r.extra?.duration_ms !== undefined ? { duration_ms: typeof r.extra.duration_ms } : {}) } })),
		}, {
			isError: [undefined],
			reports: [{
				feature: 'agent-browser',
				operation: 'devtools-tool-error-target-closed',
				extra: { duration_ms: 'number', safe_tool_name: 'take_snapshot', safe_error_kind: 'target-closed', safe_gate_reason: 'none', safe_cdp_method: 'Accessibility.getFullAXTree' },
				severity: 'info',
			}, {
				feature: 'agent-browser',
				operation: 'devtools-target-closed-retry',
				extra: { safe_tool_name: 'take_snapshot', safe_retry_succeeded: true },
				severity: 'info',
			}],
		});
		assert.ok(!JSON.stringify(reports).includes('alice'));
	});

	test('reports JSON-RPC errors and timeouts with their code and method only', async () => {
		const fixture = createFakeDevtoolsChildren({ toolCallErrors: ['Invalid arguments token=secret'], hangToolCalls: 1 });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn, callTimeoutMs: 10 }));
		const { reports } = await withRecordedReports(async () => [
			await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}),
			await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}),
		]);

		assert.deepStrictEqual(reports.map(r => ({ operation: r.operation, extra: { ...r.extra, duration_ms: typeof r.extra?.duration_ms }, severity: r.severity })), [
			{ operation: 'devtools-rpc-error', extra: { duration_ms: 'number', safe_tool_name: 'take_snapshot', safe_rpc_code: -32000 }, severity: 'warning' },
			{ operation: 'devtools-call-timeout', extra: { duration_ms: 'number', safe_tool_name: 'take_snapshot', safe_method: 'tools/call' }, severity: 'warning' },
		]);
		assert.ok(!JSON.stringify(reports).includes('secret'));
	});

	test('redacts token and endpoint from JSON-RPC tool errors', async () => {
		const token = 'secret/token value';
		const encodedToken = encodeURIComponent(token);
		const wsEndpoint = `ws://one/cdp?pane=${encodedToken}`;
		const privateDetail = 'PRIVATE_CHILD_ERROR api_key=do-not-expose';
		const fixture = createFakeDevtoolsChildren({ toolCallErrors: [`${privateDetail} token=${token} encoded=${encodedToken} endpoint=${wsEndpoint}`] });
		const logService = new CapturingLogService();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools(token, 1, wsEndpoint);

		const result = await proxy.tryCallTool(token, 1, wsEndpoint, 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		const text = result.content?.[0]?.text ?? '';
		assert.deepStrictEqual({
			isError: result.isError,
			hasPrivateDetail: text.includes(privateDetail),
			logsPrivateDetail: logService.messages.some(message => message.includes(privateDetail)),
			hasToken: text.includes(token),
			hasEncodedToken: text.includes(encodedToken),
			hasEndpoint: text.includes(wsEndpoint),
		}, { isError: true, hasPrivateDetail: false, logsPrivateDetail: false, hasToken: false, hasEncodedToken: false, hasEndpoint: false });
	});

	test('does not expose arbitrary timed out child stderr in the tool result', async () => {
		const token = 'secret/token value';
		const encodedToken = encodeURIComponent(token);
		const wsEndpoint = `ws://one/cdp?pane=${encodedToken}`;
		const privateStderr = 'PRIVATE_CHILD_STDERR api_key=do-not-expose';
		const fixture = createFakeDevtoolsChildren({
			hangToolCalls: 1,
			stderrBeforeHungToolCall: `${privateStderr} token=${token} encoded=${encodedToken} endpoint=${wsEndpoint}`,
		});
		const logService = new CapturingLogService();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn, callTimeoutMs: 10 }));
		await proxy.listTools(token, 1, wsEndpoint);

		const result = await proxy.tryCallTool(token, 1, wsEndpoint, 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		const text = result.content?.[0]?.text ?? '';
		assert.deepStrictEqual({
			isError: result.isError,
			hasPrivateStderr: text.includes(privateStderr),
			logsPrivateStderr: logService.messages.some(message => message.includes(privateStderr)),
			hasToken: text.includes(token),
			hasEncodedToken: text.includes(encodedToken),
			hasEndpoint: text.includes(wsEndpoint),
		}, { isError: true, hasPrivateStderr: false, logsPrivateStderr: false, hasToken: false, hasEncodedToken: false, hasEndpoint: false });
	});

	test('kills a timed out child and respawns on the next call', async () => {
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 10,
		}));
		const first = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		const second = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			firstIsError: (first as { isError?: boolean }).isError,
			firstChildKillCount: fixture.children[0].killCount,
			secondIsError: second.isError,
			secondText: second.content?.[0]?.text,
			childCount: fixture.children.length,
		}, { firstIsError: true, firstChildKillCount: 1, secondIsError: undefined, secondText: 'ok', childCount: 2 });
	});

	test('kills a child when its client aborts', async () => {
		const controller = new AbortController();
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const call = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, controller.signal);
		await fixture.waitForHungToolCalls(1);
		controller.abort();
		assert.strictEqual((await call as { isError?: boolean }).isError, true);
		assert.strictEqual(fixture.children[0].killCount, 1);
	});

	test('settles all pending calls once and ignores late responses after abort', async () => {
		const controller = new AbortController();
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		fixture.hangNextToolCalls(2);
		const first = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, controller.signal);
		const second = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(2);

		controller.abort();
		const results = await Promise.all([first, second]) as { isError?: boolean }[];
		const recovered = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		fixture.children[0].respondToPendingToolCalls();
		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual({
			resultErrors: results.map(result => result.isError),
			oldChildKillCount: fixture.children[0].killCount,
			newChildKillCount: fixture.children[1].killCount,
			childCount: fixture.children.length,
			recoveredIsError: recovered.isError,
			recoveredText: recovered.content?.[0]?.text,
		}, {
			resultErrors: [true, true],
			oldChildKillCount: 1,
			newChildKillCount: 0,
			childCount: 2,
			recoveredIsError: undefined,
			recoveredText: 'ok',
		});
	});

	test('replaces a child when only its endpoint changes', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await proxy.tryCallTool('secret-token', 1, 'ws://two', 'take_snapshot', {});

		assert.deepStrictEqual({ childCount: fixture.children.length, oldChildKillCount: fixture.children[0].killCount }, { childCount: 2, oldChildKillCount: 1 });
	});

	test('does not kill another token child after a timeout', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn, callTimeoutMs: 10 }));
		await proxy.listTools('token-a', 1, 'ws://a');
		await proxy.tryCallTool('token-a', 1, 'ws://a', 'take_snapshot', {});
		await proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {});
		fixture.hangNextToolCalls(1);

		const timedOut = await proxy.tryCallTool('token-a', 1, 'ws://a', 'take_snapshot', {}) as { isError?: boolean };
		const other = await proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			timedOutIsError: timedOut.isError,
			tokenAChildKillCount: fixture.children[0].killCount,
			tokenBChildKillCount: fixture.children[1].killCount,
			otherIsError: other.isError,
			otherText: other.content?.[0]?.text,
		}, { timedOutIsError: true, tokenAChildKillCount: 1, tokenBChildKillCount: 0, otherIsError: undefined, otherText: 'ok' });
	});

	test('runs two tabs of one pane in separate children in parallel and retires one tab without touching the other', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		const tabA = paradisAgentTabScopeKey('pane-token', 'tab-a');
		const tabB = paradisAgentTabScopeKey('pane-token', 'tab-b');
		await proxy.listTools(tabA, 1, 'ws://a');
		await proxy.tryCallTool(tabA, 1, 'ws://a', 'take_snapshot', {});
		await proxy.tryCallTool(tabB, 2, 'ws://b', 'take_snapshot', {});
		fixture.hangNextToolCalls(1);

		const pendingA = proxy.tryCallTool(tabA, 1, 'ws://a', 'take_snapshot', {});
		const b = await proxy.tryCallTool(tabB, 2, 'ws://b', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		proxy.retire(tabA, 3);
		const a = await pendingA as { isError?: boolean };
		assert.deepStrictEqual({
			children: fixture.children.length,
			paneTokens: fixture.spawnOptions.map(options => options.env[PARADIS_PANE_TOKEN_ENV_VAR]),
			bWhileAHangs: [b.isError, b.content?.[0]?.text],
			aAfterRetire: a.isError,
			killCounts: fixture.children.map(child => child.killCount),
			liveB: proxy.hasLiveChild(tabB),
		}, {
			children: 2,
			paneTokens: ['pane-token', 'pane-token'],
			bWhileAHangs: [undefined, 'ok'],
			aAfterRetire: true,
			killCounts: [1, 0],
			liveB: true,
		});
	});

	test('removes abort listeners after success, error, and abort', async () => {
		const successFixture = createFakeDevtoolsChildren();
		const successProxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: successFixture.spawn }));
		await successProxy.listTools('success-token', 1, 'ws://success');
		const successController = createCountingAbortController();
		await successProxy.tryCallTool('success-token', 1, 'ws://success', 'take_snapshot', {}, successController.signal);

		const errorFixture = createFakeDevtoolsChildren({ toolCallErrors: ['failed'] });
		const errorProxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: errorFixture.spawn }));
		await errorProxy.listTools('error-token', 1, 'ws://error');
		const errorController = createCountingAbortController();
		await errorProxy.tryCallTool('error-token', 1, 'ws://error', 'take_snapshot', {}, errorController.signal);

		const abortFixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
		const abortProxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: abortFixture.spawn }));
		await abortProxy.listTools('abort-token', 1, 'ws://abort');
		const abortController = createCountingAbortController();
		const aborted = abortProxy.tryCallTool('abort-token', 1, 'ws://abort', 'take_snapshot', {}, abortController.signal);
		await abortFixture.waitForHungToolCalls(1);
		const abortListenerCountWhilePending = abortController.listenerCount;
		abortController.abort();
		await aborted;

		assert.deepStrictEqual({
			success: successController.listenerCount,
			error: errorController.listenerCount,
			abortWhilePending: abortListenerCountWhilePending,
			afterAbort: abortController.listenerCount,
		}, { success: 0, error: 0, abortWhilePending: 1, afterAbort: 0 });
	});

	test('ignores valid JSON primitives and arrays on child stdout', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const stdout = fixture.children[0].child.stdout;

		assert.doesNotThrow(() => {
			for (const value of ['null', '1', '"text"', 'true', '[]']) {
				stdout.emit('data', Buffer.from(`${value}\n`));
			}
		});
		const result = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({ isError: result.isError, text: result.content?.[0]?.text }, { isError: undefined, text: 'ok' });
	});

	test('rejects malformed tools list elements before caching or filtering them', async () => {
		const fixture = createFakeDevtoolsChildren({ toolsListResult: { tools: [null, 1, 'tool', [], {}, { name: 'take_snapshot' }] } });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));

		await assert.rejects(
			proxy.listTools('secret-token', 1, 'ws://one'),
			error => error instanceof Error && error.message === 'chrome-devtools-mcp returned an unexpected tools/list response',
		);
	});

	test('deeply freezes cached tool descriptors against caller mutation', async () => {
		const fixture = createFakeDevtoolsChildren({
			toolsListResult: {
				tools: [{ name: 'list_pages', inputSchema: { type: 'object', properties: { selector: { type: 'string' } } } }],
			},
		});
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		const tools = await proxy.listTools('secret-token', 1, 'ws://one');
		const mutableTool = tools[0] as { name: string; inputSchema: { properties: { selector: { type: string } } } };

		assert.strictEqual(Object.isFrozen(mutableTool), true);
		assert.strictEqual(Object.isFrozen(mutableTool.inputSchema.properties.selector), true);
		assert.throws(() => mutableTool.name = 'poisoned');
		assert.throws(() => mutableTool.inputSchema.properties.selector.type = 'number');
		const cached = await proxy.listTools('secret-token', 1, 'ws://one');
		assert.deepStrictEqual(cached, [{ name: 'list_pages', inputSchema: { type: 'object', properties: { selector: { type: 'string' } } } }]);
	});

	test('bounds newline-less stdout and rejects every pending request without exposing it', async () => {
		const privateStdout = 'PRIVATE_STDOUT api_key=do-not-expose';
		const fixture = createFakeDevtoolsChildren();
		const logService = new CapturingLogService();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 50,
			maxStdoutBufferBytes: 256,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		fixture.hangNextToolCalls(2);
		const first = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		const second = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(2);
		const stdout = fixture.children[0].child.stdout;
		assert.strictEqual(stdout.listenerCount('data'), 1);
		stdout.emit('data', Buffer.from(privateStdout.padEnd(257, 'x')));

		const results = await Promise.all([first, second]) as { content?: { text?: string }[]; isError?: boolean }[];
		stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { privateStdout } })}\n`));
		assert.deepStrictEqual({
			isError: results.map(result => result.isError),
			retryable: results.map(result => result.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE')),
			toolResultsExposeStdout: results.some(result => result.content?.[0]?.text?.includes(privateStdout)),
			logsExposeStdout: logService.messages.some(message => message.includes(privateStdout)),
			killCount: fixture.children[0].killCount,
			stdoutDataListeners: stdout.listenerCount('data'),
		}, {
			isError: [true, true],
			retryable: [true, true],
			toolResultsExposeStdout: false,
			logsExposeStdout: false,
			killCount: 1,
			stdoutDataListeners: 0,
		});
	});

	test('handles ten thousand stdout fragments within the byte limit', async () => {
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1 });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxStdoutBufferBytes: 16_384,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const call = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(1);
		for (let index = 0; index < 10_000; index++) {
			fixture.children[0].child.stdout.emit('data', Buffer.from(' '));
		}
		fixture.children[0].respondToPendingToolCalls();

		const result = await call as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({ isError: result.isError, text: result.content?.[0]?.text }, { isError: undefined, text: 'late' });
	});

	test('bounds pending requests when ten thousand calls arrive', async () => {
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 10_002 });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 50,
			maxPendingRequests: 2,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const firstController = new AbortController();
		const secondController = new AbortController();
		const accepted = [
			proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, firstController.signal),
			proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, secondController.signal),
		];
		await fixture.waitForHungToolCalls(2);
		const overflow = await Promise.all(Array.from({ length: 10_000 }, () =>
			proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as Promise<{ content?: { text?: string }[]; isError?: boolean }>));
		firstController.abort();
		secondController.abort();
		await Promise.all(accepted);

		assert.deepStrictEqual({
			hungToolCallCount: fixture.hungToolCallCount,
			allRetryable: overflow.every(result => result.isError === true && result.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE')),
			childCount: fixture.children.length,
		}, { hungToolCallCount: 2, allRetryable: true, childCount: 1 });
	});

	test('does not grow stdin or pending requests while backpressure has no drain', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 50,
			maxStdinQueuedBytes: 1_024,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const stdin = fixture.children[0].child.stdin;
		let queuedBytes = 0;
		Object.defineProperty(stdin, 'writableLength', { configurable: true, get: () => queuedBytes });
		stdin.write = ((chunk: string | Uint8Array) => {
			queuedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
			return false;
		}) as typeof stdin.write;

		const controller = new AbortController();
		const accepted = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}, controller.signal);
		await new Promise(resolve => setImmediate(resolve));
		const overflow = await Promise.all(Array.from({ length: 10_000 }, () =>
			proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as Promise<{ content?: { text?: string }[]; isError?: boolean }>));
		controller.abort();
		await accepted;

		assert.deepStrictEqual({
			queuedWithinLimit: queuedBytes <= 1_024,
			allRetryable: overflow.every(result => result.isError === true && result.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE')),
			childCount: fixture.children.length,
		}, { queuedWithinLimit: true, allRetryable: true, childCount: 1 });
	});

	test('rejects an oversized serialized request before adding it to stdin', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxStdinQueuedBytes: 256,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const oversized = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', { privateValue: 'x'.repeat(10_000) }) as { content?: { text?: string }[]; isError?: boolean };
		const recovered = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };

		assert.deepStrictEqual({
			retryable: oversized.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			recoveredText: recovered.content?.[0]?.text,
			killCount: fixture.children[0].killCount,
		}, { retryable: true, recoveredText: 'ok', killCount: 0 });
	});

	test('rejects a new token at the global child cap without evicting existing children', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxChildren: 2,
		}));
		await proxy.listTools('token-a', 1, 'ws://a');
		await proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {});

		const capped = await proxy.tryCallTool('token-c', 1, 'ws://c', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			isError: capped.isError,
			retryable: capped.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
			killCounts: fixture.children.map(child => child.killCount),
		}, { isError: true, retryable: true, childCount: 2, killCounts: [0, 0] });

		proxy.forget('token-a');
		await Promise.resolve();
		const admitted = await proxy.tryCallTool('token-c', 1, 'ws://c', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		const stale = await proxy.tryCallTool('token-c', 0, 'ws://stale', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			admittedText: admitted.content?.[0]?.text,
			staleRetryable: stale.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
		}, { admittedText: 'ok', staleRetryable: true, childCount: 3 });
	});

	test('returns a retryable global-cap error while the shared tools cache is unresolved', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxChildren: 1,
		}));
		const controller = new AbortController();
		const listing = proxy.listTools('token-a', 1, 'ws://a', controller.signal);
		const cappedCall = proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {}) as Promise<{ content?: { text?: string }[]; isError?: boolean } | undefined>;
		controller.abort();
		const capped = await cappedCall;
		await assert.rejects(listing);

		assert.deepStrictEqual({
			isError: capped?.isError,
			retryable: capped?.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
			killCount: fixture.children[0].killCount,
		}, { isError: true, retryable: true, childCount: 1, killCount: 1 });
	});

	test('keeps a killed child slot occupied until process exit is observed', async () => {
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1, ignoreKillExit: true });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 10,
			maxChildren: 1,
		}));
		await proxy.listTools('token-a', 1, 'ws://a');
		await proxy.tryCallTool('token-a', 1, 'ws://a', 'take_snapshot', {});

		const capped = await proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({
			retryable: capped.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE'),
			childCount: fixture.children.length,
		}, { retryable: true, childCount: 1 });

		fixture.children[0].emitExit();
		const admitted = await proxy.tryCallTool('token-b', 1, 'ws://b', 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		assert.deepStrictEqual({ text: admitted.content?.[0]?.text, childCount: fixture.children.length }, { text: 'ok', childCount: 2 });
	});

	test('escalates an ignored SIGTERM to SIGKILL and releases its timer on exit', async () => {
		const fixture = createFakeDevtoolsChildren({ hangToolCalls: 1, ignoreKillExit: true });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 5,
			killGraceTimeoutMs: 5,
			maxChildren: 1,
		}));
		await proxy.listTools('token-a', 1, 'ws://a');
		await proxy.tryCallTool('token-a', 1, 'ws://a', 'take_snapshot', {});
		await new Promise(resolve => setTimeout(resolve, 15));

		const child = fixture.children[0];
		assert.deepStrictEqual({
			killSignals: child.killSignals,
			errorListeners: child.child.listenerCount('error'),
			exitListeners: child.child.listenerCount('exit'),
			closeListeners: child.child.listenerCount('close'),
		}, { killSignals: ['SIGTERM', 'SIGKILL'], errorListeners: 0, exitListeners: 0, closeListeners: 0 });
	});

	test('bounds generation high-watermarks across ten thousand rejected tokens', async () => {
		const fixture = createFakeDevtoolsChildren({ ignoreKillExit: true });
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxChildren: 1,
			maxGenerationHighWatermarks: 4,
		}));
		await proxy.listTools('token-0', 1, 'ws://0');
		const rejected = await Promise.all(Array.from({ length: 10_000 }, (_, index) =>
			proxy.tryCallTool(`token-${index + 1}`, 1, `ws://${index + 1}`, 'take_snapshot', {}) as Promise<{ content?: { text?: string }[]; isError?: boolean }>));
		const highWatermarks = (proxy as unknown as { readonly _generationHighWatermarks: ReadonlyMap<string, number> })._generationHighWatermarks;

		assert.deepStrictEqual({
			allRetryable: rejected.every(result => result.isError === true && result.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE')),
			highWatermarkSize: highWatermarks.size,
			childCount: fixture.children.length,
		}, { allRetryable: true, highWatermarkSize: 1, childCount: 1 });
	});

	test('bounds generation high-watermarks independently of the child cap', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			maxChildren: 32,
			maxGenerationHighWatermarks: 4,
		}));
		await proxy.listTools('token-0', 1, 'ws://0');
		const results = await Promise.allSettled(Array.from({ length: 10_000 }, (_, index) =>
			proxy.listTools(`token-${index + 1}`, 1, `ws://${index + 1}`)));
		const highWatermarks = (proxy as unknown as { readonly _generationHighWatermarks: ReadonlyMap<string, number> })._generationHighWatermarks;

		assert.deepStrictEqual({
			highWatermarkSize: highWatermarks.size,
			rejected: results.filter(result => result.status === 'rejected').length,
			childCount: fixture.children.length,
		}, { highWatermarkSize: 4, rejected: 9_997, childCount: 1 });
	});

	test('fails closed without respawning after disposal', async () => {
		const token = 'secret-token';
		const wsEndpoint = 'ws://secret-endpoint';
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools(token, 1, wsEndpoint);
		proxy.dispose();

		await assert.rejects(proxy.listTools(token, 2, wsEndpoint), /PARA_BROWSER_RETRYABLE/);
		const call = await proxy.tryCallTool(token, 2, wsEndpoint, 'take_snapshot', {}) as { content?: { text?: string }[]; isError?: boolean };
		const proxied = await proxy.isProxiedTool(token, 2, wsEndpoint, 'take_snapshot');
		const text = call.content?.[0]?.text ?? '';
		assert.deepStrictEqual({
			isError: call.isError,
			retryable: text.includes('PARA_BROWSER_RETRYABLE'),
			exposesToken: text.includes(token),
			exposesEndpoint: text.includes(wsEndpoint),
			proxied,
			childCount: fixture.children.length,
			killCount: fixture.children[0].killCount,
		}, { isError: true, retryable: true, exposesToken: false, exposesEndpoint: false, proxied: false, childCount: 1, killCount: 1 });
	});

	test('settles pending requests once and ignores late stdout after disposal', async () => {
		const fixture = createFakeDevtoolsChildren();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		fixture.hangNextToolCalls(2);
		const first = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		const second = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(2);

		proxy.dispose();
		const results = await Promise.all([first, second]) as { content?: { text?: string }[]; isError?: boolean }[];
		fixture.children[0].respondToPendingToolCalls();
		await Promise.resolve();
		assert.deepStrictEqual({
			allRetryable: results.every(result => result.isError === true && result.content?.[0]?.text?.includes('PARA_BROWSER_RETRYABLE')),
			killCount: fixture.children[0].killCount,
			stdoutDataListeners: fixture.children[0].child.stdout.listenerCount('data'),
		}, { allRetryable: true, killCount: 1, stdoutDataListeners: 0 });
	});

	test('genericizes arbitrary process error details in logs and tool results', async () => {
		const privateDetail = 'PRIVATE_PROCESS_ERROR api_key=do-not-expose';
		const fixture = createFakeDevtoolsChildren();
		const logService = new CapturingLogService();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, { temporaryDirectory: TEST_TEMPORARY_DIRECTORY, spawnChild: fixture.spawn }));
		await proxy.listTools('secret-token', 1, 'ws://one');
		fixture.hangNextToolCalls(1);
		const pending = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(1);
		fixture.children[0].child.emit('error', new Error(privateDetail));

		const result = await pending as { content?: { text?: string }[]; isError?: boolean };
		const text = result.content?.[0]?.text ?? '';
		assert.deepStrictEqual({
			isError: result.isError,
			retryable: text.includes('PARA_BROWSER_RETRYABLE'),
			resultExposesDetail: text.includes(privateDetail),
			logsExposeDetail: logService.messages.some(message => message.includes(privateDetail)),
		}, { isError: true, retryable: true, resultExposesDetail: false, logsExposeDetail: false });
	});

	test('continues kill and listener cleanup when diagnostic logging throws', async () => {
		const fixture = createFakeDevtoolsChildren();
		const logService = new ThrowingDiagnosticLogService();
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, {
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			spawnChild: fixture.spawn,
			callTimeoutMs: 50,
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		fixture.hangNextToolCalls(1);
		const pending = proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', {});
		await fixture.waitForHungToolCalls(1);
		const child = fixture.children[0].child;
		logService.throwOnDiagnostics = true;
		assert.doesNotThrow(() => child.emit('error', new Error('child failed')));
		assert.strictEqual((await pending as { isError?: boolean }).isError, true);
		await Promise.resolve();

		assert.deepStrictEqual({
			killCount: fixture.children[0].killCount,
			stdoutDataListeners: child.stdout.listenerCount('data'),
			errorListeners: child.listenerCount('error'),
			exitListeners: child.listenerCount('exit'),
		}, { killCount: 1, stdoutDataListeners: 0, errorListeners: 0, exitListeners: 0 });
	});

	test('detects a generation change while lookup has no binding', async () => {
		const coordinator = new ParadisDevtoolsGenerationCoordinator(() => { });
		const lookup = createDeferred();
		coordinator.setGeneration('secret-token', 1);
		const capturedGeneration = coordinator.getGeneration('secret-token')!;
		const result = coordinator.runWithLease('secret-token', async () => {
			await lookup.promise;
			return coordinator.isCurrentGeneration('secret-token', capturedGeneration) ? 'ok' : 'PARA_BROWSER_RETRYABLE';
		});

		coordinator.setGeneration('secret-token', 2);
		lookup.resolve();
		assert.strictEqual(await result, 'PARA_BROWSER_RETRYABLE');
	});

	test('forgets only after the last lease added during pending forget', async () => {
		const forgotten: string[] = [];
		const coordinator = new ParadisDevtoolsGenerationCoordinator(token => forgotten.push(token));
		const first = createDeferred();
		const second = createDeferred();
		coordinator.setGeneration('secret-token', 1);
		const firstLease = coordinator.runWithLease('secret-token', () => first.promise);
		coordinator.forgetWhenIdle('secret-token', 1);
		const secondLease = coordinator.runWithLease('secret-token', () => second.promise);

		first.resolve();
		await firstLease;
		assert.deepStrictEqual(forgotten, []);
		second.resolve();
		await secondLease;
		assert.deepStrictEqual({ forgotten, generation: coordinator.getGeneration('secret-token') }, { forgotten: ['secret-token'], generation: undefined });
	});

	test('cleans generation state after an idle forget', () => {
		const forgotten: string[] = [];
		const coordinator = new ParadisDevtoolsGenerationCoordinator(token => forgotten.push(token));
		coordinator.setGeneration('secret-token', 1);
		coordinator.forgetWhenIdle('secret-token', 1);
		coordinator.setGeneration('secret-token', 2);
		coordinator.forgetWhenIdle('secret-token', 2);

		assert.deepStrictEqual({ forgotten, generation: coordinator.getGeneration('secret-token') }, {
			forgotten: ['secret-token', 'secret-token'],
			generation: undefined,
		});
	});

	test('cancels pending forget when a token is rebound', async () => {
		const forgotten: string[] = [];
		const coordinator = new ParadisDevtoolsGenerationCoordinator(token => forgotten.push(token));
		const operation = createDeferred();
		coordinator.setGeneration('secret-token', 1);
		const lease = coordinator.runWithLease('secret-token', () => operation.promise);
		coordinator.forgetWhenIdle('secret-token', 1);
		coordinator.setGeneration('secret-token', 2, true);

		operation.resolve();
		await lease;
		assert.deepStrictEqual({ forgotten, generation: coordinator.getGeneration('secret-token') }, { forgotten: [], generation: 2 });
	});

	test('updates a pending forget to a delayed unbind generation', async () => {
		const forgotten: string[] = [];
		const coordinator = new ParadisDevtoolsGenerationCoordinator(token => forgotten.push(token));
		const operation = createDeferred();
		coordinator.setGeneration('secret-token', 1);
		const lease = coordinator.runWithLease('secret-token', () => operation.promise);
		coordinator.forgetWhenIdle('secret-token', 1);
		coordinator.setGeneration('secret-token', 2, false);

		operation.resolve();
		await lease;
		assert.deepStrictEqual({ forgotten, generation: coordinator.getGeneration('secret-token') }, { forgotten: ['secret-token'], generation: undefined });
	});


	test('advertises roots and answers roots/list with the pane folders and the Para Code temporary folder', async () => {
		const fixture = createFakeDevtoolsChildren();
		const space = join(tmpdir(), 'para-code-space');
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			spawnChild: fixture.spawn,
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			resolveRoots: async token => ({ folders: token === 'secret-token' ? [space, 'relative/folder', space] : [], complete: true }),
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const rootsResult = await fixture.children[0].requestFromChild('roots/list');
		const env = fixture.spawnOptions[0].env;

		assert.deepStrictEqual({
			capabilities: (fixture.children[0].requests.find(request => request.method === 'initialize')?.params as { capabilities?: unknown } | undefined)?.capabilities,
			temporaryEnv: [env.TMPDIR, env.TMP, env.TEMP],
			rootsResult,
		}, {
			capabilities: { roots: { listChanged: true } },
			temporaryEnv: [TEST_TEMPORARY_DIRECTORY, TEST_TEMPORARY_DIRECTORY, TEST_TEMPORARY_DIRECTORY],
			rootsResult: {
				roots: [
					{ uri: pathToFileURL(space).href, name: 'workspace' },
					{ uri: pathToFileURL(TEST_TEMPORARY_DIRECTORY).href, name: 'Para Code temporary files' },
				],
			},
		});
	});

	test('answers roots/list with only the temporary folder when the pane folders throw, reject or hang', async () => {
		const rootsFor = async (resolveRoots: (token: string) => Promise<{ folders: readonly string[]; complete: boolean }>) => {
			const fixture = createFakeDevtoolsChildren();
			const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), { spawnChild: fixture.spawn, temporaryDirectory: TEST_TEMPORARY_DIRECTORY, resolveRoots, rootsTimeoutMs: 1, rootsRetryDelayMs: 60_000 }));
			await proxy.listTools('secret-token', 1, 'ws://one');
			const result = await fixture.children[0].requestFromChild('roots/list');
			proxy.dispose();
			return result;
		};
		const onlyTemporary = { roots: [{ uri: pathToFileURL(TEST_TEMPORARY_DIRECTORY).href, name: 'Para Code temporary files' }] };

		assert.deepStrictEqual({
			thrown: await rootsFor(() => { throw new Error('sync failure'); }),
			rejected: await rootsFor(async () => { throw new Error('window gone'); }),
			hung: await rootsFor(() => new Promise(() => { })),
		}, { thrown: onlyTemporary, rejected: onlyTemporary, hung: onlyTemporary });
	});

	test('asks the child to re-read roots once degraded pane folders resolve, and never answers with the stale set again', async () => {
		const fixture = createFakeDevtoolsChildren();
		const space = join(tmpdir(), 'para-code-space');
		let windowReady = false;
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			spawnChild: fixture.spawn,
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			rootsRetryDelayMs: 1,
			resolveRoots: async () => windowReady ? { folders: [space], complete: true } : { folders: [], complete: false },
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const child = fixture.children[0];
		const degraded = await child.requestFromChild('roots/list');
		windowReady = true;
		await child.waitForRequest('notifications/roots/list_changed');
		// A slow window must not be able to take the folders back once they were resolved.
		windowReady = false;
		const refreshed = await child.requestFromChild('roots/list');

		const temporaryRoot = { uri: pathToFileURL(TEST_TEMPORARY_DIRECTORY).href, name: 'Para Code temporary files' };
		assert.deepStrictEqual({ degraded, refreshed }, {
			degraded: { roots: [temporaryRoot] },
			refreshed: { roots: [{ uri: pathToFileURL(space).href, name: 'workspace' }, temporaryRoot] },
		});
	});

	test('answers an early roots request that resolves late with the folders a later request already resolved', async () => {
		const fixture = createFakeDevtoolsChildren();
		const space = join(tmpdir(), 'para-code-space');
		let releaseFirst!: () => void;
		let calls = 0;
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			spawnChild: fixture.spawn,
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			rootsRetryDelayMs: 60_000,
			resolveRoots: () => ++calls === 1
				? new Promise(resolve => releaseFirst = () => resolve({ folders: [], complete: false }))
				: Promise.resolve({ folders: [space], complete: true }),
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const child = fixture.children[0];
		const first = child.requestFromChild('roots/list');
		const second = await child.requestFromChild('roots/list');
		releaseFirst();

		assert.deepStrictEqual(await first, second);
	});

	test('logs pane folders dropped over the roots limit', async () => {
		const fixture = createFakeDevtoolsChildren();
		const logService = new CapturingLogService();
		const folders = Array.from({ length: 20 }, (_, index) => join(tmpdir(), `para-code-space-${index}`));
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), logService, {
			spawnChild: fixture.spawn,
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			resolveRoots: async () => ({ folders, complete: true }),
		}));
		await proxy.listTools('secret-token', 1, 'ws://one');
		const result = await fixture.children[0].requestFromChild('roots/list') as { roots: unknown[] };

		assert.deepStrictEqual({
			roots: result.roots.length,
			logged: logService.messages.some(message => message.includes('4 workspace folder(s) were left out')),
		}, { roots: 17, logged: true });
	});

	test('forwards a local path argument unchanged and explains a roots denial with the allowed folders', async () => {
		const outside = join(tmpdir(), 'elsewhere', 'snapshot.txt');
		const fixture = createFakeDevtoolsChildren({
			toolCallResults: [
				{ content: [{ type: 'text', text: 'ok' }] },
				{ content: [{ type: 'text', text: `Access denied: path ${outside} (canonical: ${outside}) is not within any of the configured workspace roots.` }], isError: true },
			],
		});
		const space = join(tmpdir(), 'para-code-space');
		const proxy = disposables.add(new ParadisDevtoolsMcpProxy(new Set(), new NullLogService(), {
			spawnChild: fixture.spawn,
			temporaryDirectory: TEST_TEMPORARY_DIRECTORY,
			resolveRoots: async () => ({ folders: [space], complete: true }),
		}));
		const inside = join(space, 'snapshot.txt');
		await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', { filePath: inside });
		await fixture.children[0].requestFromChild('roots/list');
		const denied = await proxy.tryCallTool('secret-token', 1, 'ws://one', 'take_snapshot', { filePath: outside });

		assert.deepStrictEqual({
			forwarded: fixture.children[0].requests.filter(request => request.method === 'tools/call').map(request => request.params),
			denied,
		}, {
			forwarded: [
				{ name: 'take_snapshot', arguments: { filePath: inside } },
				{ name: 'take_snapshot', arguments: { filePath: outside } },
			],
			denied: {
				content: [{ type: 'text', text: `Access denied: ${outside} is outside the folders the browser tools may read and write for this terminal pane. Allowed folders: ${space}, ${TEST_TEMPORARY_DIRECTORY}. Use a path inside one of them, or call the tool without the path argument to get the result inline where the tool supports it (take_screenshot, take_snapshot, evaluate_script, get_network_request).` }],
				isError: true,
			},
		});
	});
});

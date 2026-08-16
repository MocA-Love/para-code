/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult, IFileContent, IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentEnvironment } from '../../../../../platform/remote/common/remoteAgentEnvironment.js';
import { GeneralShellType, PosixShellType, TerminalShellType } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { clearShellFileHistory, getCommandHistory, getShellFileHistory, ITerminalPersistedHistory } from '../../../../../workbench/contrib/terminalContrib/history/common/history.js';
import { ITerminalCompletion, TerminalCompletionItemKind } from '../../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionItem.js';
import { ITerminalCompletionProvider, ITerminalCompletionService } from '../../../../../workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { paradisDecodeZshHistory, paradisParseBashHistory, paradisParseZshHistory, paradisTerminalHistoryCacheKey } from '../../common/paradisTerminalHistoryCache.js';
import { IParadisTerminalHistoryCompletionProviderOptions, ParadisTerminalHistoryCompletionContribution, ParadisTerminalHistoryCompletionProvider } from '../../browser/paradisTerminalHistoryCompletion.contribution.js';

class Deferred<T> {
	private _resolve!: (value: T | PromiseLike<T>) => void;
	private _reject!: (error: unknown) => void;
	readonly promise = new Promise<T>((resolve, reject) => {
		this._resolve = resolve;
		this._reject = reject;
	});

	resolve(value: T): void {
		this._resolve(value);
	}

	reject(error: unknown): void {
		this._reject(error);
	}
}

class TrackedDeferred<T> {
	private _resolve!: (value: T | PromiseLike<T>) => void;
	private _reject!: (error: unknown) => void;
	private readonly _source = new Promise<T>((resolve, reject) => {
		this._resolve = resolve;
		this._reject = reject;
	});
	readonly promise: Promise<T>;
	thenCount = 0;
	rejectionHandlerCount = 0;

	constructor() {
		const source = this._source;
		const self = this;
		this.promise = new class implements Promise<T> {
			readonly [Symbol.toStringTag] = 'Promise';
			then<TResult1 = T, TResult2 = never>(
				onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
			): Promise<TResult1 | TResult2> {
				self.thenCount++;
				if (onrejected) {
					self.rejectionHandlerCount++;
				}
				return source.then(onfulfilled, onrejected);
			}
			catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
				return source.catch(onrejected);
			}
			finally(onfinally?: (() => void) | null): Promise<T> {
				return source.finally(onfinally);
			}
		}();
	}

	resolve(value: T): void {
		this._resolve(value);
	}

	reject(error: unknown): void {
		this._reject(error);
	}
}

class CountingCancellationToken implements CancellationToken {
	private readonly _listeners = new Set<(event: void) => unknown>();
	private _isCancellationRequested = false;
	activeListeners = 0;
	onListenerDispose: (() => void) | undefined;

	get isCancellationRequested(): boolean {
		return this._isCancellationRequested;
	}

	readonly onCancellationRequested: Event<void> = (listener, thisArgs) => {
		const callback = thisArgs ? listener.bind(thisArgs) : listener;
		let disposed = false;
		this._listeners.add(callback);
		this.activeListeners++;
		if (this._isCancellationRequested) {
			callback(undefined);
		}
		return {
			dispose: () => {
				if (disposed) {
					return;
				}
				disposed = true;
				if (this._listeners.delete(callback)) {
					this.activeListeners--;
				}
				this.onListenerDispose?.();
			},
		};
	};

	cancel(): void {
		if (this._isCancellationRequested) {
			return;
		}
		this._isCancellationRequested = true;
		for (const listener of [...this._listeners]) {
			listener(undefined);
		}
	}
}

interface ITestCounters {
	persisted: number;
	environment: number;
	read: number;
	decodeZsh: number;
	parseZsh: number;
	parseBash: number;
	fallback: number;
}

interface ITestHarnessOptions {
	readonly shellType?: TerminalShellType;
	readonly persistedCommands?: readonly string[];
	readonly environment?: IRemoteAgentEnvironment | null | Promise<IRemoteAgentEnvironment | null>;
	readonly remoteAuthority?: string;
	readonly read?: (resource: URI, token: CancellationToken | undefined) => Promise<IFileContent>;
	readonly decodeZshHistory?: (bytes: Uint8Array) => string;
	readonly parseZshHistory?: (content: string) => readonly string[];
	readonly parseBashHistory?: (content: string) => readonly string[];
	readonly fallback?: (shellType: TerminalShellType | undefined) => Promise<{ readonly sourceLabel: string; readonly commands: readonly string[] } | undefined>;
}

interface ITestHarness {
	readonly provider: ParadisTerminalHistoryCompletionProvider;
	readonly counters: ITestCounters;
	readonly resources: URI[];
	readonly keyResources: URI[];
	readonly cacheKeys: string[];
	readonly readTokens: (CancellationToken | undefined)[];
	readonly instantiationService: Pick<IInstantiationService, 'invokeFunction' | 'createInstance'>;
	readonly terminalService: Pick<ITerminalService, 'activeInstance'>;
	readonly fileService: Pick<IFileService, 'readFile'>;
	readonly remoteAgentService: Pick<IRemoteAgentService, 'getEnvironment' | 'getConnection'>;
	setShellType(shellType: TerminalShellType | undefined): void;
	setPersistedCommands(commands: readonly string[]): void;
}

function createRemoteEnvironment(home: string, os: OperatingSystem = OperatingSystem.Linux): IRemoteAgentEnvironment {
	return {
		pid: 1,
		connectionToken: '',
		appRoot: URI.file('/app'),
		execPath: '/app/code',
		tmpDir: URI.file('/tmp'),
		settingsPath: URI.file('/settings'),
		mcpResource: URI.file('/mcp'),
		logsPath: URI.file('/logs'),
		extensionHostLogsPath: URI.file('/extension-logs'),
		globalStorageHome: URI.file('/global-storage'),
		workspaceStorageHome: URI.file('/workspace-storage'),
		localHistoryHome: URI.file('/local-history'),
		userHome: URI.file(home),
		os,
		arch: 'x64',
		marks: [],
		useHostProxy: false,
		profiles: { all: [], home: URI.file('/profiles') },
		isUnsupportedGlibc: false,
	};
}

function createFileContent(resource: URI, bytes: Uint8Array): IFileContent {
	return {
		resource,
		name: resource.path.substring(resource.path.lastIndexOf('/') + 1),
		size: bytes.byteLength,
		mtime: 0,
		ctime: 0,
		etag: 'test',
		readonly: false,
		locked: false,
		executable: false,
		value: VSBuffer.wrap(bytes),
	};
}

function utf8File(resource: URI, content: string): IFileContent {
	return createFileContent(resource, new TextEncoder().encode(content));
}

function createPersistedHistory(commands: readonly string[]): ITerminalPersistedHistory<{ shellType: TerminalShellType | undefined }> {
	return {
		get entries(): IterableIterator<[string, { shellType: TerminalShellType | undefined }]> {
			return commands.map(command => [command, { shellType: undefined }] as [string, { shellType: TerminalShellType | undefined }])[Symbol.iterator]();
		},
		add: () => { },
		remove: () => { },
		clear: () => { },
	};
}

function createHarness(options: ITestHarnessOptions = {}): ITestHarness {
	let shellType: TerminalShellType | undefined = options.shellType ?? PosixShellType.Zsh;
	let persistedCommands = options.persistedCommands ?? [];
	const resources: URI[] = [];
	const keyResources: URI[] = [];
	const cacheKeys: string[] = [];
	const readTokens: (CancellationToken | undefined)[] = [];
	const counters: ITestCounters = { persisted: 0, environment: 0, read: 0, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 };
	const environment = options.environment ?? createRemoteEnvironment('/home/test');
	const remoteAgentService: Pick<IRemoteAgentService, 'getEnvironment' | 'getConnection'> = {
		getEnvironment: () => {
			counters.environment++;
			return Promise.resolve(environment);
		},
		getConnection: () => options.remoteAuthority ? { remoteAuthority: options.remoteAuthority } as IRemoteAgentConnection : null,
	};
	const fileService: Pick<IFileService, 'readFile'> = {
		readFile: async (resource, _readOptions, token) => {
			counters.read++;
			resources.push(resource);
			readTokens.push(token);
			return options.read ? options.read(resource, token) : utf8File(resource, 'echo one\necho two\n');
		},
	};
	const terminalService: Pick<ITerminalService, 'activeInstance'> = {
		get activeInstance() {
			return { shellType } as ITerminalService['activeInstance'];
		},
	};
	const accessor: ServicesAccessor = {
		get: <T>(identifier: ServiceIdentifier<T>): T => {
			if (identifier === IFileService) {
				return fileService as T;
			}
			if (identifier === IRemoteAgentService) {
				return remoteAgentService as T;
			}
			throw new Error(`Unexpected service ${identifier.toString()}`);
		},
	};
	const instantiationService: Pick<IInstantiationService, 'invokeFunction' | 'createInstance'> = {
		invokeFunction: (<R, TS extends unknown[]>(fn: (accessor: ServicesAccessor, ...args: TS) => R, ...args: TS): R => {
			if (Object.is(fn, getCommandHistory)) {
				counters.persisted++;
				return createPersistedHistory(persistedCommands) as R;
			}
			if (Object.is(fn, getShellFileHistory)) {
				counters.fallback++;
				if (options.fallback) {
					return options.fallback(args[0] as TerminalShellType | undefined) as R;
				}
			}
			return fn(accessor, ...args);
		}) as IInstantiationService['invokeFunction'],
		createInstance: (() => {
			throw new Error('Unexpected createInstance');
		}) as IInstantiationService['createInstance'],
	};
	const providerOptions: IParadisTerminalHistoryCompletionProviderOptions = {
		decodeZshHistory: bytes => {
			counters.decodeZsh++;
			return options.decodeZshHistory ? options.decodeZshHistory(bytes) : paradisDecodeZshHistory(bytes);
		},
		parseZshHistory: content => {
			counters.parseZsh++;
			return options.parseZshHistory ? options.parseZshHistory(content) : paradisParseZshHistory(content);
		},
		parseBashHistory: content => {
			counters.parseBash++;
			return options.parseBashHistory ? options.parseBashHistory(content) : paradisParseBashHistory(content);
		},
		cacheKey: (type: TerminalShellType, resource: URI) => {
			keyResources.push(resource);
			const key = paradisTerminalHistoryCacheKey(type, resource);
			cacheKeys.push(key);
			return key;
		},
	};
	const provider = new ParadisTerminalHistoryCompletionProvider(
		providerOptions,
		instantiationService as unknown as IInstantiationService,
		terminalService as unknown as ITerminalService,
		fileService as unknown as IFileService,
		remoteAgentService as unknown as IRemoteAgentService,
	);
	return {
		provider,
		counters,
		resources,
		keyResources,
		cacheKeys,
		readTokens,
		instantiationService,
		terminalService,
		fileService,
		remoteAgentService,
		setShellType: value => shellType = value,
		setPersistedCommands: value => persistedCommands = value,
	};
}

interface IContributionHarness {
	readonly contribution: ParadisTerminalHistoryCompletionContribution;
	readonly provider: ParadisTerminalHistoryCompletionProvider;
	readonly registrationDisposed: () => number;
}

function createContributionHarness(harness: ITestHarness): IContributionHarness {
	let registeredProvider: ITerminalCompletionProvider | undefined;
	let registrationDisposed = 0;
	const completionService: Pick<ITerminalCompletionService, 'registerTerminalCompletionProvider'> = {
		registerTerminalCompletionProvider: (_extensionIdentifier, _id, provider) => {
			registeredProvider = provider;
			return {
				dispose: () => registrationDisposed++,
			};
		},
	};
	const instantiationService: Pick<IInstantiationService, 'invokeFunction' | 'createInstance'> = {
		invokeFunction: harness.instantiationService.invokeFunction,
		createInstance: ((ctor: typeof ParadisTerminalHistoryCompletionProvider, options: IParadisTerminalHistoryCompletionProviderOptions | undefined) => {
			assert.strictEqual(ctor, ParadisTerminalHistoryCompletionProvider);
			assert.strictEqual(options, undefined);
			return harness.provider;
		}) as IInstantiationService['createInstance'],
	};
	const contribution = new ParadisTerminalHistoryCompletionContribution(
		completionService as unknown as ITerminalCompletionService,
		instantiationService as unknown as IInstantiationService,
	);
	assert.strictEqual(registeredProvider, harness.provider);
	return { contribution, provider: harness.provider, registrationDisposed: () => registrationDisposed };
}

function completion(label: string, detail: string, cursorPosition = 1): ITerminalCompletion {
	return {
		label,
		provider: ParadisTerminalHistoryCompletionProvider.ID,
		kind: TerminalCompletionItemKind.Method,
		isFileOverride: false,
		detail,
		replacementRange: [0, cursorPosition],
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

suite('ParadisTerminalHistoryCompletion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves the exact bash and zsh parser fixtures', () => {
		// Catches changes to upstream bash quote handling and Para zsh metafy/continuation semantics.
		/* eslint-disable local/code-no-unexternalized-strings */
		const bashFixtures: readonly { readonly input: string; readonly expected: readonly string[] }[] = [
			{ input: 'echo one\n\necho two\necho one\n', expected: ['echo one', 'echo two'] },
			{ input: '   \n', expected: [''] },
			{ input: 'printf "a\nb"\necho end\n', expected: ['printf "a\nb"', 'echo end'] },
			{ input: "printf 'a\nb'\necho end\n", expected: ["printf 'a\nb'", 'echo end'] },
			{ input: 'printf "unterminated', expected: [] },
			{ input: "printf 'unterminated", expected: [] },
			{ input: 'printf "a\\"b"\necho end\n', expected: [] },
			{ input: "printf 'a\\'b'\necho end\n", expected: [] },
		];
		/* eslint-enable local/code-no-unexternalized-strings */
		for (const fixture of bashFixtures) {
			assert.deepStrictEqual(paradisParseBashHistory(fixture.input), fixture.expected);
		}

		const zshFixtures: readonly { readonly input: string; readonly expected: readonly string[] }[] = [
			{ input: 'echo one\nprintf foo\\\nbar\necho two\n', expected: ['echo one', 'printf foo\nbar', 'echo two'] },
			{ input: ': 1:0;echo one: 2:0;echo two: 3:0;echo one', expected: ['echo one', 'echo two'] },
		];
		for (const fixture of zshFixtures) {
			assert.deepStrictEqual(paradisParseZshHistory(fixture.input), fixture.expected);
		}

		const metafiedJapanese = new Uint8Array([0x83, 0xC6, 0x83, 0xB7, 0x83, 0x85, 0x83, 0xC6, 0x83, 0xBC, 0x83, 0x8C, 0x83, 0xC8, 0x83, 0x8A, 0x83, 0xBE]);
		const decodedJapanese = paradisDecodeZshHistory(metafiedJapanese);
		assert.deepStrictEqual({ decoded: decodedJapanese, parsed: paradisParseZshHistory(decodedJapanese) }, { decoded: '日本語', parsed: ['日本語'] });

		const trailingMeta = paradisDecodeZshHistory(new Uint8Array([0x83]));
		assert.deepStrictEqual({ decoded: trailingMeta, parsed: paradisParseZshHistory(trailingMeta) }, { decoded: '�', parsed: ['�'] });
	});

	test('single-flights one hundred non-cancelled zsh calls with identical snapshots', async () => {
		// Catches registration of the cache flight after I/O and decode/parse outside the shared loader.
		const read = new Deferred<IFileContent>();
		const harness = createHarness({ read: () => read.promise });
		const calls = Array.from({ length: 100 }, () => harness.provider.provideCompletions('e', 1, CancellationToken.None));
		await flushMicrotasks();
		assert.deepStrictEqual(harness.counters, { persisted: 100, environment: 1, read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 });

		read.resolve(utf8File(harness.resources[0], 'echo one\necho two\n'));
		const results = await Promise.all(calls);
		const expected = [completion('echo two', '~/.zsh_history'), completion('echo one', '~/.zsh_history')];
		assert.strictEqual(results.length, 100);
		for (const result of results) {
			assert.deepStrictEqual(result, expected);
		}
		assert.deepStrictEqual({ counters: harness.counters, readToken: harness.readTokens }, {
			counters: { persisted: 100, environment: 1, read: 1, decodeZsh: 1, parseZsh: 1, parseBash: 0, fallback: 0 },
			readToken: [undefined],
		});
		harness.provider.dispose();
	});

	test('detaches ninety-nine cancelled zsh waiters while one shared read survives', async () => {
		// Catches passing a waiter token to shared I/O or cancelling the loader with one waiter.
		const read = new Deferred<IFileContent>();
		const harness = createHarness({
			read: (_resource, token) => {
				token?.onCancellationRequested(() => read.reject(new Error('shared read cancelled')));
				return read.promise;
			},
		});
		const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
		const calls = tokens.map(token => harness.provider.provideCompletions('e', 1, token));
		await flushMicrotasks();
		for (let index = 0; index < 99; index++) {
			tokens[index].cancel();
		}
		assert.deepStrictEqual(await Promise.all(calls.slice(0, 99)), Array.from({ length: 99 }, () => undefined));
		assert.deepStrictEqual({ listeners: tokens.slice(0, 99).map(token => token.activeListeners), read: harness.counters.read }, {
			listeners: Array.from({ length: 99 }, () => 0),
			read: 1,
		});

		read.resolve(utf8File(harness.resources[0], 'echo survivor\n'));
		assert.deepStrictEqual(await calls[99], [completion('echo survivor', '~/.zsh_history')]);
		assert.deepStrictEqual({ read: harness.counters.read, decode: harness.counters.decodeZsh, parse: harness.counters.parseZsh, survivorListeners: tokens[99].activeListeners }, {
			read: 1,
			decode: 1,
			parse: 1,
			survivorListeners: 0,
		});
		harness.provider.dispose();
	});

	test('single-flights one hundred bash calls and parses inside the loader', async () => {
		// Catches bash parsing after each waiter resumes instead of within the single-flight loader.
		const read = new Deferred<IFileContent>();
		const harness = createHarness({ shellType: PosixShellType.Bash, read: () => read.promise });
		const calls = Array.from({ length: 100 }, () => harness.provider.provideCompletions('p', 1, CancellationToken.None));
		await flushMicrotasks();
		read.resolve(utf8File(harness.resources[0], 'printf "a\nb"\necho end\n'));
		const results = await Promise.all(calls);
		const expected = [completion('printf "a\nb"', '~/.bash_history')];
		assert.strictEqual(results.length, 100);
		for (const result of results) {
			assert.deepStrictEqual(result, expected);
		}
		assert.deepStrictEqual(harness.counters, { persisted: 100, environment: 1, read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 1, fallback: 0 });
		harness.provider.dispose();
	});

	test('returns one hundred warm positive snapshots without new IO and keeps caller results fresh', async () => {
		// Catches completion array/item reuse and in-place reversal of cached commands.
		const harness = createHarness();
		const cold = await harness.provider.provideCompletions('e', 1, CancellationToken.None);
		assert.deepStrictEqual(cold, [completion('echo two', '~/.zsh_history'), completion('echo one', '~/.zsh_history')]);
		const beforeWarm = { ...harness.counters };
		const warm = await Promise.all(Array.from({ length: 100 }, () => harness.provider.provideCompletions('e', 1, CancellationToken.None)));
		for (const result of warm) {
			assert.deepStrictEqual(result, [completion('echo two', '~/.zsh_history'), completion('echo one', '~/.zsh_history')]);
		}
		assert.deepStrictEqual({ beforeWarm, afterWarm: harness.counters }, {
			beforeWarm: { persisted: 1, environment: 1, read: 1, decodeZsh: 1, parseZsh: 1, parseBash: 0, fallback: 0 },
			afterWarm: { persisted: 101, environment: 1, read: 1, decodeZsh: 1, parseZsh: 1, parseBash: 0, fallback: 0 },
		});

		assert.notStrictEqual(cold, warm[0]);
		assert.notStrictEqual(cold?.[0], warm[0]?.[0]);
		if (cold) {
			cold[0].label = 'mutated by caller';
			cold.push(completion('mutated extra', '~/.zsh_history'));
		}
		assert.deepStrictEqual(await harness.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo two', '~/.zsh_history'),
			completion('echo one', '~/.zsh_history'),
		]);
		harness.provider.dispose();
	});

	test('resolves one lazy location into exact local and remote shell resources', async () => {
		// Catches shell-only keys, duplicate location resolution, and shell recapture after awaiting location.
		const local = createHarness();
		assert.deepStrictEqual(await local.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo two', '~/.zsh_history'),
			completion('echo one', '~/.zsh_history'),
		]);
		local.setShellType(PosixShellType.Bash);
		assert.deepStrictEqual(await local.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo two', '~/.bash_history'),
			completion('echo one', '~/.bash_history'),
		]);
		assert.deepStrictEqual({ environment: local.counters.environment, resources: local.resources.map(resource => resource.toString()) }, {
			environment: 1,
			resources: ['file:///home/test/.zsh_history', 'file:///home/test/.bash_history'],
		});
		local.provider.dispose();

		const remote = createHarness({ shellType: PosixShellType.Bash, remoteAuthority: 'authority' });
		await remote.provider.provideCompletions('e', 1, CancellationToken.None);
		assert.deepStrictEqual(remote.resources.map(resource => resource.toString()), ['vscode-remote://authority/home/test/.bash_history']);
		remote.provider.dispose();

		const pendingEnvironment = new Deferred<IRemoteAgentEnvironment | null>();
		const capturedShell = createHarness({ environment: pendingEnvironment.promise });
		const capturedCall = capturedShell.provider.provideCompletions('e', 1, CancellationToken.None);
		capturedShell.setShellType(PosixShellType.Bash);
		pendingEnvironment.resolve(createRemoteEnvironment('/home/test'));
		await capturedCall;
		assert.deepStrictEqual(capturedShell.resources.map(resource => resource.toString()), ['file:///home/test/.zsh_history']);
		capturedShell.provider.dispose();

		const windows = createHarness({ environment: createRemoteEnvironment('C:\\Users\\test', OperatingSystem.Windows), remoteAuthority: 'authority' });
		assert.deepStrictEqual(await windows.provider.provideCompletions('e', 1, CancellationToken.None), []);
		assert.strictEqual(windows.counters.read, 0);
		windows.provider.dispose();
	});

	test('uses the exact same full URI object for the cache key and file read', async () => {
		// Catches cloning/truncating the resource between key construction and I/O wiring.
		const harness = createHarness({ shellType: PosixShellType.Bash, remoteAuthority: 'authority' });
		await harness.provider.provideCompletions('e', 1, CancellationToken.None);
		assert.strictEqual(harness.keyResources.length, 1);
		assert.strictEqual(harness.resources.length, 1);
		assert.strictEqual(harness.keyResources[0], harness.resources[0]);
		assert.deepStrictEqual({ key: harness.cacheKeys[0], resource: harness.resources[0].toString(), environment: harness.counters.environment }, {
			key: '["bash","vscode-remote://authority/home/test/.bash_history"]',
			resource: 'vscode-remote://authority/home/test/.bash_history',
			environment: 1,
		});
		harness.provider.dispose();
	});

	test('preserves persisted MRU then file MRU completion semantics', async () => {
		// Catches changes to MRU direction, dedupe, exact-prefix exclusion, case matching, metadata, and the twenty-item cap.
		const harness = createHarness({
			persistedCommands: ['echo p01', 'echo p02', 'echo p03', 'echo p04', 'echo p05', 'echo p06', 'echo p07', 'echo p08', 'echo p09', 'echo p10', 'echo shared', 'e', 'Echo case'],
			read: async resource => utf8File(resource, 'echo f01\necho f02\necho f03\necho f04\necho f05\necho f06\necho f07\necho f08\necho f09\necho f10\necho f11\necho f12\necho shared\n'),
		});
		assert.deepStrictEqual(await harness.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo shared', 'History'),
			completion('echo p10', 'History'),
			completion('echo p09', 'History'),
			completion('echo p08', 'History'),
			completion('echo p07', 'History'),
			completion('echo p06', 'History'),
			completion('echo p05', 'History'),
			completion('echo p04', 'History'),
			completion('echo p03', 'History'),
			completion('echo p02', 'History'),
			completion('echo p01', 'History'),
			completion('echo f12', '~/.zsh_history'),
			completion('echo f11', '~/.zsh_history'),
			completion('echo f10', '~/.zsh_history'),
			completion('echo f09', '~/.zsh_history'),
			completion('echo f08', '~/.zsh_history'),
			completion('echo f07', '~/.zsh_history'),
			completion('echo f06', '~/.zsh_history'),
			completion('echo f05', '~/.zsh_history'),
			completion('echo f04', '~/.zsh_history'),
		]);
		const beforeBlank = { ...harness.counters };
		assert.strictEqual(await harness.provider.provideCompletions('   ', 3, CancellationToken.None), undefined);
		assert.deepStrictEqual(harness.counters, beforeBlank);
		harness.provider.dispose();
	});

	test('skips every location and file callback when persisted history already fills twenty', async () => {
		// Catches moving the cancelled/disposed and persisted-cap guards after file resolution.
		const commands = ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e18', 'e19', 'e20'];
		const harness = createHarness({ persistedCommands: commands });
		const result = await harness.provider.provideCompletions('e', 1, CancellationToken.None);
		assert.strictEqual(result?.length, 20);
		assert.deepStrictEqual(harness.counters, { persisted: 1, environment: 0, read: 0, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 });

		const cancelledToken = new CountingCancellationToken();
		cancelledToken.cancel();
		assert.strictEqual(await harness.provider.provideCompletions('e', 1, cancelledToken), undefined);
		assert.deepStrictEqual(harness.counters, { persisted: 1, environment: 0, read: 0, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 });
		harness.provider.dispose();
	});

	test('routes representative parser rows through the real provider', async () => {
		// Catches bypassing the production bash/zsh parsers in the provider loader.
		const bash = createHarness({ shellType: PosixShellType.Bash, read: async resource => utf8File(resource, 'printf "a\nb"\necho end\n') });
		assert.deepStrictEqual(await bash.provider.provideCompletions('p', 1, CancellationToken.None), [completion('printf "a\nb"', '~/.bash_history')]);
		bash.provider.dispose();

		const extended = createHarness({ read: async resource => utf8File(resource, ': 1:0;echo one: 2:0;echo two: 3:0;echo one') });
		assert.deepStrictEqual(await extended.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo two', '~/.zsh_history'),
			completion('echo one', '~/.zsh_history'),
		]);
		extended.provider.dispose();

		const metafiedJapanese = new Uint8Array([0x83, 0xC6, 0x83, 0xB7, 0x83, 0x85, 0x83, 0xC6, 0x83, 0xBC, 0x83, 0x8C, 0x83, 0xC8, 0x83, 0x8A, 0x83, 0xBE]);
		const metafied = createHarness({ read: async resource => createFileContent(resource, metafiedJapanese) });
		assert.deepStrictEqual(await metafied.provider.provideCompletions('日', 1, CancellationToken.None), [completion('日本語', '~/.zsh_history')]);
		metafied.provider.dispose();
	});

	test('keeps one hundred warm snapshots through each completed negative without new IO', async () => {
		// Catches omission of resolved/rejected negative cache publication or parser failures escaping the file cache.
		const variants: readonly { readonly name: string; readonly options: ITestHarnessOptions; readonly initial: Partial<ITestCounters> }[] = [
			{
				name: 'file not found',
				options: { read: async () => { throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND); } },
				initial: { read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 0 },
			},
			{
				name: 'permission rejection',
				options: { read: async () => { throw new FileOperationError('permission denied', FileOperationResult.FILE_PERMISSION_DENIED); } },
				initial: { read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 0 },
			},
			{
				name: 'zsh decode throw',
				options: { decodeZshHistory: () => { throw new Error('decode failed'); } },
				initial: { read: 1, decodeZsh: 1, parseZsh: 0, parseBash: 0 },
			},
			{
				name: 'zsh parse throw',
				options: { parseZshHistory: () => { throw new Error('zsh parse failed'); } },
				initial: { read: 1, decodeZsh: 1, parseZsh: 1, parseBash: 0 },
			},
			{
				name: 'bash parse throw',
				options: { shellType: PosixShellType.Bash, parseBashHistory: () => { throw new Error('bash parse failed'); } },
				initial: { read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 1 },
			},
		];
		for (const variant of variants) {
			const harness = createHarness({ ...variant.options, persistedCommands: ['echo persisted'] });
			const expected = [completion('echo persisted', 'History')];
			assert.deepStrictEqual(await harness.provider.provideCompletions('e', 1, CancellationToken.None), expected, variant.name);
			assert.deepStrictEqual({
				read: harness.counters.read,
				decodeZsh: harness.counters.decodeZsh,
				parseZsh: harness.counters.parseZsh,
				parseBash: harness.counters.parseBash,
			}, variant.initial, variant.name);
			const beforeWarm = { ...harness.counters };
			const results = await Promise.all(Array.from({ length: 100 }, () => harness.provider.provideCompletions('e', 1, CancellationToken.None)));
			for (const result of results) {
				assert.deepStrictEqual(result, expected, variant.name);
			}
			assert.deepStrictEqual({
				environment: harness.counters.environment - beforeWarm.environment,
				read: harness.counters.read - beforeWarm.read,
				decodeZsh: harness.counters.decodeZsh - beforeWarm.decodeZsh,
				parseZsh: harness.counters.parseZsh - beforeWarm.parseZsh,
				parseBash: harness.counters.parseBash - beforeWarm.parseBash,
			}, { environment: 0, read: 0, decodeZsh: 0, parseZsh: 0, parseBash: 0 }, variant.name);
			harness.provider.dispose();
		}

		const cancelled = createHarness({ persistedCommands: ['echo persisted'] });
		const token = new CountingCancellationToken();
		token.cancel();
		assert.strictEqual(await cancelled.provider.provideCompletions('e', 1, token), undefined);
		assert.deepStrictEqual(cancelled.counters, { persisted: 0, environment: 0, read: 0, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 });
		cancelled.provider.dispose();
	});

	test('detaches one hundred cancelled location waiters before the environment settles', async () => {
		// Catches waiter-specific reactions on the remote environment promise and late file continuations.
		const environment = new TrackedDeferred<IRemoteAgentEnvironment | null>();
		const harness = createHarness({ environment: environment.promise });
		const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
		const calls = tokens.map(token => harness.provider.provideCompletions('e', 1, token));
		await flushMicrotasks();
		assert.deepStrictEqual({ environment: harness.counters.environment, handler: environment.thenCount, read: harness.counters.read }, { environment: 1, handler: 1, read: 0 });
		for (const token of tokens) {
			token.cancel();
		}
		assert.deepStrictEqual(await Promise.all(calls), Array.from({ length: 100 }, () => undefined));
		assert.deepStrictEqual(tokens.map(token => token.activeListeners), Array.from({ length: 100 }, () => 0));

		environment.resolve(createRemoteEnvironment('/home/test'));
		await flushMicrotasks();
		assert.deepStrictEqual({ read: harness.counters.read, decode: harness.counters.decodeZsh, parse: harness.counters.parseZsh }, { read: 0, decode: 0, parse: 0 });
		assert.deepStrictEqual(await harness.provider.provideCompletions('e', 1, CancellationToken.None), [
			completion('echo two', '~/.zsh_history'),
			completion('echo one', '~/.zsh_history'),
		]);
		assert.strictEqual(harness.counters.read, 1);
		harness.provider.dispose();
	});

	test('owns and disposes a real provider while environment resolution is pending', async () => {
		// Catches contribution ownership limited to the provider registration.
		const environment = new TrackedDeferred<IRemoteAgentEnvironment | null>();
		const harness = createHarness({ environment: environment.promise });
		const actual = createContributionHarness(harness);
		const pending = actual.provider.provideCompletions('e', 1, CancellationToken.None);
		await flushMicrotasks();
		actual.contribution.dispose();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(actual.registrationDisposed(), 1);

		environment.resolve(createRemoteEnvironment('/home/test'));
		await flushMicrotasks();
		assert.deepStrictEqual({ handler: environment.thenCount, read: harness.counters.read, decode: harness.counters.decodeZsh, parse: harness.counters.parseZsh }, {
			handler: 1,
			read: 0,
			decode: 0,
			parse: 0,
		});
	});

	test('stops decode parse cache and completion publication after a pending read is disposed', async () => {
		// Catches missing read-continuation and provider top-level disposal fences.
		const read = new Deferred<IFileContent>();
		const harness = createHarness({ read: () => read.promise });
		const actual = createContributionHarness(harness);
		const pending = actual.provider.provideCompletions('e', 1, CancellationToken.None);
		await flushMicrotasks();
		actual.contribution.dispose();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(actual.registrationDisposed(), 1);

		read.resolve(utf8File(harness.resources[0], 'echo late\n'));
		await flushMicrotasks();
		assert.deepStrictEqual({ decode: harness.counters.decodeZsh, parse: harness.counters.parseZsh }, { decode: 0, parse: 0 });
		assert.strictEqual(await actual.provider.provideCompletions('e', 1, CancellationToken.None), undefined);
		harness.setPersistedCommands(['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e18', 'e19', 'e20']);
		assert.strictEqual(await actual.provider.provideCompletions('e', 1, CancellationToken.None), undefined);
		assert.deepStrictEqual(harness.counters, { persisted: 1, environment: 1, read: 1, decodeZsh: 0, parseZsh: 0, parseBash: 0, fallback: 0 });
	});

	test('shares only a pending fallback generation and preserves upstream invalidation', async () => {
		// Catches fulfilled fallback caching, lack of pending sharing, cross-shell sharing, and rejection normalization.
		clearShellFileHistory();
		try {
			let source = 'old one\nold two\n';
			const coldRead = new Deferred<IFileContent>();
			let firstRead = true;
			const harness = createHarness({
				shellType: GeneralShellType.PowerShell,
				read: resource => {
					if (firstRead) {
						firstRead = false;
						return coldRead.promise;
					}
					return Promise.resolve(utf8File(resource, source));
				},
			});
			const coldCalls = Array.from({ length: 100 }, () => harness.provider.provideCompletions('o', 1, CancellationToken.None));
			await flushMicrotasks();
			const firstResource = harness.resources[0];
			coldRead.resolve(utf8File(firstResource, source));
			const coldResults = await Promise.all(coldCalls);
			const oldExpected = [
				completion('old two', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt'),
				completion('old one', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt'),
			];
			assert.deepStrictEqual({ fallback: harness.counters.fallback, read: harness.counters.read, resultCount: coldResults.length }, { fallback: 1, read: 1, resultCount: 100 });
			for (const result of coldResults) {
				assert.deepStrictEqual(result, oldExpected);
			}

			source = 'new one\nnew two\n';
			assert.deepStrictEqual(await harness.provider.provideCompletions('o', 1, CancellationToken.None), oldExpected);
			assert.deepStrictEqual({ fallback: harness.counters.fallback, read: harness.counters.read }, { fallback: 2, read: 1 });
			clearShellFileHistory();
			assert.deepStrictEqual(await harness.provider.provideCompletions('n', 1, CancellationToken.None), [
				completion('new two', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt'),
				completion('new one', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt'),
			]);
			assert.deepStrictEqual({ fallback: harness.counters.fallback, read: harness.counters.read }, { fallback: 3, read: 2 });

			harness.setShellType(GeneralShellType.Python);
			clearShellFileHistory();
			await harness.provider.provideCompletions('n', 1, CancellationToken.None);
			assert.deepStrictEqual({ fallback: harness.counters.fallback, read: harness.counters.read }, { fallback: 4, read: 3 });
			harness.provider.dispose();

			clearShellFileHistory();
			const missing = createHarness({
				shellType: GeneralShellType.PowerShell,
				read: async () => { throw new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND); },
			});
			assert.deepStrictEqual(await missing.provider.provideCompletions('e', 1, CancellationToken.None), []);
			assert.deepStrictEqual(await missing.provider.provideCompletions('e', 1, CancellationToken.None), []);
			assert.deepStrictEqual({ fallback: missing.counters.fallback, read: missing.counters.read }, { fallback: 2, read: 1 });
			missing.provider.dispose();

			clearShellFileHistory();
			const sharedError = new Error('fallback rejected');
			let rejectFirst = true;
			const rejected = createHarness({
				shellType: GeneralShellType.PowerShell,
				read: async resource => {
					if (rejectFirst) {
						rejectFirst = false;
						throw sharedError;
					}
					return utf8File(resource, 'retry result\n');
				},
			});
			const rejectedCalls = Array.from({ length: 100 }, () => rejected.provider.provideCompletions('r', 1, CancellationToken.None));
			const settlements = await Promise.allSettled(rejectedCalls);
			assert.deepStrictEqual({
				fallback: rejected.counters.fallback,
				rejected: settlements.filter(result => result.status === 'rejected').length,
				sameErrors: settlements.every(result => result.status === 'rejected' && result.reason === sharedError),
			}, { fallback: 1, rejected: 100, sameErrors: true });
			assert.deepStrictEqual(await rejected.provider.provideCompletions('r', 1, CancellationToken.None), [
				completion('retry result', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt'),
			]);
			assert.strictEqual(rejected.counters.fallback, 2);
			rejected.provider.dispose();
		} finally {
			clearShellFileHistory();
		}
	});

	test('shares only the pending fallback generation for Fish and an undefined shell', async () => {
		for (const shellType of [PosixShellType.Fish, undefined] as const) {
			const first = new Deferred<{ readonly sourceLabel: string; readonly commands: readonly string[] } | undefined>();
			let generation = 0;
			const harness = createHarness({
				shellType: PosixShellType.Fish,
				fallback: () => ++generation === 1
					? first.promise
					: Promise.resolve({ sourceLabel: 'fallback source', commands: ['next result'] }),
			});
			harness.setShellType(shellType);
			const calls = Array.from({ length: 100 }, () => harness.provider.provideCompletions('f', 1, CancellationToken.None));
			await flushMicrotasks();
			assert.strictEqual(harness.counters.fallback, 1, String(shellType));
			first.resolve({ sourceLabel: 'fallback source', commands: ['first old', 'first new'] });
			const results = await Promise.all(calls);
			for (const result of results) {
				assert.deepStrictEqual(result, [
					completion('first new', 'fallback source'),
					completion('first old', 'fallback source'),
				], String(shellType));
			}
			assert.deepStrictEqual(await harness.provider.provideCompletions('n', 1, CancellationToken.None), [completion('next result', 'fallback source')]);
			assert.strictEqual(harness.counters.fallback, 2, String(shellType));
			harness.provider.dispose();
		}
	});

	test('keeps an all-cancelled fallback generation pending until it settles', async () => {
		// Catches eviction of a pending-only generation when its last waiter cancels.
		const variants: readonly ('success' | 'undefined' | 'reject')[] = ['success', 'undefined', 'reject'];
		for (const variant of variants) {
			clearShellFileHistory();
			const deferred = new Deferred<IFileContent>();
			let nextRead = false;
			const sharedError = new Error('late fallback rejection');
			const harness = createHarness({
				shellType: GeneralShellType.PowerShell,
				read: resource => nextRead ? Promise.resolve(utf8File(resource, 'retry result\n')) : deferred.promise,
			});
			const tokens = Array.from({ length: 100 }, () => new CountingCancellationToken());
			const cancelledCalls = tokens.map(token => harness.provider.provideCompletions('l', 1, token));
			await flushMicrotasks();
			for (const token of tokens) {
				token.cancel();
			}
			assert.deepStrictEqual(await Promise.all(cancelledCalls), Array.from({ length: 100 }, () => undefined));
			const joined = harness.provider.provideCompletions('l', 1, CancellationToken.None);
			assert.strictEqual(harness.counters.fallback, 1, variant);
			if (variant === 'success') {
				deferred.resolve(utf8File(harness.resources[0], 'late result\n'));
				assert.deepStrictEqual(await joined, [completion('late result', '~/.local/share/powershell/PSReadline/ConsoleHost_history.txt')]);
			} else if (variant === 'undefined') {
				deferred.reject(new FileOperationError('missing', FileOperationResult.FILE_NOT_FOUND));
				assert.deepStrictEqual(await joined, []);
			} else {
				deferred.reject(sharedError);
				await assert.rejects(joined, error => error === sharedError);
			}
			nextRead = true;
			await harness.provider.provideCompletions('r', 1, CancellationToken.None);
			assert.strictEqual(harness.counters.fallback, 2, variant);
			assert.deepStrictEqual(tokens.map(token => token.activeListeners), Array.from({ length: 100 }, () => 0));
			harness.provider.dispose();
		}
		clearShellFileHistory();
	});

	test('cancels a pending fallback immediately when the actual contribution is disposed', async () => {
		// Catches fallback shared values omitted from the provider-owned disposable map.
		clearShellFileHistory();
		try {
			const deferred = new Deferred<IFileContent>();
			const harness = createHarness({ shellType: GeneralShellType.PowerShell, read: () => deferred.promise });
			const actual = createContributionHarness(harness);
			const pending = actual.provider.provideCompletions('l', 1, CancellationToken.None);
			await flushMicrotasks();
			actual.contribution.dispose();
			assert.strictEqual(await pending, undefined);
			assert.strictEqual(actual.registrationDisposed(), 1);
			deferred.resolve(utf8File(harness.resources[0], 'late fallback\n'));
			await flushMicrotasks();
			assert.strictEqual(await pending, undefined);
			assert.deepStrictEqual({ fallback: harness.counters.fallback, read: harness.counters.read, decode: harness.counters.decodeZsh, parseZsh: harness.counters.parseZsh, parseBash: harness.counters.parseBash }, {
				fallback: 1,
				read: 1,
				decode: 0,
				parseZsh: 0,
				parseBash: 0,
			});
		} finally {
			clearShellFileHistory();
		}
	});

	test('handles a late rejected pending fallback after actual contribution disposal', async () => {
		const fallback = new TrackedDeferred<{ readonly sourceLabel: string; readonly commands: readonly string[] } | undefined>();
		const harness = createHarness({ shellType: PosixShellType.Fish, fallback: () => fallback.promise });
		const actual = createContributionHarness(harness);
		const pending = actual.provider.provideCompletions('l', 1, CancellationToken.None);
		await flushMicrotasks();
		actual.contribution.dispose();
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(actual.registrationDisposed(), 1);

		fallback.reject(new Error('late fallback rejection'));
		await flushMicrotasks();
		assert.deepStrictEqual({ fallback: harness.counters.fallback, rejectionHandlers: fallback.rejectionHandlerCount }, { fallback: 1, rejectionHandlers: 1 });
		assert.strictEqual(await pending, undefined);
		assert.strictEqual(await actual.provider.provideCompletions('l', 1, CancellationToken.None), undefined);
	});

	test('applies the generic post-await guard when listener disposal disposes the contribution', async () => {
		// Catches a fallback-only result path that omits the shared post-await disposal guard.
		clearShellFileHistory();
		try {
			const deferred = new Deferred<IFileContent>();
			const harness = createHarness({ shellType: GeneralShellType.PowerShell, read: () => deferred.promise });
			const actual = createContributionHarness(harness);
			const token = new CountingCancellationToken();
			let contributionDisposals = 0;
			token.onListenerDispose = () => {
				contributionDisposals++;
				actual.contribution.dispose();
			};
			const pending = actual.provider.provideCompletions('r', 1, token);
			await flushMicrotasks();
			deferred.resolve(utf8File(harness.resources[0], 'race result\n'));
			assert.strictEqual(await pending, undefined);
			assert.deepStrictEqual({ contributionDisposals, listener: token.activeListeners, registrationDisposed: actual.registrationDisposed() }, {
				contributionDisposals: 1,
				listener: 0,
				registrationDisposed: 1,
			});
		} finally {
			clearShellFileHistory();
		}
	});
});

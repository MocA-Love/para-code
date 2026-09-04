/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, exec } from 'child_process';
import { AutoOpenBarrier, ProcessTimeRunOnceScheduler, Promises, Queue, timeout } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IProcessEnvironment, isWindows, OperatingSystem, OS } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { getSystemShell } from '../../../base/node/shell.js';
import { ILogService, LogLevel } from '../../log/common/log.js';
import { RequestStore } from '../common/requestStore.js';
import { IProcessDataEvent, IProcessReadyEvent, IPtyService, IRawTerminalInstanceLayoutInfo, IReconnectConstants, IShellLaunchConfig, ITerminalInstanceLayoutInfoById, ITerminalLaunchError, ITerminalsLayoutInfo, ITerminalTabLayoutInfoById, TerminalIcon, IProcessProperty, TitleEventSource, ProcessPropertyType, IProcessPropertyMap, IFixedTerminalDimensions, IPersistentTerminalProcessLaunchConfig, ICrossVersionSerializedTerminalState, ISerializedTerminalState, ITerminalProcessOptions, IPtyHostLatencyMeasurement, type IPtyServiceContribution, PosixShellType, ITerminalLaunchResult, PARADIS_UNRESOLVABLE_PTY_ID, paradisTerminalIdentityNonce } from '../common/terminal.js';
import { TerminalDataBufferer } from '../common/terminalDataBuffering.js';
import { escapeNonWindowsPath } from '../common/terminalEnvironment.js';
import type { ISerializeOptions, SerializeAddon as XtermSerializeAddon } from '@xterm/addon-serialize';
import type { Unicode11Addon as XtermUnicode11Addon } from '@xterm/addon-unicode11';
import { IGetTerminalLayoutInfoArgs, IProcessDetails, ISetTerminalLayoutInfoArgs, ITerminalTabLayoutInfoDto } from '../common/terminalProcess.js';
import { sanitizeEnvForLogging } from './terminalEnvironment.js';
import { localize } from '../../../nls.js';
import { ignoreProcessNames } from './childProcessMonitor.js';
import { ErrorNoTelemetry } from '../../../base/common/errors.js';
import { ShellIntegrationAddon } from '../common/xterm/shellIntegrationAddon.js';
import { formatMessageForTerminal } from '../common/terminalStrings.js';
import { IPtyHostProcessReplayEvent } from '../common/capabilities/capabilities.js';
import { IParadisTerminalProcessLike } from '../../../paradis/contrib/ptyDaemon/common/paradisTerminalProcessLike.js';
import { paradisAdoptionSettled, paradisCreateTerminalProcess } from '../../../paradis/contrib/ptyDaemon/node/paradisTerminalProcessFactory.js';
import { IParadisAdoptTarget, paradisHandleOf } from '../../../paradis/contrib/ptyDaemon/node/paradisTerminalHandleRegistry.js';
import { paradisRememberLayout } from '../../../paradis/contrib/ptyDaemon/node/paradisTerminalLayoutStore.js';
import { IProductService } from '../../product/common/productService.js';
import { join } from '../../../base/common/path.js';
import { memoize } from '../../../base/common/decorators.js';
import * as performance from '../../../base/common/performance.js';
import pkg from '@xterm/headless';
import { AutoRepliesPtyServiceContribution } from './terminalContrib/autoReplies/autoRepliesContribController.js';
import { hasKey, isFunction, isNumber, isString } from '../../../base/common/types.js';
import { getWindowsBuildNumberAsync } from '../../../base/node/windowsVersion.js';

type XtermTerminal = pkg.Terminal;
const { Terminal: XtermTerminal } = pkg;

/**
 * Sanitizes arguments for logging, specifically handling env objects in createProcess calls.
 */
function sanitizeArgsForLogging(fnName: string, args: unknown[]): unknown[] {
	// createProcess signature: shellLaunchConfig, cwd, cols, rows, unicodeVersion, env (index 5), executableEnv (index 6), ...
	if (fnName === 'createProcess' && args.length > 5) {
		const sanitizedArgs = [...args];
		if (args[5] && typeof args[5] === 'object') {
			sanitizedArgs[5] = sanitizeEnvForLogging(args[5] as IProcessEnvironment);
		}
		if (args[6] && typeof args[6] === 'object') {
			sanitizedArgs[6] = sanitizeEnvForLogging(args[6] as IProcessEnvironment);
		}
		return sanitizedArgs;
	}
	return args;
}

interface ITraceRpcArgs {
	logService: ILogService;
	simulatedLatency: number;
}

export function traceRpc(_target: Object, key: string, descriptor: PropertyDescriptor) {
	if (!isFunction(descriptor.value)) {
		throw new Error('not supported');
	}
	const fnKey = 'value';
	const fn = descriptor.value;
	descriptor[fnKey] = async function <TThis extends { traceRpcArgs: ITraceRpcArgs }>(this: TThis, ...args: unknown[]) {
		if (this.traceRpcArgs.logService.getLevel() === LogLevel.Trace) {
			const sanitizedArgs = sanitizeArgsForLogging(fn.name, args);
			this.traceRpcArgs.logService.trace(`[RPC Request] PtyService#${fn.name}(${sanitizedArgs.map(e => JSON.stringify(e)).join(', ')})`);
		}
		if (this.traceRpcArgs.simulatedLatency) {
			await timeout(this.traceRpcArgs.simulatedLatency);
		}
		let result: unknown;
		try {
			result = await fn.apply(this, args);
		} catch (e) {
			this.traceRpcArgs.logService.error(`[RPC Response] PtyService#${fn.name}`, e);
			throw e;
		}
		if (this.traceRpcArgs.logService.getLevel() === LogLevel.Trace) {
			this.traceRpcArgs.logService.trace(`[RPC Response] PtyService#${fn.name}`, result);
		}
		return result;
	};
}

type WorkspaceId = string;

let SerializeAddon: typeof XtermSerializeAddon;
let Unicode11Addon: typeof XtermUnicode11Addon;

export class PtyService extends Disposable implements IPtyService {
	declare readonly _serviceBrand: undefined;

	private readonly _ptys: Map<number, PersistentTerminalProcess> = new Map();
	private readonly _workspaceLayoutInfos = new Map<WorkspaceId, ISetTerminalLayoutInfoArgs>();
	private readonly _detachInstanceRequestStore: RequestStore<IProcessDetails | undefined, { workspaceId: string; instanceId: number }>;
	private readonly _revivedPtyIdMap: Map<string, { newId: number; state: ISerializedTerminalState }> = new Map();
	private readonly _revivedPtyOldIdByNewId: Map<string, number> = new Map();
	/**
	 * PARA-PATCH: revived terminals indexed by shell integration nonce, see getRevivedPtyNewId.
	 *
	 * `_revivedPtyIdMap` above is keyed by the id of the session that was revived and is consumed as
	 * the panel layout claims each entry, so it cannot answer for a restored editor tab. A nonce, on
	 * the other hand, names the terminal itself no matter which generation asks, which makes this
	 * index safe to keep for as long as the host lives.
	 */
	private readonly _paradisRevivedNewIdByNonce = new Map<string, number>();
	/** PARA-CODE: which entries above name a terminal taken back from the daemon rather than revived. */
	private readonly _paradisAdoptedNonces = new Set<string>();
	/** Short leases serialize nonce-proven orphan attachment across renderer processes. */
	private readonly _paradisOrphanAttachClaims = new Map<number, number>();

	// #region Pty service contribution RPC calls

	private readonly _autoRepliesContribution: AutoRepliesPtyServiceContribution;
	@traceRpc
	async installAutoReply(match: string, reply: string) {
		await this._autoRepliesContribution.installAutoReply(match, reply);
	}
	@traceRpc
	async uninstallAllAutoReplies() {
		await this._autoRepliesContribution.uninstallAllAutoReplies();
	}

	// #endregion

	private readonly _contributions: IPtyServiceContribution[];

	private _lastPtyId: number = 0;

	private readonly _onHeartbeat = this._register(new Emitter<void>());
	readonly onHeartbeat = this._traceEvent('_onHeartbeat', this._onHeartbeat.event);

	private readonly _onProcessData = this._register(new Emitter<{ id: number; event: IProcessDataEvent | string }>());
	readonly onProcessData = this._traceEvent('_onProcessData', this._onProcessData.event);
	private readonly _onProcessReplay = this._register(new Emitter<{ id: number; event: IPtyHostProcessReplayEvent }>());
	readonly onProcessReplay = this._traceEvent('_onProcessReplay', this._onProcessReplay.event);
	private readonly _onProcessReady = this._register(new Emitter<{ id: number; event: IProcessReadyEvent }>());
	readonly onProcessReady = this._traceEvent('_onProcessReady', this._onProcessReady.event);
	private readonly _onProcessExit = this._register(new Emitter<{ id: number; event: number | undefined }>());
	readonly onProcessExit = this._traceEvent('_onProcessExit', this._onProcessExit.event);
	private readonly _onProcessOrphanQuestion = this._register(new Emitter<{ id: number }>());
	readonly onProcessOrphanQuestion = this._traceEvent('_onProcessOrphanQuestion', this._onProcessOrphanQuestion.event);
	private readonly _onDidRequestDetach = this._register(new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>());
	readonly onDidRequestDetach = this._traceEvent('_onDidRequestDetach', this._onDidRequestDetach.event);
	private readonly _onDidChangeProperty = this._register(new Emitter<{ id: number; property: IProcessProperty }>());
	readonly onDidChangeProperty = this._traceEvent('_onDidChangeProperty', this._onDidChangeProperty.event);

	private _traceEvent<T>(name: string, event: Event<T>): Event<T> {
		event(e => {
			if (this._logService.getLevel() === LogLevel.Trace) {
				this._logService.trace(`[RPC Event] PtyService#${name}.fire(${JSON.stringify(e)})`);
			}
		});
		return event;
	}

	@memoize
	get traceRpcArgs(): ITraceRpcArgs {
		return {
			logService: this._logService,
			simulatedLatency: this._simulatedLatency
		};
	}

	constructor(
		private readonly _logService: ILogService,
		private readonly _productService: IProductService,
		private readonly _reconnectConstants: IReconnectConstants,
		private readonly _simulatedLatency: number
	) {
		super();

		this._register(toDisposable(() => {
			for (const pty of this._ptys.values()) {
				pty.shutdown(true);
			}
			this._ptys.clear();
		}));

		this._detachInstanceRequestStore = this._register(new RequestStore(undefined, this._logService));
		this._register(this._detachInstanceRequestStore.onCreateRequest(this._onDidRequestDetach.fire, this._onDidRequestDetach));

		this._autoRepliesContribution = new AutoRepliesPtyServiceContribution(this._logService);

		this._contributions = [this._autoRepliesContribution];

	}

	@traceRpc
	async refreshIgnoreProcessNames(names: string[]): Promise<void> {
		ignoreProcessNames.length = 0;
		ignoreProcessNames.push(...names);
	}

	@traceRpc
	async requestDetachInstance(workspaceId: string, instanceId: number): Promise<IProcessDetails | undefined> {
		return this._detachInstanceRequestStore.createRequest({ workspaceId, instanceId });
	}

	@traceRpc
	async acceptDetachInstanceReply(requestId: number, persistentProcessId: number): Promise<void> {
		let processDetails: IProcessDetails | undefined = undefined;
		const pty = this._ptys.get(persistentProcessId);
		if (pty) {
			processDetails = await this._buildProcessDetails(persistentProcessId, pty);
		}
		this._detachInstanceRequestStore.acceptReply(requestId, processDetails);
	}

	@traceRpc
	async freePortKillProcess(port: string): Promise<{ port: string; processId: string }> {
		const stdout = await new Promise<string>((resolve, reject) => {
			exec(isWindows ? `netstat -ano | findstr "${port}"` : `lsof -nP -iTCP -sTCP:LISTEN | grep ${port}`, {}, (err, stdout) => {
				if (err) {
					return reject('Problem occurred when listing active processes');
				}
				resolve(stdout);
			});
		});
		const processesForPort = stdout.split(/\r?\n/).filter(s => !!s.trim());
		if (processesForPort.length >= 1) {
			const capturePid = /\s+(\d+)(?:\s+|$)/;
			const processId = processesForPort[0].match(capturePid)?.[1];
			if (processId) {
				try {
					process.kill(Number.parseInt(processId));
				} catch { }
			} else {
				throw new Error(`Processes for port ${port} were not found`);
			}
			return { port, processId };
		}
		throw new Error(`Could not kill process with port ${port}`);
	}

	@traceRpc
	async serializeTerminalState(ids: number[]): Promise<string> {
		const promises: Promise<ISerializedTerminalState>[] = [];
		for (const [persistentProcessId, persistentProcess] of this._ptys.entries()) {
			// Only serialize persistent processes that have had data written or performed a replay
			if (persistentProcess.hasWrittenData && ids.indexOf(persistentProcessId) !== -1) {
				promises.push(Promises.withAsyncBody<ISerializedTerminalState>(async r => {
					r({
						id: persistentProcessId,
						shellLaunchConfig: persistentProcess.shellLaunchConfig,
						processDetails: await this._buildProcessDetails(persistentProcessId, persistentProcess),
						processLaunchConfig: persistentProcess.processLaunchOptions,
						unicodeVersion: persistentProcess.unicodeVersion,
						replayEvent: await persistentProcess.serializeNormalBuffer(),
						timestamp: Date.now()
					});
				}));
			}
		}
		const serialized: ICrossVersionSerializedTerminalState = {
			version: 1,
			state: await Promise.all(promises)
		};
		return JSON.stringify(serialized);
	}

	@traceRpc
	async reviveTerminalProcesses(workspaceId: string, state: ISerializedTerminalState[], dateTimeFormatLocale: string) {
		const promises: Promise<void>[] = [];
		for (const terminal of state) {
			promises.push(this._reviveTerminalProcess(workspaceId, terminal));
		}
		await Promise.all(promises);
	}

	private async _reviveTerminalProcess(workspaceId: string, terminal: ISerializedTerminalState): Promise<void> {
		const restoreMessage = localize('terminal-history-restored', "History restored");

		// Conpty v1.22+ uses passthrough and doesn't reprint the buffer often, this means that when
		// the terminal is revived, the cursor would be at the bottom of the buffer then when
		// PSReadLine requests `GetConsoleCursorInfo` it will be handled by conpty itself by design.
		// This causes the cursor to move to the top into the replayed terminal contents. To avoid
		// this, the post restore message will print new lines to get a clear viewport and put the
		// cursor back at to top left.
		let postRestoreMessage = '';
		if (isWindows) {
			const lastReplayEvent = terminal.replayEvent.events.length > 0 ? terminal.replayEvent.events.at(-1) : undefined;
			if (lastReplayEvent) {
				postRestoreMessage += '\r\n'.repeat(lastReplayEvent.rows - 1) + `\x1b[H`;
			}
		}

		// TODO: We may at some point want to show date information in a hover via a custom sequence:
		//   new Date(terminal.timestamp).toLocaleDateString(dateTimeFormatLocale)
		//   new Date(terminal.timestamp).toLocaleTimeString(dateTimeFormatLocale)
		const newId = await this.createProcess(
			{
				...terminal.shellLaunchConfig,
				cwd: terminal.processDetails.cwd,
				color: terminal.processDetails.color,
				icon: terminal.processDetails.icon,
				name: terminal.processDetails.titleSource === TitleEventSource.Api ? terminal.processDetails.title : undefined,
				initialText: terminal.replayEvent.events[0].data + formatMessageForTerminal(restoreMessage, { loudFormatting: true }) + postRestoreMessage
			},
			terminal.processDetails.cwd,
			terminal.replayEvent.events[0].cols,
			terminal.replayEvent.events[0].rows,
			terminal.unicodeVersion,
			terminal.processLaunchConfig.env,
			terminal.processLaunchConfig.executableEnv,
			terminal.processLaunchConfig.options,
			true,
			terminal.processDetails.workspaceId,
			terminal.processDetails.workspaceName,
			true,
			terminal.replayEvent.events[0].data
		);
		// Don't start the process here as there's no terminal to answer CPR
		const oldId = this._getRevivingProcessId(workspaceId, terminal.id);
		this._revivedPtyIdMap.set(oldId, { newId, state: terminal });
		this._revivedPtyOldIdByNewId.set(this._getRevivingProcessId(workspaceId, newId), terminal.id);
		// PARA-PATCH: also index by nonce so a restored editor tab can find this terminal (getRevivedPtyNewId)
		const nonce = paradisTerminalIdentityNonce(terminal.processDetails.shellIntegrationNonce);
		// PARA-PATCH: never over a terminal taken back from the daemon. That one is still running the
		// work; this one is a shell restarted from a saved screenful.
		if (nonce !== undefined && !this._paradisAdoptedNonces.has(nonce)) {
			this._paradisRevivedNewIdByNonce.set(nonce, newId);
		}
		this._logService.info(`Revived process, old id ${oldId} -> new id ${newId}`);
	}

	@traceRpc
	async shutdownAll(): Promise<void> {
		this.dispose();
	}

	@traceRpc
	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		unicodeVersion: '6' | '11',
		env: IProcessEnvironment,
		executableEnv: IProcessEnvironment,
		options: ITerminalProcessOptions,
		shouldPersist: boolean,
		workspaceId: string,
		workspaceName: string,
		isReviving?: boolean,
		rawReviveBuffer?: string,
		// PARA-PATCH: adopt a terminal the daemon is already holding instead of starting one.
		// See paradisTerminalProcessFactory.ts.
		paradisAdoptTarget?: IParadisAdoptTarget
	): Promise<number> {
		if (shellLaunchConfig.attachPersistentProcess) {
			throw new Error('Attempt to create a process when attach object was provided');
		}
		const id = ++this._lastPtyId;
		// PARA-PATCH: the pty may belong to a daemon that outlives this process, so the decision of
		// where it runs is made in one place. See paradisTerminalProcessFactory.ts.
		const process = await paradisCreateTerminalProcess(shellLaunchConfig, cwd, cols, rows, env, executableEnv, options, this._logService, this._productService, { id, workspaceId, workspaceName, shouldPersist }, paradisAdoptTarget);
		const processLaunchOptions: IPersistentTerminalProcessLaunchConfig = {
			env,
			executableEnv,
			options
		};
		const persistentProcess = new PersistentTerminalProcess(id, process, workspaceId, workspaceName, shouldPersist, cols, rows, processLaunchOptions, unicodeVersion, this._reconnectConstants, this._logService, isReviving && isString(shellLaunchConfig.initialText) ? shellLaunchConfig.initialText : undefined, rawReviveBuffer, shellLaunchConfig.icon, shellLaunchConfig.color, shellLaunchConfig.name, shellLaunchConfig.fixedDimensions, paradisAdoptTarget);
		process.onProcessExit(event => {
			this._paradisOrphanAttachClaims.delete(id);
			this._revivedPtyOldIdByNewId.delete(this._getRevivingProcessId(workspaceId, id));
			// PARA-PATCH: let go of the nonce this terminal was answering for. Nothing else clears
			// these, and an entry naming a terminal that has exited is worse than no entry: the
			// adopted mark keeps every later revive of the same tab from registering, so once an
			// adopted terminal ends, its tab can never be reconnected again for as long as this pty
			// host lives — the exact failure the mark exists to prevent, in the other direction.
			const exitedNonce = paradisTerminalIdentityNonce(options.shellIntegration.nonce);
			if (exitedNonce !== undefined && this._paradisRevivedNewIdByNonce.get(exitedNonce) === id) {
				this._paradisRevivedNewIdByNonce.delete(exitedNonce);
				this._paradisAdoptedNonces.delete(exitedNonce);
			}
			for (const contrib of this._contributions) {
				contrib.handleProcessDispose(id);
			}
			persistentProcess.dispose();
			this._ptys.delete(id);
			this._onProcessExit.fire({ id, event });
		});
		persistentProcess.onProcessData(event => this._onProcessData.fire({ id, event }));
		persistentProcess.onProcessReplay(event => this._onProcessReplay.fire({ id, event }));
		persistentProcess.onProcessReady(event => this._onProcessReady.fire({ id, event }));
		persistentProcess.onProcessOrphanQuestion(() => this._onProcessOrphanQuestion.fire({ id }));
		persistentProcess.onDidChangeProperty(property => this._onDidChangeProperty.fire({ id, property }));
		persistentProcess.onPersistentProcessReady(() => {
			for (const contrib of this._contributions) {
				contrib.handleProcessReady(id, process);
			}
		});
		this._ptys.set(id, persistentProcess);
		// PARA-PATCH: taking a terminal back from a daemon hands out a new id, exactly like reviving
		// one does, so it has to answer the same question reviving answers. A window restoring an
		// editor terminal knows only the id it was given generations ago plus the nonce, and asks
		// `getRevivedPtyNewId` to translate. Registering nothing here is what left every adopted
		// editor terminal unreachable: the window gave up, launched a fresh shell, and the process we
		// had just taken back sat in `_ptys` with nobody attached to it.
		//
		// Two held terminals can carry the same nonce: when an attach fails, upstream relaunches the
		// tab and the replacement keeps the instance's nonce, so a daemon that outlived a failed
		// reconnect holds both the original and an empty replacement under one nonce. Adoption offers
		// them live-first, oldest-first (paradisTerminalAdoption.ts), so refusing to overwrite hands
		// the tab back the one still running rather than the shell started because we could not find
		// it.
		if (paradisAdoptTarget) {
			const adoptedNonce = paradisTerminalIdentityNonce(options.shellIntegration.nonce);
			if (adoptedNonce !== undefined && !this._paradisAdoptedNonces.has(adoptedNonce)) {
				// **Taking one back outranks reviving one.** Both write this table, and a revive can
				// land either side of adoption, so order cannot decide it. One of the two is the
				// process that has been running all along; the other is a shell started from a saved
				// screenful. Remember which is which rather than letting the clock choose.
				this._paradisAdoptedNonces.add(adoptedNonce);
				this._paradisRevivedNewIdByNonce.set(adoptedNonce, id);
			}
		}
		return id;
	}

	@traceRpc
	async attachToProcess(id: number): Promise<void> {
		// PARA-PATCH: a window reconnects before the daemon's terminals have been taken back, so the
		// id it asks for does not exist yet. See paradisTerminalProcessFactory.ts.
		await paradisAdoptionSettled();
		try {
			await this._throwIfNoPty(id).attach();
			this._logService.info(`Persistent process reconnection "${id}"`);
		} catch (e) {
			this._logService.warn(`Persistent process reconnection "${id}" failed`, e.message);
			throw e;
		}
	}

	/**
	 * Resolve and claim an orphan in one pty-host RPC. Renderer-side list/held checks cannot prevent
	 * two windows from racing on the same snapshot, so the final nonce/orphan decision lives here.
	 */
	@traceRpc
	async paradisClaimAndAttachToProcess(workspaceId: string, id: number, paradisExpectedNonce: string): Promise<number> {
		await paradisAdoptionSettled();
		const expectedNonce = paradisTerminalIdentityNonce(paradisExpectedNonce);
		if (expectedNonce === undefined) {
			throw new Error('Cannot claim a terminal without a valid nonce');
		}
		const resolvedId = await this.getRevivedPtyNewId(workspaceId, id, expectedNonce) ?? id;
		const pty = this._throwIfNoPty(resolvedId);
		if (pty.workspaceId !== workspaceId || this._paradisNonceOf(resolvedId) !== expectedNonce) {
			throw new Error('The terminal claim did not match the requested workspace and nonce');
		}
		const now = Date.now();
		const existingClaim = this._paradisOrphanAttachClaims.get(resolvedId);
		if (existingClaim !== undefined && existingClaim > now) {
			throw new Error('The terminal is already being attached by another renderer');
		}
		// Hold the reservation across the async orphan question. A bounded lease recovers if the
		// renderer disappears before the RPC completes.
		this._paradisOrphanAttachClaims.set(resolvedId, now + 10_000);
		try {
			if (!await pty.isOrphaned()) {
				throw new Error('The terminal is already attached to a renderer');
			}
			await pty.attach();
			// Keep a brief post-RPC lease until the winning renderer has registered its Local/RemotePty
			// and can answer the next orphan question.
			this._paradisOrphanAttachClaims.set(resolvedId, Date.now() + 2_000);
			return resolvedId;
		} catch (error) {
			this._paradisOrphanAttachClaims.delete(resolvedId);
			throw error;
		}
	}

	@traceRpc
	async updateTitle(id: number, title: string, titleSource: TitleEventSource): Promise<void> {
		this._throwIfNoPty(id).setTitle(title, titleSource);
	}

	@traceRpc
	async updateIcon(id: number, userInitiated: boolean, icon: URI | { light: URI; dark: URI } | { id: string; color?: { id: string } }, color?: string): Promise<void> {
		this._throwIfNoPty(id).setIcon(userInitiated, icon, color);
	}

	@traceRpc
	async clearBuffer(id: number): Promise<void> {
		this._throwIfNoPty(id).clearBuffer();
	}

	@traceRpc
	async refreshProperty<T extends ProcessPropertyType>(id: number, type: T): Promise<IProcessPropertyMap[T]> {
		return this._throwIfNoPty(id).refreshProperty(type);
	}

	@traceRpc
	async updateProperty<T extends ProcessPropertyType>(id: number, type: T, value: IProcessPropertyMap[T]): Promise<void> {
		return this._throwIfNoPty(id).updateProperty(type, value);
	}

	@traceRpc
	async detachFromProcess(id: number, forcePersist?: boolean): Promise<void> {
		this._paradisOrphanAttachClaims.delete(id);
		return this._throwIfNoPty(id).detach(forcePersist);
	}

	@traceRpc
	async reduceConnectionGraceTime(): Promise<void> {
		for (const pty of this._ptys.values()) {
			pty.reduceGraceTime();
		}
	}

	@traceRpc
	/**
	 * PARA-PATCH: everything this host is holding, including terminals a window is attached to.
	 *
	 * `listProcesses` below cannot answer that: it ends with `filter(entry => entry.isOrphan)`,
	 * because it exists to offer terminals that can still be attached to. The pty daemon needs the
	 * other question — what is being held right now — for the count it shows and for deciding
	 * when it may stop. See vs/paradis/contrib/ptyDaemon.
	 */
	async paradisListHeldTerminals(): Promise<IProcessDetails[]> {
		const held = Array.from(this._ptys.entries()).filter(([_, pty]) => pty.shouldPersistTerminal);
		return Promise.all(held.map(([id, data]) => this._buildProcessDetails(id, data)));
	}

	/**
	 * PARA-PATCH: lightweight counterpart of {@link paradisListHeldTerminals} for pollers that
	 * only need how many terminals are held and their workspace names. `_buildProcessDetails`
	 * shells out per terminal (`getCwd` runs lsof on macOS) and waits on the orphan barrier,
	 * which is pure waste when nothing but the name is going to be read.
	 *
	 * Deliberately not `@traceRpc`: this is an in-process query from the pty daemon's pollers,
	 * so neither the trace log nor simulated latency injection should apply.
	 */
	async paradisListHeldWorkspaceNames(): Promise<{ workspaceName: string }[]> {
		const names: { workspaceName: string }[] = [];
		for (const [, data] of this._ptys.entries()) {
			if (data.shouldPersistTerminal) {
				names.push({ workspaceName: data.workspaceName });
			}
		}
		return names;
	}

	async listProcesses(): Promise<IProcessDetails[]> {
		// PARA-PATCH: listing before the daemon's terminals have been taken back reports none of
		// them, and nothing tells the asker later. See paradisTerminalProcessFactory.ts.
		await paradisAdoptionSettled();
		const persistentProcesses = Array.from(this._ptys.entries()).filter(([_, pty]) => pty.shouldPersistTerminal);

		this._logService.info(`Listing ${persistentProcesses.length} persistent terminals, ${this._ptys.size} total terminals`);
		const promises = persistentProcesses.map(async ([id, terminalProcessData]) => {
			const processDetails = await this._buildProcessDetails(id, terminalProcessData);
			if (!processDetails.isOrphan) {
				return processDetails;
			}
			const revivedFromPersistentProcessId = this._getRevivedFromPersistentProcessId(terminalProcessData.workspaceId, id);
			return revivedFromPersistentProcessId === undefined
				? processDetails
				: { ...processDetails, paradisRevivedFromPersistentProcessId: revivedFromPersistentProcessId };
		});
		const allTerminals = await Promise.all(promises);
		return allTerminals.filter(entry => entry.isOrphan);
	}

	@traceRpc
	async getPerformanceMarks(): Promise<performance.PerformanceMark[]> {
		return performance.getMarks();
	}

	@traceRpc
	async start(id: number): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		const pty = this._ptys.get(id);
		return pty ? pty.start() : { message: `Could not find pty with id "${id}"` };
	}

	@traceRpc
	async shutdown(id: number, immediate: boolean): Promise<void> {
		// Don't throw if the pty is already shutdown
		return this._ptys.get(id)?.shutdown(immediate);
	}
	@traceRpc
	async input(id: number, data: string): Promise<void> {
		const pty = this._throwIfNoPty(id);
		if (pty) {
			for (const contrib of this._contributions) {
				contrib.handleProcessInput(id, data);
			}
			pty.input(data);
		}
	}
	@traceRpc
	async sendSignal(id: number, signal: string): Promise<void> {
		return this._throwIfNoPty(id).sendSignal(signal);
	}
	@traceRpc
	async processBinary(id: number, data: string): Promise<void> {
		return this._throwIfNoPty(id).writeBinary(data);
	}
	@traceRpc
	async resize(id: number, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): Promise<void> {
		const pty = this._throwIfNoPty(id);
		if (pty) {
			for (const contrib of this._contributions) {
				contrib.handleProcessResize(id, cols, rows, pixelWidth, pixelHeight);
			}
			pty.resize(cols, rows, pixelWidth, pixelHeight);
		}
	}
	@traceRpc
	async getInitialCwd(id: number): Promise<string> {
		return this._throwIfNoPty(id).getInitialCwd();
	}
	@traceRpc
	async getCwd(id: number): Promise<string> {
		return this._throwIfNoPty(id).getCwd();
	}
	@traceRpc
	async acknowledgeDataEvent(id: number, charCount: number): Promise<void> {
		return this._throwIfNoPty(id).acknowledgeDataEvent(charCount);
	}
	@traceRpc
	async setUnicodeVersion(id: number, version: '6' | '11'): Promise<void> {
		return this._throwIfNoPty(id).setUnicodeVersion(version);
	}

	@traceRpc
	async setNextCommandId(id: number, commandLine: string, commandId: string): Promise<void> {
		return this._throwIfNoPty(id).setNextCommandId(commandLine, commandId);
	}
	@traceRpc
	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		return [];
	}
	@traceRpc
	async orphanQuestionReply(id: number): Promise<void> {
		return this._throwIfNoPty(id).orphanQuestionReply();
	}

	@traceRpc
	async getDefaultSystemShell(osOverride: OperatingSystem = OS): Promise<string> {
		return getSystemShell(osOverride, process.env);
	}

	@traceRpc
	async getEnvironment(): Promise<IProcessEnvironment> {
		return { ...process.env };
	}

	@traceRpc
	async getWslPath(original: string, direction: 'unix-to-win' | 'win-to-unix' | unknown): Promise<string> {
		if (direction === 'win-to-unix') {
			if (!isWindows) {
				return original;
			}
			if (await getWindowsBuildNumberAsync() < 17063) {
				return original.replace(/\\/g, '/');
			}
			const wslExecutable = await this._getWSLExecutablePath();
			if (!wslExecutable) {
				return original;
			}
			return new Promise<string>(c => {
				const proc = execFile(wslExecutable, ['-e', 'wslpath', original], {}, (error, stdout, stderr) => {
					c(error ? original : escapeNonWindowsPath(stdout.trim(), PosixShellType.Bash));
				});
				proc.stdin!.end();
			});
		}
		if (direction === 'unix-to-win') {
			// The backend is Windows, for example a local Windows workspace with a wsl session in
			// the terminal.
			if (isWindows) {
				if (await getWindowsBuildNumberAsync() < 17063) {
					return original;
				}
				const wslExecutable = await this._getWSLExecutablePath();
				if (!wslExecutable) {
					return original;
				}
				return new Promise<string>(c => {
					const proc = execFile(wslExecutable, ['-e', 'wslpath', '-w', original], {}, (error, stdout, stderr) => {
						c(error ? original : stdout.trim());
					});
					proc.stdin!.end();
				});
			}
		}
		// Fallback just in case
		return original;
	}

	private async _getWSLExecutablePath(): Promise<string | undefined> {
		const useWSLexe = await getWindowsBuildNumberAsync() >= 16299;
		const is32ProcessOn64Windows = process.env.hasOwnProperty('PROCESSOR_ARCHITEW6432');
		const systemRoot = process.env['SystemRoot'];
		if (systemRoot) {
			return join(systemRoot, is32ProcessOn64Windows ? 'Sysnative' : 'System32', useWSLexe ? 'wsl.exe' : 'bash.exe');
		}
		return undefined;
	}

	/**
	 * PARA-PATCH: `paradisExpectedNonce` names the terminal the caller means to reattach to.
	 *
	 * A persistent process id only means something within the session that handed it out — this host
	 * restarts the counter at 0, so reviving old ids 4, 5, 13… hands out new ids 1, 2, 3… and the two
	 * ranges overlap. A serialized editor input, which is written once and then restored several
	 * generations later, therefore cannot be resolved by id alone: attaching to whichever terminal
	 * holds that number now takes the process away from the window that owns it. The nonce is carried
	 * across revives, so it answers the question the id cannot.
	 */
	@traceRpc
	async getRevivedPtyNewId(workspaceId: string, id: number, paradisExpectedNonce?: string): Promise<number | undefined> {
		// PARA-PATCH: the tables consulted below are filled in as terminals are taken back from a
		// daemon, so answering before that is done answers "nowhere". See
		// paradisTerminalProcessFactory.ts.
		await paradisAdoptionSettled();
		try {
			const expectedNonce = paradisTerminalIdentityNonce(paradisExpectedNonce);
			if (expectedNonce !== undefined) {
				// The terminal was revived in this host, possibly generations ago.
				const revivedId = this._paradisRevivedNewIdByNonce.get(expectedNonce);
				if (revivedId !== undefined && this._paradisNonceOf(revivedId) === expectedNonce) {
					return revivedId;
				}
				// No revive in between (a window reload): the id still names the right terminal.
				if (this._paradisNonceOf(id) === expectedNonce) {
					return undefined;
				}
				// The id names somebody else's terminal. Answering with an id that cannot exist makes
				// the attach fail, which upstream handles by launching a fresh shell — far better than
				// stealing a live process. An id with nothing behind it fails either way.
				return this._ptys.has(id) ? PARADIS_UNRESOLVABLE_PTY_ID : undefined;
			}
			return this._revivedPtyIdMap.get(this._getRevivingProcessId(workspaceId, id))?.newId;
		} catch (e) {
			// PARA-PATCH: fail closed. Returning `undefined` here means "the id you asked with is
			// still right", and the caller then attaches to whatever holds that number now — which,
			// after ids are handed out afresh, is somebody else's live terminal. An id that cannot
			// exist fails the attach instead, and upstream answers a failed attach with a new shell.
			this._logService.warn(`Couldn't find terminal ID ${workspaceId}-${id}`, e.message);
			return PARADIS_UNRESOLVABLE_PTY_ID;
		}
	}

	/** PARA-CODE: The shell integration nonce of a live terminal, if there is one. */
	private _paradisNonceOf(id: number): string | undefined {
		return paradisTerminalIdentityNonce(this._ptys.get(id)?.processLaunchOptions.options.shellIntegration.nonce);
	}

	@traceRpc
	async setTerminalLayoutInfo(args: ISetTerminalLayoutInfoArgs): Promise<void> {
		// PARA-PATCH: a window can hand over a layout that leaves out terminals a daemon is holding
		// for this very workspace, and taking that at face value is how the running processes lose
		// their way back onto the screen.
		//
		// Two ways it happens. A window that restored nothing — because taking the terminals back ran
		// past its deadline — saves an empty layout, and an empty layout is the signal telling the
		// daemon to forget the one it was keeping. And a window that revived from a saved screenful
		// re-seeds the layout it wrote before the update, in ids from a pty host that no longer
		// exists; those ids are small integers from a counter that restarts, so they land on today's
		// terminals by coincidence rather than missing cleanly.
		//
		// A layout that accounts for every terminal the daemon holds here is the whole picture and is
		// taken as such. One that does not is somebody's partial view, and there is nothing to gain
		// by writing it down.
		if (!this._paradisLayoutAccountsForHeldTerminals(args)) {
			this._logService.info(`Ignoring a layout for ${args.workspaceId} that leaves out terminals the daemon is holding`);
			return;
		}
		this.paradisSetTerminalLayoutInfo(args);
		// PARA-PATCH: this only lives as long as the process, so terminals kept by a daemon would
		// come back with nowhere to appear. See paradisTerminalLayout.ts.
		paradisRememberLayout(args);
	}

	/**
	 * PARA-CODE: Record a layout here without handing it to the daemon.
	 *
	 * Taking terminals back uses this. The daemon already holds the layout it gave us, and what we
	 * pass back is that layout with every terminal we could not take back dropped from it
	 * (`paradisDecodeLayout`). Writing that over the original turns "we could not reach it this time"
	 * into "it was never there", and no later launch can undo it.
	 */
	paradisSetTerminalLayoutInfo(args: ISetTerminalLayoutInfoArgs): void {
		this._workspaceLayoutInfos.set(args.workspaceId, args);
	}

	/**
	 * PARA-CODE: Whether a layout names every terminal a daemon is holding for its workspace.
	 *
	 * Holding none — the ordinary case, with the daemon off — makes this trivially true, so nothing
	 * changes for anyone not using it.
	 */
	private _paradisLayoutAccountsForHeldTerminals(args: ISetTerminalLayoutInfoArgs): boolean {
		const held = new Set<number>();
		for (const [id, pty] of this._ptys) {
			if (pty.workspaceId === args.workspaceId && paradisHandleOf(id) !== undefined) {
				held.add(id);
			}
		}
		if (held.size === 0) {
			return true;
		}
		for (const tab of args.tabs ?? []) {
			for (const terminal of tab.terminals ?? []) {
				held.delete(terminal.terminal);
			}
		}
		for (const id of args.background ?? []) {
			held.delete(id);
		}
		return held.size === 0;
	}

	@traceRpc
	async getTerminalLayoutInfo(args: IGetTerminalLayoutInfoArgs): Promise<ITerminalsLayoutInfo | undefined> {
		performance.mark('code/willGetTerminalLayoutInfo');
		// PARA-PATCH: a window asked before terminals kept by a daemon were taken back would see
		// none of them, and nothing tells it later. See paradisTerminalProcessFactory.ts.
		await paradisAdoptionSettled();
		const layout = this._workspaceLayoutInfos.get(args.workspaceId);
		if (layout) {
			const doneSet: Set<number> = new Set();
			const expandedTabs = await Promise.all(layout.tabs.map(async tab => this._expandTerminalTab(args.workspaceId, tab, doneSet)));
			const tabs = expandedTabs.filter(t => t.terminals.length > 0);
			const expandedBackground = (await Promise.all(layout.background?.map(b => this._expandTerminalInstance(args.workspaceId, b, doneSet)) ?? [])).filter(b => b.terminal !== null).map(b => b.terminal);
			performance.mark('code/didGetTerminalLayoutInfo');
			return { tabs, background: expandedBackground };
		}
		performance.mark('code/didGetTerminalLayoutInfo');
		return undefined;
	}

	private async _expandTerminalTab(workspaceId: string, tab: ITerminalTabLayoutInfoById, doneSet: Set<number>): Promise<ITerminalTabLayoutInfoDto> {
		const expandedTerminals = (await Promise.all(tab.terminals.map(t => this._expandTerminalInstance(workspaceId, t, doneSet))));
		const filtered = expandedTerminals.filter(term => term.terminal !== null) as IRawTerminalInstanceLayoutInfo<IProcessDetails>[];
		const activePersistentProcessId = tab.activePersistentProcessId === undefined
			? undefined
			: filtered.find(term => term.terminal.id === tab.activePersistentProcessId
				|| term.terminal.paradisRevivedFromPersistentProcessId === tab.activePersistentProcessId)?.terminal.id;
		return {
			isActive: tab.isActive,
			activePersistentProcessId,
			terminals: filtered
		};
	}

	private async _expandTerminalInstance(workspaceId: string, t: ITerminalInstanceLayoutInfoById | number, doneSet: Set<number>): Promise<IRawTerminalInstanceLayoutInfo<IProcessDetails | null>> {
		const hasLayout = !isNumber(t);
		const ptyId = hasLayout ? t.terminal : t;
		try {
			const oldId = this._getRevivingProcessId(workspaceId, ptyId);
			const revivedPtyId = this._revivedPtyIdMap.get(oldId)?.newId;
			this._logService.info(`Expanding terminal instance, old id ${oldId} -> new id ${revivedPtyId}`);
			this._revivedPtyIdMap.delete(oldId);
			const persistentProcessId = revivedPtyId ?? ptyId;
			if (doneSet.has(persistentProcessId)) {
				throw new Error(`Terminal ${persistentProcessId} has already been expanded`);
			}
			doneSet.add(persistentProcessId);
			const persistentProcess = this._throwIfNoPty(persistentProcessId);
			const processDetails = persistentProcess && await this._buildProcessDetails(
				persistentProcessId,
				persistentProcess,
				revivedPtyId !== undefined ? ptyId : undefined,
			);
			return {
				terminal: processDetails,
				relativeSize: hasLayout ? t.relativeSize : 0
			};
		} catch (e) {
			this._logService.warn(`Couldn't get layout info, a terminal was probably disconnected`, e.message);
			this._logService.debug('Reattach to wrong terminal debug info - layout info by id', t);
			this._logService.debug('Reattach to wrong terminal debug info - _revivePtyIdMap', Array.from(this._revivedPtyIdMap.values()));
			this._logService.debug('Reattach to wrong terminal debug info - _ptys ids', Array.from(this._ptys.keys()));
			// this will be filtered out and not reconnected
			return {
				terminal: null,
				relativeSize: hasLayout ? t.relativeSize : 0
			};
		}
	}

	private _getRevivingProcessId(workspaceId: string, ptyId: number): string {
		return `${workspaceId}-${ptyId}`;
	}

	private _getRevivedFromPersistentProcessId(workspaceId: string, persistentProcessId: number): number | undefined {
		return this._revivedPtyOldIdByNewId.get(this._getRevivingProcessId(workspaceId, persistentProcessId));
	}

	private async _buildProcessDetails(id: number, persistentProcess: PersistentTerminalProcess, revivedFromPersistentProcessId?: number): Promise<IProcessDetails> {
		performance.mark(`code/willBuildProcessDetails/${id}`);
		// If the process was just revived, don't do the orphan check as it will
		// take some time
		const wasRevived = revivedFromPersistentProcessId !== undefined;
		const [cwd, isOrphan] = await Promise.all([persistentProcess.getCwd(), wasRevived ? true : persistentProcess.isOrphaned()]);
		// PARA-PATCH: mobile relay recovery — read the pane token injected at PTY launch
		// PARA-CODE: Carry the exact token injected at PTY launch across revive and detach.
		const paneToken = persistentProcess.shellLaunchConfig.env?.['PARA_CODE_TERMINAL_PANE_ID'];
		const result = {
			id,
			title: persistentProcess.title,
			titleSource: persistentProcess.titleSource,
			pid: persistentProcess.pid,
			workspaceId: persistentProcess.workspaceId,
			workspaceName: persistentProcess.workspaceName,
			cwd,
			isOrphan,
			icon: persistentProcess.icon,
			color: persistentProcess.color,
			fixedDimensions: persistentProcess.fixedDimensions,
			environmentVariableCollections: persistentProcess.processLaunchOptions.options.environmentVariableCollections,
			reconnectionProperties: persistentProcess.shellLaunchConfig.reconnectionProperties,
			waitOnExit: persistentProcess.shellLaunchConfig.waitOnExit,
			hideFromUser: persistentProcess.shellLaunchConfig.hideFromUser,
			isFeatureTerminal: persistentProcess.shellLaunchConfig.isFeatureTerminal,
			type: persistentProcess.shellLaunchConfig.type,
			hasChildProcesses: persistentProcess.hasChildProcesses,
			shellIntegrationNonce: persistentProcess.processLaunchOptions.options.shellIntegration.nonce,
			// PARA-PATCH: tells readers keyed by persistent process id that this id says nothing about
			// earlier sessions. See IProcessDetails#paradisAdopted.
			...(persistentProcess.paradisAdopted ? { paradisAdopted: true } : {}),
			// PARA-PATCH: mobile relay recovery — include the validated pane token in process details
			...(typeof paneToken === 'string' && paneToken.length > 0 && paneToken.length <= 200 ? { paradisPaneToken: paneToken } : {}),
			...(revivedFromPersistentProcessId !== undefined ? { paradisRevivedFromPersistentProcessId: revivedFromPersistentProcessId } : {}),
			tabActions: persistentProcess.shellLaunchConfig.tabActions
		};
		performance.mark(`code/didBuildProcessDetails/${id}`);
		return result;
	}

	private _throwIfNoPty(id: number): PersistentTerminalProcess {
		const pty = this._ptys.get(id);
		if (!pty) {
			throw new ErrorNoTelemetry(`Could not find pty ${id} on pty host`);
		}
		return pty;
	}
}

const enum InteractionState {
	/** The terminal has not been interacted with. */
	None = 'None',
	/** The terminal has only been interacted with by the replay mechanism. */
	ReplayOnly = 'ReplayOnly',
	/** The terminal has been directly interacted with this session. */
	Session = 'Session'
}

class PersistentTerminalProcess extends Disposable {

	private readonly _bufferer: TerminalDataBufferer;

	private readonly _pendingCommands = new Map<number, { resolve: (data: unknown) => void; reject: (err: unknown) => void }>();

	private _isStarted: boolean = false;
	private _interactionState: MutationLogger<InteractionState>;

	private _orphanQuestionBarrier: AutoOpenBarrier | null;
	private _orphanQuestionReplyTime: number;
	private _orphanRequestQueue = new Queue<boolean>();
	private _disconnectRunner1: ProcessTimeRunOnceScheduler;
	private _disconnectRunner2: ProcessTimeRunOnceScheduler;

	private readonly _onProcessReplay = this._register(new Emitter<IPtyHostProcessReplayEvent>());
	readonly onProcessReplay = this._onProcessReplay.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onPersistentProcessReady = this._register(new Emitter<void>());
	/** Fired when the persistent process has a ready process and has finished its replay. */
	readonly onPersistentProcessReady = this._onPersistentProcessReady.event;
	private readonly _onProcessData = this._register(new Emitter<string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessOrphanQuestion = this._register(new Emitter<void>());
	readonly onProcessOrphanQuestion = this._onProcessOrphanQuestion.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;

	private _inReplay = false;

	private _pid = -1;
	private _paradisAdopted = false;
	private _cwd = '';
	private _title: string | undefined;
	private _titleSource: TitleEventSource = TitleEventSource.Process;
	private _serializer: ITerminalSerializer;
	private _wasRevived: boolean;
	private _fixedDimensions: IFixedTerminalDimensions | undefined;

	get pid(): number { return this._pid; }
	/** PARA-CODE: Whether this was taken back from a daemon rather than started here. */
	get paradisAdopted(): boolean { return this._paradisAdopted; }
	get shellLaunchConfig(): IShellLaunchConfig { return this._terminalProcess.shellLaunchConfig; }
	get hasWrittenData(): boolean { return this._interactionState.value !== InteractionState.None; }
	get title(): string { return this._title || this._terminalProcess.currentTitle; }
	get titleSource(): TitleEventSource { return this._titleSource; }
	get icon(): TerminalIcon | undefined { return this._icon; }
	get color(): string | undefined { return this._color; }
	get fixedDimensions(): IFixedTerminalDimensions | undefined { return this._fixedDimensions; }
	get hasChildProcesses(): boolean { return this._terminalProcess.hasChildProcesses; }

	setTitle(title: string, titleSource: TitleEventSource): void {
		if (titleSource === TitleEventSource.Api) {
			this._interactionState.setValue(InteractionState.Session, 'setTitle');
			this._serializer.freeRawReviveBuffer();
		}
		this._title = title;
		this._titleSource = titleSource;
	}

	setIcon(userInitiated: boolean, icon: TerminalIcon, color?: string): void {
		if (!this._icon || hasKey(icon, { id: true }) && hasKey(this._icon, { id: true }) && icon.id !== this._icon.id ||
			!this.color || color !== this._color) {

			this._serializer.freeRawReviveBuffer();
			if (userInitiated) {
				this._interactionState.setValue(InteractionState.Session, 'setIcon');
			}
		}
		this._icon = icon;
		this._color = color;
	}

	private _setFixedDimensions(fixedDimensions?: IFixedTerminalDimensions): void {
		this._fixedDimensions = fixedDimensions;
	}

	constructor(
		private _persistentProcessId: number,
		// PARA-PATCH: terminals may live in a daemon that outlives this process, so what is held here
		// is not always the local one. See paradisTerminalProcessLike.ts.
		private readonly _terminalProcess: IParadisTerminalProcessLike,
		readonly workspaceId: string,
		readonly workspaceName: string,
		readonly shouldPersistTerminal: boolean,
		cols: number,
		rows: number,
		readonly processLaunchOptions: IPersistentTerminalProcessLaunchConfig,
		public unicodeVersion: '6' | '11',
		reconnectConstants: IReconnectConstants,
		private readonly _logService: ILogService,
		reviveBuffer: string | undefined,
		rawReviveBuffer: string | undefined,
		private _icon?: TerminalIcon,
		private _color?: string,
		name?: string,
		fixedDimensions?: IFixedTerminalDimensions,
		// PARA-PATCH: a terminal taken back from a daemon has not been typed into, and reloading a
		// window ends terminals nobody has touched. Being handed one counts as having touched it.
		paradisAdopt?: IParadisAdoptTarget
	) {
		super();
		this._interactionState = new MutationLogger(`Persistent process "${this._persistentProcessId}" interaction state`, InteractionState.None, this._logService);
		if (paradisAdopt) {
			this._paradisAdopted = true;
			this._interactionState.setValue(InteractionState.ReplayOnly, 'paradisAdopted');
			// PARA-PATCH: `_pid` is normally filled in by the ready event, which the daemon-backed
			// process only fires once a window opens this terminal. Until then every adopted
			// terminal would list itself as pid -1 with no title, which is precisely the state
			// someone reading `listProcesses` needs to tell them apart. We already know the pid.
			this._pid = paradisAdopt.pid;
		}
		this._wasRevived = reviveBuffer !== undefined;
		this._serializer = new XtermSerializer(
			cols,
			rows,
			reconnectConstants.scrollback,
			unicodeVersion,
			reviveBuffer,
			processLaunchOptions.options.shellIntegration.nonce,
			shouldPersistTerminal ? rawReviveBuffer : undefined,
			this._logService
		);
		if (name) {
			this.setTitle(name, TitleEventSource.Api);
		}
		this._fixedDimensions = fixedDimensions;
		this._orphanQuestionBarrier = null;
		this._orphanQuestionReplyTime = 0;
		this._disconnectRunner1 = this._register(new ProcessTimeRunOnceScheduler(() => {
			this._logService.info(`Persistent process "${this._persistentProcessId}": The reconnection grace time of ${printTime(reconnectConstants.graceTime)} has expired, shutting down pid "${this._pid}"`);
			this.shutdown(true);
		}, reconnectConstants.graceTime));
		this._disconnectRunner2 = this._register(new ProcessTimeRunOnceScheduler(() => {
			this._logService.info(`Persistent process "${this._persistentProcessId}": The short reconnection grace time of ${printTime(reconnectConstants.shortGraceTime)} has expired, shutting down pid ${this._pid}`);
			this.shutdown(true);
		}, reconnectConstants.shortGraceTime));
		this._register(this._terminalProcess.onProcessExit(() => this._bufferer.stopBuffering(this._persistentProcessId)));
		this._register(this._terminalProcess.onProcessReady(e => {
			this._pid = e.pid;
			this._cwd = e.cwd;
			this._onProcessReady.fire(e);
		}));
		this._register(this._terminalProcess.onDidChangeProperty(e => {
			this._onDidChangeProperty.fire(e);
		}));

		// Data buffering to reduce the amount of messages going to the renderer
		this._bufferer = new TerminalDataBufferer((_, data) => this._onProcessData.fire(data));
		this._register(this._bufferer.startBuffering(this._persistentProcessId, this._terminalProcess.onProcessData));

		// Data recording for reconnect
		this._register(this.onProcessData(e => this._serializer.handleData(e)));
	}

	async attach(): Promise<void> {
		if (!this._disconnectRunner1.isScheduled() && !this._disconnectRunner2.isScheduled()) {
			this._logService.warn(`Persistent process "${this._persistentProcessId}": Process had no disconnect runners but was an orphan`);
		}
		this._disconnectRunner1.cancel();
		this._disconnectRunner2.cancel();
	}

	async detach(forcePersist?: boolean): Promise<void> {
		// Keep the process around if it was indicated to persist and it has had some iteraction or
		// was replayed
		if (this.shouldPersistTerminal && (this._interactionState.value !== InteractionState.None || forcePersist)) {
			this._disconnectRunner1.schedule();
		} else {
			this.shutdown(true);
		}
	}

	serializeNormalBuffer(): Promise<IPtyHostProcessReplayEvent> {
		return this._serializer.generateReplayEvent(true, this._interactionState.value !== InteractionState.Session);
	}

	async refreshProperty<T extends ProcessPropertyType>(type: T): Promise<IProcessPropertyMap[T]> {
		return this._terminalProcess.refreshProperty(type);
	}

	async updateProperty<T extends ProcessPropertyType>(type: T, value: IProcessPropertyMap[T]): Promise<void> {
		if (type === ProcessPropertyType.FixedDimensions) {
			return this._setFixedDimensions(value as IProcessPropertyMap[ProcessPropertyType.FixedDimensions]);
		}
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		if (!this._isStarted) {
			const result = await this._terminalProcess.start();
			if (result && hasKey(result, { message: true })) {
				// it's a terminal launch error
				return result;
			}
			this._isStarted = true;

			// If the process was revived, trigger a replay on first start. An alternative approach
			// could be to start it on the pty host before attaching but this fails on Windows as
			// conpty's inherit cursor option which is required, ends up sending DSR CPR which
			// causes conhost to hang when no response is received from the terminal (which wouldn't
			// be attached yet). https://github.com/microsoft/terminal/issues/11213
			if (this._wasRevived) {
				this.triggerReplay();
			} else {
				this._onPersistentProcessReady.fire();
			}
			return result;
		}

		this._onProcessReady.fire({ pid: this._pid, cwd: this._cwd, windowsPty: this._terminalProcess.getWindowsPty() });
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.Title, value: this._terminalProcess.currentTitle });
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.ShellType, value: this._terminalProcess.shellType });
		this.triggerReplay();
		return undefined;
	}
	shutdown(immediate: boolean): void {
		return this._terminalProcess.shutdown(immediate);
	}
	input(data: string): void {
		this._interactionState.setValue(InteractionState.Session, 'input');
		this._serializer.freeRawReviveBuffer();
		if (this._inReplay) {
			return;
		}
		return this._terminalProcess.input(data);
	}
	sendSignal(signal: string): void {
		if (this._inReplay) {
			return;
		}
		return this._terminalProcess.sendSignal(signal);
	}
	writeBinary(data: string): Promise<void> {
		return this._terminalProcess.processBinary(data);
	}
	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this._inReplay) {
			return;
		}
		this._serializer.handleResize(cols, rows);

		// Buffered events should flush when a resize occurs
		this._bufferer.flushBuffer(this._persistentProcessId);

		return this._terminalProcess.resize(cols, rows, pixelWidth, pixelHeight);
	}
	async clearBuffer(): Promise<void> {
		this._serializer.clearBuffer();
		this._terminalProcess.clearBuffer();
	}
	setUnicodeVersion(version: '6' | '11'): void {
		this.unicodeVersion = version;
		this._serializer.setUnicodeVersion?.(version);
		// TODO: Pass in unicode version in ctor
	}

	async setNextCommandId(commandLine: string, commandId: string): Promise<void> {
		this._serializer.setNextCommandId?.(commandLine, commandId);
	}

	acknowledgeDataEvent(charCount: number): void {
		if (this._inReplay) {
			return;
		}
		return this._terminalProcess.acknowledgeDataEvent(charCount);
	}
	getInitialCwd(): Promise<string> {
		return this._terminalProcess.getInitialCwd();
	}
	getCwd(): Promise<string> {
		return this._terminalProcess.getCwd();
	}

	async triggerReplay(): Promise<void> {
		if (this._interactionState.value === InteractionState.None) {
			this._interactionState.setValue(InteractionState.ReplayOnly, 'triggerReplay');
		}
		const ev = await this._serializer.generateReplayEvent();
		let dataLength = 0;
		for (const e of ev.events) {
			dataLength += e.data.length;
		}
		this._logService.info(`Persistent process "${this._persistentProcessId}": Replaying ${dataLength} chars and ${ev.events.length} size events`);
		this._onProcessReplay.fire(ev);
		this._terminalProcess.clearUnacknowledgedChars();
		this._onPersistentProcessReady.fire();
	}

	sendCommandResult(reqId: number, isError: boolean, serializedPayload: unknown): void {
		const data = this._pendingCommands.get(reqId);
		if (!data) {
			return;
		}
		this._pendingCommands.delete(reqId);
	}

	orphanQuestionReply(): void {
		this._orphanQuestionReplyTime = Date.now();
		if (this._orphanQuestionBarrier) {
			const barrier = this._orphanQuestionBarrier;
			this._orphanQuestionBarrier = null;
			barrier.open();
		}
	}

	reduceGraceTime(): void {
		if (this._disconnectRunner2.isScheduled()) {
			// we are disconnected and already running the short reconnection timer
			return;
		}
		if (this._disconnectRunner1.isScheduled()) {
			// we are disconnected and running the long reconnection timer
			this._disconnectRunner2.schedule();
		}
	}

	async isOrphaned(): Promise<boolean> {
		return await this._orphanRequestQueue.queue(async () => this._isOrphaned());
	}

	private async _isOrphaned(): Promise<boolean> {
		// The process is already known to be orphaned
		if (this._disconnectRunner1.isScheduled() || this._disconnectRunner2.isScheduled()) {
			return true;
		}

		// Ask whether the renderer(s) whether the process is orphaned and await the reply
		if (!this._orphanQuestionBarrier) {
			// the barrier opens after 4 seconds with or without a reply
			this._orphanQuestionBarrier = new AutoOpenBarrier(4000);
			this._orphanQuestionReplyTime = 0;
			this._onProcessOrphanQuestion.fire();
		}

		await this._orphanQuestionBarrier.wait();
		return (Date.now() - this._orphanQuestionReplyTime > 500);
	}
}

class MutationLogger<T> {
	get value(): T { return this._value; }
	setValue(value: T, reason: string) {
		if (this._value !== value) {
			this._value = value;
			this._log(reason);
		}
	}

	constructor(
		private readonly _name: string,
		private _value: T,
		private readonly _logService: ILogService
	) {
		this._log('initialized');
	}

	private _log(reason: string): void {
		this._logService.debug(`MutationLogger "${this._name}" set to "${this._value}", reason: ${reason}`);
	}
}

class XtermSerializer implements ITerminalSerializer {
	private readonly _xterm: XtermTerminal;
	private readonly _shellIntegrationAddon: ShellIntegrationAddon;
	private _unicodeAddon?: XtermUnicode11Addon;

	constructor(
		cols: number,
		rows: number,
		scrollback: number,
		unicodeVersion: '6' | '11',
		reviveBufferWithRestoreMessage: string | undefined,
		shellIntegrationNonce: string,
		private _rawReviveBuffer: string | undefined,
		logService: ILogService
	) {
		this._xterm = new XtermTerminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true
		});
		if (reviveBufferWithRestoreMessage) {
			this._xterm.writeln(reviveBufferWithRestoreMessage);
		}
		this.setUnicodeVersion(unicodeVersion);
		this._shellIntegrationAddon = new ShellIntegrationAddon(shellIntegrationNonce, true, undefined, undefined, logService);
		this._xterm.loadAddon(this._shellIntegrationAddon);
	}

	freeRawReviveBuffer(): void {
		// Free the memory of the terminal if it will need to be re-serialized
		this._rawReviveBuffer = undefined;
	}

	handleData(data: string): void {
		this._xterm.write(data);
	}

	handleResize(cols: number, rows: number): void {
		this._xterm.resize(cols, rows);
	}

	clearBuffer(): void {
		this._xterm.clear();
	}

	setNextCommandId(commandLine: string, commandId: string): void {
		this._shellIntegrationAddon.setNextCommandId(commandLine, commandId);
	}

	async generateReplayEvent(normalBufferOnly?: boolean, restoreToLastReviveBuffer?: boolean): Promise<IPtyHostProcessReplayEvent> {
		const serialize = new (await this._getSerializeConstructor());
		this._xterm.loadAddon(serialize);
		const options: ISerializeOptions = {
			scrollback: this._xterm.options.scrollback
		};
		if (normalBufferOnly) {
			options.excludeAltBuffer = true;
			options.excludeModes = true;
		}
		let serialized: string;
		if (restoreToLastReviveBuffer && this._rawReviveBuffer) {
			serialized = this._rawReviveBuffer;
		} else {
			serialized = serialize.serialize(options);
		}
		return {
			events: [
				{
					cols: this._xterm.cols,
					rows: this._xterm.rows,
					data: serialized
				}
			],
			commands: this._shellIntegrationAddon.serialize()
		};
	}

	async setUnicodeVersion(version: '6' | '11'): Promise<void> {
		if (this._xterm.unicode.activeVersion === version) {
			return;
		}
		if (version === '11') {
			this._unicodeAddon = new (await this._getUnicode11Constructor());
			this._xterm.loadAddon(this._unicodeAddon);
		} else {
			this._unicodeAddon?.dispose();
			this._unicodeAddon = undefined;
		}
		this._xterm.unicode.activeVersion = version;
	}

	async _getUnicode11Constructor(): Promise<typeof Unicode11Addon> {
		if (!Unicode11Addon) {
			Unicode11Addon = (await import('@xterm/addon-unicode11')).Unicode11Addon;
		}
		return Unicode11Addon;
	}

	async _getSerializeConstructor(): Promise<typeof SerializeAddon> {
		if (!SerializeAddon) {
			SerializeAddon = (await import('@xterm/addon-serialize')).SerializeAddon;
		}
		return SerializeAddon;
	}
}

function printTime(ms: number): string {
	let h = 0;
	let m = 0;
	let s = 0;
	if (ms >= 1000) {
		s = Math.floor(ms / 1000);
		ms -= s * 1000;
	}
	if (s >= 60) {
		m = Math.floor(s / 60);
		s -= m * 60;
	}
	if (m >= 60) {
		h = Math.floor(m / 60);
		m -= h * 60;
	}
	const _h = h ? `${h}h` : ``;
	const _m = m ? `${m}m` : ``;
	const _s = s ? `${s}s` : ``;
	const _ms = ms ? `${ms}ms` : ``;
	return `${_h}${_m}${_s}${_ms}`;
}

interface ITerminalSerializer {
	handleData(data: string): void;
	freeRawReviveBuffer(): void;
	handleResize(cols: number, rows: number): void;
	clearBuffer(): void;
	generateReplayEvent(normalBufferOnly?: boolean, restoreToLastReviveBuffer?: boolean): Promise<IPtyHostProcessReplayEvent>;
	setUnicodeVersion?(version: '6' | '11'): void;
	setNextCommandId?(commandLine: string, commandId: string): void;
}

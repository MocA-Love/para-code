/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { raceCancellation, timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { joinPath } from '../../../../base/common/resources.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ITerminalContributionContext, registerTerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisCodexThreadPromptRequest,
	IParadisCodexThreadPromptResult,
	PARADIS_CODEX_TERMINAL_TITLE_CHANNEL,
	PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING,
	PARADIS_CODEX_TERMINAL_TITLE_ITEMS,
} from '../common/paradisCodexTerminalTitle.js';

// `[tui].terminal_title` asks for the app name (PARADIS_CODEX_TERMINAL_TITLE_ITEMS), so the title
// normally arrives as `codex | <thread id>`. The prefix is still optional here as a safety net: a
// user who edited that config themselves, or a Codex build that renders the items differently,
// should not lose the feature outright. That raw title is what the tab shows until the transient
// title below replaces it with something readable.
const CODEX_THREAD_TITLE_PATTERN = /^(?:codex \| )?([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const TRANSIENT_TITLE_OWNER_PREFIX = 'para.codexTerminalTitle';
// Codex prints the thread id as its title the moment the TUI starts, but it only writes the
// thread row (and therefore any title, first user message, or rollout) once the first turn is
// submitted. The gap between the two is however long the user takes to type their first prompt,
// so the lookup has to outlive that pause instead of sampling a fixed window right after launch.
// Each poll costs well under a millisecond in the shared process, so waiting is cheap. The delay
// is capped low enough that the row is picked up promptly once it appears: Codex may rewrite the
// title itself later in the session, which drops our transient title, so a late win is no win.
const PROMPT_LOOKUP_INITIAL_DELAY_MS = 250;
const PROMPT_LOOKUP_MAX_DELAY_MS = 2_000;
// The poll ends on its own when the Codex command finishes, so this only bounds a session that is
// started and then left sitting at an empty prompt.
const PROMPT_LOOKUP_DEADLINE_MS = 30 * 60 * 1_000;
// Keeps a shared process restart from permanently giving up on an otherwise healthy session.
const PROMPT_LOOKUP_MAX_CONSECUTIVE_ERRORS = 5;
const CODEX_SUBCOMMANDS = new Set([
	'app-server', 'apply', 'cloud', 'completion', 'debug', 'exec', 'features', 'fork', 'login', 'logout',
	'mcp', 'mcp-server', 'review', 'sandbox',
]);
const CODEX_OPTIONS_WITH_VALUES = new Set([
	'--add-dir', '--ask-for-approval', '--cd', '--config', '--disable', '--enable', '--image', '--local-provider',
	'--model', '--profile', '--sandbox', '-a', '-C', '-c', '-i', '-m', '-p', '-s',
]);

function tokenizeShellCommand(command: string): string[] | undefined {
	command = command.trim();
	const tokens: string[] = [];
	let token = '';
	let tokenStarted = false;
	let quote: 'single' | 'double' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (escaped) {
			token += character;
			tokenStarted = true;
			escaped = false;
			continue;
		}
		if (quote === 'single') {
			if (character === '\'') {
				quote = undefined;
			} else {
				token += character;
			}
			continue;
		}
		if (quote === 'double') {
			if (character === '"') {
				quote = undefined;
			} else if (character === '\\') {
				if ('"\\$`'.includes(command[index + 1] ?? '')) {
					escaped = true;
				} else {
					token += character;
				}
			} else {
				token += character;
			}
			continue;
		}
		if (character === '\\') {
			if (/^[A-Za-z]:/.test(token)) {
				token += character;
			} else {
				escaped = true;
			}
			tokenStarted = true;
		} else if (character === '\'') {
			quote = 'single';
			tokenStarted = true;
		} else if (character === '"') {
			quote = 'double';
			tokenStarted = true;
		} else if (/\s/.test(character)) {
			if (tokenStarted) {
				tokens.push(token);
				token = '';
				tokenStarted = false;
			}
		} else if (';&|<>`'.includes(character) || (character === '$' && command.includes('$('))) {
			return undefined;
		} else {
			token += character;
			tokenStarted = true;
		}
	}
	if (quote || escaped) {
		return undefined;
	}
	if (tokenStarted) {
		tokens.push(token);
	}
	return tokens;
}

function classifyCodexTuiCommand(command: string): 'start' | 'resume' | undefined {
	const tokens = tokenizeShellCommand(command);
	// Tokenizing an empty command line yields an empty array, which the buffer produces whenever a
	// command executes before its line has been recovered.
	const executableName = tokens?.[0]?.split(/[\\/]/).pop();
	if (!tokens?.length || !executableName || !/^codex(?:\.exe|\.cmd)?$/i.test(executableName)) {
		return undefined;
	}
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === '--') {
			return 'start';
		}
		if (token.startsWith('-')) {
			if (CODEX_OPTIONS_WITH_VALUES.has(token)) {
				index++;
				if (index >= tokens.length) {
					return undefined;
				}
			}
			continue;
		}
		if (token === 'resume') {
			return 'resume';
		}
		return CODEX_SUBCOMMANDS.has(token) ? undefined : 'start';
	}
	return 'start';
}

/** Returns whether a trusted shell command starts the supported interactive Codex TUI. */
export function isCodexTuiCommand(command: string): boolean {
	return classifyCodexTuiCommand(command) !== undefined;
}

/** The properties of an executed command that decide whether it can be tracked. */
export interface ICodexTrackableCommand {
	readonly command: string;
	readonly commandLineConfidence: 'low' | 'medium' | 'high';
	readonly isTrusted: boolean;
	readonly wasReplayed?: boolean;
	readonly cwd?: string;
}

/** How a tracked command started Codex, alongside the directory the lookup is scoped to. */
export interface ICodexCommandInvocation {
	readonly invocation: 'start' | 'resume';
	readonly cwd: string;
}

/**
 * Returns how a just-executed command invoked the Codex TUI, or `undefined` when it cannot be
 * tracked.
 *
 * Only `isTrusted` means the shell itself reported this command line under the shell integration
 * nonce; `'high'` confidence alone is set for any `OSC 633;E` and so is spoofable. Every other
 * command line was recovered from the screen buffer, which is all a prompt that suppresses VS
 * Code's shell integration (powerlevel10k unsets the flag that enables it) can ever offer.
 * `'medium'` at least requires prompt markers, a single line and a prompt that is not at column
 * zero, and whatever it recovers still has to survive `classifyCodexTuiCommand`, so it is accepted
 * rather than losing the feature entirely on those prompts. Only `'low'`, a bare guess, is refused.
 *
 * A recovered line is still reported as `'start'` even when it reads like a resume, because the
 * buffer includes autosuggestion ghost text: typing `codex` under a `codex resume --last`
 * suggestion recovers the whole line. `'resume'` waives the cwd check that keeps another
 * directory's thread off this tab, so it is granted only to a line the shell vouched for.
 */
export function classifyTrackableCodexCommand(command: ICodexTrackableCommand): ICodexCommandInvocation | undefined {
	if (command.wasReplayed || command.commandLineConfidence === 'low' || !command.cwd || !isAbsolute(command.cwd)) {
		return undefined;
	}
	const invocation = classifyCodexTuiCommand(command.command);
	if (!invocation) {
		return undefined;
	}
	const vouchedFor = command.isTrusted && command.commandLineConfidence === 'high';
	return { invocation: vouchedFor ? invocation : 'start', cwd: command.cwd };
}

/** Creates a bounded, display-safe tab title from Codex thread metadata. */
export function createCodexTerminalTitle(prompt: string): string | undefined {
	const firstLine = prompt.split(/\r?\n/).map(line => line.trim()).find(Boolean);
	if (!firstLine) {
		return undefined;
	}
	const cleaned = removeAnsiEscapeCodes(firstLine)
		.replace(/^(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, '')
		.replace(/[`*_~]/g, '')
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) {
		return undefined;
	}
	const characters = Array.from(cleaned);
	// 接頭辞は付けない。ここで作るのがタブに出る唯一の「読めるタイトル」で、`codex | ` は
	// どのタブにも同じように付くぶん、肝心のタイトルを読みにくくするだけだから。
	return characters.length > 36 ? `${characters.slice(0, 36).join('')}…` : cleaned;
}

interface ICodexTerminalRunState {
	readonly generation: number;
	readonly commandKey: string;
	readonly commandDetection: ICommandDetectionCapability;
	readonly processId: number | undefined;
	readonly cwd: string;
	readonly invocation: 'start' | 'resume';
	threadId?: string;
	expectedSequence?: string;
	lookupStarted?: boolean;
}

class ParadisCodexTerminalTitleTrackerContribution extends Disposable implements ITerminalContribution {

	static readonly ID = 'para.codexTerminalTitleTracker';

	private readonly instance: ITerminalContributionContext['instance'];
	private readonly owner: string;
	private readonly commandListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly lookupCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private generation = 0;
	private runState: ICodexTerminalRunState | undefined;

	constructor(
		context: ITerminalContributionContext,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.instance = context.instance;
		this.owner = `${TRANSIENT_TITLE_OWNER_PREFIX}:${this.instance.instanceId}`;
		this._register(this.instance.capabilities.onDidAddCommandDetectionCapability(capability => this.attachCommandDetection(capability)));
		this._register(this.instance.capabilities.onDidRemoveCommandDetectionCapability(() => {
			this.commandListeners.clear();
			this.reset();
		}));
		this._register(this.instance.onTitleChanged(() => this.handleTitleChanged()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) || event.affectsConfiguration('terminal.integrated.tabs.allowAgentCliTitle')) {
				this.reset();
			}
		}));
		const commandDetection = this.instance.capabilities.get(TerminalCapability.CommandDetection);
		if (commandDetection) {
			this.attachCommandDetection(commandDetection);
		}
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) !== false
			&& this.configurationService.getValue<boolean>('terminal.integrated.tabs.allowAgentCliTitle') !== false;
	}

	/**
	 * `titleTemplate` 付きのターミナルも対象に含める。
	 *
	 * Para Code はコマンドプリセットのターミナル名を `titleTemplate` で渡すため（`name` で渡すと固定
	 * タイトル扱いになり、OSC タイトルの購読自体が張られない）、ここで弾くとプリセット起動の Codex
	 * だけ依頼文由来のタイトルが付かなくなる。Codex 自身が OSC に出すのは実測ではスレッド ID だけなので、
	 * 弾くと素の UUID がタブに出っぱなしになる。
	 */
	private get terminalEligible(): boolean {
		const terminalType = this.instance.shellLaunchConfig.attachPersistentProcess?.type ?? this.instance.shellLaunchConfig.type;
		return !this.instance.hasRemoteAuthority && terminalType !== 'Task';
	}

	private attachCommandDetection(commandDetection: ICommandDetectionCapability): void {
		const store = new DisposableStore();
		store.add(commandDetection.onCommandExecuted(command => this.handleCommandExecuted(commandDetection, command)));
		store.add(commandDetection.onCommandFinished(() => this.reset()));
		store.add(commandDetection.onCurrentCommandInvalidated(() => this.reset()));
		this.commandListeners.value = store;
	}

	private handleCommandExecuted(commandDetection: ICommandDetectionCapability, command: ITerminalCommand): void {
		this.reset();
		const tracked = classifyTrackableCodexCommand(command);
		if (!this.enabled || !this.terminalEligible || !tracked) {
			return;
		}
		// A prompt that emits its own OSC 133 alongside ours reports the same command twice: once
		// from its marker with the buffer-recovered line, then again once `OSC 633;E` lands. The
		// second pass resets this state and rebuilds it from the vouched-for line.
		this.runState = {
			generation: this.generation,
			commandKey: command.id ?? `${command.timestamp}:${command.command}`,
			commandDetection,
			processId: this.instance.processId,
			cwd: tracked.cwd,
			invocation: tracked.invocation,
		};
		this.handleTitleChanged();
	}

	private handleTitleChanged(): void {
		const state = this.runState;
		if (!state) {
			return;
		}
		if (!this.enabled || !this.terminalEligible || this.instance.staticTitle || this.instance.processId !== state.processId) {
			this.reset();
			return;
		}
		const sequence = this.instance.sequence;
		if (state.expectedSequence && sequence !== state.expectedSequence) {
			this.reset();
			return;
		}
		if (state.lookupStarted) {
			return;
		}
		const match = sequence ? CODEX_THREAD_TITLE_PATTERN.exec(sequence) : undefined;
		if (!match) {
			return;
		}
		state.threadId = match[1].toLowerCase();
		state.expectedSequence = sequence;
		state.lookupStarted = true;
		this.startLookup(state);
	}

	private startLookup(state: ICodexTerminalRunState): void {
		// Assigning to a `MutableDisposable` only disposes the previous source, and disposing a
		// `CancellationTokenSource` does not cancel it, so any lookup already in flight has to be
		// cancelled here as well as in `reset()` — otherwise it would run out its own backoff.
		this.lookupCancellation.value?.cancel();
		const cancellation = this.lookupCancellation.value = new CancellationTokenSource();
		this.resolveTitle(state, cancellation.token).catch(error => {
			if (!isCancellationError(error)) {
				this.logService.debug('[ParadisCodexTerminalTitle] prompt lookup stopped', error);
			}
		});
	}

	private async resolveTitle(state: ICodexTerminalRunState, token: CancellationToken): Promise<void> {
		// Monotonic so that suspending the machine mid-session does not silently burn the deadline.
		const deadline = performance.now() + PROMPT_LOOKUP_DEADLINE_MS;
		let delay = PROMPT_LOOKUP_INITIAL_DELAY_MS;
		let skipRolloutScan = false;
		let consecutiveErrors = 0;
		while (!token.isCancellationRequested && this.isCurrent(state)) {
			const request: IParadisCodexThreadPromptRequest = {
				threadId: state.threadId!,
				cwd: state.cwd,
				invocation: state.invocation,
				skipRolloutScan,
			};
			try {
				const result = await raceCancellation(this.sharedProcessService.getChannel(PARADIS_CODEX_TERMINAL_TITLE_CHANNEL)
					.call<IParadisCodexThreadPromptResult>('findThreadPrompt', [request]), token);
				if (!result || token.isCancellationRequested || !this.isCurrent(state)) {
					return;
				}
				consecutiveErrors = 0;
				if (result.prompt) {
					// The row can still gain a better title later, but Codex rewrites its own OSC
					// title at the same point, which drops the transient title anyway — so there is
					// nothing left for this lookup to win by staying alive.
					const title = createCodexTerminalTitle(result.prompt);
					if (title) {
						this.instance.setTransientTitle(this.owner, title, state.expectedSequence!);
					}
					return;
				}
				skipRolloutScan ||= result.rolloutScanExhausted === true;
			} catch (error) {
				this.logService.debug('[ParadisCodexTerminalTitle] prompt lookup failed', error);
				if (++consecutiveErrors >= PROMPT_LOOKUP_MAX_CONSECUTIVE_ERRORS) {
					return;
				}
			}
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				return;
			}
			await timeout(Math.min(delay, remaining), token);
			delay = Math.min(delay * 2, PROMPT_LOOKUP_MAX_DELAY_MS);
		}
	}

	private isCurrent(state: ICodexTerminalRunState): boolean {
		const executingCommand = state.commandDetection.executingCommandObject;
		const executingCommandKey = executingCommand?.id ?? (executingCommand ? `${executingCommand.timestamp}:${executingCommand.command}` : undefined);
		return this.runState === state
			&& state.generation === this.generation
			&& executingCommandKey === state.commandKey
			&& this.enabled
			&& this.terminalEligible
			&& !this.instance.staticTitle
			&& this.instance.processId === state.processId
			&& this.instance.sequence === state.expectedSequence;
	}

	private reset(): void {
		this.generation++;
		this.runState = undefined;
		// `MutableDisposable` only disposes the source, which on its own leaves a pending lookup
		// waiting out its backoff, so cancel before clearing.
		this.lookupCancellation.value?.cancel();
		this.lookupCancellation.clear();
		this.instance.clearTransientTitle(this.owner);
	}

	override dispose(): void {
		this.reset();
		super.dispose();
	}
}

registerTerminalContribution(ParadisCodexTerminalTitleTrackerContribution.ID, ParadisCodexTerminalTitleTrackerContribution);

function replaceTerminalTitleInTuiSection(config: string): string {
	const titleLine = `terminal_title = [${PARADIS_CODEX_TERMINAL_TITLE_ITEMS.map(item => `"${item}"`).join(', ')}]`;
	const tuiHeader = /^\[tui\][^\n]*(?:\n|$)/m;
	const headerMatch = tuiHeader.exec(config);
	if (!headerMatch || headerMatch.index === undefined) {
		return `${config.trimEnd()}\n\n[tui]\n${titleLine}\n`;
	}

	const sectionStart = headerMatch.index + headerMatch[0].length;
	const nextSection = /^\[/m;
	const nextSectionMatch = nextSection.exec(config.slice(sectionStart));
	const sectionEnd = nextSectionMatch?.index === undefined ? config.length : sectionStart + nextSectionMatch.index;
	const section = config.slice(sectionStart, sectionEnd);
	const titleKey = /^[\t ]*terminal_title[\t ]*=/m;
	const titleKeyMatch = titleKey.exec(section);
	if (!titleKeyMatch || titleKeyMatch.index === undefined) {
		return `${config.slice(0, sectionStart)}${titleLine}\n${config.slice(sectionStart)}`;
	}

	const valueStart = titleKeyMatch.index + titleKeyMatch[0].length;
	let valueEnd = valueStart;
	let arrayDepth = 0;
	let inString = false;
	let escaped = false;
	for (; valueEnd < section.length; valueEnd++) {
		const character = section[valueEnd];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === '[') {
			arrayDepth++;
		} else if (character === ']') {
			arrayDepth--;
			if (arrayDepth === 0) {
				valueEnd++;
				break;
			}
		} else if (character === '\n' && arrayDepth === 0) {
			break;
		}
	}

	return `${config.slice(0, sectionStart + titleKeyMatch.index)}${titleLine}${config.slice(sectionStart + valueEnd)}`;
}

class ParadisCodexTerminalTitleContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisCodexTerminalTitle';

	private writeQueue = Promise.resolve();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this.applySetting();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING)) {
				this.applySetting();
			}
		}));
	}

	private applySetting(): void {
		if (this.configurationService.getValue<boolean>(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) !== false) {
			this.writeQueue = this.writeQueue.then(async () => {
				if (this.configurationService.getValue<boolean>(PARADIS_CODEX_TERMINAL_TITLE_ENABLED_SETTING) !== false) {
					await this.writeCodexConfig();
				}
			}).catch(error => {
				this.logService.warn('[ParadisCodexTerminalTitle] failed to update Codex terminal title', error);
			});
		}
	}

	private async writeCodexConfig(): Promise<void> {
		const userHome = await this.pathService.userHome();
		const codexHome = joinPath(userHome, '.codex');
		const configFile = joinPath(codexHome, 'config.toml');
		if (!(await this.fileService.exists(codexHome))) {
			await this.fileService.createFolder(codexHome);
		}
		const currentConfig = (await this.fileService.exists(configFile))
			? (await this.fileService.readFile(configFile)).value.toString()
			: '';
		const nextConfig = replaceTerminalTitleInTuiSection(currentConfig);
		if (nextConfig !== currentConfig) {
			await this.fileService.writeFile(configFile, VSBuffer.fromString(nextConfig));
		}
	}
}

registerWorkbenchContribution2(ParadisCodexTerminalTitleContribution.ID, ParadisCodexTerminalTitleContribution, WorkbenchPhase.AfterRestored);

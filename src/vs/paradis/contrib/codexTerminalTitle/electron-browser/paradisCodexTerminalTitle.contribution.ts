/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { timeout } from '../../../../base/common/async.js';
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

const CODEX_THREAD_TITLE_PATTERN = /^codex \| ([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const TRANSIENT_TITLE_OWNER_PREFIX = 'para.codexTerminalTitle';
const PROMPT_LOOKUP_ATTEMPTS = 8;
const PROMPT_LOOKUP_DELAY_MS = 250;
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
	const executableName = tokens?.[0].split(/[\\/]/).pop();
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
	const summary = characters.length > 36 ? `${characters.slice(0, 36).join('')}…` : cleaned;
	return `codex | ${summary}`;
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

	private get terminalEligible(): boolean {
		const terminalType = this.instance.shellLaunchConfig.attachPersistentProcess?.type ?? this.instance.shellLaunchConfig.type;
		return !this.instance.hasRemoteAuthority && terminalType !== 'Task' && !this.instance.shellLaunchConfig.titleTemplate;
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
		const invocation = classifyCodexTuiCommand(command.command);
		if (!this.enabled || !this.terminalEligible || command.wasReplayed || !command.isTrusted || command.commandLineConfidence !== 'high'
			|| !invocation || !command.cwd || !isAbsolute(command.cwd)) {
			return;
		}
		this.runState = {
			generation: this.generation,
			commandKey: command.id ?? `${command.timestamp}:${command.command}`,
			commandDetection,
			processId: this.instance.processId,
			cwd: command.cwd,
			invocation,
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
		void this.resolveTitle(state);
	}

	private async resolveTitle(state: ICodexTerminalRunState): Promise<void> {
		const request: IParadisCodexThreadPromptRequest = { threadId: state.threadId!, cwd: state.cwd, invocation: state.invocation };
		for (let attempt = 0; attempt < PROMPT_LOOKUP_ATTEMPTS; attempt++) {
			if (!this.isCurrent(state)) {
				return;
			}
			try {
				const result = await this.sharedProcessService.getChannel(PARADIS_CODEX_TERMINAL_TITLE_CHANNEL)
					.call<IParadisCodexThreadPromptResult>('findThreadPrompt', [request]);
				if (!this.isCurrent(state)) {
					return;
				}
				const title = result.prompt ? createCodexTerminalTitle(result.prompt) : undefined;
				if (title) {
					this.instance.setTransientTitle(this.owner, title, state.expectedSequence!);
					return;
				}
			} catch (error) {
				this.logService.debug('[ParadisCodexTerminalTitle] prompt lookup failed', error);
				return;
			}
			if (attempt + 1 < PROMPT_LOOKUP_ATTEMPTS) {
				await timeout(PROMPT_LOOKUP_DELAY_MS);
			}
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

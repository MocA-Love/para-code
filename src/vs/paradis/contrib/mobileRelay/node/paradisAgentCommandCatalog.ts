/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: descriptions may come from user-authored Markdown)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { basename, dirname, extname, join, resolve } from '../../../../base/common/path.js';
import { paradisClaudeConfigDir, paradisCodexHome } from '../../agentBrowser/node/paradisAgentHome.js';

type ParadisCommandAgentKind = 'claude' | 'codex';

const DEFAULT_MAX_ITEMS = 200;
const MAX_MARKDOWN_BYTES = 16 * 1024;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_COMMAND_DEPTH = 4;
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** mobile relayへ返す、プロバイダー非依存のコマンド候補。 */
export interface IParadisAgentCommandOption {
	readonly name: string;
	readonly insertText: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly kind: 'command' | 'skill' | 'prompt';
	readonly source: 'built-in' | 'user' | 'project';
}

/** テスト時の設定ルートと返却上限の差し替え。 */
export interface IParadisAgentCommandCatalogOptions {
	readonly userHome?: string;
	readonly claudeConfigDir?: string;
	readonly codexHome?: string;
	readonly maxItems?: number;
}

interface MarkdownMetadata {
	readonly name?: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly userInvocable: boolean;
}

const CODEX_BUILT_INS: readonly [string, string][] = [
	['model', 'choose what model and reasoning effort to use'],
	['fast', 'toggle fast mode for lower-latency responses'],
	['ide', 'include current selection, open files, and other IDE context'],
	['permissions', 'choose what Codex is allowed to do'],
	['keymap', 'remap TUI shortcuts'],
	['vim', 'toggle Vim mode for the composer'],
	['experimental', 'toggle experimental features'],
	['approve', 'approve one retry of a recent auto-review denial'],
	['memories', 'configure memory use and generation'],
	['skills', 'browse and use skills'],
	['import', 'import setup, project files, and recent chats from Claude Code'],
	['hooks', 'view and manage lifecycle hooks'],
	['review', 'review current changes and find issues'],
	['rename', 'rename the current thread'],
	['new', 'start a new chat during a conversation'],
	['archive', 'archive this session and exit'],
	['delete', 'permanently delete this session and exit'],
	['resume', 'resume a saved chat'],
	['fork', 'fork the current chat'],
	['app', 'continue this session in Codex Desktop'],
	['init', 'create an AGENTS.md file with instructions for Codex'],
	['compact', 'summarize conversation to prevent hitting the context limit'],
	['plan', 'switch to Plan mode'],
	['goal', 'set or view the goal for a long-running task'],
	['agent', 'switch the active agent thread'],
	['subagents', 'switch the active agent thread'],
	['side', 'start a side conversation in an ephemeral fork'],
	['btw', 'start a side conversation in an ephemeral fork'],
	['copy', 'copy the last response as Markdown'],
	['raw', 'toggle raw scrollback mode'],
	['diff', 'show git diff, including untracked files'],
	['mention', 'mention a file'],
	['status', 'show current session configuration and token usage'],
	['usage', 'view account usage or use a usage limit reset'],
	['debug-config', 'show config layers and requirement sources'],
	['title', 'configure items shown in the terminal title'],
	['statusline', 'configure items shown in the status line'],
	['theme', 'choose a syntax highlighting theme'],
	['pets', 'choose or hide the terminal pet'],
	['mcp', 'list configured MCP tools'],
	['apps', 'browse apps'],
	['plugins', 'browse plugins'],
	['logout', 'log out of Codex'],
	['quit', 'exit Codex'],
	['exit', 'exit Codex'],
	['feedback', 'send logs to maintainers'],
	['ps', 'list background terminals'],
	['stop', 'stop all background terminals'],
	['clear', 'clear the terminal and start a new chat'],
	['personality', 'choose a communication style for Codex'],
];

const CLAUDE_BUILT_INS: readonly [string, string][] = [
	['add-dir', 'Add a working directory for this session'],
	['agents', 'Manage agent configurations'],
	['background', 'Detach the current session to run in the background'],
	['branch', 'Create a branch of the current conversation'],
	['btw', 'Ask a side question without adding to the conversation'],
	['cd', 'Move this session to a new working directory'],
	['clear', 'Start a new conversation with empty context'],
	['compact', 'Summarize the conversation to free context'],
	['config', 'Open settings or apply a setting'],
	['context', 'Show what is using the context window'],
	['doctor', 'Diagnose installation and configuration issues'],
	['effort', 'Set the model effort level'],
	['exit', 'Exit Claude Code'],
	['export', 'Export the current conversation'],
	['fast', 'Toggle fast mode'],
	['feedback', 'Submit feedback or report a bug'],
	['fork', 'Spawn a forked background subagent'],
	['goal', 'Set or view a persistent goal'],
	['help', 'Show help and available commands'],
	['hooks', 'View hook configurations'],
	['ide', 'Manage IDE integrations and show status'],
	['init', 'Initialize the project with a CLAUDE.md guide'],
	['insights', 'Analyze Claude Code sessions'],
	['keybindings', 'Open keyboard shortcut settings'],
	['login', 'Sign in to Anthropic'],
	['logout', 'Sign out from Anthropic'],
	['mcp', 'Manage MCP server connections'],
	['memory', 'Edit CLAUDE.md and auto-memory settings'],
	['model', 'Switch the AI model'],
	['permissions', 'Manage tool permission rules'],
	['plan', 'Enter plan mode'],
	['plugin', 'Manage Claude Code plugins'],
	['reload-plugins', 'Reload active plugins'],
	['reload-skills', 'Re-scan skill and command directories'],
	['rename', 'Rename the current session'],
	['resume', 'Resume a conversation'],
	['review', 'Review a GitHub pull request'],
	['rewind', 'Rewind the conversation or code'],
	['security-review', 'Analyze pending changes for security issues'],
	['skills', 'List available skills'],
	['status', 'Show version, model, account, and connectivity'],
	['statusline', 'Configure the status line'],
	['tasks', 'View and manage background work'],
	['theme', 'Change the color theme'],
	['usage', 'Show session cost and usage limits'],
];

/**
 * PC側で確定したプロバイダーとcwdだけを入力にし、CLIの候補をモバイル向けに正規化する。
 * 個々の設定ファイルが読めない場合は、その候補だけを落として残りを返す。
 */
export async function paradisBuildAgentCommandCatalog(agent: ParadisCommandAgentKind, cwd: string, options: IParadisAgentCommandCatalogOptions = {}): Promise<readonly IParadisAgentCommandOption[]> {
	const maxItems = Math.min(DEFAULT_MAX_ITEMS, Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS));
	const userHome = options.userHome ?? homedir();
	const claudeHome = options.claudeConfigDir ?? paradisClaudeConfigDir();
	const codexConfigHome = options.codexHome ?? paradisCodexHome();
	const items: IParadisAgentCommandOption[] = builtIns(agent);
	const seen = new Set(items.map(item => item.name.toLocaleLowerCase()));
	const append = (candidates: readonly IParadisAgentCommandOption[]) => {
		for (const candidate of candidates) {
			const key = candidate.name.toLocaleLowerCase();
			if (items.length >= maxItems) {
				return;
			}
			if (!seen.has(key)) {
				seen.add(key);
				items.push(candidate);
			}
		}
	};

	if (agent === 'claude') {
		append(await readSkillDirectory(join(claudeHome, 'skills'), 'user'));
		append(await readCommandDirectory(join(claudeHome, 'commands'), 'user'));
		for (const directory of await projectDirectories(cwd)) {
			append(await readSkillDirectory(join(directory, '.claude', 'skills'), 'project'));
			append(await readCommandDirectory(join(directory, '.claude', 'commands'), 'project'));
		}
	} else {
		append(await readCodexPrompts(join(codexConfigHome, 'prompts')));
		append(await readSkillDirectory(join(codexConfigHome, 'skills'), 'user'));
		append(await readSkillDirectory(join(userHome, '.agents', 'skills'), 'user'));
		for (const directory of await projectDirectories(cwd)) {
			append(await readSkillDirectory(join(directory, '.agents', 'skills'), 'project'));
		}
	}

	return items.slice(0, maxItems);
}

function builtIns(agent: ParadisCommandAgentKind): IParadisAgentCommandOption[] {
	return (agent === 'codex' ? CODEX_BUILT_INS : CLAUDE_BUILT_INS).map(([name, description]) => ({
		name, insertText: `/${name}`, description, kind: 'command', source: 'built-in',
	}));
}

async function projectDirectories(cwd: string): Promise<readonly string[]> {
	const candidates: string[] = [];
	let current = resolve(cwd);
	for (let depth = 0; depth < 32; depth++) {
		candidates.push(current);
		if (await pathExists(join(current, '.git'))) {
			return candidates;
		}
		const parent = dirname(current);
		if (parent === current) {
			return [resolve(cwd)];
		}
		current = parent;
	}
	return [resolve(cwd)];
}

async function readSkillDirectory(directory: string, source: 'user' | 'project'): Promise<IParadisAgentCommandOption[]> {
	const entries = await readDirectory(directory);
	const result: IParadisAgentCommandOption[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name, 'SKILL.md');
		if (!entry.isDirectory() && !await isDirectory(join(directory, entry.name))) {
			continue;
		}
		const metadata = await readMarkdownMetadata(path);
		const name = metadata?.name ?? entry.name;
		if (metadata === undefined || !metadata.userInvocable || !isValidCommandName(name)) {
			continue;
		}
		result.push({ name, insertText: `/${name}`, description: metadata.description, ...(metadata.argumentHint !== undefined ? { argumentHint: metadata.argumentHint } : {}), kind: 'skill', source });
	}
	return result;
}

async function readCommandDirectory(directory: string, source: 'user' | 'project', prefix = '', depth = 0): Promise<IParadisAgentCommandOption[]> {
	if (depth > MAX_COMMAND_DEPTH) {
		return [];
	}
	const entries = await readDirectory(directory);
	const result: IParadisAgentCommandOption[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() || await isDirectory(path)) {
			result.push(...await readCommandDirectory(path, source, prefix.length > 0 ? `${prefix}:${entry.name}` : entry.name, depth + 1));
			continue;
		}
		if (extname(entry.name).toLocaleLowerCase() !== '.md') {
			continue;
		}
		const leaf = basename(entry.name, extname(entry.name));
		const name = prefix.length > 0 ? `${prefix}:${leaf}` : leaf;
		const metadata = await readMarkdownMetadata(path);
		if (metadata === undefined || !metadata.userInvocable || !isValidCommandName(name)) {
			continue;
		}
		result.push({ name, insertText: `/${name}`, description: metadata.description, ...(metadata.argumentHint !== undefined ? { argumentHint: metadata.argumentHint } : {}), kind: 'command', source });
	}
	return result;
}

async function readCodexPrompts(directory: string): Promise<IParadisAgentCommandOption[]> {
	const entries = await readDirectory(directory);
	const result: IParadisAgentCommandOption[] = [];
	for (const entry of entries) {
		if (entry.isDirectory() || extname(entry.name).toLocaleLowerCase() !== '.md') {
			continue;
		}
		const promptName = basename(entry.name, extname(entry.name));
		const name = `prompts:${promptName}`;
		const metadata = await readMarkdownMetadata(join(directory, entry.name));
		if (metadata === undefined || !metadata.userInvocable || !isValidCommandName(name)) {
			continue;
		}
		result.push({ name, insertText: `/${name}`, description: metadata.description, ...(metadata.argumentHint !== undefined ? { argumentHint: metadata.argumentHint } : {}), kind: 'prompt', source: 'user' });
	}
	return result;
}

async function readMarkdownMetadata(path: string): Promise<MarkdownMetadata | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(path, 'r');
		const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_MARKDOWN_BYTES) {
			return undefined;
		}
		const content = buffer.subarray(0, bytesRead).toString('utf8');
		const { attributes, body } = parseFrontMatter(content);
		const description = compactText(attributes.get('description') ?? firstParagraph(body) ?? 'Custom command');
		return {
			...(cleanScalar(attributes.get('name')) !== undefined ? { name: cleanScalar(attributes.get('name')) } : {}),
			description: description.slice(0, MAX_DESCRIPTION_LENGTH),
			...(cleanScalar(attributes.get('argument-hint')) !== undefined ? { argumentHint: cleanScalar(attributes.get('argument-hint'))?.slice(0, 120) } : {}),
			userInvocable: attributes.get('user-invocable')?.toLocaleLowerCase() !== 'false',
		};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function parseFrontMatter(content: string): { attributes: Map<string, string>; body: string } {
	const normalized = content.replace(/\r\n/g, '\n');
	if (!normalized.startsWith('---\n')) {
		return { attributes: new Map(), body: normalized };
	}
	const end = normalized.indexOf('\n---\n', 4);
	if (end < 0) {
		return { attributes: new Map(), body: normalized };
	}
	const attributes = new Map<string, string>();
	for (const line of normalized.slice(4, end).split('\n')) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/.exec(line);
		if (match !== null) {
			attributes.set(match[1]!.toLocaleLowerCase(), cleanScalar(match[2]) ?? '');
		}
	}
	return { attributes, body: normalized.slice(end + 5) };
}

function firstParagraph(body: string): string | undefined {
	return body.split(/\n\s*\n/).map(value => value.trim()).find(value => value.length > 0 && !value.startsWith('#'));
}

function cleanScalar(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\'')))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed.length > 0 ? trimmed : undefined;
}

function compactText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function isValidCommandName(value: string): boolean {
	return COMMAND_NAME_PATTERN.test(value);
}

async function readDirectory(path: string): Promise<readonly import('fs').Dirent[]> {
	return fs.readdir(path, { withFileTypes: true }).then(entries => entries.sort((a, b) => a.name.localeCompare(b.name))).catch(() => []);
}

async function pathExists(path: string): Promise<boolean> {
	return fs.stat(path).then(() => true, () => false);
}

async function isDirectory(path: string): Promise<boolean> {
	return fs.stat(path).then(stat => stat.isDirectory(), () => false);
}

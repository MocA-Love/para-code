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

/** 新しいアプリ（`agent.commands.v2`）へ返す上限。Claude Code は skill だけで数百件になる（2.1.289 の実測で 338 件）。 */
export const PARADIS_AGENT_COMMAND_CATALOG_MAX_ITEMS = 500;
/** 古いアプリが受け取れる上限（超えると一覧ごと捨てる）。 */
const LEGACY_MAX_ITEMS = 200;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_ARGUMENT_HINT_LENGTH = 120;
const MAX_PLUGIN_NAME_LENGTH = 100;
const MAX_COMMAND_DEPTH = 4;
/** frontmatter を探して読む上限。本文は読まない（本文が長い skill も一覧から落とさない）。 */
const MAX_FRONT_MATTER_BYTES = 64 * 1024;
/** frontmatter が無いファイルで、説明に使う最初の段落を探す範囲。 */
const MAX_BODY_PREVIEW_BYTES = 4 * 1024;
const READ_CHUNK_BYTES = 4 * 1024;
/** 新しいアプリが受け取る名前（Claude Code の MCP の prompt・skill は `_` を含む）。 */
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
/** 古いアプリが受け取る名前（先頭に `_` を置けない。これに合わない 1 件があると、古いアプリは一覧ごと捨てる）。 */
const LEGACY_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** 候補の出どころ。`plugin` と `mcp` は新しいアプリ（`agent.commands.v2`）にだけ送る。 */
export type ParadisAgentCommandSource = 'built-in' | 'user' | 'project' | 'plugin' | 'mcp';

/**
 * mobile relay とデスクトップのチャット欄へ返す、プロバイダー非依存のコマンド候補。
 * 並びは実際に効く順（同じ名前が 2 件あれば、先にある方を Claude Code が実行する）。
 */
export interface IParadisAgentCommandOption {
	readonly name: string;
	readonly insertText: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly kind: 'command' | 'skill' | 'prompt';
	readonly source: ParadisAgentCommandSource;
	/** `source: 'plugin'` のとき、足したプラグインの名前（分かれば）。 */
	readonly plugin?: string;
}

/** テスト時の設定ルートと返却上限の差し替え。 */
export interface IParadisAgentCommandCatalogOptions {
	readonly userHome?: string;
	readonly claudeConfigDir?: string;
	readonly codexHome?: string;
	readonly maxItems?: number;
	/** ペインで動いている Codex の版（rollout の `cli_version`）。0.160 以降は `/prompts:*` を出さない。 */
	readonly codexVersion?: string;
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
 * PC側で確定したプロバイダーとcwdだけを入力にし、CLIの候補をファイルから組み立てる。
 * 個々の設定ファイルが読めない場合は、その候補だけを落として残りを返す。
 *
 * Claude Code は実際の候補と同じ順（自分の skill とコマンド → プロジェクト → 有効なプラグイン → 組み込み）で返し、
 * 同じ名前が重なっても両方を残す（先にある方が実行される。古いアプリへは {@link paradisLegacyAgentCommandCatalog} で 1 件にする）。
 * Codex は組み込みが先で、同じ名前は 1 件にする（skill は `$name` で呼ぶので組み込みを隠さない）。
 */
export async function paradisBuildAgentCommandCatalog(agent: ParadisCommandAgentKind, cwd: string, options: IParadisAgentCommandCatalogOptions = {}): Promise<readonly IParadisAgentCommandOption[]> {
	const maxItems = Math.min(PARADIS_AGENT_COMMAND_CATALOG_MAX_ITEMS, Math.max(1, options.maxItems ?? PARADIS_AGENT_COMMAND_CATALOG_MAX_ITEMS));
	const userHome = options.userHome ?? homedir();
	const claudeHome = options.claudeConfigDir ?? paradisClaudeConfigDir();
	const codexConfigHome = options.codexHome ?? paradisCodexHome();

	if (agent === 'claude') {
		const items: IParadisAgentCommandOption[] = [];
		const projects = await projectDirectories(cwd);
		items.push(...await readSkillDirectory(join(claudeHome, 'skills'), 'user'));
		items.push(...await readCommandDirectory(join(claudeHome, 'commands'), 'user'));
		for (const directory of projects) {
			items.push(...await readSkillDirectory(join(directory, '.claude', 'skills'), 'project'));
			items.push(...await readCommandDirectory(join(directory, '.claude', 'commands'), 'project'));
		}
		items.push(...await readEnabledClaudePlugins(claudeHome, projects));
		items.push(...paradisBuiltInAgentCommands('claude'));
		return paradisCapAgentCommands(items.filter(item => !isInternalCommandName(item.name)), maxItems);
	}

	const items: IParadisAgentCommandOption[] = paradisBuiltInAgentCommands('codex');
	const seen = new Set(items.map(item => item.name.toLocaleLowerCase()));
	const append = (candidates: readonly IParadisAgentCommandOption[]) => {
		for (const candidate of candidates) {
			const key = candidate.name.toLocaleLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				items.push(candidate);
			}
		}
	};
	if (paradisCodexSupportsCustomPrompts(options.codexVersion)) {
		append(await readCodexPrompts(join(codexConfigHome, 'prompts')));
	}
	append(await readSkillDirectory(join(codexConfigHome, 'skills'), 'user'));
	append(await readSkillDirectory(join(userHome, '.agents', 'skills'), 'user'));
	for (const directory of await projectDirectories(cwd)) {
		append(await readSkillDirectory(join(directory, '.agents', 'skills'), 'project'));
	}
	return paradisCapAgentCommands(items, maxItems);
}

/**
 * 一覧を `limit` 件に収める。Claude Code は自作・プラグインを組み込みより前に並べるので、そのまま先頭から切ると
 * skill が多い人の一覧から `/clear`・`/model`・`/compact` などの組み込みが消える。先に組み込みの枠を取り
 * （同じ名前の自作より後ろにあって、実際には動かない組み込みは除く）、残りの枠を効く順で埋める。並びは元のまま。
 */
export function paradisCapAgentCommands(items: readonly IParadisAgentCommandOption[], limit: number): IParadisAgentCommandOption[] {
	if (items.length <= limit) {
		return [...items];
	}
	const earlier = new Set<string>();
	const chosen = new Set<number>();
	items.forEach((item, index) => {
		const key = item.name.toLocaleLowerCase();
		if (item.source === 'built-in' && !earlier.has(key) && chosen.size < limit) {
			chosen.add(index);
		}
		earlier.add(key);
	});
	for (let index = 0; index < items.length && chosen.size < limit; index++) {
		chosen.add(index);
	}
	return items.filter((_, index) => chosen.has(index));
}

/** 組み込みのコマンドだけ（SSH の接続先で動くペインには、手元の設定を読まずにこれだけを返す）。 */
export function paradisBuiltInAgentCommands(agent: ParadisCommandAgentKind): IParadisAgentCommandOption[] {
	return (agent === 'codex' ? CODEX_BUILT_INS : CLAUDE_BUILT_INS).map(([name, description]) => ({
		name, insertText: `/${name}`, description, kind: 'command', source: 'built-in',
	}));
}

/**
 * Codex の `/prompts:<name>`（`$CODEX_HOME/prompts/*.md`）が動く版か。0.160.0 では `Unrecognized command` になる（実測）。
 * 版が分からないときは今までどおり出す。
 */
export function paradisCodexSupportsCustomPrompts(version: string | undefined): boolean {
	const match = version !== undefined ? /^(\d+)\.(\d+)\./.exec(version.trim()) : null;
	if (match === null) {
		return true;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major === 0 && minor < 160;
}

/**
 * Claude Mods の `$.command.list()` の結果を候補へ直す。並びはそのまま（Claude Code の候補と同じ順）。
 * 内部向けのもの（`__` で始まるもの）と、形の合わないものは落とす。配列でなければ undefined。
 */
export function paradisNormalizeModCommandList(value: unknown, maxItems: number = PARADIS_AGENT_COMMAND_CATALOG_MAX_ITEMS): IParadisAgentCommandOption[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: IParadisAgentCommandOption[] = [];
	for (const candidate of value) {
		const record = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
		const name = typeof record?.name === 'string' ? record.name.trim() : '';
		if (record === undefined || !isValidCommandName(name) || isInternalCommandName(name)) {
			continue;
		}
		const source: ParadisAgentCommandSource = record.source === 'builtin' ? 'built-in' : record.source === 'plugin' ? 'plugin' : record.source === 'mcp' ? 'mcp' : 'user';
		const plugin = source === 'plugin' && typeof record.plugin === 'string' && record.plugin.trim().length > 0 ? record.plugin.trim().slice(0, MAX_PLUGIN_NAME_LENGTH) : undefined;
		const description = typeof record.description === 'string' ? compactText(record.description).slice(0, MAX_DESCRIPTION_LENGTH) : '';
		result.push({ name, insertText: `/${name}`, description, kind: 'command', source, ...(plugin !== undefined ? { plugin } : {}) });
	}
	return paradisCapAgentCommands(result, maxItems);
}

/**
 * 古いアプリ（`agent.commands.v2` より前）へ送れる形にする。古いアプリは同じ名前・知らない出どころ・`_` を含む名前が 1 件でも
 * あると一覧ごと捨てるので、同じ名前は先にある方（実際に動く方）だけを残し、`plugin` / `mcp` は `user` として送る。
 */
export function paradisLegacyAgentCommandCatalog(commands: readonly IParadisAgentCommandOption[]): IParadisAgentCommandOption[] {
	const result: IParadisAgentCommandOption[] = [];
	const seen = new Set<string>();
	for (const command of commands) {
		const key = command.name.toLocaleLowerCase();
		if (seen.has(key) || !LEGACY_COMMAND_NAME_PATTERN.test(command.name)) {
			continue;
		}
		seen.add(key);
		result.push({
			name: command.name, insertText: command.insertText, description: command.description,
			...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
			kind: command.kind,
			source: command.source === 'plugin' || command.source === 'mcp' ? 'user' : command.source,
		});
	}
	// 同じ名前を 1 件にした後で切る（残った組み込みは動くものだけなので、すべて枠を取る）
	return paradisCapAgentCommands(result, LEGACY_MAX_ITEMS);
}

function isInternalCommandName(name: string): boolean {
	return name.startsWith('__');
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

async function readSkillDirectory(directory: string, source: 'user' | 'project' | 'plugin', plugin?: string): Promise<IParadisAgentCommandOption[]> {
	const entries = await readDirectory(directory);
	const result: IParadisAgentCommandOption[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name, 'SKILL.md');
		if (!entry.isDirectory() && !await isDirectory(join(directory, entry.name))) {
			continue;
		}
		const metadata = await readMarkdownMetadata(path);
		const leaf = metadata?.name ?? entry.name;
		const name = plugin !== undefined ? `${plugin}:${leaf}` : leaf;
		if (metadata === undefined || !metadata.userInvocable || !isValidCommandName(name)) {
			continue;
		}
		result.push({ name, insertText: `/${name}`, description: metadata.description, ...(metadata.argumentHint !== undefined ? { argumentHint: metadata.argumentHint } : {}), kind: 'skill', source, ...(plugin !== undefined ? { plugin } : {}) });
	}
	return result;
}

async function readCommandDirectory(directory: string, source: 'user' | 'project' | 'plugin', prefix = '', depth = 0, plugin?: string): Promise<IParadisAgentCommandOption[]> {
	if (depth > MAX_COMMAND_DEPTH) {
		return [];
	}
	const entries = await readDirectory(directory);
	const result: IParadisAgentCommandOption[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() || await isDirectory(path)) {
			result.push(...await readCommandDirectory(path, source, prefix.length > 0 ? `${prefix}:${entry.name}` : entry.name, depth + 1, plugin));
			continue;
		}
		if (extname(entry.name).toLocaleLowerCase() !== '.md') {
			continue;
		}
		const leaf = basename(entry.name, extname(entry.name));
		const local = prefix.length > 0 ? `${prefix}:${leaf}` : leaf;
		const name = plugin !== undefined ? `${plugin}:${local}` : local;
		const metadata = await readMarkdownMetadata(path);
		if (metadata === undefined || !metadata.userInvocable || !isValidCommandName(name)) {
			continue;
		}
		result.push({ name, insertText: `/${name}`, description: metadata.description, ...(metadata.argumentHint !== undefined ? { argumentHint: metadata.argumentHint } : {}), kind: 'command', source, ...(plugin !== undefined ? { plugin } : {}) });
	}
	return result;
}

/**
 * 有効なプラグインのコマンドと skill（`<プラグイン>:<名前>`）。`installed_plugins.json` に入っていて、
 * 設定（ユーザー → プロジェクト → ローカルの順に上書き）の `enabledPlugins` で true のもの。
 * プロジェクトに入れたプラグインは、そのプロジェクトの中で開いたペインにだけ出す。
 */
async function readEnabledClaudePlugins(claudeHome: string, projects: readonly string[]): Promise<IParadisAgentCommandOption[]> {
	const installed = rec(await readJson(join(claudeHome, 'plugins', 'installed_plugins.json')));
	const plugins = rec(installed?.plugins);
	if (plugins === undefined) {
		return [];
	}
	const enabled = new Map<string, boolean>();
	const applyEnabled = (settings: unknown) => {
		const map = rec(rec(settings)?.enabledPlugins);
		for (const [id, value] of Object.entries(map ?? {})) {
			if (typeof value === 'boolean') {
				enabled.set(id, value);
			}
		}
	};
	applyEnabled(await readJson(join(claudeHome, 'settings.json')));
	// プロジェクトの設定は、近い方（cwd に近いディレクトリ）が後から上書きする
	for (const directory of [...projects].reverse()) {
		applyEnabled(await readJson(join(directory, '.claude', 'settings.json')));
		applyEnabled(await readJson(join(directory, '.claude', 'settings.local.json')));
	}
	const projectSet = new Set(projects.map(directory => resolve(directory)));
	const result: IParadisAgentCommandOption[] = [];
	for (const id of Object.keys(plugins).sort((a, b) => a.localeCompare(b))) {
		if (enabled.get(id) !== true) {
			continue;
		}
		const entries = Array.isArray(plugins[id]) ? plugins[id] as unknown[] : [];
		const entry = entries.map(rec).find(candidate => {
			if (candidate === undefined || typeof candidate.installPath !== 'string') {
				return false;
			}
			return candidate.scope === 'user' || candidate.scope === undefined
				|| (typeof candidate.projectPath === 'string' && projectSet.has(resolve(candidate.projectPath)));
		});
		if (entry === undefined) {
			continue;
		}
		const installPath = entry.installPath as string;
		const manifest = rec(await readJson(join(installPath, '.claude-plugin', 'plugin.json')));
		const pluginName = typeof manifest?.name === 'string' && isValidCommandName(manifest.name) ? manifest.name : id.split('@')[0];
		if (pluginName === undefined || !isValidCommandName(pluginName)) {
			continue;
		}
		const commandDirs = [join(installPath, 'commands'), ...manifestPaths(installPath, manifest?.commands)];
		const skillDirs = [join(installPath, 'skills'), ...manifestPaths(installPath, manifest?.skills)];
		const plugin = pluginName.slice(0, MAX_PLUGIN_NAME_LENGTH);
		for (const directory of [...new Set(commandDirs)]) {
			result.push(...await readCommandDirectory(directory, 'plugin', '', 0, plugin));
		}
		for (const directory of [...new Set(skillDirs)]) {
			result.push(...await readSkillDirectory(directory, 'plugin', plugin));
		}
	}
	return result;
}

/** プラグインの manifest の `commands` / `skills`（文字列か文字列の配列。プラグインの中のパスだけ）。 */
function manifestPaths(installPath: string, value: unknown): string[] {
	const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	const root = resolve(installPath);
	return values.map(item => resolve(root, item)).filter(path => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)).slice(0, 8);
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
	let head: string;
	try {
		head = await readFrontMatterRegion(path);
	} catch {
		return undefined;
	}
	const { attributes, body } = paradisParseCommandFrontMatter(head);
	const description = compactText(attributes.get('description') ?? firstParagraph(body) ?? 'Custom command');
	const name = cleanScalar(attributes.get('name'));
	const argumentHint = cleanScalar(attributes.get('argument-hint'));
	return {
		...(name !== undefined ? { name } : {}),
		description: description.slice(0, MAX_DESCRIPTION_LENGTH),
		...(argumentHint !== undefined ? { argumentHint: compactText(argumentHint).slice(0, MAX_ARGUMENT_HINT_LENGTH) } : {}),
		userInvocable: attributes.get('user-invocable')?.toLocaleLowerCase() !== 'false',
	};
}

/**
 * ファイルの先頭から frontmatter の終わりまでだけを読む（本文は読まない）。frontmatter が無ければ、最初の段落を探す
 * ぶん（{@link MAX_BODY_PREVIEW_BYTES}）だけ読む。
 */
async function readFrontMatterRegion(path: string): Promise<string> {
	const handle = await fs.open(path, 'r');
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < MAX_FRONT_MATTER_BYTES) {
			const buffer = Buffer.alloc(READ_CHUNK_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (bytesRead === 0) {
				break;
			}
			chunks.push(buffer.subarray(0, bytesRead));
			total += bytesRead;
			const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
			if (!text.startsWith('---')) {
				if (total >= MAX_BODY_PREVIEW_BYTES) {
					break;
				}
				continue;
			}
			if (/\n---[ \t]*(?:\n|$)/.test(text.slice(3))) {
				break;
			}
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * frontmatter の値を読む（YAML の一部: `key: value`、引用符、`>` / `|` のブロック、インデントで続く複数行）。
 * 値は 1 本の文字列にする（ブロックの改行は保たない。説明と引数のヒントにしか使わない）。
 */
export function paradisParseCommandFrontMatter(content: string): { attributes: Map<string, string>; body: string } {
	const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
	const opening = /^---[ \t]*\n/.exec(normalized);
	if (opening === null) {
		return { attributes: new Map(), body: normalized };
	}
	const rest = normalized.slice(opening[0].length);
	const closing = /(?:^|\n)---[ \t]*(?:\n|$)/.exec(rest);
	if (closing === null) {
		// 閉じていない（または上限より長い）frontmatter。本文の段落と取り違えないよう、何も読まない
		return { attributes: new Map(), body: '' };
	}
	const attributes = new Map<string, string>();
	const lines = rest.slice(0, closing.index).split('\n');
	for (let index = 0; index < lines.length; index++) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/.exec(lines[index]);
		if (match === null) {
			continue;
		}
		const key = match[1].toLocaleLowerCase();
		const value = match[2] ?? '';
		// 引用符で囲んでいない値だけ、行末のコメントを外す
		const head = /^["']/.test(value) ? value : value.replace(/[ \t]+#.*$/, '');
		const continuation: string[] = [];
		while (index + 1 < lines.length && (/^[ \t]+\S/.test(lines[index + 1]) || (lines[index + 1].trim().length === 0 && continuationFollows(lines, index + 1)))) {
			continuation.push(lines[++index].trim());
		}
		if (/^[>|][+-]?[0-9]?$/.test(head)) {
			attributes.set(key, continuation.filter(line => line.length > 0).join(' '));
			continue;
		}
		const joined = [head, ...continuation].filter(line => line.length > 0).join(' ');
		attributes.set(key, cleanScalar(joined) ?? '');
	}
	return { attributes, body: rest.slice(closing.index + closing[0].length) };
}

/** 空行の後にもインデントされた行が続くか（ブロックの途中の空行）。 */
function continuationFollows(lines: readonly string[], from: number): boolean {
	for (let index = from; index < lines.length; index++) {
		if (lines[index].trim().length > 0) {
			return /^[ \t]+\S/.test(lines[index]);
		}
	}
	return false;
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

function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function readJson(path: string): Promise<unknown> {
	try {
		const stat = await fs.stat(path);
		if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
			return undefined;
		}
		return JSON.parse(await fs.readFile(path, 'utf8'));
	} catch {
		return undefined;
	}
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)
/* eslint-disable local/code-no-unexternalized-strings -- CLI tokens and shell quote characters are protocol literals. */

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisInteractiveAgentMode = 'new' | 'resume' | 'fork';
export interface ParadisInteractiveAgentCommand {
	readonly agent: 'claude' | 'codex';
	readonly mode: ParadisInteractiveAgentMode;
	/** Codexの-C/--cdで指定された実行ディレクトリ（シェルcwdからの相対値を含む）。 */
	readonly cwd?: string;
	/** `codex resume <thread-id>` / `codex fork <thread-id>` の明示対象。 */
	readonly sessionId?: string;
}

const codexOptionsWithValue = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
const codexNonInteractiveCommands = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'cloud', 'exec-server', 'features', 'help']);
const claudeOptionsWithValue = new Set(['--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt', '--betas', '--debug-file', '--disallowedTools', '--disallowed-tools', '--effort', '--fallback-model', '--file', '--input-format', '--json-schema', '--max-budget-usd', '--mcp-config', '--model', '-n', '--name', '--output-format', '--permission-mode', '--plugin-dir', '--plugin-url', '--remote-control', '-r', '--resume', '--session-id', '--setting-sources']);
const claudeNonInteractiveCommands = new Set(['agents', 'auth', 'auto-mode', 'doctor', 'gateway', 'install', 'mcp', 'plugin', 'plugins', 'project', 'setup-token', 'ultrareview', 'update', 'upgrade']);
const claudeForkableResumeOptions = new Set(['-r', '--resume', '-c', '--continue']);
const claudeResumeOptions = new Set([...claudeForkableResumeOptions, '--from-pr', '--teleport']);

function shellWords(commandLine: string): string[] {
	const words: string[] = [];
	let word = '';
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const character of commandLine.trim()) {
		if (escaped) {
			word += character;
			escaped = false;
		} else if (character === '\\' && quote !== "'") {
			escaped = true;
		} else if (quote !== undefined) {
			if (character === quote) { quote = undefined; } else { word += character; }
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			if (word.length > 0) { words.push(word); word = ''; }
		} else {
			word += character;
		}
	}
	if (escaped) { word += '\\'; }
	if (word.length > 0) { words.push(word); }
	return words;
}

function firstPositionalIndex(args: readonly string[], optionsWithValue: ReadonlySet<string>): number | undefined {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === '--') { return args[index + 1] !== undefined ? index + 1 : undefined; }
		if (!argument.startsWith('-')) { return index; }
		const option = argument.split('=', 1)[0];
		if (!argument.includes('=') && optionsWithValue.has(option)) { index++; }
	}
	return undefined;
}

function firstPositional(args: readonly string[], optionsWithValue: ReadonlySet<string>): string | undefined {
	const index = firstPositionalIndex(args, optionsWithValue);
	return index !== undefined ? args[index] : undefined;
}

function optionValue(args: readonly string[], names: ReadonlySet<string>): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		const equals = argument.indexOf('=');
		if (equals > 0 && names.has(argument.slice(0, equals))) {
			return argument.slice(equals + 1);
		}
		if (names.has(argument)) {
			return args[index + 1];
		}
	}
	return undefined;
}

/** 現行CLIで長時間動作する対話型Agentコマンドだけを分類する。 */
export function paradisInteractiveAgentCommand(commandLine: string): ParadisInteractiveAgentCommand | undefined {
	const words = shellWords(commandLine);
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) { words.shift(); }
	const executable = (words.shift()?.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '');
	if (executable !== 'codex' && executable !== 'claude') { return undefined; }
	if (words.some(argument => argument === '-h' || argument === '--help' || argument === '-v' || argument === '-V' || argument === '--version')) { return undefined; }
	if (executable === 'codex') {
		const commandIndex = firstPositionalIndex(words, codexOptionsWithValue);
		const positional = commandIndex !== undefined ? words[commandIndex] : undefined;
		if (positional !== undefined && codexNonInteractiveCommands.has(positional)) { return undefined; }
		const mode = positional === 'resume' ? 'resume' : positional === 'fork' ? 'fork' : 'new';
		const sessionId = mode !== 'new' && commandIndex !== undefined ? firstPositional(words.slice(commandIndex + 1), codexOptionsWithValue) : undefined;
		const cwd = optionValue(words, new Set(['-C', '--cd']));
		return {
			agent: 'codex', mode,
			...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
			...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
		};
	}
	if (words.some(argument => argument === '-p' || argument === '--print' || argument === '--bg' || argument === '--background')) { return undefined; }
	const positional = firstPositional(words, claudeOptionsWithValue);
	if (positional !== undefined && claudeNonInteractiveCommands.has(positional)) { return undefined; }
	const resume = words.some(argument => claudeResumeOptions.has(argument) || argument.startsWith('--resume=') || argument.startsWith('--from-pr='));
	const fork = words.includes('--fork-session') && words.some(argument => claudeForkableResumeOptions.has(argument) || argument.startsWith('--resume='));
	return { agent: 'claude', mode: fork ? 'fork' : resume ? 'resume' : 'new' };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * OpenCode and the OpenCode-compatible CLIs that run the Para Code bridge.
 *
 * A bridge-capable CLI tells Para Code its command name when it registers a session. Para Code checks the name with
 * {@link paradisIsOpenCodeCompatibleCommand}, remembers the names it has verified, and then recognizes them the same way
 * as `opencode`: in the terminal title (`<command> | <title>`), in the process tree and in the resume command line.
 * Nothing here knows any CLI other than `opencode` by name.
 */

/** The command of OpenCode itself. */
export const PARADIS_OPENCODE_COMMAND = 'opencode';

/** At most this many learned commands are kept (per process). */
const MAX_COMMANDS = 16;

/** Safe command names: a plain file name that a shell does not interpret, and never an option. */
const COMMAND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/**
 * Names that must never be treated as OpenCode: shells, script runtimes, wrappers and other agent CLIs. Taking one of
 * these as an agent would make every process of that name look like OpenCode to the ownership checks.
 */
const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
	'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'xonsh', 'pwsh', 'powershell', 'cmd', 'wsl', 'login',
	'node', 'bun', 'bunx', 'deno', 'npx', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'ruby', 'perl', 'env', 'sudo', 'doas',
	'ssh', 'tmux', 'screen', 'zellij', 'script', 'nohup', 'time', 'timeout', 'exec', 'xargs',
	'claude', 'codex', 'copilot', 'gemini', 'commandcode', 'code', 'code-oss', 'cursor',
	// OpenCode's own title prefix (`OC | <title>`), never a command of another CLI
	'oc',
]);

/** Whether `name` may be remembered as the command of an OpenCode-compatible CLI. */
export function paradisIsOpenCodeCompatibleCommand(name: unknown): name is string {
	return typeof name === 'string' && COMMAND_PATTERN.test(name) && !RESERVED_COMMANDS.has(name);
}

/** Whether a program file name is a script runtime or a shell (never remembered as an OpenCode-compatible CLI). */
export function paradisIsRuntimeOrShellProgram(name: string): boolean {
	const lower = name.toLowerCase().replace(/\.exe$/, '');
	return RESERVED_COMMANDS.has(lower) || /^(?:python|pypy|ruby|perl|php|lua|node|bun|deno|java|dotnet)[\d.]*$/.test(lower);
}

/**
 * The absolute path of a remembered OpenCode-compatible CLI, safe to put on a command line without quoting: a normalized
 * POSIX path of plain characters whose file name is a valid compatible command.
 */
export function paradisIsOpenCodeCliExecutable(path: unknown): path is string {
	if (typeof path !== 'string' || path.length > 512 || !/^\/[A-Za-z0-9._@+/-]+$/.test(path) || path.endsWith('/')) {
		return false;
	}
	const segments = path.split('/').slice(1);
	if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
		return false;
	}
	const name = segments[segments.length - 1];
	return paradisIsOpenCodeCompatibleCommand(name) && !paradisIsRuntimeOrShellProgram(name);
}

/** What may resume an OpenCode session: `opencode`, or the absolute path of a remembered compatible CLI. */
export function paradisIsOpenCodeResumeCli(value: unknown): value is string {
	return value === PARADIS_OPENCODE_COMMAND || paradisIsOpenCodeCliExecutable(value);
}

/** A display name sent by the CLI: one short line without control characters. */
export function paradisNormalizeOpenCodeCliLabel(label: unknown): string | undefined {
	if (typeof label !== 'string') {
		return undefined;
	}
	const trimmed = label.trim();
	return trimmed.length > 0 && trimmed.length <= 40 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(trimmed) ? trimmed : undefined;
}

let learned: readonly string[] = [];

/** Replace the learned commands of this process (only valid names are kept). */
export function paradisSetOpenCodeCompatibleCommands(commands: readonly unknown[]): void {
	const next = [...new Set(commands.filter(paradisIsOpenCodeCompatibleCommand))].filter(command => command !== PARADIS_OPENCODE_COMMAND).slice(0, MAX_COMMANDS);
	if (next.length !== learned.length || next.some((command, index) => command !== learned[index])) {
		learned = next;
	}
}

/** `opencode` and the learned commands. */
export function paradisOpenCodeCommands(): readonly string[] {
	return [PARADIS_OPENCODE_COMMAND, ...learned];
}

/** Whether a program name (lower case, without extension) is OpenCode or a learned OpenCode-compatible CLI. */
export function paradisIsOpenCodeProgram(basename: string): boolean {
	return basename === PARADIS_OPENCODE_COMMAND || learned.includes(basename);
}

/**
 * The command that an OSC title belongs to, or undefined.
 *
 * - OpenCode itself sets `OpenCode` (home, or a session without a title) and `OC | <title>` (packages/tui/src/app.tsx).
 *   Both give `opencode`. `opencode | <title>` is accepted too.
 * - A learned OpenCode-compatible CLI sets `<command> | <title>` or just `<command>`.
 *
 * Titles that only mention the name elsewhere (`Review opencode notes`) or a longer name (`opencode-tools`) do not match.
 */
export function paradisOpenCodeTitleCommand(title: string): string | undefined {
	const match = /^\s*([^\s|]+)\s*(\|)?/.exec(title);
	if (match === null) {
		return undefined;
	}
	const head = match[1].toLowerCase();
	const piped = match[2] !== undefined;
	const rest = title.slice(match[0].length);
	if (!piped && rest.trim().length > 0) {
		return undefined;
	}
	if (head === 'oc') {
		return piped ? PARADIS_OPENCODE_COMMAND : undefined;
	}
	return paradisIsOpenCodeProgram(head) ? head : undefined;
}

/** The part of an OpenCode title after its `<command> |` / `OC |` prefix (empty for a bare `OpenCode`), or undefined. */
export function paradisOpenCodeTitleText(title: string): string | undefined {
	if (paradisOpenCodeTitleCommand(title) === undefined) {
		return undefined;
	}
	return title.replace(/^\s*[^\s|]+\s*\|?\s*/, '').trim();
}

/** For the terminal's title patterns: matches the titles {@link paradisOpenCodeTitleCommand} accepts. */
export const paradisOpenCodeTitlePattern: { test(title: string): boolean } = {
	test: title => paradisOpenCodeTitleCommand(title) !== undefined,
};

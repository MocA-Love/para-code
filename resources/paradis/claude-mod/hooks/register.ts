/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The Para Code mod for Claude Code (Claude Mods, function hooks).
//
// Para Code loads this folder into the Claude Code sessions it starts in its own terminals
// (CLAUDE_CODE_PLUGIN_DIRS, see src/vs/paradis/contrib/claudeMod). It talks to the Para Code
// shared process over the same loopback port and pane token the settings hooks use
// (PARA_CODE_MCP_PORT_FILE / PARA_CODE_TERMINAL_PANE_ID), under /claude-mod/v1/<op>.
//
// It never changes what Claude Code does on its own: every hook passes through, and the only
// answers it gives are the ones the person gave on Para Code Mobile (a question's answers, an
// approval). The settings hooks, the transcript and the key injection keep working beside it,
// so a session where this mod is not loaded (or Para Code cannot be reached) behaves as before.
//
// Rules for this file:
// - Never wait on a promise of our own inside a hook: only `next` and `$` calls, whose time the
//   10 second budget does not count. Background work runs from the session.start engine.
// - Every request that fails is dropped quietly: Para Code may be restarting or gone.

import type { EngineInterface, Register } from 'claude-code';

type Engine = EngineInterface;
type Json = Record<string, unknown>;

const MOD_PROTOCOL = '1';
const MOD_VERSION = '1.3.0';
/**
 * What this mod can do beyond the first version, sent with every wait for commands (Para Code may have
 * restarted since hello): `commands.list` answers `commandList` with `$.command.list()`, `command.run` runs a
 * slash command for Para Code Mobile with `$.command.run`, `prompt.dialog` answers `dialogCheck` (whether a
 * screen such as `/config` holds the keys).
 */
const MOD_FEATURES = ['commands.list', 'command.run', 'prompt.dialog'];
/** How long a slash command may take before Para Code is told it was taken (a panel holds `$.command.run` open). */
const COMMAND_RUN_EARLY_MS = 1_500;
/**
 * Commands sent back for `commandList` at most (Claude Code lists hundreds with many skills). The built-ins come
 * last in the typeahead's order, so they keep their places first and the rest fill what is left, in order.
 */
const MAX_LISTED_COMMANDS = 2_000;
/** How long the port read from the port file is trusted before it is read again. */
const ENDPOINT_TTL_MS = 30_000;
/** Text chunks of a response are sent at most this often. */
const STEP_FLUSH_MS = 150;
/** Events waiting to be sent; beyond this new ones are dropped (Para Code is not answering). */
const MAX_QUEUED_EVENTS = 512;
/** Rows larger than this are left to the transcript reader. */
const MAX_ROW_CHARS = 256 * 1024;
/** One wait asks again at most this many times (each wait is held by Para Code for about 25 s). */
const MAX_WAIT_ROUNDS = 1_000;
/** Tool calls remembered from tool.check to pair with the PermissionRequest that follows. */
const MAX_REMEMBERED_ASKS = 64;

interface IEndpoint {
	readonly url: string;
	readonly token: string;
	readonly at: number;
}

interface IReply {
	readonly status: number;
	readonly json: Json | undefined;
}

let endpoint: IEndpoint | undefined;
/** `$.http.fetch` was refused (an administrator's policy) while curl reached Para Code. */
let useCurl = false;
/** This module is connected to an interactive session in a Para Code terminal. */
let active = false;
let mainBusy = false;
let pumpGeneration = 0;
/** Events waiting to be sent, each with the session it happened in (taken when it happened, see emit). */
let queue: { readonly event: Json; readonly session: Promise<string | undefined> }[] = [];
let flushing = false;
/** Approvals waiting for Para Code Mobile: Para Code's id -> the call they belong to. */
const pendingPermissions = new Map<string, { readonly toolUseId: string | undefined; readonly toolName: string }>();
/** tool.check answered `ask`: `tool\0input` -> tool_use_ids, oldest first. */
const askedCalls = new Map<string, string[]>();
/**
 * A prompt from Para Code Mobile is being submitted. Only one at a time: another one handed over meanwhile is
 * refused at once (ack ok: false, reason: 'busy') and Para Code sends it with keys once the first one is
 * taken, so this mod never sends it. Every other refusal carries a reason (`stale`: the session moved on,
 * `panel-open`: a screen such as /config holds the keys, `refused`), and Para Code then answers the phone instead
 * of typing the text.
 */
let submitting = false;
/** Counts the sends, so one that finishes after a new session started does not clear the flag of a later send. */
let submitGeneration = 0;
/** A prompt submitted for Para Code, waiting for its row to learn the row's uuid. */
let submitWatch: { readonly id: string; readonly text: string; uuid?: string } | undefined;

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rec(value: unknown): Json | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(',')}]`;
	}
	const record = rec(value);
	if (record !== undefined) {
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function curlQuote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

async function resolveEndpoint($: Engine, refresh = false): Promise<IEndpoint | undefined> {
	const now = Date.now();
	if (!refresh && endpoint !== undefined && now - endpoint.at < ENDPOINT_TTL_MS) {
		return endpoint;
	}
	const token = await $.env.get('PARA_CODE_TERMINAL_PANE_ID');
	const portFile = await $.env.get('PARA_CODE_MCP_PORT_FILE');
	if (token === undefined || token.length === 0 || portFile === undefined || portFile.length === 0) {
		endpoint = undefined;
		return undefined;
	}
	let port: unknown;
	try {
		port = rec(JSON.parse(String(await $.fs.read(portFile))))?.port;
	} catch {
		endpoint = undefined;
		return undefined;
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
		endpoint = undefined;
		return undefined;
	}
	endpoint = { url: `http://127.0.0.1:${port}/claude-mod/v1`, token, at: now };
	return endpoint;
}

function parseReply(status: number, text: string): IReply {
	let json: Json | undefined;
	try {
		json = rec(JSON.parse(text));
	} catch {
		json = undefined;
	}
	return { status, json };
}

async function viaFetch($: Engine, target: IEndpoint, op: string, body: string): Promise<IReply> {
	const response = await $.http.fetch(`${target.url}/${op}`, {
		method: 'POST',
		headers: {
			'authorization': `Bearer ${target.token}`,
			'content-type': 'application/json',
			'x-para-code-mod': MOD_PROTOCOL,
		},
		body,
	});
	return parseReply(response.status, response.text);
}

/** The same request through curl: the token and the body go on stdin, never on the command line. */
async function viaCurl($: Engine, target: IEndpoint, op: string, body: string): Promise<IReply> {
	const config = [
		`url = ${curlQuote(`${target.url}/${op}`)}`,
		'request = "POST"',
		`header = ${curlQuote(`Authorization: Bearer ${target.token}`)}`,
		'header = "Content-Type: application/json"',
		`header = ${curlQuote(`X-Para-Code-Mod: ${MOD_PROTOCOL}`)}`,
		`data-binary = ${curlQuote(body)}`,
		'silent',
		'max-time = 60',
		'write-out = "\\n%{http_code}"',
		'',
	].join('\n');
	const result = await $.process.run(['curl', '--config', '-'], { stdin: config, timeoutMs: 70_000 });
	const newline = result.stdout.lastIndexOf('\n');
	const status = Number.parseInt(result.stdout.slice(newline + 1), 10);
	if (result.exitCode !== 0 || !Number.isInteger(status) || status === 0) {
		throw new Error('curl did not reach Para Code');
	}
	return parseReply(status, result.stdout.slice(0, Math.max(0, newline)));
}

async function request($: Engine, op: string, payload: Json): Promise<IReply | undefined> {
	const target = await resolveEndpoint($);
	if (target === undefined) {
		return undefined;
	}
	const body = JSON.stringify(payload);
	if (useCurl) {
		try {
			return await viaCurl($, target, op, body);
		} catch {
			endpoint = undefined;
			return undefined;
		}
	}
	try {
		return await viaFetch($, target, op, body);
	} catch {
		endpoint = undefined;
	}
	// The fetch failed. Para Code may have restarted on another port: read the port file again and
	// fetch once more. Only when that fetch fails too while curl gets through was the fetch refused
	// (an administrator's policy, not Para Code being away): keep using curl from here on.
	const retry = await resolveEndpoint($, true);
	if (retry === undefined) {
		return undefined;
	}
	try {
		return await viaFetch($, retry, op, body);
	} catch {
		// fall through to curl
	}
	try {
		const reply = await viaCurl($, retry, op, body);
		useCurl = true;
		return reply;
	} catch {
		endpoint = undefined;
		return undefined;
	}
}

/**
 * Queues an event for Para Code; sent in order and in batches. The session is taken when the event
 * happens (a /clear starts a new one while older events may still be waiting to be sent).
 */
function emit($: Engine, event: Json, sessionId?: string): void {
	if (!active || queue.length >= MAX_QUEUED_EVENTS) {
		return;
	}
	const session = sessionId !== undefined ? Promise.resolve(sessionId) : $.session.id().then(value => value, () => undefined);
	queue.push({ event: { ...event, at: Date.now() }, session });
	if (!flushing) {
		flushing = true;
		void flush($);
	}
}

async function flush($: Engine): Promise<void> {
	try {
		while (queue.length > 0) {
			const waiting = queue;
			queue = [];
			// One request per run of events from the same session, in the order they happened
			let batch: Json[] = [];
			let batchSession: string | undefined;
			for (const item of waiting) {
				const sessionId = await item.session;
				if (sessionId === undefined) {
					continue;
				}
				if (batchSession !== undefined && sessionId !== batchSession && batch.length > 0) {
					await request($, 'event', { sessionId: batchSession, events: batch });
					batch = [];
				}
				batchSession = sessionId;
				batch.push(item.event);
			}
			if (batchSession !== undefined && batch.length > 0) {
				await request($, 'event', { sessionId: batchSession, events: batch });
			}
		}
	} catch {
		// Dropped: Para Code reads the transcript and the settings hooks as before.
	} finally {
		flushing = false;
		if (queue.length > 0) {
			flushing = true;
			void flush($);
		}
	}
}

/** Asks Para Code until the item `id` is answered, settled or expired; undefined when Para Code is away. */
async function waitFor($: Engine, sessionId: string, id: string, stop: () => boolean): Promise<Json | undefined> {
	for (let round = 0; round < MAX_WAIT_ROUNDS && !stop(); round++) {
		const reply = await request($, 'wait', { sessionId, id });
		if (reply === undefined || reply.status !== 200 || reply.json === undefined) {
			return undefined;
		}
		if (reply.json.state !== 'pending') {
			return reply.json;
		}
	}
	return undefined;
}

function settle($: Engine, sessionId: string, ids: readonly string[]): void {
	if (ids.length > 0) {
		void request($, 'settle', { sessionId, ids }).catch(() => undefined);
	}
}

/** The approvals this tool call answers (the call only starts once its approval was given). */
function settleForCall($: Engine, sessionId: string, toolUseId: string | undefined, toolName: string): void {
	const ids: string[] = [];
	for (const [id, call] of pendingPermissions) {
		if ((call.toolUseId !== undefined && call.toolUseId === toolUseId) || (call.toolUseId === undefined && call.toolName === toolName)) {
			ids.push(id);
			pendingPermissions.delete(id);
		}
	}
	settle($, sessionId, ids);
}

function rememberAsk(tool: string, input: unknown, toolUseId: string): void {
	const key = `${tool}\0${stableJson(input)}`;
	const ids = askedCalls.get(key) ?? [];
	ids.push(toolUseId);
	askedCalls.delete(key);
	askedCalls.set(key, ids.slice(-8));
	while (askedCalls.size > MAX_REMEMBERED_ASKS) {
		const oldest = askedCalls.keys().next();
		if (oldest.done === true) {
			break;
		}
		askedCalls.delete(oldest.value);
	}
}

/** The tool_use_id of the call a PermissionRequest is about (it does not carry one itself). */
function takeAskedCall(tool: string, input: unknown): string | undefined {
	const key = `${tool}\0${stableJson(input)}`;
	const exact = askedCalls.get(key);
	if (exact !== undefined && exact.length > 0) {
		const id = exact.shift();
		if (exact.length === 0) {
			askedCalls.delete(key);
		}
		return id;
	}
	// The input may be spelled differently between the two events: accept a single open call of the tool.
	const sameTool = [...askedCalls.entries()].filter(([candidate, ids]) => candidate.startsWith(`${tool}\0`) && ids.length > 0);
	const only = sameTool.length === 1 ? sameTool[0] : undefined;
	if (only !== undefined && only[1].length === 1) {
		askedCalls.delete(only[0]);
		return only[1][0];
	}
	return undefined;
}

function contentBlocks(message: unknown): Json[] {
	const content = rec(message)?.content;
	return Array.isArray(content) ? content.map(rec).filter((block): block is Json => block !== undefined) : [];
}

function textOf(blocks: readonly Json[]): string {
	return blocks.filter(block => block.type === 'text').map(block => str(block.text) ?? '').join('\n');
}

function observeRow($: Engine, e: { readonly message: unknown; readonly door: string; readonly origin: unknown; readonly uuid: string; readonly agentId?: string }): void {
	const blocks = contentBlocks(e.message);
	const results = blocks.filter(block => block.type === 'tool_result');
	if (results.length > 0) {
		const ids = results.map(block => str(block.tool_use_id)).filter((id): id is string => id !== undefined);
		const errorIds = results.filter(block => block.is_error === true).map(block => str(block.tool_use_id)).filter((id): id is string => id !== undefined);
		emit($, { type: 'tool-results', ids, errorIds, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) });
	}
	const originKind = str(rec(e.origin)?.kind);
	if (e.agentId === undefined && e.door === 'prompt' && originKind === 'plugin' && submitWatch !== undefined && submitWatch.uuid === undefined
		&& textOf(blocks).trim() === submitWatch.text.trim()) {
		submitWatch.uuid = e.uuid;
	}
	// Only the main conversation's prompts and responses: the transcript reader keeps the rest
	// (tool results carry structured records, attachments and media are read from the file).
	if (e.agentId !== undefined || (e.door !== 'prompt' && e.door !== 'response')) {
		return;
	}
	if (blocks.some(block => block.type === 'image' || block.type === 'document')) {
		return;
	}
	const message = rec(e.message) ?? {};
	const content = typeof message.content === 'string'
		? message.content
		: blocks.map(block => block.type === 'thinking' || block.type === 'redacted_thinking' ? { type: block.type, thinking: block.thinking } : block);
	const row: Json = {
		type: 'row', uuid: e.uuid, door: e.door,
		...(originKind !== undefined ? { origin: originKind } : {}),
		message: {
			type: message.type,
			...(message.role !== undefined ? { role: message.role } : {}),
			...(message.isMeta === true ? { isMeta: true } : {}),
			...(message.name !== undefined ? { name: message.name } : {}),
			content,
		},
	};
	if (JSON.stringify(row).length <= MAX_ROW_CHARS) {
		emit($, row);
	}
}

/**
 * Stops a background task (a shell started with run_in_background) for Para Code Mobile. TaskStop asks no
 * permission and the call leaves nothing in the transcript, so the ack is how Para Code learns the outcome.
 */
async function stopTask($: Engine, sessionId: string, id: string, taskId: string): Promise<void> {
	let ok = false;
	let message: string | undefined;
	try {
		const reply = await $.tool.call({ tool: 'TaskStop', task_id: taskId }) as unknown as Json;
		const deny = str(reply.deny);
		ok = deny === undefined && reply.isError !== true && rec(reply.result) !== undefined;
		message = deny ?? str(rec(reply.result)?.message) ?? str(reply.text);
	} catch (error) {
		message = error instanceof Error ? error.message : undefined;
	}
	await request($, 'ack', { sessionId, id, ok, ...(message !== undefined ? { message: message.slice(0, 500) } : {}) });
}

/** The slash commands the person can run now, for Para Code's list on Para Code Mobile (in the typeahead's order). */
async function listCommands($: Engine, sessionId: string, id: string): Promise<void> {
	try {
		const listed = await $.command.list();
		const builtIns = listed.filter(command => command.source === 'builtin').length;
		let others = Math.max(0, MAX_LISTED_COMMANDS - builtIns);
		const kept = listed.length <= MAX_LISTED_COMMANDS ? listed : listed.filter(command => command.source === 'builtin' || others-- > 0);
		const commands = kept.slice(0, MAX_LISTED_COMMANDS).map(command => ({
			name: command.name,
			description: typeof command.description === 'string' ? command.description.slice(0, 300) : '',
			source: command.source,
			...(typeof command.plugin === 'string' ? { plugin: command.plugin.slice(0, 100) } : {}),
		}));
		await request($, 'ack', { sessionId, id, ok: true, commands });
	} catch (error) {
		await request($, 'ack', { sessionId, id, ok: false, ...(error instanceof Error ? { message: error.message.slice(0, 500) } : {}) });
	}
}

/**
 * Whether a screen holds the keys (`/config`, `/rewind`, `/model`'s picker, and also an approval or a question):
 * an empty append to the prompt box is refused with `dialog` then, and leaves the draft as it is otherwise.
 * Telling an approval or a question apart is Para Code's: it asks only while it sees none waiting.
 */
async function panelOpen($: Engine): Promise<boolean> {
	try {
		const filled = await $.prompt.fill({ text: '', mode: 'append' });
		return !filled.isFilled && filled.refusal === 'dialog';
	} catch {
		return false;
	}
}

async function checkDialog($: Engine, sessionId: string, id: string): Promise<void> {
	await request($, 'ack', { sessionId, id, ok: true, dialog: await panelOpen($) });
}

function errorText(error: unknown): string | undefined {
	return error instanceof Error ? error.message.slice(0, 500) : typeof error === 'string' ? error.slice(0, 500) : undefined;
}

/**
 * Runs a slash command sent from Para Code Mobile (`$.prompt.submit` refuses a text that begins with `/`).
 * An unknown name is refused at once, and that refusal goes back to the phone. A command that opens a panel
 * holds `$.command.run` open until the panel closes: past {@link COMMAND_RUN_EARLY_MS} Para Code is told it
 * was taken, and the outcome follows in a second ack.
 */
async function runSlashCommand($: Engine, sessionId: string, id: string, name: string, args: string, generation: number): Promise<void> {
	if (name.startsWith('__')) {
		// Claude Code's own internal commands are not run for the phone.
		await request($, 'ack', { sessionId, id, ok: false, reason: 'refused', message: `/${name} is internal to Claude Code` });
		return;
	}
	if (submitting) {
		await request($, 'ack', { sessionId, id, ok: false, reason: 'busy' });
		return;
	}
	submitting = true;
	const mine = ++submitGeneration;
	try {
		if (generation !== pumpGeneration || !active || await $.session.id() !== sessionId) {
			await request($, 'ack', { sessionId, id, ok: false, reason: 'stale' });
			return;
		}
		if (await panelOpen($)) {
			// A screen holds the keys: the command would only queue behind it, and Para Code must not type either.
			await request($, 'ack', { sessionId, id, ok: false, reason: 'panel-open' });
			return;
		}
		const running = $.command.run({ command: name, args }).then(
			() => ({ ok: true }),
			(error: unknown) => ({ ok: false, reason: 'refused', ...(errorText(error) !== undefined ? { message: errorText(error) } : {}) }),
		);
		const early = await Promise.race([
			running,
			new Promise<undefined>(resolve => $.clock.after(COMMAND_RUN_EARLY_MS, () => resolve(undefined))),
		]);
		if (early !== undefined) {
			await request($, 'ack', { sessionId, id, ...early });
			return;
		}
		// Still running (a screen it opened, or a long command such as /compact): tell Para Code it was taken, then how it ended.
		await request($, 'ack', { sessionId, id, received: true });
		await request($, 'ack', { sessionId, id, ...await running });
	} finally {
		if (submitGeneration === mine) {
			submitting = false;
		}
	}
}

/**
 * The commands Para Code hands over: prompts and slash commands sent from Para Code Mobile while the session
 * is idle, background tasks to stop, and the list of slash commands.
 */
async function runCommand($: Engine, sessionId: string, command: Json, generation: number): Promise<void> {
	const id = str(command.id);
	if (id !== undefined && command.kind === 'taskStop') {
		const taskId = str(command.taskId);
		if (taskId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
			await stopTask($, sessionId, id, taskId);
		}
		return;
	}
	if (id !== undefined && command.kind === 'dialogCheck') {
		await checkDialog($, sessionId, id);
		return;
	}
	if (id !== undefined && command.kind === 'commandList') {
		await listCommands($, sessionId, id);
		return;
	}
	if (id !== undefined && command.kind === 'commandRun') {
		const name = str(command.command);
		const args = typeof command.args === 'string' ? command.args : '';
		if (name !== undefined) {
			await runSlashCommand($, sessionId, id, name, args, generation);
		}
		return;
	}
	const text = str(command.text);
	if (id === undefined || command.kind !== 'submit' || text === undefined) {
		return;
	}
	if (submitting) {
		// `reason: 'busy'`: Para Code waits for the first prompt to be taken before it types this one with keys.
		await request($, 'ack', { sessionId, id, ok: false, reason: 'busy' });
		return;
	}
	// Taken before any await, so a second prompt of the same batch sees it.
	submitting = true;
	const mine = ++submitGeneration;
	try {
		// The session moved on (a new session.start, /clear) since this prompt was handed over: it was for the old one.
		if (generation !== pumpGeneration || !active || await $.session.id() !== sessionId) {
			await request($, 'ack', { sessionId, id, ok: false, reason: 'stale' });
			return;
		}
		if (await panelOpen($)) {
			// A screen such as /config holds the keys: the prompt would wait behind it.
			await request($, 'ack', { sessionId, id, ok: false, reason: 'panel-open' });
			return;
		}
		submitWatch = { id, text };
		// Tell Para Code first that the prompt is ours now: if a turn started meanwhile, $.prompt.submit
		// only resolves once that turn ends, and Para Code must not send the same text again with keys.
		await request($, 'ack', { sessionId, id, received: true });
		let ok = false;
		let message: string | undefined;
		try {
			await $.prompt.submit({ text, asUser: true });
			ok = true;
		} catch (error) {
			ok = false;
			message = errorText(error);
		}
		const uuid = submitWatch?.id === id ? submitWatch.uuid : undefined;
		submitWatch = undefined;
		await request($, 'ack', { sessionId, id, ok, ...(ok ? {} : { reason: 'refused' }), ...(message !== undefined ? { message } : {}), ...(uuid !== undefined ? { uuid } : {}) });
	} finally {
		if (submitGeneration === mine) {
			submitting = false;
		}
	}
}

function schedulePump($: Engine, generation: number, delayMs: number): void {
	$.clock.after(delayMs, () => {
		void pumpOnce($, generation);
	});
}

/** Holds one request open with Para Code for commands, then asks again. */
async function pumpOnce($: Engine, generation: number): Promise<void> {
	if (generation !== pumpGeneration || !active) {
		return;
	}
	let delayMs = 1;
	try {
		const sessionId = await $.session.id();
		const reply = await request($, 'commands', { sessionId, busy: mainBusy, features: MOD_FEATURES });
		if (reply === undefined || reply.status !== 200) {
			delayMs = 5_000;
		} else {
			const commands = Array.isArray(reply.json?.commands) ? reply.json.commands : [];
			for (const command of commands.slice(0, 8)) {
				const record = rec(command);
				if (record === undefined) {
					continue;
				}
				// Never hold the loop on a command: a prompt's `$.prompt.submit` only resolves once a running turn
				// ends, and a stop must still reach the task meanwhile. A prompt that comes while another is being
				// submitted is refused (runCommand), never queued.
				void runCommand($, sessionId, record, generation).catch(() => undefined);
			}
		}
	} catch {
		delayMs = 5_000;
	}
	if (generation === pumpGeneration && active) {
		schedulePump($, generation, delayMs);
	}
}

export const register: Register = on => {
	on('session.start', async ($, e, next) => {
		const started = await next(e);
		active = false;
		pumpGeneration++;
		// A new session (or a reload of this module) starts with nothing being sent and no panel of ours open.
		submitting = false;
		submitGeneration++;
		if (e.isInteractive && await resolveEndpoint($, true) !== undefined) {
			active = true;
			mainBusy = false;
			emit($, { type: 'hello', version: MOD_VERSION });
			schedulePump($, pumpGeneration, 1);
		}
		return started;
	});

	on('session.end', ($, e, next) => {
		if (active) {
			emit($, { type: 'bye', reason: e.reason });
		}
		return next(e);
	});

	on('session.append', ($, e, next) => {
		if (active) {
			try {
				observeRow($, e);
			} catch {
				// Observing never stands in the way of the row.
			}
		}
		return next(e);
	});

	on('turn.start', ($, e, next) => {
		if (active) {
			mainBusy = true;
			emit($, { type: 'turn.start', turnId: e.turnId });
		}
		return next(e);
	});

	on('turn.complete', ($, e, next) => {
		if (active) {
			if (e.agentId === undefined) {
				mainBusy = false;
			}
			emit($, { type: 'turn.complete', turnId: e.turnId, reason: e.reason, aborted: e.isAborted, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) });
		}
		return next(e);
	});

	// The context window as the status line shows it (Para Code Mobile's session ring). Older Claude Code has no
	// session.measure; registering it must not cost the other hooks.
	try {
		on('session.measure', ($, e, next) => {
			if (active && e.changed.includes('context')) {
				const { tokens, window, percent } = e.context;
				emit($, { type: 'measure', context: { window, ...(tokens !== undefined ? { tokens } : {}), ...(percent !== undefined ? { percent } : {}) } });
			}
			return next(e);
		});
	} catch {
		// This Claude Code does not measure sessions: Para Code reads the transcript's usage instead.
	}

	on('turn.step', async function* ($, e, next) {
		const stream = next(e);
		if (!active || e.agentId !== undefined) {
			return yield* stream;
		}
		let chunks: { index: number; text: string }[] = [];
		let sentAt = Date.now();
		const send = (end: boolean) => {
			if (chunks.length > 0 || end) {
				emit($, { type: 'step', turnId: e.turnId, step: e.index, chunks, end });
				chunks = [];
				sentAt = Date.now();
			}
		};
		for await (const chunk of stream) {
			if (chunk.kind === 'text' && chunk.text.length > 0) {
				const last = chunks[chunks.length - 1];
				if (last !== undefined && last.index === chunk.index) {
					last.text += chunk.text;
				} else {
					chunks.push({ index: chunk.index, text: chunk.text });
				}
				if (Date.now() - sentAt >= STEP_FLUSH_MS) {
					send(false);
				}
			}
			yield chunk;
		}
		send(true);
		return await stream.result;
	});

	on('tool.check', async ($, e, next) => {
		const verdict = await next(e);
		if (active && verdict.decision === 'ask' && e.tool_use_id !== undefined) {
			rememberAsk(e.tool, e.input, e.tool_use_id);
			emit($, { type: 'tool.check', toolUseId: e.tool_use_id, tool: e.tool });
		}
		return verdict;
	});

	on('classic.SubagentStart', ($, e, next) => {
		if (active) {
			emit($, { type: 'subagent.resume', agentId: e.agent_id, ...(str(e.agent_type) !== undefined ? { agentType: e.agent_type } : {}) }, e.session_id);
		}
		return next(e);
	});

	on('tool.call', async ($, e, next) => {
		if (!active) {
			return next(e);
		}
		const toolName = String(e.tool);
		if (pendingPermissions.size > 0) {
			settleForCall($, await $.session.id(), e.tool_use_id, toolName);
		}
		if (e.tool === 'AskUserQuestion') {
			const sessionId = await $.session.id();
			const asked = rec(e.answers);
			if (asked !== undefined && Object.keys(asked).length > 0) {
				return next(e);
			}
			const registered = await request($, 'question', {
				sessionId, questions: e.questions,
				...(e.tool_use_id !== undefined ? { toolUseId: e.tool_use_id } : {}),
				...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
			});
			const id = str(registered?.json?.id);
			if (registered?.status !== 200 || id === undefined || registered.json?.wait !== true) {
				return next(e);
			}
			// Race the terminal's own dialog with Para Code Mobile: the first answer is the answer.
			let finished = false;
			const fromTerminal = next(e).then(result => ({ kind: 'terminal' as const, result }));
			const fromMobile = waitFor($, sessionId, id, () => finished).then(reply => ({ kind: 'mobile' as const, reply }));
			const first = await Promise.race([fromTerminal, fromMobile]);
			finished = true;
			if (first.kind === 'mobile') {
				const answers = rec(first.reply?.answers);
				if (first.reply?.state === 'answer' && answers !== undefined) {
					const annotations = rec(first.reply?.annotations);
					return { result: { questions: e.questions, answers, ...(annotations !== undefined ? { annotations } : {}) } };
				}
				// "Chat about this" from the phone: every question is withdrawn. With a message the model
				// reads "The user responded: …"; without one it gets the same refusal the terminal's own
				// "Chat about this" writes (Para Code builds the text, with the partial answers and notes).
				if (first.reply?.state === 'clarify') {
					const response = str(first.reply.response);
					if (response !== undefined && response.trim().length > 0) {
						return { result: { questions: e.questions, answers: {}, response } };
					}
					const deny = str(first.reply.deny);
					if (deny !== undefined && deny.length > 0) {
						return { deny };
					}
				}
				// Nothing came from the phone (it went away, or Para Code did): the dialog decides.
				return (await fromTerminal).result;
			}
			settle($, sessionId, [id]);
			return first.result;
		}
		if (toolName === 'Agent' || toolName === 'Task') {
			const started = await next(e);
			const result = rec(started.result);
			const agentId = str(result?.agentId) ?? str(result?.agent_id);
			if (agentId !== undefined) {
				const input = e as unknown as Json;
				emit($, {
					type: 'subagent.start', agentId,
					...(e.tool_use_id !== undefined ? { toolUseId: e.tool_use_id } : {}),
					...(str(input.subagent_type) !== undefined ? { subagentType: input.subagent_type } : {}),
					...(str(input.description) !== undefined ? { description: input.description } : {}),
					...(str(input.name) !== undefined ? { name: input.name } : {}),
				});
			}
			return started;
		}
		return next(e);
	});

	on('classic.PermissionRequest', async ($, e, next) => {
		// The settings hooks (Para Code's own notification among them) run first, as without this mod.
		const decided = await next(e);
		if (!active || decided.decision !== undefined || decided.block !== undefined || e.tool_name === 'AskUserQuestion') {
			return decided;
		}
		const sessionId = e.session_id;
		const toolUseId = takeAskedCall(e.tool_name, e.tool_input);
		const suggestions = Array.isArray(e.permission_suggestions) ? e.permission_suggestions : [];
		// denyMessage: this mod hands the refusal text Para Code sends back to Claude Code (older mods use a fixed one).
		const registered = await request($, 'permission', {
			sessionId, toolName: e.tool_name, toolInput: e.tool_input, suggestions, denyMessage: true,
			...(toolUseId !== undefined ? { toolUseId } : {}),
			...(e.agent_id !== undefined ? { agentId: e.agent_id } : {}),
		});
		const id = str(registered?.json?.id);
		if (registered?.status !== 200 || id === undefined || registered.json?.wait !== true) {
			return decided;
		}
		// The terminal's own permission prompt is up beside this wait. Whichever answers first wins:
		// an answer in the terminal starts the call (tool.call settles this wait) or writes its
		// refusal (Para Code settles it from the row).
		pendingPermissions.set(id, { toolUseId, toolName: e.tool_name });
		try {
			const reply = await waitFor($, sessionId, id, () => !pendingPermissions.has(id));
			if (reply?.state === 'answer' && reply.decision === 'allow') {
				return {
					...decided,
					decision: { behavior: 'allow', ...(reply.always === true && suggestions.length > 0 ? { updatedPermissions: suggestions } : {}) },
				};
			}
			if (reply?.state === 'answer' && reply.decision === 'deny') {
				// With an instruction from the phone, Para Code sends the same refusal the terminal's
				// "No, and tell Claude what to do differently" writes, so the model reads it as the user's.
				const message = str(reply.message);
				return { ...decided, decision: { behavior: 'deny', message: message !== undefined && message.length > 0 ? message : 'Denied from Para Code Mobile.' } };
			}
			return decided;
		} finally {
			pendingPermissions.delete(id);
		}
	});
};

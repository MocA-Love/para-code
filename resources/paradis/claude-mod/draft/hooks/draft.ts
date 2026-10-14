/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The prompt box's text for Para Code (the person's draft in the Claude Code prompt box).
//
// `prompt.edit` carries the typed edits and `prompt.change` (Claude Code 2.1.300) everything else: undo, a clear, a
// recalled history entry, the clear after a submit, a plugin's fill. Without `prompt.change` a submit is never seen, so
// the text would stay stale. Claude Code refuses to load a hooks module that names an event it does not know, so this
// lives in its own module: older Claude Code skips this file and keeps register.ts. Para Code treats the box as unknown
// until a `draft` event arrives, and then keeps everything else as before.
//
// Rules: the same as register.ts (only `next` and `$` are waited on; every failed request is dropped quietly).

import type { EngineInterface, Register } from 'claude-code';

type Engine = EngineInterface;
type Json = Record<string, unknown>;

const MOD_PROTOCOL = '1';
/** The box's text is sent at most this often (the last text of a burst is always sent). */
const DRAFT_FLUSH_MS = 150;
/** Longer text is sent cut and marked `truncated` (Para Code then does not put it back). */
const MAX_DRAFT_CHARS = 20_000;

interface IEndpoint {
	readonly url: string;
	readonly token: string;
}

let endpoint: IEndpoint | undefined;
/** Connected to an interactive session in a Para Code terminal. */
let active = false;
/** The box's text as the last `prompt.edit` / `prompt.change` left it; undefined until one came this session. */
let draft: string | undefined;
/** The text last sent to Para Code, and whether a send waits for {@link DRAFT_FLUSH_MS}. */
let draftSent: string | undefined;
let draftScheduled = false;
/** Counts the sessions, so a send scheduled before a new session.start is not sent for the new one. */
let generation = 0;

function rec(value: unknown): Json | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function curlQuote(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

async function resolveEndpoint($: Engine): Promise<IEndpoint | undefined> {
	const token = await $.env.get('PARA_CODE_TERMINAL_PANE_ID');
	const portFile = await $.env.get('PARA_CODE_MCP_PORT_FILE');
	if (token === undefined || token.length === 0 || portFile === undefined || portFile.length === 0) {
		return undefined;
	}
	let port: unknown;
	try {
		port = rec(JSON.parse(String(await $.fs.read(portFile))))?.port;
	} catch {
		return undefined;
	}
	if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
		return undefined;
	}
	return { url: `http://127.0.0.1:${port}/claude-mod/v1`, token };
}

/** Sends the events through `$.http.fetch`, or curl when the fetch is refused (the token and body go on stdin). */
async function post($: Engine, body: string): Promise<void> {
	// Para Code may have restarted on another port since the last send: read the port file again after a failure.
	for (let attempt = 0; attempt < 2; attempt++) {
		const target = endpoint ?? await resolveEndpoint($);
		if (target === undefined) {
			return;
		}
		endpoint = target;
		try {
			await $.http.fetch(`${target.url}/event`, {
				method: 'POST',
				headers: { 'authorization': `Bearer ${target.token}`, 'content-type': 'application/json', 'x-para-code-mod': MOD_PROTOCOL },
				body,
			});
			return;
		} catch {
			// fall through to curl
		}
		try {
			const config = [
				`url = ${curlQuote(`${target.url}/event`)}`,
				'request = "POST"',
				`header = ${curlQuote(`Authorization: Bearer ${target.token}`)}`,
				'header = "Content-Type: application/json"',
				`header = ${curlQuote(`X-Para-Code-Mod: ${MOD_PROTOCOL}`)}`,
				`data-binary = ${curlQuote(body)}`,
				'silent',
				'max-time = 10',
				'',
			].join('\n');
			const result = await $.process.run(['curl', '--config', '-'], { stdin: config, timeoutMs: 15_000 });
			if (result.exitCode === 0) {
				return;
			}
		} catch {
			// try the port file once more
		}
		endpoint = undefined;
	}
}

async function send($: Engine, mine: number): Promise<void> {
	if (!active || mine !== generation || draft === undefined || draft === draftSent) {
		return;
	}
	const text = draft;
	draftSent = text;
	const sessionId = await $.session.id();
	const event = { type: 'draft', text: text.slice(0, MAX_DRAFT_CHARS), ...(text.length > MAX_DRAFT_CHARS ? { truncated: true } : {}), at: Date.now() };
	await post($, JSON.stringify({ sessionId, events: [event] }));
}

/** The box changed: sends its text to Para Code, at most every {@link DRAFT_FLUSH_MS}. */
function noteDraft($: Engine, text: string): void {
	draft = text;
	if (!active || draftScheduled) {
		return;
	}
	draftScheduled = true;
	const mine = generation;
	$.clock.after(DRAFT_FLUSH_MS, () => {
		draftScheduled = false;
		void send($, mine).catch(() => undefined);
	});
}

export const register: Register = on => {
	on('session.start', async ($, e, next) => {
		const started = await next(e);
		generation++;
		// The box is unknown until it changes (a reload of this module may find text in it).
		draft = undefined;
		draftSent = undefined;
		draftScheduled = false;
		endpoint = e.isInteractive ? await resolveEndpoint($) : undefined;
		active = endpoint !== undefined;
		return started;
	});

	on('prompt.change', ($, e, next) => {
		if (active && typeof e.text === 'string') {
			noteDraft($, e.text);
		}
		return next(e);
	});

	on('prompt.edit', async ($, e, next) => {
		const edited = await next(e);
		if (active) {
			noteDraft($, typeof edited?.text === 'string' ? edited.text : `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`);
		}
		return edited;
	});
};

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IncomingMessage, ServerResponse } from 'http';
import { generateUuid } from '../../../../base/common/uuid.js';
import { paradisRedactToolInputSecrets } from '../common/paradisBrowserPageOps.js';
import type { IParadisOpenCodeMessage } from '../../sessionResume/node/paradisOpenCodeHistory.js';

export interface IParadisOpenCodeRegistration {
	readonly sessionId: string;
	readonly dbPath: string;
	readonly cwd: string;
	/** What resumes the session (`opencode`, or the absolute path of a verified compatible CLI). */
	readonly cli?: string;
	readonly pid?: number;
	readonly authority?: string;
}

export interface IParadisOpenCodeCommand {
	readonly name: string;
	readonly description: string;
	readonly argumentHint?: string;
	readonly source: 'built-in' | 'user' | 'plugin' | 'mcp';
}

type Operation = 'sendMessage' | 'answerPermission' | 'answerQuestion' | 'listCommands' | 'readMessages' | 'interrupt';
interface Request {
	readonly id: string;
	readonly sessionId: string;
	readonly operation: Operation;
	readonly input: Readonly<Record<string, unknown>>;
}
/** How a request ended: never handed to the frontend, handed over but no result came back, or answered. */
type Settlement = { readonly kind: 'unclaimed' } | { readonly kind: 'unanswered' } | { readonly kind: 'answered'; readonly ok: boolean; readonly value: unknown };

/**
 * The outcome of an action. `unknown` means the frontend took the request but its result did not arrive in time, so the
 * action may have run: callers keep their duplicate guards instead of letting it be sent again.
 */
export type ParadisOpenCodeActionOutcome = 'accepted' | 'rejected' | 'unknown';

const COMMAND_SOURCES: ReadonlySet<string> = new Set(['built-in', 'user', 'plugin', 'mcp']);
const MAX_ROW_TEXT = 256 * 1024;

function boundedString(value: unknown, limit: number): string | undefined {
	return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

/** Keep only the fields Para Code knows from a frontend history row; anything malformed is dropped. */
function parseMessageRow(value: unknown): IParadisOpenCodeMessage | undefined {
	const raw = value as Record<string, unknown> | null;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const id = boundedString(raw.id, 300);
	const text = boundedString(raw.text, MAX_ROW_TEXT);
	if (!id || text === undefined || (raw.role !== 'user' && raw.role !== 'assistant') || (raw.kind !== 'message' && raw.kind !== 'thinking' && raw.kind !== 'tool')) {
		return undefined;
	}
	const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : undefined;
	let tool: IParadisOpenCodeMessage['tool'];
	if (raw.kind === 'tool') {
		const value = raw.tool as Record<string, unknown> | null;
		const name = value !== null && typeof value === 'object' ? boundedString(value.name, 200) : undefined;
		if (!name) {
			return undefined;
		}
		// 入力は文字列でもオブジェクトでも受ける（オブジェクトは資格情報を伏せてから文字列にする）
		const rawInput = value!.input;
		const input = typeof rawInput === 'string' ? rawInput.slice(0, MAX_ROW_TEXT)
			: rawInput !== null && typeof rawInput === 'object' ? JSON.stringify(paradisRedactToolInputSecrets(name, rawInput)).slice(0, MAX_ROW_TEXT) : undefined;
		const output = boundedString(value!.output, MAX_ROW_TEXT);
		const status = boundedString(value!.status, 32);
		tool = { name, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), ...(status !== undefined ? { status } : {}) };
	}
	return { id, role: raw.role, kind: raw.kind, text, ...(tool !== undefined ? { tool } : {}), ...(ts !== undefined ? { ts } : {}) };
}

/** Keep only well-formed slash commands (a plain name, short texts and a known source). */
function parseCommand(value: unknown): IParadisOpenCodeCommand | undefined {
	const raw = value as Record<string, unknown> | null;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.name !== 'string' || !/^[\w.:@/-]{1,100}$/.test(raw.name)
		|| typeof raw.source !== 'string' || !COMMAND_SOURCES.has(raw.source)) {
		return undefined;
	}
	const argumentHint = boundedString(raw.argumentHint, 200);
	return { name: raw.name, description: boundedString(raw.description, 500) ?? '', ...(argumentHint !== undefined ? { argumentHint } : {}), source: raw.source as IParadisOpenCodeCommand['source'] };
}

interface Pending {
	readonly request: Request;
	readonly resolve: (value: Settlement) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	polled: boolean;
}
interface Owner {
	registration: IParadisOpenCodeRegistration;
	readonly pending: Map<string, Pending>;
	/** The last positive process-ownership verdict for this exact registration (the gateway's cache). */
	verdict?: { readonly key: string; readonly at: number };
}

/** The authenticated pane's frontend owns API credentials and executes these bounded requests. */
export class ParadisOpenCodeBridge {
	private readonly owners = new Map<string, Owner>();

	register(token: string, registration: IParadisOpenCodeRegistration): void {
		const previous = this.owners.get(token);
		if (previous && previous.registration.sessionId === registration.sessionId && previous.registration.dbPath === registration.dbPath && previous.registration.pid === registration.pid && previous.registration.authority === registration.authority && previous.registration.cli === registration.cli) {
			previous.registration = { ...registration };
			previous.verdict = undefined;
			return;
		}
		this.unregister(token);
		this.owners.set(token, { registration: { ...registration }, pending: new Map() });
	}

	unregister(token: string): void {
		const owner = this.owners.get(token);
		if (!owner) {
			return;
		}
		this.owners.delete(token);
		for (const item of owner.pending.values()) {
			clearTimeout(item.timer);
			item.resolve(item.polled ? { kind: 'unanswered' } : { kind: 'unclaimed' });
		}
		owner.pending.clear();
	}

	getRegistration(token: string): IParadisOpenCodeRegistration | undefined {
		return this.owners.get(token)?.registration;
	}

	/** Whether a positive ownership verdict for this exact registration and identity key was recorded at or after `since`. */
	hasOwnerVerdict(token: string, registration: IParadisOpenCodeRegistration, key: string, since: number): boolean {
		const owner = this.owners.get(token);
		return owner?.registration === registration && owner.verdict?.key === key && owner.verdict.at >= since;
	}

	setOwnerVerdict(token: string, registration: IParadisOpenCodeRegistration, verdict: { readonly key: string; readonly at: number } | undefined): void {
		const owner = this.owners.get(token);
		if (owner?.registration === registration) {
			owner.verdict = verdict;
		}
	}

	hasSession(token: string, sessionId: string): boolean {
		return this.owners.get(token)?.registration.sessionId === sessionId;
	}

	databasePath(token: string, sessionId: string): string | undefined {
		return this.hasSession(token, sessionId) ? this.owners.get(token)?.registration.dbPath : undefined;
	}

	private request(token: string, sessionId: string, operation: Operation, input: Readonly<Record<string, unknown>> = {}): Promise<Settlement> {
		const owner = this.owners.get(token);
		if (!owner || owner.registration.sessionId !== sessionId || owner.pending.size >= 32) {
			return Promise.resolve({ kind: 'unclaimed' });
		}
		return new Promise(resolve => {
			const id = generateUuid();
			const timer = setTimeout(() => {
				const item = owner.pending.get(id);
				owner.pending.delete(id);
				resolve(item?.polled === true ? { kind: 'unanswered' } : { kind: 'unclaimed' });
			}, 15_000);
			owner.pending.set(id, { request: { id, sessionId, operation, input }, resolve, timer, polled: false });
		});
	}

	private async action(token: string, sessionId: string, operation: Operation, input?: Readonly<Record<string, unknown>>): Promise<ParadisOpenCodeActionOutcome> {
		const settlement = await this.request(token, sessionId, operation, input);
		return settlement.kind === 'unanswered' ? 'unknown' : settlement.kind === 'answered' && settlement.ok && settlement.value === true ? 'accepted' : 'rejected';
	}

	sendMessage(token: string, sessionId: string, text: string): Promise<ParadisOpenCodeActionOutcome> {
		return this.action(token, sessionId, 'sendMessage', { text });
	}

	interrupt(token: string, sessionId: string): Promise<ParadisOpenCodeActionOutcome> {
		return this.action(token, sessionId, 'interrupt');
	}

	answerPermission(token: string, sessionId: string, requestId: string, response: 'once' | 'always' | 'reject'): Promise<ParadisOpenCodeActionOutcome> {
		return this.action(token, sessionId, 'answerPermission', { requestId, response });
	}

	answerQuestion(token: string, sessionId: string, requestId: string, answers: readonly (readonly string[])[]): Promise<ParadisOpenCodeActionOutcome> {
		return this.action(token, sessionId, 'answerQuestion', { requestId, answers });
	}

	async listCommands(token: string, sessionId: string): Promise<readonly IParadisOpenCodeCommand[]> {
		const settlement = await this.request(token, sessionId, 'listCommands');
		const value = settlement.kind === 'answered' && settlement.ok ? settlement.value : undefined;
		return Array.isArray(value) ? value.slice(0, 500).map(parseCommand).filter((command): command is IParadisOpenCodeCommand => command !== undefined) : [];
	}

	async readMessages(token: string, sessionId: string): Promise<readonly IParadisOpenCodeMessage[]> {
		const settlement = await this.request(token, sessionId, 'readMessages');
		const value = settlement.kind === 'answered' && settlement.ok ? settlement.value : undefined;
		if (!Array.isArray(value)) {
			throw new Error('OpenCode frontend is unavailable');
		}
		return value.slice(-400).map(parseMessageRow).filter((row): row is IParadisOpenCodeMessage => row !== undefined);
	}

	/** Only the service's validated pane/PID/session ingress may call this handler. */
	async handleHttp(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		const owner = this.owners.get(token);
		if (!owner || req.method !== 'POST') {
			reply(403, { error: 'No active OpenCode frontend' });
			return;
		}
		let size = 0;
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += data.length;
			if (size > 2 * 1024 * 1024) {
				reply(413, { error: 'OpenCode response too large' });
				return;
			}
			chunks.push(data);
		}
		let body: { id?: unknown; sessionId?: unknown; session_id?: unknown; ok?: unknown; value?: unknown };
		try {
			body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
		} catch {
			reply(400, { error: 'Invalid OpenCode bridge request' });
			return;
		}
		// The session is named `session_id` (the hook form); `sessionId` is accepted too. Both checks below use the same value.
		const bodySession = body && typeof body === 'object' ? (body.session_id ?? body.sessionId) : undefined;
		const conflicting = body && typeof body === 'object' && body.session_id !== undefined && body.sessionId !== undefined && body.session_id !== body.sessionId;
		if (!body || typeof body !== 'object' || conflicting || bodySession !== owner.registration.sessionId || this.owners.get(token) !== owner) {
			reply(409, { error: 'OpenCode session changed' });
			return;
		}
		const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
		if (pathname.endsWith('/poll')) {
			const requests = [...owner.pending.values()].filter(item => !item.polled);
			for (const item of requests) {
				item.polled = true;
			}
			reply(200, { requests: requests.map(item => item.request) });
			return;
		}
		if (pathname.endsWith('/result') && typeof body.id === 'string') {
			const pending = owner.pending.get(body.id);
			if (!pending || !pending.polled || pending.request.sessionId !== bodySession) {
				reply(409, { error: 'Unknown or expired OpenCode request' });
				return;
			}
			owner.pending.delete(body.id);
			clearTimeout(pending.timer);
			pending.resolve({ kind: 'answered', ok: body.ok === true, value: body.value });
			reply(200, { ok: true });
			return;
		}
		reply(404, { error: 'Unknown OpenCode bridge operation' });
	}
}

export const paradisOpenCodeBridge = new ParadisOpenCodeBridge();

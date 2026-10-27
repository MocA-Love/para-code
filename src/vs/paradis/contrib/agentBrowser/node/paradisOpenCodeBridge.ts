/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { IncomingMessage, ServerResponse } from 'http';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IParadisOpenCodeMessage } from '../../sessionResume/node/paradisOpenCodeHistory.js';

export interface IParadisOpenCodeRegistration {
	readonly sessionId: string;
	readonly dbPath: string;
	readonly cwd: string;
	/** The command that resumes the session (`opencode`, or the command a compatible CLI declared). */
	readonly cli: string;
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
interface Pending {
	readonly request: Request;
	readonly resolve: (value: unknown) => void;
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
			item.resolve(undefined);
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

	private request(token: string, sessionId: string, operation: Operation, input: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
		const owner = this.owners.get(token);
		if (!owner || owner.registration.sessionId !== sessionId || owner.pending.size >= 32) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => {
			const id = generateUuid();
			const timer = setTimeout(() => {
				owner.pending.delete(id);
				resolve(undefined);
			}, 15_000);
			owner.pending.set(id, { request: { id, sessionId, operation, input }, resolve, timer, polled: false });
		});
	}

	async sendMessage(token: string, sessionId: string, text: string): Promise<boolean> {
		return await this.request(token, sessionId, 'sendMessage', { text }) === true;
	}

	async interrupt(token: string, sessionId: string): Promise<boolean> {
		return await this.request(token, sessionId, 'interrupt') === true;
	}

	async answerPermission(token: string, sessionId: string, requestId: string, response: 'once' | 'always' | 'reject'): Promise<boolean> {
		return await this.request(token, sessionId, 'answerPermission', { requestId, response }) === true;
	}

	async answerQuestion(token: string, sessionId: string, requestId: string, answers: readonly (readonly string[])[]): Promise<boolean> {
		return await this.request(token, sessionId, 'answerQuestion', { requestId, answers }) === true;
	}

	async listCommands(token: string, sessionId: string): Promise<readonly IParadisOpenCodeCommand[]> {
		const result = await this.request(token, sessionId, 'listCommands');
		return Array.isArray(result) ? result : [];
	}

	async readMessages(token: string, sessionId: string): Promise<readonly IParadisOpenCodeMessage[]> {
		const result = await this.request(token, sessionId, 'readMessages');
		if (!Array.isArray(result)) {
			throw new Error('OpenCode frontend is unavailable');
		}
		return result;
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
		if (!body || typeof body !== 'object' || (body.sessionId ?? body.session_id) !== owner.registration.sessionId || this.owners.get(token) !== owner) {
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
			if (!pending || !pending.polled || pending.request.sessionId !== body.sessionId) {
				reply(409, { error: 'Unknown or expired OpenCode request' });
				return;
			}
			owner.pending.delete(body.id);
			clearTimeout(pending.timer);
			pending.resolve(body.ok === true ? body.value : undefined);
			reply(200, { ok: true });
			return;
		}
		reply(404, { error: 'Unknown OpenCode bridge operation' });
	}
}

export const paradisOpenCodeBridge = new ParadisOpenCodeBridge();

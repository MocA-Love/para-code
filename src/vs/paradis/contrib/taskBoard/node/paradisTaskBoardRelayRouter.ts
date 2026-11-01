/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボードの SSH 中継の振り分け（shared process。設計書 G3・G8）。
//
//  - 中継のセッションは SSH の窓が作って登録する。セッションはその窓（ctx）と、そのボードの鍵に結び付く
//  - ボードからの `/v1/relay` は、セッションを作った窓だけへ送る。宛先の窓・接続先・リポジトリは登録から決め、
//    依頼に書かれた値では選ばない。鍵の違うボードからは使えない
//  - 窓が閉じたら（接続が切れたら）そのセッションを捨てる。REH の側も心拍が途絶えれば閉じる
//  - 通した依頼も断った依頼も、監査ログに 1 行ずつ残す（出力・中身は残さない）

import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisTaskBoardResult, paradisTaskBoardHttpStatus } from '../common/paradisTaskBoardBridge.js';
import {
	IParadisTaskBoardAuditEntry,
	PARADIS_TASK_BOARD_RELAY_TIMEOUT_MS,
	paradisParseTaskBoardRelaySessionRegistration,
	paradisTaskBoardIsRelaySessionId,
	paradisTaskBoardRelayOperationName,
} from '../common/paradisTaskBoardRelay.js';
import { paradisTaskBoardKeyHash } from './paradisTaskBoardBoardAuth.js';
import { IParadisTaskBoardHttpResponse, IParadisTaskBoardWindowRouter } from './paradisTaskBoardBridgeService.js';

interface IRelaySession {
	readonly ctx: string;
	readonly keyHash: string;
	readonly authority: string | undefined;
	readonly repository: string | undefined;
}

/** 断った依頼を監査ログに残す、1 分あたりの行数（鍵の無い相手が叩き続けてもログを膨らませない）。超えた分は数だけ残す。 */
const MAX_DENIED_LINES_PER_MINUTE = 60;

/** 1 つのウィンドウが持てるセッションの数（ボードのホストは 1 つのボードしか持たない。開き直しの重なりの分）。 */
const MAX_SESSIONS_PER_WINDOW = 4;

export interface IParadisTaskBoardAuditSink {
	append(entry: Omit<IParadisTaskBoardAuditEntry, 'time'>): unknown;
}

function shortText(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

export class ParadisTaskBoardRelayRouter {

	private readonly sessions = new Map<string, IRelaySession>();
	private deniedMinute = -1;
	private deniedLines = 0;
	private deniedSuppressed = 0;

	constructor(
		private readonly router: IParadisTaskBoardWindowRouter,
		private readonly audit: IParadisTaskBoardAuditSink,
		private readonly logService: ILogService,
		private readonly now: () => number = Date.now,
	) { }

	/** 窓（ctx）からセッションを登録する。ほかの窓のセッションの ID は上書きさせない。 */
	register(ctx: string, arg: unknown): boolean {
		const registration = paradisParseTaskBoardRelaySessionRegistration(arg);
		if (!registration) {
			return false;
		}
		const existing = this.sessions.get(registration.sessionId);
		if (existing && existing.ctx !== ctx) {
			return false;
		}
		if (!existing && [...this.sessions.values()].filter(session => session.ctx === ctx).length >= MAX_SESSIONS_PER_WINDOW) {
			return false;
		}
		const record = arg as { authority?: unknown; repository?: unknown };
		this.sessions.set(registration.sessionId, {
			ctx,
			keyHash: paradisTaskBoardKeyHash(registration.boardKey),
			authority: shortText(record.authority, 512),
			repository: shortText(record.repository, 4096),
		});
		return true;
	}

	close(ctx: string, sessionId: unknown): void {
		if (paradisTaskBoardIsRelaySessionId(sessionId) && this.sessions.get(sessionId)?.ctx === ctx) {
			this.sessions.delete(sessionId);
		}
	}

	onWindowDisconnected(ctx: string): void {
		for (const [sessionId, session] of this.sessions) {
			if (session.ctx === ctx) {
				this.sessions.delete(sessionId);
			}
		}
	}

	/** 接続口が鍵と pid を確かめた後の `/v1/relay`。`keyHash` は確かめたボードの鍵。 */
	async handle(body: unknown, keyHash: string): Promise<IParadisTaskBoardHttpResponse> {
		const started = this.now();
		const operation = paradisTaskBoardRelayOperationName(body);
		const sessionId = body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined;
		const session = paradisTaskBoardIsRelaySessionId(sessionId) ? this.sessions.get(sessionId) : undefined;
		const base = { operation, initiator: 'board' as const, ...(session && paradisTaskBoardIsRelaySessionId(sessionId) ? { sessionId, authority: session.authority, repository: session.repository } : {}) };
		if (!session || session.keyHash !== keyHash) {
			this.appendDenied({ ...base, outcome: 'denied', reason: session ? 'session-of-another-board' : 'unknown-session' });
			return { status: 404, body: { error: 'not-found', message: 'The relay session is not open.' } };
		}
		let result: ParadisTaskBoardResult<unknown>;
		try {
			result = await this.router.call<ParadisTaskBoardResult<unknown>>(session.ctx, 'relay', body, PARADIS_TASK_BOARD_RELAY_TIMEOUT_MS);
		} catch (error) {
			this.logService.warn('[ParadisTaskBoardRelay] the window did not answer', String(error));
			this.audit.append({ ...base, outcome: 'failed', reason: 'window-unavailable', durationMs: this.now() - started });
			return { status: 503, body: { error: 'unavailable', message: 'The SSH window did not answer.' } };
		}
		if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
			this.audit.append({ ...base, outcome: 'failed', reason: 'bad-window-answer', durationMs: this.now() - started });
			return { status: 500, body: { error: 'failed' } };
		}
		if (!result.ok) {
			const entry = { ...base, outcome: result.code === 'failed' || result.code === 'unavailable' ? 'failed' as const : 'denied' as const, reason: result.code, durationMs: this.now() - started };
			if (entry.outcome === 'denied') {
				this.appendDenied(entry);
			} else {
				this.audit.append(entry);
			}
			return { status: paradisTaskBoardHttpStatus(result.code), body: { error: result.code, message: result.message } };
		}
		const value = result.value as { code?: unknown; detail?: unknown } | undefined;
		this.audit.append({
			...base, outcome: 'allowed', durationMs: this.now() - started,
			...(typeof value?.code === 'number' ? { code: value.code } : {}),
			...(typeof value?.detail === 'string' ? { detail: value.detail.slice(0, 512) } : {}),
		});
		return { status: 200, body: { ok: true, value: result.value } };
	}

	/** 接続口が鍵と pid で断った `/v1/relay` を残す（本文は読まずに断るので、操作の名前は分からない）。 */
	denied(reason: string): void {
		this.appendDenied({ operation: 'relay', initiator: 'board', outcome: 'denied', reason });
	}

	/** 断った依頼を、1 分あたり {@link MAX_DENIED_LINES_PER_MINUTE} 行まで残す。超えた分は次の分の初めに数だけ残す。 */
	private appendDenied(entry: Omit<IParadisTaskBoardAuditEntry, 'time'>): void {
		const minute = Math.floor(this.now() / 60_000);
		if (minute !== this.deniedMinute) {
			if (this.deniedSuppressed > 0) {
				this.audit.append({ operation: 'relay', initiator: 'board', outcome: 'denied', reason: 'suppressed', detail: `${this.deniedSuppressed} more denied requests were not logged` });
			}
			this.deniedMinute = minute;
			this.deniedLines = 0;
			this.deniedSuppressed = 0;
		}
		if (this.deniedLines >= MAX_DENIED_LINES_PER_MINUTE) {
			this.deniedSuppressed++;
			return;
		}
		this.deniedLines++;
		this.audit.append(entry);
	}
}

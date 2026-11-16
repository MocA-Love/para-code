/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の、Antigravity CLI の許可の待ちの帳簿（paradisAntigravityApproval.ts の hook のスクリプトが使う）。
//
// スクリプトは PreToolUse ごとに `register` で待ってよいかを聞き、待つなら許可の hook（PermissionRequest）を
// 今の hook の受け口へ流してカードを出させてから、`wait` の長いポーリングで答えを待つ。カードの答え（モバイル・
// PC のチャット）は ParadisMobileAgentChat が {@link ParadisAntigravityApprovalHold.answer} で返す。
// Claude Code の mod の承認の待ち（paradisClaudeModBridge.ts）と同じ考え方で、shared process 内のモジュールシングルトン
// にして ParadisAgentBrowserService と ParadisMobileRelayService を疎結合につなぐ。
//
// 待つのは次のすべてを満たすときだけ（どれかが外れたら待たずに返し、agy の TUI の許可の画面に任せる）:
//  - モバイルのアプリが今リレーに繋がっている（{@link ParadisAntigravityApprovalHold.setPresence}）
//  - そのペインの本会話で、モバイルがそのペインを見ていて、質問の回答待ちではない（{@link ParadisAntigravityApprovalHold.setGate}）
//  - 許可を求めうるツール（PARADIS_ANTIGRAVITY_APPROVAL_TOOLS）
// 待つ間に、上限（PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS）・モバイルの切断（30 秒の猶予）・スクリプトの切断で、答えずに終える。

import { randomBytes } from 'crypto';
import { PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS, PARADIS_ANTIGRAVITY_APPROVAL_TOOLS } from '../common/paradisAntigravityApproval.js';

/** カードの答え。 */
export type ParadisAntigravityApprovalDecision = 'allow' | 'deny';

/** 待ちを登録してから、`wait` が来るまでの猶予（スクリプトは登録の直後に許可の hook を流してから来る）。 */
const ATTACH_GRACE_MS = 15_000;
/** モバイルの接続が切れてから、待ちを打ち切るまでの猶予（一時的な切断は待つ）。 */
const PRESENCE_GRACE_MS = 30_000;
const SWEEP_MS = 5_000;
const MAX_PENDING_PER_TOKEN = 8;
const MAX_PENDING = 64;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const FIELD_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

interface IHoldEntry {
	readonly id: string;
	readonly token: string;
	readonly sessionId: string;
	readonly toolUseId: string;
	readonly registeredAt: number;
	readonly expiresAt: number;
	outcome?: ParadisAntigravityApprovalDecision | 'none';
	waiter?: (outcome: ParadisAntigravityApprovalDecision | undefined) => void;
	presenceLostAt?: number;
}

/** 待ってよいかの判定（ParadisMobileAgentChat が持つ。ペインの本会話か・モバイルが見ているか・質問中ではないか）。 */
export type ParadisAntigravityApprovalGate = (token: string, sessionId: string) => boolean;

export interface IParadisAntigravityApprovalHoldOptions {
	readonly now?: () => number;
	readonly newId?: () => string;
	/** 掃除の時計を回さない（テスト）。掃除は {@link ParadisAntigravityApprovalHold.sweep} を直接呼ぶ。 */
	readonly manualSweep?: boolean;
}

export class ParadisAntigravityApprovalHold {
	private readonly entries = new Map<string, IHoldEntry>();
	private presence: () => boolean = () => false;
	private gate: ParadisAntigravityApprovalGate = () => false;
	private sweepTimer: ReturnType<typeof setInterval> | undefined;
	private readonly now: () => number;
	private readonly newId: () => string;
	private readonly manualSweep: boolean;

	constructor(options: IParadisAntigravityApprovalHoldOptions = {}) {
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? (() => randomBytes(16).toString('hex'));
		this.manualSweep = options.manualSweep === true;
	}

	/** モバイルのアプリが今リレーに繋がっているか。 */
	setPresence(presence: () => boolean): void {
		this.presence = presence;
	}

	setGate(gate: ParadisAntigravityApprovalGate): void {
		this.gate = gate;
	}

	/**
	 * 待ちを登録する。待つなら待ちの ID、待たないなら undefined（スクリプトは何も書かずに終わり、agy の判定に任せる）。
	 * 同じ呼び出し（`toolUseId`）の待ちが既にあれば、新しく待たない。
	 */
	register(token: string, request: { readonly sessionId: string | undefined; readonly toolUseId: string | undefined; readonly toolName: string | undefined }): string | undefined {
		const { sessionId, toolUseId, toolName } = request;
		if (sessionId === undefined || toolUseId === undefined || toolName === undefined
			|| !FIELD_PATTERN.test(sessionId) || !FIELD_PATTERN.test(toolUseId) || !PARADIS_ANTIGRAVITY_APPROVAL_TOOLS.includes(toolName)) {
			return undefined;
		}
		const open = [...this.entries.values()].filter(entry => entry.outcome === undefined);
		if (open.length >= MAX_PENDING || open.filter(entry => entry.token === token).length >= MAX_PENDING_PER_TOKEN
			|| open.some(entry => entry.token === token && entry.toolUseId === toolUseId)) {
			return undefined;
		}
		if (!this.presence() || !this.gate(token, sessionId)) {
			return undefined;
		}
		const id = this.newId();
		const now = this.now();
		this.entries.set(id, { id, token, sessionId, toolUseId, registeredAt: now, expiresAt: now + PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS });
		this.ensureSweep();
		return id;
	}

	/**
	 * 答えを待つ。答え（allow / deny）か、答えずに終えたら undefined。`signal` が切れたら（スクリプトが打ち切った・agy が
	 * hook を止めた）待ちを外す。
	 */
	wait(token: string, id: string, signal?: AbortSignal): Promise<ParadisAntigravityApprovalDecision | undefined> {
		const entry = ID_PATTERN.test(id) ? this.entries.get(id) : undefined;
		if (entry === undefined || entry.token !== token || entry.waiter !== undefined) {
			return Promise.resolve(undefined);
		}
		if (entry.outcome !== undefined) {
			this.entries.delete(id);
			return Promise.resolve(entry.outcome === 'none' ? undefined : entry.outcome);
		}
		return new Promise(resolve => {
			const onAbort = () => this.finish(entry, 'none');
			entry.waiter = outcome => {
				signal?.removeEventListener('abort', onAbort);
				resolve(outcome);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	/** カードの答えを返す。そのペインのその呼び出しを待っていれば true（待っていなければ何もしない）。 */
	answer(token: string, toolUseId: string, decision: ParadisAntigravityApprovalDecision): boolean {
		const entry = this.findOpen(token, toolUseId);
		if (entry === undefined) {
			return false;
		}
		this.finish(entry, decision);
		return true;
	}

	/** そのペインのその呼び出しを、まだ答えを待っているか。 */
	isWaiting(token: string, toolUseId: string): boolean {
		return this.findOpen(token, toolUseId) !== undefined;
	}

	/** 上限・切断・`wait` の来ない待ちを終える（時計から呼ぶ。テストからも呼ぶ）。 */
	sweep(): void {
		const now = this.now();
		const present = this.presence();
		for (const entry of [...this.entries.values()]) {
			if (entry.outcome !== undefined) {
				// 答えたのに `wait` が来ない（スクリプトが先に終わった）
				if (now - entry.registeredAt > PARADIS_ANTIGRAVITY_APPROVAL_HOLD_MS + ATTACH_GRACE_MS) {
					this.entries.delete(entry.id);
				}
				continue;
			}
			if (!present) {
				entry.presenceLostAt ??= now;
			} else {
				entry.presenceLostAt = undefined;
			}
			if (now >= entry.expiresAt || (entry.waiter === undefined && now - entry.registeredAt > ATTACH_GRACE_MS)
				|| (entry.presenceLostAt !== undefined && now - entry.presenceLostAt >= PRESENCE_GRACE_MS)) {
				this.finish(entry, 'none');
			}
		}
		if (this.entries.size === 0) {
			this.stopSweep();
		}
	}

	dispose(): void {
		this.stopSweep();
		for (const entry of [...this.entries.values()]) {
			if (entry.outcome === undefined) {
				this.finish(entry, 'none');
			}
		}
		this.entries.clear();
	}

	private findOpen(token: string, toolUseId: string): IHoldEntry | undefined {
		return [...this.entries.values()].find(entry => entry.token === token && entry.toolUseId === toolUseId && entry.outcome === undefined);
	}

	private finish(entry: IHoldEntry, outcome: ParadisAntigravityApprovalDecision | 'none'): void {
		if (entry.outcome !== undefined) {
			return;
		}
		entry.outcome = outcome;
		const waiter = entry.waiter;
		if (waiter !== undefined) {
			this.entries.delete(entry.id);
			waiter(outcome === 'none' ? undefined : outcome);
		}
	}

	private ensureSweep(): void {
		if (this.manualSweep || this.sweepTimer !== undefined) {
			return;
		}
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
		(this.sweepTimer as { unref?: () => void }).unref?.();
	}

	private stopSweep(): void {
		if (this.sweepTimer !== undefined) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}
}

/** shared process に 1 つだけの帳簿。 */
export const paradisAntigravityApprovalHold = new ParadisAntigravityApprovalHold();

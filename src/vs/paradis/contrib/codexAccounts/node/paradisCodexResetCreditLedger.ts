/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT): src/main/codex-accounts/codex-reset-credit-ledger.ts

// リセットクレジットの消費を1回に限るための台帳（shared process に1つ）。
//
// 守りたいこと:
//  1. 同じ提示（アカウント × 確認ダイアログで見せた残数）に対して provider へ出す消費要求は1つだけ。
//     連打・複数ウィンドウからの同時操作でも2回目は出さない（claimedKeyForOffer）。
//  2. provider へ要求を出した後にプロセスが落ちて結果が分からなくなっても、次の操作は
//     **同じ idempotencyKey の再送** になる（pendingKeyForAccount）。app-server の消費は
//     idempotencyKey ごとに1回しか効かないので、再送しても2枚目は減らない。
//  3. 台帳が読めない・書けないときは消費しない（fail closed）。
//
// 永続化は「provider へ出す前に providerPending を書く」「結果を受けたら settled を書く」の2回。
// 書き込みは一時ファイル＋rename で、途中で落ちても壊れた JSON を残さない。

import * as fs from 'fs';
import { dirname } from '../../../../base/common/path.js';
import { ParadisCodexResetOutcome, paradisCodexResetOutcome } from '../common/paradisCodexAccounts.js';

/** settled の記録を残す期間。これより古い記録は次の書き込みで捨てる。 */
const SETTLED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type DurableAttemptState = 'providerPending' | 'settled';

interface IDurableAttempt {
	readonly key: string;
	/** ホーム × アカウント × 提示。同じ提示への2回目の要求を断るのに使う。 */
	readonly offerScope: string;
	/** ホーム × アカウント。結果不明の要求の再送先を探すのに使う。 */
	readonly accountScope: string;
	readonly state: DurableAttemptState;
	readonly outcome?: ParadisCodexResetOutcome;
	readonly updatedAt: number;
}

interface IDurableLedger {
	readonly version: 1;
	readonly attempts: readonly IDurableAttempt[];
}

export interface IParadisCodexResetAttempt {
	readonly key: string;
	readonly offerScope: string;
	readonly accountScope: string;
	readonly state: DurableAttemptState;
	readonly outcome?: ParadisCodexResetOutcome;
}

function isDurableAttempt(value: unknown): value is IDurableAttempt {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const attempt = value as Partial<IDurableAttempt>;
	return typeof attempt.key === 'string' && attempt.key.length > 0
		&& typeof attempt.offerScope === 'string'
		&& typeof attempt.accountScope === 'string'
		&& (attempt.state === 'providerPending' || (attempt.state === 'settled' && paradisCodexResetOutcome(attempt.outcome) !== undefined))
		&& typeof attempt.updatedAt === 'number';
}

export class ParadisCodexResetCreditLedger {

	private attempts = new Map<string, IDurableAttempt>();
	private loadPromise: Promise<void> | undefined;
	private stateError: Error | undefined;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly now: () => number = Date.now,
	) { }

	/** 台帳が使えないときの理由。使えるなら undefined。 */
	get error(): Error | undefined {
		return this.stateError;
	}

	/** 初回だけファイルを読む。何度呼んでもよい。 */
	load(): Promise<void> {
		if (!this.loadPromise) {
			this.loadPromise = this.doLoad();
		}
		return this.loadPromise;
	}

	private async doLoad(): Promise<void> {
		let text: string;
		try {
			text = await fs.promises.readFile(this.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return;
			}
			this.stateError = new Error('Codex reset-credit ledger is unreadable');
			return;
		}
		try {
			const parsed = JSON.parse(text) as Partial<IDurableLedger>;
			if (parsed.version !== 1 || !Array.isArray(parsed.attempts) || !parsed.attempts.every(isDurableAttempt)) {
				throw new Error('invalid ledger');
			}
			for (const attempt of parsed.attempts) {
				this.attempts.set(attempt.key, attempt);
			}
		} catch {
			// 壊れた台帳を黙って空として扱うと、結果不明の要求を忘れて別の鍵で出し直しうる。
			// ファイルは消さずに残し、消費だけを止める。
			this.stateError = new Error('Codex reset-credit ledger is corrupt');
		}
	}

	get(key: string): IParadisCodexResetAttempt | undefined {
		return this.attempts.get(key);
	}

	/** この提示に対して既に要求を出した（出している）鍵。 */
	claimedKeyForOffer(offerScope: string): string | undefined {
		for (const attempt of this.attempts.values()) {
			if (attempt.offerScope === offerScope) {
				return attempt.key;
			}
		}
		return undefined;
	}

	/** このアカウントで結果が分かっていない要求の鍵。 */
	pendingKeyForAccount(accountScope: string): string | undefined {
		for (const attempt of this.attempts.values()) {
			if (attempt.accountScope === accountScope && attempt.state === 'providerPending') {
				return attempt.key;
			}
		}
		return undefined;
	}

	/** provider へ要求を出す直前に呼ぶ。書けなければ例外（呼び出し側は要求を出さない）。 */
	markProviderPending(key: string, offerScope: string, accountScope: string): Promise<void> {
		return this.update({ key, offerScope, accountScope, state: 'providerPending', updatedAt: this.now() });
	}

	/** provider から結果を受けたら呼ぶ。 */
	markSettled(key: string, outcome: ParadisCodexResetOutcome): Promise<void> {
		const existing = this.attempts.get(key);
		if (!existing) {
			return Promise.reject(new Error('unknown reset-credit attempt'));
		}
		return this.update({ ...existing, state: 'settled', outcome, updatedAt: this.now() });
	}

	private update(next: IDurableAttempt): Promise<void> {
		const run = this.writeQueue.then(async () => {
			if (this.stateError) {
				throw this.stateError;
			}
			const attempts = new Map(this.attempts);
			attempts.set(next.key, next);
			const cutoff = this.now() - SETTLED_RETENTION_MS;
			for (const [key, attempt] of attempts) {
				if (attempt.state === 'settled' && attempt.updatedAt < cutoff) {
					attempts.delete(key);
				}
			}
			const payload: IDurableLedger = { version: 1, attempts: [...attempts.values()] };
			await this.writeAtomically(JSON.stringify(payload));
			// ファイルへ書けてから手元の状態を進める（書けなかった要求は無かったことにする）。
			this.attempts = attempts;
		});
		this.writeQueue = run.catch(() => { });
		return run;
	}

	private async writeAtomically(content: string): Promise<void> {
		await fs.promises.mkdir(dirname(this.filePath), { recursive: true });
		const temporaryPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
		try {
			await fs.promises.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
			await fs.promises.rename(temporaryPath, this.filePath);
		} catch (error) {
			await fs.promises.rm(temporaryPath, { force: true }).catch(() => { });
			throw error;
		}
	}
}

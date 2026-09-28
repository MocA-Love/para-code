/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 片付いた通知を、次に届くプッシュでロック画面から消してもらう（W2-27、Q119 A）。
//
// PC で確認済みにした・別のスマホで開いた通知は、オンラインのスマホにしか知らせていない
// （`dismissed` / `dismissed-token`）。裏にいるスマホのロック画面には、アプリを開くまで残る。
// サイレントプッシュ（リレーの変更とネイティブ部品の追加が要り、iOS が間引く）の代わりに、
// 次に送る通常のプッシュの暗号文へ「もう消してよい通知」の印を入れ、通知拡張（NSE）が届いた時点で消す。
// 次の通知が来るまでは消えないが、リレーの変更は要らない。
//
// **消してよいのは PC が片付いたと知っているものだけ:**
// - スマホがその通知を開いた・消した（`dismiss`。通知 ID で1件）
// - PC がそのエージェントのペインを確認済みにした、またはターミナルが終わった（`onDidAcknowledgePane`。
//   エージェントのトークンで、確認した時刻より前に出した通知だけ）。確認済みになるのは完了（review）を
//   見たときと、ペインが終わったときだけなので、その前に出た許可・質問はもう答えが済んでいる。
//   確認より後に出た許可・質問は対象にしない（未回答のものを消さない）。
// 状態（working など）からは推測しない（hook が来ないと状態が残り、未回答でも消してしまう）。

/** 1回のプッシュに載せる印の数の上限（APNs の 4KB に収めるため）。 */
export const PARADIS_NOTIFY_DISMISS_MAX_IDS = 10;
/** これより前に片付いたものは載せない（ロック画面に1日以上残っているものは、アプリを開いたときの突き合わせに任せる）。 */
export const PARADIS_NOTIFY_DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
/** 覚えておく通知の数（出した通知・片付いた通知の合計）。 */
const LEDGER_LIMIT = 200;

interface IEmitted {
	readonly id: string;
	readonly agentToken: string | undefined;
	readonly at: number;
	handledAt: number | undefined;
}

export class ParadisNotifyDismissLedger {

	/** 出した順（古い順）。 */
	private readonly entries: IEmitted[] = [];

	/** 通知を出した（プッシュ・フレームのどちらでも）。 */
	record(id: string, agentToken: string | undefined, at: number): void {
		if (this.entries.some(entry => entry.id === id)) {
			return;
		}
		this.entries.push({ id, agentToken, at, handledAt: undefined });
		this.trim();
	}

	/** スマホがその通知を開いた・消した。この PC が出したと覚えていない通知（再起動前など）も対象にする。 */
	markDismissed(id: string, at: number): void {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (entry !== undefined) {
			entry.handledAt ??= at;
			return;
		}
		this.entries.push({ id, agentToken: undefined, at, handledAt: at });
		this.trim();
	}

	/** PC がそのエージェントのペインを確認済みにした。確認より前に出した同じエージェントの通知が片付く。 */
	markAcknowledged(agentToken: string, at: number): void {
		for (const entry of this.entries) {
			if (entry.agentToken === agentToken && entry.at < at) {
				entry.handledAt ??= at;
			}
		}
	}

	/** 次のプッシュに載せる通知 ID（新しく片付いた順）。`except` はいま送る通知自身。 */
	dismissable(now: number, except?: string): string[] {
		return this.entries
			.filter(entry => entry.handledAt !== undefined && now - entry.handledAt <= PARADIS_NOTIFY_DISMISS_TTL_MS && entry.id !== except)
			.sort((a, b) => b.handledAt! - a.handledAt!)
			.slice(0, PARADIS_NOTIFY_DISMISS_MAX_IDS)
			.map(entry => entry.id);
	}

	private trim(): void {
		if (this.entries.length > LEDGER_LIMIT) {
			this.entries.splice(0, this.entries.length - LEDGER_LIMIT);
		}
	}
}

/**
 * 通知の本文（JSON）に印を足す（プッシュ用。フレームには足さない）。印が無い・JSON として読めない
 * ときはそのまま返す。
 */
export function paradisWithNotifyDismiss(bytes: Uint8Array, tags: readonly string[]): Uint8Array {
	if (tags.length === 0) {
		return bytes;
	}
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return bytes;
		}
		return new TextEncoder().encode(JSON.stringify({ ...parsed, dismiss: tags }));
	} catch {
		return bytes;
	}
}

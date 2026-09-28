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
// - スマホがその通知を ID を指定して開いた・消した（`dismiss` に `opened: true`。通知 ID で1件）。
//   許可・質問（`agent-question`）はこれでだけ消す
// - スマホが一覧を「すべて消去」した（`opened` の無い `dismiss`）: 完了などの通知だけ。許可・質問は消さない
//   （旧アプリは1件ずつの操作にも `opened` を付けないので、旧アプリからの許可・質問は消さない側に倒れる）
// - PC がそのエージェントのペインを確認済みにした、またはターミナルが終わった（`onDidAcknowledgePane`）:
//   確認した時刻より前に出した、許可・質問以外の通知だけ
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
	/** 通知の種別（分からなければ undefined。許可・質問として扱う）。 */
	readonly kind: string | undefined;
	readonly at: number;
	handledAt: number | undefined;
}

/** 許可・質問（未回答かもしれない）か。種別が分からないものも、消さない側に倒してこちらに入れる。 */
function isPrompt(kind: string | undefined): boolean {
	return kind === undefined || kind === 'agent-question';
}

export class ParadisNotifyDismissLedger {

	/** 出した順（古い順）。 */
	private readonly entries: IEmitted[] = [];

	/** 通知を出した（プッシュ・フレームのどちらでも）。 */
	record(id: string, agentToken: string | undefined, kind: string | undefined, at: number): void {
		if (this.entries.some(entry => entry.id === id)) {
			return;
		}
		this.entries.push({ id, agentToken, kind, at, handledAt: undefined });
		this.trim();
	}

	/**
	 * スマホがその通知を消した。`opened` はその通知を ID で指定して開いた・消した（新しいアプリの1件ごとの
	 * 操作）。`opened` が無い（「すべて消去」・旧アプリ）ときは、許可・質問と、この PC が出したと
	 * 覚えていない通知（再起動前など。種別が分からない）は片付いたことにしない。
	 */
	markDismissed(id: string, at: number, opened: boolean): void {
		const entry = this.entries.find(candidate => candidate.id === id);
		if (entry !== undefined) {
			if (opened || !isPrompt(entry.kind)) {
				entry.handledAt ??= at;
			}
			return;
		}
		if (opened) {
			this.entries.push({ id, agentToken: undefined, kind: undefined, at, handledAt: at });
			this.trim();
		}
	}

	/** PC がそのエージェントのペインを確認済みにした。確認より前に出した同じエージェントの、許可・質問以外の通知が片付く。 */
	markAcknowledged(agentToken: string, at: number): void {
		for (const entry of this.entries) {
			if (entry.agentToken === agentToken && entry.at < at && !isPrompt(entry.kind)) {
				entry.handledAt ??= at;
			}
		}
	}

	/** その通知がもう片付いたか（裏に回ったときのプッシュし直しで、片付いたものを送らないため）。 */
	isSettled(id: string | undefined): boolean {
		return id !== undefined && this.entries.some(entry => entry.id === id && entry.handledAt !== undefined);
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

/** スマホの `dismiss` が、その通知を ID で指定して開いた・消したものか（`opened: true`。旧アプリは付けない）。 */
export function paradisNotifyDismissOpened(bytes: Uint8Array): boolean {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { opened?: unknown } | null;
		return parsed !== null && typeof parsed === 'object' && parsed.opened === true;
	} catch {
		return false;
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

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェントへの送信（入力欄・通知からの返信）に付ける `sendId`。PC は同じ id の送信をウィンドウへ二度渡さず、
 * 二度目には「受け付け済み（duplicate）」と答える（W2-29 の預かり送信と同じ仕組み）。
 *
 * id は利用者の 1 回の操作につき 1 つ。届いたか分からないまま失敗にした送信（時間切れ・接続断。断りの理由 code が
 * 無いもの）は、入力欄へ戻した同じ文を同じターミナルへ送り直したとき、前と同じ id を使う。PC が実は受け取って
 * いたなら二度目は送られない。理由の付いた断り・受け付け・入力欄に残った（consumed）は送り直しではないので忘れる。
 * 時間切れの後に新しい id で自動で送り直すことはしない（送り直すのはいつも利用者）。
 */

import { randomToken, toBase64Url } from '@para/protocol';

/** 送り直しとみなす上限（PC が送った id を覚えている 24 時間より十分短く、別の機会の同じ文と取り違えない長さ）。 */
export const AGENT_SEND_RETRY_WINDOW_MS = 10 * 60_000;
/** 覚えておくターミナルの数の上限。 */
const UNSETTLED_LIMIT = 50;

/** PC が受け付ける形（`/^[A-Za-z0-9._:-]{1,100}$/`）の新しい id。 */
export function newAgentSendId(): string {
	return `send-${toBase64Url(randomToken(12))}`;
}

/** 送った結果のうち、id の扱いを決めるのに要る部分。 */
export interface AgentSendOutcome {
	readonly status: 'accepted' | 'rejected' | 'consumed';
	readonly code?: string;
}

interface UnsettledSend {
	readonly text: string;
	readonly sendId: string;
	readonly at: number;
}

/** ターミナルごとに、届いたか分からないまま終わった最後の送信を覚える。 */
export class AgentSendIdBook {
	private readonly unsettled = new Map<string, UnsettledSend>();

	constructor(private readonly now: () => number = Date.now, private readonly newId: () => string = newAgentSendId) { }

	/** この送信に付ける id。直前の分からないまま終わった送信と同じ文なら、その id を使い回す。 */
	idFor(terminalKey: string, text: string): string {
		const previous = this.unsettled.get(terminalKey);
		if (previous !== undefined && previous.text === text && this.now() - previous.at <= AGENT_SEND_RETRY_WINDOW_MS) {
			return previous.sendId;
		}
		return this.newId();
	}

	/** 送った結果を記録する。分からないまま終わったものだけを覚え、それ以外はそのターミナルの記録を消す。 */
	settle(terminalKey: string, text: string, sendId: string, outcome: AgentSendOutcome): void {
		if (outcome.status === 'rejected' && outcome.code === undefined) {
			this.unsettled.delete(terminalKey);
			this.unsettled.set(terminalKey, { text, sendId, at: this.now() });
			while (this.unsettled.size > UNSETTLED_LIMIT) {
				const oldest = this.unsettled.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				this.unsettled.delete(oldest);
			}
			return;
		}
		if (this.unsettled.get(terminalKey)?.sendId === sendId || outcome.status !== 'rejected') {
			this.unsettled.delete(terminalKey);
		}
	}
}

/** アプリ全体で 1 つ（入力欄と通知からの返信が同じ記録を使う。通知の返信が失敗して入力欄へ戻った文も同じ id で送り直せる）。 */
export const agentSendIds = new AgentSendIdBook();

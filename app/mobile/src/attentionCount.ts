// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isAgentWaiting } from './store.js';

/**
 * 「要対応」の件数の数え方。タブのバッジ（iPhone のタブバー・iPad のサイドバーとレール）、
 * ホームの要対応の見出し、ドロワーの統計、PC切替の「要対応 N」は
 * **すべてここを通す**。以前は画面ごとに数え方が違い、タブのバッジ（全ターミナル）と
 * ホームの件数（選択中スペースのエージェントだけ）が食い違っていた。
 * ホームのベルはここを通さない（押した先の通知履歴に合わせる。`components/notificationCount.ts`）。
 *
 * 決めごと:
 *  - 数えるのはエージェント（`agent === true`）だけ。エージェントCLIが動いた実績の無い
 *    プレーンなターミナルはホームの一覧に出ないので、数に入れると「押しても見つからない1件」になる
 *  - **ドロワーのスペースの絞り込みは見ない（常に全スペース）。** 要対応は放っておくと
 *    エージェントが止まったままになるもので、タブのバッジとドロワーの統計は絞り込みと無関係に
 *    全体を示す場所にある。ホームもこれに合わせ、要対応の段だけは絞り込み中も全スペース分を出す
 *    （絞り込みで隠すと、バッジの数だけあるのにホームで見つからない状態になる）
 *  - アーカイブは見ない。要対応になったものはアーカイブ中でも自動でホームへ戻る（archivedAgents.ts）
 */
export interface AttentionCandidate {
	readonly agent?: boolean;
	readonly agentStatus?: string;
}

/** 要対応として数える1件か。ホームの要対応スタックに積む行もこの判定で選ぶ。 */
export function isAttentionAgent(terminal: AttentionCandidate): boolean {
	return terminal.agent === true && isAgentWaiting(terminal.agentStatus);
}

/** 要対応の件数。 */
export function countAttentionAgents(terminals: readonly AttentionCandidate[] | undefined): number {
	let count = 0;
	for (const terminal of terminals ?? []) {
		if (isAttentionAgent(terminal)) {
			count++;
		}
	}
	return count;
}

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isAgentWaiting, pinKeyForTerminal } from './store.js';

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

/** 実行中として数える候補（アーカイブの印を引くので `terminalKey` が要る）。 */
export interface RunningCandidate extends AttentionCandidate {
	readonly terminalKey: string;
}

/**
 * 実行中として数える1件か。ホームの「実行中」のカード・PC のカードの「実行中」・全 PC 横断の一覧
 * （`/agents?state=running`）は**すべてここを通す**。
 *
 *  - 数えるのはエージェント（`agent === true`）の `working` だけ（要対応と同じく、プレーンなターミナルは数えない）
 *  - 要対応と違い、**アーカイブしたものは数えない**。実行中のものはアーカイブしても一覧へ戻らない
 *    （戻るのは要対応になったときだけ。archivedAgents.ts）ので、数えると押した先に見つからない
 */
export function isRunningAgent(terminal: RunningCandidate, isArchived: (key: string) => boolean): boolean {
	return terminal.agent === true && terminal.agentStatus === 'working' && !isArchived(pinKeyForTerminal(terminal));
}

/** 実行中の件数。`archived` はその PC のアーカイブの印（`pinKeyForTerminal` のキー）。 */
export function countRunningAgents(terminals: readonly RunningCandidate[] | undefined, archived: ReadonlySet<string> | readonly string[]): number {
	const isArchived = archivedLookup(archived);
	let count = 0;
	for (const terminal of terminals ?? []) {
		if (isRunningAgent(terminal, isArchived)) {
			count++;
		}
	}
	return count;
}

/** アーカイブの印を引く関数（保存形の配列と、画面が持つ Set のどちらでも受ける）。 */
export function archivedLookup(archived: ReadonlySet<string> | readonly string[]): (key: string) => boolean {
	if (isReadonlyArray(archived)) {
		if (archived.length === 0) {
			return () => false;
		}
		const set = new Set(archived);
		return key => set.has(key);
	}
	return key => archived.has(key);
}

function isReadonlyArray(value: ReadonlySet<string> | readonly string[]): value is readonly string[] {
	return Array.isArray(value);
}

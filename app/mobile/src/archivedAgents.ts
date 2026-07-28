// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { isAgentWaiting, pinKeyForTerminal } from './store.js';

/**
 * アーカイブ（ホーム一覧から外す印）の維持規則。印はこの端末ローカルのみで、
 * ピン留めと同じく pinKeyForTerminal をキーにする。
 *
 * PC側のターミナルはアーカイブしても動き続けるため、印を放っておくと
 *  - 質問や応答待ちになったエージェントが一覧から消えたまま黙って止まる
 *  - 閉じたターミナルの印だけが永久に残る
 * の2つが起きる。状態が届くたびにここを通して両方を落とす。
 */

/** 判定に必要なターミナルの形（実体は store.ts の workspace.terminals）。 */
export interface ArchivableTerminal {
	readonly terminalKey: string;
	readonly agentStatus?: string;
}

/**
 * 印を維持すべきものだけに絞る。落とすのは次の2つ:
 *  - **こちらの回答を待っているもの**（質問・応答待ち）。アーカイブは「自分から動かないものに
 *    だけ効く印」という位置づけなので、向こうから呼ばれた時点で解除して一覧へ戻す
 *  - **もう存在しないターミナル**の印
 *
 * 変更が無ければ受け取った集合をそのまま返す（呼び出し側が無駄な再描画をしないで済む）。
 */
export function releaseArchivedOnAttention(
	archivedKeys: ReadonlySet<string>,
	terminals: readonly ArchivableTerminal[],
): ReadonlySet<string> {
	if (archivedKeys.size === 0) {
		return archivedKeys;
	}
	const keep = new Set<string>();
	for (const terminal of terminals) {
		const key = pinKeyForTerminal(terminal);
		if (archivedKeys.has(key) && !isAgentWaiting(terminal.agentStatus)) {
			keep.add(key);
		}
	}
	return keep.size === archivedKeys.size ? archivedKeys : keep;
}

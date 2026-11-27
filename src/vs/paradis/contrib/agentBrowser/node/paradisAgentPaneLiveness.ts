/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ペインのエージェントがまだ動いているかを、shared process のほかの機能（Bot）から聞く口。答えるのは hook の発信元の
// プロセスを覚えている ParadisAgentBrowserService（hook の所有者の pid と開始時刻をプロセス表で照らす）。

/** そのペインのエージェント（hook の所有者）が動いているか。動いていれば true、終わっていれば false、分からなければ undefined。 */
export type ParadisAgentPaneLivenessProbe = (token: string) => Promise<boolean | undefined>;

let probe: ParadisAgentPaneLivenessProbe | undefined;

/** 答える側を置く（ParadisAgentBrowserService が作られたとき）。 */
export function setParadisAgentPaneLivenessProbe(value: ParadisAgentPaneLivenessProbe | undefined): void {
	probe = value;
}

/** そのペインのエージェントが動いているか。答える側がいない・確かめられないときは undefined。 */
export async function paradisAgentPaneAlive(token: string): Promise<boolean | undefined> {
	return probe === undefined ? undefined : probe(token).catch(() => undefined);
}

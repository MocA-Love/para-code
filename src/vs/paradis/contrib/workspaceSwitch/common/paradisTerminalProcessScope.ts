/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルグループの persistentProcessId ベースの所属スコープ解決 (機能1 Phase 2 の一部)。
 *
 * `ParadisTerminalWorkspaceScope`（paradisTerminalScope.contribution.ts）が使う。ここに切り出して
 * いるのは、グループ「オブジェクト」の参照ではなく persistentProcessId という安定な識別子を
 * キーにした純粋なマップ操作だけを、DI/TerminalGroupService に依存せずテストできるようにするため。
 */
export interface IParadisScopedTerminalInstanceLike {
	readonly persistentProcessId?: number;
}

/** persistentProcessId ごとの所属スコープ記録に、対象グループの各インスタンスの対応を書き込む */
export function paradisRecordProcessScopes(processScopes: Map<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[], stateKey: string): void {
	for (const instance of instances) {
		if (typeof instance.persistentProcessId === 'number') {
			processScopes.set(instance.persistentProcessId, stateKey);
		}
	}
}

/**
 * グループの所属スコープを、構成インスタンスの persistentProcessId から引く。
 * 今セッション中の記録 (`processScopes`) を優先し、無ければ前回セッションからの
 * 保存済みマッピング (`restoredMapping`) にフォールバックする。どちらにも無ければ
 * (真に新規のグループ/プロセスなら) undefined を返す。
 */
export function paradisLookupProcessScope(processScopes: ReadonlyMap<number, string>, restoredMapping: ReadonlyMap<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[]): string | undefined {
	for (const instance of instances) {
		if (typeof instance.persistentProcessId === 'number') {
			const repositoryId = processScopes.get(instance.persistentProcessId) ?? restoredMapping.get(instance.persistentProcessId);
			if (repositoryId) {
				return repositoryId;
			}
		}
	}
	return undefined;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルグループの、グループオブジェクト再作成をまたぐ所属スコープ解決 (機能1 Phase 2 の一部)。
 *
 * `ParadisTerminalWorkspaceScope`（paradisTerminalScope.contribution.ts）が使う。ここに切り出して
 * いるのは、グループ「オブジェクト」の参照ではなく安定な識別子をキーにした純粋なマップ操作だけを、
 * DI/TerminalGroupService に依存せずテストできるようにするため。
 *
 * キーの使い分け:
 * - 今セッション中のライブ記録は `instanceId` をキーにする。moveToBackground →
 *   showBackgroundTerminal によるグループ再作成は同じ ITerminalInstance オブジェクトを
 *   新しいグループへ包み直すだけなので instanceId は安定しており、かつ同期採番のため
 *   「タグ付け時点では未確定」という穴が存在しない（persistentProcessId はプロセス起動後に
 *   非同期で確定するため、生成直後のタグ付けでは記録できないことがある）。
 * - 前回セッションからの復元は `persistentProcessId` をキーにする。instanceId はウィンドウ
 *   セッションごとに振り直されるため、リロードをまたげるのはこちらだけ。
 */
export interface IParadisScopedTerminalInstanceLike {
	readonly instanceId: number;
	readonly persistentProcessId?: number;
}

/** instanceId ごとの所属スコープ記録に、対象グループの各インスタンスの対応を書き込む */
export function paradisRecordInstanceScopes(instanceScopes: Map<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[], stateKey: string): void {
	for (const instance of instances) {
		instanceScopes.set(instance.instanceId, stateKey);
	}
}

/**
 * グループの所属スコープを、構成インスタンスから引く。
 * 今セッション中の記録 (`instanceScopes`、instanceId キー) を優先し、無ければ前回セッションからの
 * 保存済みマッピング (`restoredMapping`、persistentProcessId キー) にフォールバックする。
 * どちらにも無ければ (真に新規のグループなら) undefined を返す。
 */
export function paradisLookupInstanceScope(instanceScopes: ReadonlyMap<number, string>, restoredMapping: ReadonlyMap<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[]): string | undefined {
	for (const instance of instances) {
		const live = instanceScopes.get(instance.instanceId);
		if (live) {
			return live;
		}
	}
	for (const instance of instances) {
		if (typeof instance.persistentProcessId === 'number') {
			const restored = restoredMapping.get(instance.persistentProcessId);
			if (restored) {
				return restored;
			}
		}
	}
	return undefined;
}

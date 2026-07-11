/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/**
 * エディタエリアのターミナルを Paradis ワークスペース切り替えを跨いで生かすためのパーク台帳 (機能1)。
 *
 * working set の入れ替えでターミナルエディタが閉じられると、通常は TerminalEditorInput.dispose()
 * がインスタンス（= PTY プロセス）ごと破棄する。一方 working set には persistentProcessId が
 * シリアライズされて残るため、切り替えで戻った際に既に死んだ pty へ attachToProcess を試みて
 * 「Could not find pty」で壊れたターミナルが復元されてしまう。
 *
 * そこで切り替え時 (ParadisWorkspaceSwitchService.switchToTarget) に、エディタターミナルの
 * インスタンスを input から切り離して殺さずにここへ登録し、working set 復帰時の
 * reviveInput (terminalEditorService.ts の PARA-PATCH) で pty 再接続の代わりに生きている
 * インスタンスをそのまま再利用する。パネルターミナルの park/unpark
 * (terminalGroupService.ts の PARA-PATCH) と対になる仕組み。
 *
 * park 中のインスタンスは、対応するスコープへ戻れば revive で再利用され、スコープが退役
 * (リポジトリ削除 / worktree 削除) すれば paradisRetireParkedTerminalEditorInstances で
 * 実体ごと破棄される。どちらの経路にも乗らない場合のみパネルの park と同様ウィンドウの寿命まで
 * 生存し、ウィンドウを閉じると pty host 側の孤児処理で回収される。
 *
 * 各エントリには park 元スコープの stateKey を併記する。working set の実体 (persistentProcessId を
 * 含むシリアライズ済みエディタ入力) は EditorParts 内部 storage にあり外部から列挙できないため、
 * 退役スコープの park インスタンスを特定するにはこの park 時点のタグに頼る。パネル側 _parkedGroups が
 * repositoryId でグループを束ねているのと対称。
 */
const parkedInstances = new Map<number, { readonly instance: ITerminalInstance; readonly stateKey: string; readonly onDisposedListener: IDisposable }>();

/**
 * インスタンスを persistentProcessId をキーにパークする。ID未確定のインスタンスは登録しない。
 * stateKey は park 元スコープ (= 切り替え元の working set を保存したスコープ) の状態キー。
 */
export function paradisParkTerminalEditorInstance(instance: ITerminalInstance, stateKey: string): boolean {
	const persistentProcessId = instance.persistentProcessId;
	if (typeof persistentProcessId !== 'number' || !instance.shouldPersist) {
		return false;
	}
	// パーク中にプロセスが終了した場合に台帳から漏れないよう掃除する
	const onDisposedListener = instance.onDisposed(() => {
		if (parkedInstances.get(persistentProcessId)?.instance === instance) {
			parkedInstances.delete(persistentProcessId);
		}
		onDisposedListener.dispose();
	});
	parkedInstances.get(persistentProcessId)?.onDisposedListener.dispose();
	parkedInstances.set(persistentProcessId, { instance, stateKey, onDisposedListener });
	return true;
}

/**
 * 退役したスコープ (リポジトリ削除 / worktree 削除) の park 中エディタターミナルを実体ごと破棄する。
 * 破棄対象は「park 時に当該 stateKey でタグ付けされた」インスタンスのみ。park 台帳に居る =
 * どの UI にも接続されていない (revive で取り出されると台帳から消える) ため、現在表示中の
 * インスタンスや他スコープの park を誤って殺すことはない。
 *
 * instance.dispose() が onDisposed を発火して上の掃除リスナーが再入で台帳を触るのを避けるため、
 * 先に台帳から取り除きリスナーを解除してから dispose する。パネル側 retireScope が
 * instance.dispose(TerminalExitReason.User) で PTY ごと停止するのと対称に User 理由で破棄する。
 */
export function paradisRetireParkedTerminalEditorInstances(stateKey: string): void {
	const retiring: ITerminalInstance[] = [];
	for (const [persistentProcessId, entry] of [...parkedInstances]) {
		if (entry.stateKey !== stateKey) {
			continue;
		}
		parkedInstances.delete(persistentProcessId);
		entry.onDisposedListener.dispose();
		retiring.push(entry.instance);
	}
	for (const instance of retiring) {
		instance.dispose(TerminalExitReason.User);
	}
}

/**
 * パーク中の全インスタンスを列挙する（台帳からは取り出さない）。
 * モバイルリレーが「他ワークスペースへ退避中のエディタターミナル」も一覧・attach できるようにするための読み取り専用ビュー。
 * terminalService.instances にも paradisParkedGroups にも現れないのはこの台帳のインスタンスだけなので、
 * 全ターミナル列挙はこの3つの合算で完全になる。
 */
export function paradisListParkedTerminalEditorInstances(): ITerminalInstance[] {
	return [...parkedInstances.values()].map(e => e.instance);
}

/**
 * park中インスタンスの instanceId → park元スコープの stateKey を引く（スコープ解決用）。
 * エディタエリアのターミナルはパネルのグループ台帳 (_groupRepositories) に乗らないため、
 * IParadisTerminalScopeService.getStateKeyForInstance がこの台帳を第二の解決先として使う。
 */
export function paradisGetParkedTerminalEditorStateKey(instanceId: number): string | undefined {
	for (const entry of parkedInstances.values()) {
		if (entry.instance.instanceId === instanceId) {
			return entry.stateKey;
		}
	}
	return undefined;
}

/**
 * 指定スコープの park 中インスタンスをすべて取り出す（台帳から消え、監視リスナーも解除される）。
 *
 * エディタターミナルの復元は本来 working set の deserialize → reviveInput
 * (terminalEditorService.ts の PARA-PATCH) が担うが、復路で適用される working set が
 * park した世代と一致しない場合など、reviveInput の台帳ルックアップに到達しないことがある。
 * その場合インスタンスは誰にも回収されず PTY だけが不可視のまま生き続ける（リーク）。
 * スコープ切り替え完了時にこの関数で残留分を回収し、明示的にエディタとして開き直す
 * フォールバックに使う（paradisTerminalScope.contribution.ts の applyScope）。
 */
export function paradisTakeParkedTerminalEditorInstancesForScope(stateKey: string): ITerminalInstance[] {
	const taken: ITerminalInstance[] = [];
	for (const [persistentProcessId, entry] of [...parkedInstances]) {
		if (entry.stateKey !== stateKey) {
			continue;
		}
		parkedInstances.delete(persistentProcessId);
		entry.onDisposedListener.dispose();
		taken.push(entry.instance);
	}
	return taken;
}

/** パーク済みインスタンスを取り出す（一度取り出したら台帳から消え、監視リスナーも解除される）。 */
export function paradisTakeParkedTerminalEditorInstance(persistentProcessId: number): ITerminalInstance | undefined {
	const entry = parkedInstances.get(persistentProcessId);
	if (!entry) {
		return undefined;
	}
	parkedInstances.delete(persistentProcessId);
	entry.onDisposedListener.dispose();
	return entry.instance;
}

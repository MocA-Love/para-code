/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { GroupDirection } from '../../../../workbench/services/editor/common/editorGroupsService.js';

/** 閉じたエディタエリアのターミナル1件分。プロセスは戻らないので、開き直しに要る場所だけを持つ。 */
export interface IParadisClosedTerminal {
	/** 閉じた時点のフォルダ（シェル統合で分かった cwd、無ければ起動時のフォルダ）。 */
	readonly cwd: string | undefined;
	/** 閉じたタブがあったエディタグループ。 */
	readonly groupId: number;
	/** グループ内のタブの位置。 */
	readonly index: number;
	/**
	 * 最後のタブを閉じるとグループごと消えるため、グリッド上の位置を戻す手がかりとして
	 * 「隣のグループ」と「そのどちら側に作り直すか」を持つ。
	 */
	readonly neighbor?: { readonly groupId: number; readonly direction: GroupDirection };
}

export type ParadisClosedEntry =
	| { readonly kind: 'terminal'; readonly terminal: IParadisClosedTerminal; readonly batch: number }
	/** ターミナル以外のエディタが閉じられた印。中身は upstream の「閉じたエディタを開き直す」の履歴が持つ。 */
	| { readonly kind: 'editor'; readonly batch: number };

/** 取り出したまとまりをどう開き直すか。 */
export interface IParadisReopenPlan {
	/** upstream の「閉じたエディタを開き直す」を1回呼ぶか。 */
	readonly reopenEditors: boolean;
	/** 開き直すターミナル（閉じた順）。 */
	readonly terminals: readonly IParadisClosedTerminal[];
}

/**
 * まとまりの開き直し方を決める。エディタの印だけのまとまりで、upstream の履歴が既に空
 * （閉じたファイルが削除された等）なら undefined（このまとまりは飛ばして1つ前へ）。
 */
export function paradisPlanReopen(batch: readonly ParadisClosedEntry[], canReopenClosedEditor: boolean): IParadisReopenPlan | undefined {
	const terminals = batch.flatMap(entry => entry.kind === 'terminal' ? [entry.terminal] : []);
	const reopenEditors = terminals.length !== batch.length;
	if (!terminals.length && !canReopenClosedEditor) {
		return undefined;
	}
	return { reopenEditors, terminals };
}

/** スペースごとに覚えておく閉じたターミナルの件数。 */
export const PARADIS_CLOSED_TERMINAL_LIMIT = 10;
/** エディタの印を含めた全体の上限（upstream の閉じたエディタ履歴は 20 件）。 */
const PARADIS_CLOSED_ENTRY_LIMIT = 30;

/**
 * 閉じたターミナルと、ターミナル以外のエディタを閉じた順番をスペースごとに覚える。
 *
 * ⌘⇧T は upstream の「閉じたエディタを開き直す」と共有する。ターミナル以外のエディタは upstream の
 * 履歴がそのまま開き直すので、ここでは「その順番にエディタが閉じられた」という印だけを置き、
 * 最後に閉じたものがターミナルかエディタかを判定するのに使う。
 *
 * 同じ同期処理の中で閉じられたもの（「すべて閉じる」など）は upstream と同じく1まとめにして、
 * まとめて開き直す。
 */
export class ParadisClosedTerminalHistory {

	private readonly _stacks = new Map<string, ParadisClosedEntry[]>();
	private _batch = 0;
	private _batchOpen = false;

	constructor(private readonly _scheduleBatchEnd: (callback: () => void) => void = callback => queueMicrotask(callback)) { }

	recordTerminal(scope: string, terminal: IParadisClosedTerminal): void {
		this._push(scope, { kind: 'terminal', terminal, batch: this._currentBatch() });
	}

	recordEditor(scope: string): void {
		const batch = this._currentBatch();
		const stack = this._stacks.get(scope);
		const top = stack?.at(-1);
		if (top?.kind === 'editor' && top.batch === batch) {
			return; // 同じまとまりのエディタは upstream が1回でまとめて開き直す
		}
		this._push(scope, { kind: 'editor', batch });
	}

	/** 最後に閉じたまとまりを取り出す（閉じた順）。 */
	takeLastBatch(scope: string): ParadisClosedEntry[] {
		const stack = this._stacks.get(scope);
		const last = stack?.at(-1);
		if (!stack || !last) {
			return [];
		}
		const batch: ParadisClosedEntry[] = [];
		while (stack.length && stack[stack.length - 1].batch === last.batch) {
			batch.unshift(stack.pop()!);
		}
		if (!stack.length) {
			this._stacks.delete(scope);
		}
		return batch;
	}

	/** スペースを削除したときに、そのスペースの履歴を捨てる。 */
	clearScope(scope: string): void {
		this._stacks.delete(scope);
	}

	private _push(scope: string, entry: ParadisClosedEntry): void {
		let stack = this._stacks.get(scope);
		if (!stack) {
			stack = [];
			this._stacks.set(scope, stack);
		}
		stack.push(entry);
		let terminals = stack.filter(candidate => candidate.kind === 'terminal').length;
		while (terminals > PARADIS_CLOSED_TERMINAL_LIMIT) {
			stack.splice(stack.findIndex(candidate => candidate.kind === 'terminal'), 1);
			terminals--;
		}
		while (stack.length > PARADIS_CLOSED_ENTRY_LIMIT) {
			stack.shift();
		}
	}

	private _currentBatch(): number {
		if (!this._batchOpen) {
			this._batchOpen = true;
			this._batch++;
			this._scheduleBatchEnd(() => this._batchOpen = false);
		}
		return this._batch;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../../base/common/lifecycle.js';
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
 * ここに残ったままのインスタンス（対応する working set が二度と適用されない等）は、パネルの
 * park と同様ウィンドウの寿命まで生存し、ウィンドウを閉じると pty host 側の孤児処理で回収される。
 */
const parkedInstances = new Map<number, { readonly instance: ITerminalInstance; readonly onDisposedListener: IDisposable }>();

/** インスタンスを persistentProcessId をキーにパークする。ID未確定のインスタンスは登録しない。 */
export function paradisParkTerminalEditorInstance(instance: ITerminalInstance): boolean {
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
	parkedInstances.set(persistentProcessId, { instance, onDisposedListener });
	return true;
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

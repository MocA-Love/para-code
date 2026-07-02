/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルグリッドの各セル右上に表示する「エージェント共有インジケータ」のDIフリーな実装。
// `SessionTerminalGridCell`（vs/sessions/contrib/terminalGrid、DIを持たないプレーンクラス）から
// `createParadisPaneIndicator` を呼ぶだけで済むよう、状態の供給元（バインディングモデル）は
// electron-browser 側の contribution が `setParadisPaneIndicatorHost` でモジュールレジストリへ
// 登録する（デスクトップ以外ではホスト未登録のままインジケータは非表示になる）。

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';

/** インジケータの表示状態。 */
export type ParadisPaneIndicatorState = 'bound' | 'unbound';

/**
 * インジケータへ状態を供給し、クリック時にバインディングダイアログを開くホスト。
 * electron-browser 側の contribution が実装・登録する。
 */
export interface IParadisPaneIndicatorHost {
	getPaneIndicatorState(instanceId: number): ParadisPaneIndicatorState;
	getPaneIndicatorTooltip(instanceId: number): string;
	readonly onDidChangeState: Event<void>;
	openBindingDialog(instanceId: number): void;
}

let currentHost: IParadisPaneIndicatorHost | undefined;
const onDidChangeHost = new Emitter<void>();

/** ホストを登録（または解除）する。登録済みインジケータは即座に再描画される。 */
export function setParadisPaneIndicatorHost(host: IParadisPaneIndicatorHost | undefined): void {
	currentHost = host;
	onDidChangeHost.fire();
}

/**
 * 指定ターミナルインスタンス用のインジケータDOMを作る。呼び出し側（グリッドセル）は
 * `element` を自身のDOMへ追加し、セル破棄時に `dispose()` を呼ぶ。
 */
export function createParadisPaneIndicator(instanceId: number): { readonly element: HTMLElement } & IDisposable {
	const disposables = new DisposableStore();
	const element = document.createElement('div');
	element.className = 'paradis-pane-indicator';

	const update = () => {
		if (!currentHost) {
			element.style.display = 'none';
			return;
		}
		element.style.display = '';
		const state = currentHost.getPaneIndicatorState(instanceId);
		element.classList.toggle('bound', state === 'bound');
		element.title = currentHost.getPaneIndicatorTooltip(instanceId);
	};

	disposables.add(onDidChangeHost.event(() => {
		update();
		if (currentHost) {
			disposables.add(currentHost.onDidChangeState(update));
		}
	}));
	if (currentHost) {
		disposables.add(currentHost.onDidChangeState(update));
	}
	disposables.add(addDisposableListener(element, 'click', e => {
		e.stopPropagation();
		currentHost?.openBindingDialog(instanceId);
	}));
	update();

	return {
		element,
		dispose: () => {
			element.remove();
			disposables.dispose();
		},
	};
}

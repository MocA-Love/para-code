/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの右上に表示する「エージェント共有インジケータ」のDIフリーな実装。
// `SessionTerminalGridCell`（vs/sessions/contrib/terminalGrid、DIを持たないプレーンクラス）や
// `SessionTerminalEditor`（vs/sessions/contrib/terminalGrid、エディタタブのターミナル向け）から
// `createParadisPaneIndicator` を呼ぶだけで済むよう、状態の供給元（バインディングモデル）は
// electron-browser 側の contribution が `setParadisPaneIndicatorHost` でモジュールレジストリへ
// 登録する（デスクトップ以外ではホスト未登録のままインジケータは非表示になる）。

import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';

/** インジケータの表示状態。 */
export type ParadisPaneIndicatorState = 'bound' | 'unbound';

/** 共有中ページの概要。ライブウィンドウのチップ表示に使う。 */
export interface IParadisPaneIndicatorBoundPage {
	readonly title: string;
	readonly url: string;
}

/**
 * インジケータへ状態を供給し、クリック時にバインディングダイアログを開くホスト。
 * electron-browser 側の contribution が実装・登録する。
 */
export interface IParadisPaneIndicatorHost {
	getPaneIndicatorState(instanceId: number): ParadisPaneIndicatorState;
	getPaneIndicatorTooltip(instanceId: number): string;
	readonly onDidChangeState: Event<void>;
	openBindingDialog(instanceId: number): void;
	/** そのペインが共有中のページ。未共有なら undefined。 */
	getBoundPage(instanceId: number): IParadisPaneIndicatorBoundPage | undefined;
	/** メインウィンドウをそのページのスペースへ切り替え、ブラウザを前面に出す。 */
	revealBoundPage(instanceId: number): void;
}

let currentHost: IParadisPaneIndicatorHost | undefined;
const onDidChangeHost = new Emitter<void>();

/** ホストを登録（または解除）する。登録済みインジケータは即座に再描画される。 */
export function setParadisPaneIndicatorHost(host: IParadisPaneIndicatorHost | undefined): void {
	currentHost = host;
	onDidChangeHost.fire();
}

/**
 * 現在のホスト。グリッドセル以外の利用者（エージェントライブウィンドウ）が、共有状態の
 * 参照とスペース復帰のためにこのレジストリを経由する。バインディングモデル本体は
 * electron-browser レイヤーにあり browser レイヤーからは直接触れないため、ここが唯一の口になる。
 */
export function getParadisPaneIndicatorHost(): IParadisPaneIndicatorHost | undefined {
	return currentHost;
}

/** ホストの差し替え（登録・解除）通知。 */
export const onDidChangeParadisPaneIndicatorHost: Event<void> = onDidChangeHost.event;

// --- 背面ターミナルハイライト（バインディングダイアログ ⇔ グリッドセル/エディタターミナル） ---
//
// ダイアログのペイン行をホバー/フォーカスしている間、そのペインの背面（グリッドセルまたは
// エディタタブのターミナル）を枠グローで強調表示する。dialog（electron-browser）と
// セル（vs/sessions）/エディタターミナル（vs/workbench）は互いを import できない/しないため、
// indicator と同じくこのモジュールのレジストリを疎結合な通知路として使う:
//   dialog → setParadisHoveredPaneInstanceId() → event → 各 indicator が自分宛てか
//   判定し、親要素へ .paradis-pvh-target クラスを設定。

let currentHoveredInstanceId: number | undefined;
const onDidChangeHoveredPane = new Emitter<number | undefined>();

/** ホバー/フォーカス中のペインが変わったことを通知するイベント（undefined = どこもホバーしていない）。 */
export const onDidChangeParadisHoveredPane: Event<number | undefined> = onDidChangeHoveredPane.event;

/** バインディングダイアログ側から「いま指し示しているペイン」を設定する。 */
export function setParadisHoveredPaneInstanceId(instanceId: number | undefined): void {
	if (currentHoveredInstanceId === instanceId) {
		return;
	}
	currentHoveredInstanceId = instanceId;
	onDidChangeHoveredPane.fire(instanceId);
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

	// ホスト購読は付け替え式で持つ。onDidChangeHost は繰り返し発火しうるため、旧ホストの
	// 購読を MutableDisposable で解除してから新ホストへ張り直す (長寿命 store への無条件 add で
	// 旧ホスト購読が蓄積するのを防ぐ)。
	const hostSubscription = disposables.add(new MutableDisposable());
	const bindHost = () => {
		hostSubscription.value = currentHost?.onDidChangeState(update);
	};
	disposables.add(onDidChangeHost.event(() => {
		update();
		bindHost();
	}));
	bindHost();
	disposables.add(addDisposableListener(element, 'click', e => {
		e.stopPropagation();
		currentHost?.openBindingDialog(instanceId);
	}));
	// ダイアログのペイン行 hover/focus 中は、親要素（グリッドセル/エディタターミナルの
	// overflow guard）へハイライトを反映する。親はこの indicator をちょうど1つ子に持つため、
	// 親経由の直接DOM操作で足りる。
	const applyHoverHighlight = () => {
		const cell = element.parentElement;
		if (!cell) {
			return;
		}
		const active = currentHost !== undefined && currentHoveredInstanceId === instanceId;
		cell.classList.toggle('paradis-pvh-target', active);
	};
	const clearHoverHighlight = () => {
		element.parentElement?.classList.remove('paradis-pvh-target');
	};
	disposables.add(onDidChangeParadisHoveredPane(() => applyHoverHighlight()));
	// ハイライトは「変化した瞬間」だけでなくマウント時にも反映する必要がある。ダイアログのペイン行を
	// ホバーしたままグリッドのセルが作り直されると、新しいセルは onDidChangeParadisHoveredPane を
	// 一度も受け取らないため、ホバー中なのに強調が付かないままになる（呼び出し側は
	// createParadisPaneIndicator() の直後に appendChild するので、親が付くのを待ってから適用する）。
	queueMicrotask(() => {
		if (!disposables.isDisposed) {
			applyHoverHighlight();
		}
	});
	update();

	return {
		element,
		dispose: () => {
			// セルより先にインジケータだけが破棄される場合に強調が残らないよう、親から外す前に落とす。
			clearHoverHighlight();
			element.remove();
			disposables.dispose();
		},
	};
}

/** {@link createParadisEditorTerminalIndicator} が返す、対象ペインを差し替え可能なハンドル。 */
export interface IParadisEditorTerminalIndicatorController extends IDisposable {
	/** インジケータの対象ペインを差し替える。`undefined` なら非表示にする。 */
	setInstance(instanceId: number | undefined): void;
}

/**
 * エディタタブのターミナル向け版の {@link createParadisPaneIndicator}。グリッドセルは
 * インスタンスごとに使い捨てだが、`TerminalEditor` のコンテナ（overflow guard）はタブ切り替えの
 * 間ずっと再利用され続けるため、コンテナは呼び出し側から一度だけ渡し、対象ペインは
 * `setInstance()` で都度差し替える。
 */
export function createParadisEditorTerminalIndicator(container: HTMLElement): IParadisEditorTerminalIndicatorController {
	const current = new MutableDisposable<{ readonly element: HTMLElement } & IDisposable>();
	return {
		setInstance(instanceId) {
			current.value = instanceId !== undefined ? createParadisPaneIndicator(instanceId) : undefined;
			if (current.value) {
				container.appendChild(current.value.element);
			}
		},
		dispose: () => current.dispose(),
	};
}

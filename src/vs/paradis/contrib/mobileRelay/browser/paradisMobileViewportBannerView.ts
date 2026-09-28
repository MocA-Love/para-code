/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの画面に合わせて縮めているターミナルに重ねる案内（W2-19）。DOM だけを持ち、状態と操作は
// 台帳（common/paradisMobileTerminalViewportStatus.ts）に任せる。エディタ領域のターミナルは
// 重ね合わせの口（paradisRegisterEditorTerminalOverlay）、パネルのターミナルは terminal contribution から付ける。
// 縮めている間はターミナルの右側と下側が空くので、右下に出す（右上は共有ドットと復元のバナーの場所）。

import './media/paradisMobileViewportBanner.css';
import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisMobileTerminalViewportStatus } from '../common/paradisMobileTerminalViewportStatus.js';

const $ = dom.$;

/** ターミナル 1 つ分の案内。エディタのタブでは対象のターミナルが切り替わる。 */
export interface IParadisMobileViewportBanner {
	setInstance(instanceId: number | undefined): void;
	dispose(): void;
}

export function createParadisMobileViewportBanner(container: HTMLElement, status: ParadisMobileTerminalViewportStatus): IParadisMobileViewportBanner {
	const view = new MutableDisposable<DisposableStore>();
	const listener = new DisposableStore();
	let instanceId: number | undefined;

	const render = (): void => {
		const override = instanceId === undefined ? undefined : status.get(instanceId);
		if (instanceId === undefined || override === undefined) {
			view.clear();
			return;
		}
		const target = instanceId;
		const store = new DisposableStore();
		const element = $('.paradis-mobile-viewport-banner');
		element.setAttribute('role', 'status');
		const text = dom.append(element, $('span.paradis-mobile-viewport-banner-text'));
		text.textContent = localize('paradis.mobileViewportBanner.text', "スマホ表示に合わせて縮小中");
		const size = dom.append(element, $('span.paradis-mobile-viewport-banner-size'));
		size.textContent = override.rows !== undefined
			? localize('paradis.mobileViewportBanner.size', "{0}×{1}", override.cols, override.rows)
			: localize('paradis.mobileViewportBanner.cols', "{0} 桁", override.cols);
		const button = store.add(new Button(element, {
			...defaultButtonStyles,
			secondary: true,
			title: localize('paradis.mobileViewportBanner.takeBackTitle', "このターミナルを PC の幅に戻します。スマホでターミナルを開き直すか［再び合わせる］を押すまで、スマホからは縮めません"),
		}));
		button.label = localize('paradis.mobileViewportBanner.takeBack', "PC の幅に戻す");
		store.add(button.onDidClick(() => status.takeBack(target)));
		// ターミナルへ届くとフォーカスの移動や選択として扱われるので、案内の中で止める。
		store.add(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		container.appendChild(element);
		store.add({ dispose: () => element.remove() });
		view.value = store;
	};

	listener.add(status.onDidChange(changed => {
		if (changed === instanceId) {
			render();
		}
	}));

	return {
		setInstance(next) {
			instanceId = next;
			render();
		},
		dispose() {
			listener.dispose();
			view.dispose();
		},
	};
}

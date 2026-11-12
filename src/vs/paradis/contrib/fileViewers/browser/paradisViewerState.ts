/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ファイルビューアの「読み込み中」と「表示できない」（失敗・空・対応外・変更なし）の表示。
// 本家に合わせ、読み込み中は上端の 2px の進み具合の線（ProgressBar）だけ、それ以外は本家のエディタの
// 「開けません」（editorplaceholder.css）と同じ 48px のアイコン・文・ボタンにする。ボタンは UI キットの主・副
// （paradisButton.ts、28px で折り返さない）。全ビューアで同じ部品を使う。

import * as dom from '../../../../base/browser/dom.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ParadisButton } from '../../../browser/paradisButton.js';
import './media/paradisViewerState.css';

/** 表示の種類。`loading` は線だけ、ほかはアイコンの色と形が変わる。 */
export type ParadisViewerStateKind = 'loading' | 'error' | 'warning' | 'info' | 'empty' | 'done';

/** 文の下に並べるボタン。先頭が主ボタン、2 つ目からは副ボタン。 */
export interface IParadisViewerStateAction {
	readonly label: string;
	readonly run: () => void;
}

/** 重ねた面。dispose すると外れる。`focus` は主ボタン（無ければ何もしない）へフォーカスを移す。 */
export interface IParadisViewerStateView extends IDisposable {
	focus(): void;
}

/** 読み込み中のあいだ画面に出さずに読み上げる文。 */
export const PARADIS_VIEWER_LOADING_LABEL = localize('paradis.viewer.loading', "読み込み中…");

/** 外部のアプリで開くボタンの文言（全ビューアで同じ言い方にする）。 */
export const PARADIS_VIEWER_OPEN_IN_APP_LABEL = localize('paradis.viewer.openInDefaultApp', "既定のアプリで開く");

/** 再試行のボタンの文言。 */
export const PARADIS_VIEWER_RETRY_LABEL = localize('paradis.viewer.retry', "再試行");

function iconFor(kind: ParadisViewerStateKind): ThemeIcon {
	switch (kind) {
		case 'error': return Codicon.error;
		case 'warning': return Codicon.warning;
		case 'empty': return Codicon.file;
		case 'done': return Codicon.check;
		default: return Codicon.info;
	}
}

/**
 * `container` の上に、読み込み中または表示できないことを示す面を重ねて出す。面は `container` の全体を
 * エディタの地の色で覆う（Excel のシートの白い地の上に薄い文字が出ないように）。返した値を dispose すると
 * 面ごと外す。`message` は読み込み中のときは画面に出さず、読み上げだけに使う。`detail` は文の下の補足（説明の色）。
 */
export function renderParadisViewerState(container: HTMLElement, kind: ParadisViewerStateKind, message: string, actions: readonly IParadisViewerStateAction[] = [], detail?: string): IParadisViewerStateView {
	const store = new DisposableStore();
	let primary: ParadisButton | undefined;
	const view: IParadisViewerStateView = { dispose: () => store.dispose(), focus: () => primary?.focus() };
	const element = dom.append(container, dom.$(`.paradis-viewer-state.${kind}`));
	store.add({ dispose: () => element.remove() });
	if (kind === 'loading') {
		const progress = store.add(new ProgressBar(element, defaultProgressBarStyles));
		progress.getContainer().classList.add('paradis-viewer-state-progress');
		// 速く読めたときに線が一瞬だけ出ないよう、少し待ってから出す（本家の画像プレビューと同じ 150ms）。
		progress.infinite().show(150);
		const status = dom.append(element, dom.$('span.paradis-viewer-state-status'));
		status.setAttribute('role', 'status');
		status.textContent = message;
		return view;
	}
	// 失敗だけを割り込みで読み上げる。変更なし・空・対応外は落ち着いた知らせにする。
	element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
	const iconContainer = dom.append(element, dom.$('.paradis-viewer-state-icon'));
	dom.append(iconContainer, dom.$(ThemeIcon.asCSSSelector(iconFor(kind))));
	dom.append(element, dom.$('.paradis-viewer-state-label')).textContent = message;
	if (detail) {
		dom.append(element, dom.$('.paradis-viewer-state-detail')).textContent = detail;
	}
	if (actions.length > 0) {
		const buttons = dom.append(element, dom.$('.paradis-viewer-state-buttons'));
		actions.forEach((action, index) => {
			const button = store.add(new ParadisButton(buttons, { kind: index === 0 ? 'primary' : 'secondary', label: action.label }));
			store.add(button.onDidClick(() => action.run()));
			primary ??= button;
		});
	}
	return view;
}

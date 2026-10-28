/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの「まだ応答がありません（待つ / 中止）」の帯。アドレスバーの下（検索の帯と同じ場所）に出す。
// ページの中（ContentArea）に出さないのは、読み込み中のページ（ネイティブのビュー）が DOM の上に
// 重なって見えなくなるため。
// 質問を出すか、答えをどうするかは main の見張り（paraBrowserViewLoadWatchdog.ts）が決める。
// ここは質問を映して、押されたボタンを返すだけ。

import './media/paradisBrowserLoadStall.css';
import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IParaBrowserViewLoadStall, ParaBrowserViewLoadStallResponse } from '../../../../platform/browserView/common/paraBrowserViewLoadStall.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisBrowserLoadStallChange, PARADIS_BROWSER_LOAD_STALL_CHANNEL } from '../common/paradisBrowserLoadStall.js';

/** 帯の文言。経過秒は main が質問を出した時点のもの。 */
export function paradisBrowserLoadStallMessage(stall: IParaBrowserViewLoadStall): string {
	return localize('paradisBrowserLoadStall.message', "このページはまだ応答がありません（{0} 秒経過）。待ちますか？", Math.round(stall.elapsedMs / 1000));
}

export class ParadisBrowserLoadStallFeature extends BrowserEditorContribution {

	private readonly _element = $('.paradis-browser-load-stall');
	private readonly _message: HTMLElement;
	private readonly _channel: IChannel;
	/** 質問の取得（非同期）より後に届いたイベントを優先するための番号。 */
	private _version = 0;
	private _shown = false;

	constructor(
		editor: BrowserEditor,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super(editor);
		this._channel = mainProcessService.getChannel(PARADIS_BROWSER_LOAD_STALL_CHANNEL);
		this._element.hidden = true;
		this._element.setAttribute('role', 'alert');
		this._message = append(this._element, $('span.paradis-browser-load-stall-message'));

		const wait = this._register(new Button(this._element, { ...defaultButtonStyles, title: localize('paradisBrowserLoadStall.waitTitle', "もうしばらく応答を待ちます") }));
		wait.label = localize('paradisBrowserLoadStall.wait', "待つ");
		this._register(wait.onDidClick(() => this._respond('wait')));
		const stop = this._register(new Button(this._element, { ...defaultButtonStyles, secondary: true, title: localize('paradisBrowserLoadStall.stopTitle', "読み込みを止めます") }));
		stop.label = localize('paradisBrowserLoadStall.stop', "中止");
		this._register(stop.onDidClick(() => this._respond('stop')));

		this._register(this._channel.listen<IParadisBrowserLoadStallChange>('onDidChange')(change => {
			if (change.viewId === this.editor.model?.id) {
				this._version++;
				this._render(change.stall);
			}
		}));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		// アドレスバー（order 0）の直後。
		return [{ location: BrowserWidgetLocation.Toolbar, element: this._element, order: 20 }];
	}

	protected override onModelAttached(model: IBrowserViewModel, _store: DisposableStore): void {
		// タブを切り替えて戻った・開き直したときも、出ている質問を映し直す。
		const version = ++this._version;
		this._render(undefined);
		this._channel.call<IParaBrowserViewLoadStall | undefined>('get', [model.id]).then(stall => {
			if (version === this._version && this.editor.model === model) {
				this._render(stall);
			}
		}, () => { /* 窓口が無い（テストなど）ときは出さない */ });
	}

	override onModelDetached(): void {
		this._version++;
		this._render(undefined);
	}

	private _render(stall: IParaBrowserViewLoadStall | undefined): void {
		if (stall) {
			this._message.textContent = paradisBrowserLoadStallMessage(stall);
		}
		const shown = !!stall;
		if (shown === this._shown) {
			return;
		}
		this._shown = shown;
		this._element.hidden = !shown;
		// 帯の高さの分だけページの枠が動くので、ネイティブのビューの位置を合わせ直す。
		this.editor.layoutBrowserContainer();
	}

	private _respond(response: ParaBrowserViewLoadStallResponse): void {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		this._channel.call<boolean>('respond', [model.id, response]).catch(() => { /* もう質問は消えている */ });
	}
}

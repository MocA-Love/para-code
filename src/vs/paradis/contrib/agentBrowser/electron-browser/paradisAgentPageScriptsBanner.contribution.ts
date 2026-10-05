/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのタブに、エージェントが置いたスクリプト（add_init_script）が入っている間、ナビバーの下に
// 「このタブにエージェントのスクリプトが入っています」と「外す」を出す。スクリプトはページを読み込むたびに
// 動き、利用者がそのタブで見るページにも効くので、入っていることが見えるようにする。
//
// 本数は electron-main から PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL で流れてくる（タブ＝BrowserView の id ごと）。
// upstream のファイルには触らず、BrowserEditor.registerContribution() の拡張点だけで足している。

import './media/paradisAgentPageScriptsBanner.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisAgentPageScriptsSurface, PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL } from '../common/paradisAgentBrowser.js';

/** Toolbar の帯の並び順（Design Mode のトレイより上に出す）。 */
const BANNER_ORDER = 5;

/** タブにエージェントのスクリプトが入っている間だけ出す帯。 */
export class ParadisAgentPageScriptsBanner extends BrowserEditorContribution {

	private readonly surface: IParadisAgentPageScriptsSurface;
	private readonly banner: HTMLElement;
	private readonly label: HTMLElement;
	private readonly removeButton: HTMLButtonElement;
	private visible = false;
	private count = 0;

	constructor(
		editor: BrowserEditor,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super(editor);
		this.surface = ProxyChannel.toService<IParadisAgentPageScriptsSurface>(mainProcessService.getChannel(PARADIS_AGENT_PAGE_SCRIPTS_CHANNEL));
		this.banner = $('.paradis-page-scripts-banner');
		this.banner.setAttribute('role', 'status');
		this.banner.style.display = 'none';
		this.label = append(this.banner, $('span.paradis-page-scripts-banner-text'));
		this.removeButton = append(this.banner, $<HTMLButtonElement>('button.paradis-page-scripts-banner-button'));
		this.removeButton.type = 'button';
		this.removeButton.textContent = localize('paradis.agentPageScripts.remove', "外す");
		this.removeButton.title = localize('paradis.agentPageScripts.removeTitle', "このタブからエージェントのスクリプトをすべて外します。読み込み済みのページは、再読み込みするまでスクリプトの効果が残ります。");
		this._register(addDisposableListener(this.removeButton, EventType.CLICK, () => void this.removeAll()));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{ location: BrowserWidgetLocation.Toolbar, element: this.banner, order: BANNER_ORDER }];
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		store.add(this.surface.onDidChangeInitScripts(change => {
			if (change.viewId === model.id) {
				this.render(change.count);
			}
		}));
		this.render(0);
		void this.surface.getInitScriptCounts().then(counts => {
			if (this.editor.model === model) {
				this.render(counts.find(entry => entry.viewId === model.id)?.count ?? 0);
			}
		}, error => this.logService.warn('[ParadisAgentPageScripts] could not read the scripts of the tab', error));
	}

	override onModelDetached(): void {
		this.render(0);
	}

	private async removeAll(): Promise<void> {
		const model = this.editor.model;
		if (!model) {
			return;
		}
		this.removeButton.disabled = true;
		try {
			await this.surface.removeAllInitScripts(model.id);
		} catch (error) {
			this.logService.warn('[ParadisAgentPageScripts] could not remove the scripts of the tab', error);
		} finally {
			this.removeButton.disabled = false;
		}
	}

	private render(count: number): void {
		this.count = count;
		this.label.textContent = localize('paradis.agentPageScripts.banner', "このタブにエージェントのスクリプトが入っています（{0} 本）。ページを読み込むたびに動きます。", this.count);
		const visible = count > 0;
		if (visible !== this.visible) {
			this.visible = visible;
			this.banner.style.display = visible ? '' : 'none';
			// 帯の高さの分だけページの領域が変わるので、ネイティブのビューの位置を合わせ直す
			this.editor.layoutBrowserContainer();
		}
	}
}

BrowserEditor.registerContribution(ParadisAgentPageScriptsBanner);

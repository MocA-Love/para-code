/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通知設定ダイアログの「ユーザー辞書」の先頭に置く、「通知と同じ辞書と声の調整をエージェントの読み上げにも使う」の切り替え。
// 反映は paradisAgentDictionarySync.contribution.ts が受け持つ。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisNotificationsSettingsService } from '../browser/paradisNotificationsSettings.js';

const $ = dom.$;

// allow-any-unicode-next-line
const STR_LABEL = localize('paradis.notif.agentDictionary.label', "通知と同じ辞書と声の調整をエージェントの読み上げにも使う");
// allow-any-unicode-next-line
const STR_DESC = localize('paradis.notif.agentDictionary.desc', "エージェントが aivis-mcp で読み上げるときも、ここで選んだ辞書（2.5.3 以降）と、音声報告で調整した ElevenLabs の声の安定度・声の近さ（2.5.4 以降）を使います。SSH で接続中は接続先の aivis-mcp にも反映します。オフにすると、Para Code が設定した値だけを外します。");

export class ParadisAgentDictionarySection extends Disposable {

	private readonly toggle: HTMLInputElement;

	constructor(
		container: HTMLElement,
		@IParadisNotificationsSettingsService private readonly settingsService: IParadisNotificationsSettingsService,
	) {
		super();
		const row = dom.append(container, $('.setting-row'));
		const labels = dom.append(row, $('.sr-main'));
		dom.append(labels, $('.sr-label')).textContent = STR_LABEL;
		dom.append(labels, $('.sr-desc')).textContent = STR_DESC;
		this.toggle = dom.append(row, $('input.pns-toggle')) as HTMLInputElement;
		this.toggle.type = 'checkbox';
		this.toggle.setAttribute('aria-label', STR_LABEL);
		this.refresh();
		this._register(dom.addDisposableListener(this.toggle, 'change', () => {
			this.settingsService.setAivisSettings({ shareDictionaryWithAgents: this.toggle.checked });
		}));
		this._register(this.settingsService.onDidChange(scope => {
			if (scope === 'aivis') {
				this.refresh();
			}
		}));
	}

	private refresh(): void {
		this.toggle.checked = this.settingsService.getAivisSettings().shareDictionaryWithAgents !== false;
	}
}

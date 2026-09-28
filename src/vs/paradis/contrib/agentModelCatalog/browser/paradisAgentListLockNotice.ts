/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントの一覧が設定 `paradis.workspaceSwitch.agents` で決められているとき、選ぶ画面に
// そのことと「既定に戻す」ボタンを出す。新しいスペースの作成と定期実行のダイアログで使う。

import './media/paradisAgentListLockNotice.css';
import * as dom from '../../../../base/browser/dom.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IParadisAgentModelCatalogService, PARADIS_WORKSPACE_AGENTS_SETTING, ParadisAgentListResetResult } from '../common/paradisAgentModelCatalog.js';

const $ = dom.$;

/**
 * `container` の末尾に「設定で固定中」の行を足す。固定されていない間は隠す。
 * 返した IDisposable を捨てると行も消える。
 *
 * 確認で「settings.json を開く」が選ばれたら、`closeHost` で行を置いているダイアログを閉じてから開く。
 * 先に開くと、エディタが前面のダイアログ（新しいスペース・定期実行）の背面に出て編集できない。
 */
export function paradisAppendAgentListLockNotice(container: HTMLElement, modelCatalogService: IParadisAgentModelCatalogService, closeHost: () => void): IDisposable {
	const store = new DisposableStore();
	const notice = dom.append(container, $('.paradis-agent-list-lock'));
	dom.append(notice, $('span.codicon.codicon-lock'));
	const text = dom.append(notice, $('span.paradis-agent-list-lock-text'));
	// allow-any-unicode-next-line
	text.textContent = localize('paradis.agentModelCatalog.fixedBySettings', "エージェントとモデルの一覧は設定 {0} で固定されています。インストール済みの CLI から取った一覧は使いません。", PARADIS_WORKSPACE_AGENTS_SETTING);
	const button = dom.append(notice, $('button.paradis-agent-list-lock-reset')) as HTMLButtonElement;
	button.type = 'button';
	// allow-any-unicode-next-line
	button.textContent = localize('paradis.agentModelCatalog.resetToDefault', "既定に戻す");

	const update = () => notice.classList.toggle('hidden', !modelCatalogService.isFixedBySettings());
	update();
	store.add(modelCatalogService.onDidChange(update));
	store.add(dom.addDisposableListener(button, 'click', async () => {
		button.disabled = true;
		let result: ParadisAgentListResetResult = 'unchanged';
		try {
			result = await modelCatalogService.resetToDefault();
		} finally {
			if (!store.isDisposed) {
				button.disabled = false;
				update();
			}
		}
		if (result === 'openSettings') {
			closeHost();
			await modelCatalogService.openSettingsJson();
		}
	}));
	store.add(toDisposable(() => notice.remove()));
	return store;
}

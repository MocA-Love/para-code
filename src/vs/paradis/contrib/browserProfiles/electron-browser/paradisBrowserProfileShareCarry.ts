/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisAgentBrowserBindingModel } from '../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from '../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';

/** 利用者の切り替えで、作り直したタブとペインの共有を引き継いだ結果。 */
export interface IParadisShareCarryResult<T> {
	/** 作り直したタブ。切り替えられなかったら undefined。 */
	readonly replacement: T | undefined;
	/** 切り替える前にそのタブを共有していたペインの数。 */
	readonly sharedPanes: number;
	/** 作り直したタブへ共有を付け直せたペインの数。 */
	readonly carriedPanes: number;
}

/**
 * タブのプロファイルを利用者が切り替える（ピル・「今のタブも切り替える」）ときに、共有（bind）を引き継ぐ。
 *
 * 切り替えはタブの作り直しで tabId が変わり、古いタブの共有は台帳がタブの消えたのを見て外す。そのため共有先の
 * ペインは切り替える前に控え、作り直したタブを各ペインへ共有し直す（そのペインの current になる）。共有して
 * いなかったタブは何もしない。利用者が自分で切り替えたので確認は挟まない: 直接共有できないタブ（ネットワークの
 * 制限）は upstream が確認やダイアログを出すので、付け直さない。
 */
export async function paradisSwitchKeepingShares<T extends BrowserEditorInput>(
	input: T,
	switchView: () => Promise<T | undefined>,
	bindingModel: Pick<IParadisAgentBrowserBindingModel, 'getBindingsForPage'>,
	agentTabsService: Pick<IParadisAgentBrowserTabsService, 'bindTab'>,
): Promise<IParadisShareCarryResult<T>> {
	const tokens = [...new Set(bindingModel.getBindingsForPage(input.id).map(binding => binding.token))];
	const replacement = await switchView();
	if (!replacement || tokens.length === 0) {
		return { replacement, sharedPanes: tokens.length, carriedPanes: 0 };
	}
	let carriedPanes = 0;
	try {
		const model = await replacement.resolve();
		if (model.isDirectlyShareable && model.sharingState !== BrowserViewSharingState.BlockedByNetworkPolicy) {
			for (const token of tokens) {
				if (await agentTabsService.bindTab(token, replacement)) {
					carriedPanes++;
				}
			}
		}
	} catch {
		// 作り直したタブを開けなかった。共有は引き継がない（切り替え自体は済んでいる）。
	}
	return { replacement, sharedPanes: tokens.length, carriedPanes };
}

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
 * ペインは切り替える前に控え、作り直したタブを各ペインへ共有し直す。共有し直すとそのペインの current
 * （tab_id を省いたときのタブ）が作り直したタブへ移るので、切り替えたタブが current でなかったペインでは、
 * 元の current をもう一度共有して current へ戻す（もう無ければ戻さない）。共有していなかったタブは何もしない。利用者が自分で切り替えたので確認は挟まない: 直接共有できないタブ（ネットワークの
 * 制限）は upstream が確認やダイアログを出すので、付け直さない。
 */
export async function paradisSwitchKeepingShares<T extends BrowserEditorInput>(
	input: T,
	switchView: () => Promise<T | undefined>,
	bindingModel: Pick<IParadisAgentBrowserBindingModel, 'getBindingsForPage' | 'getBindingForToken'>,
	agentTabsService: Pick<IParadisAgentBrowserTabsService, 'bindTab'>,
	findInput: (viewId: string) => BrowserEditorInput | undefined,
): Promise<IParadisShareCarryResult<T>> {
	const tokens = [...new Set(bindingModel.getBindingsForPage(input.id).map(binding => binding.token))];
	// 切り替えたタブではない current（切り替えの後に戻す先）。
	const previousCurrent = new Map<string, string>();
	for (const token of tokens) {
		const current = bindingModel.getBindingForToken(token)?.pageId;
		if (current !== undefined && current !== input.id) {
			previousCurrent.set(token, current);
		}
	}
	const replacement = await switchView();
	if (!replacement || tokens.length === 0) {
		return { replacement, sharedPanes: tokens.length, carriedPanes: 0 };
	}
	let carriedPanes = 0;
	try {
		const model = await replacement.resolve();
		if (model.isDirectlyShareable && model.sharingState !== BrowserViewSharingState.BlockedByNetworkPolicy) {
			for (const token of tokens) {
				if (!await agentTabsService.bindTab(token, replacement)) {
					continue;
				}
				carriedPanes++;
				const restore = previousCurrent.get(token);
				const restoreInput = restore !== undefined ? findInput(restore) : undefined;
				if (restoreInput && !restoreInput.isDisposed()) {
					// 既に共有しているページを共有し直すと、2 枚目以降から current へ戻る（tab_id の接続は保たれる）。
					await agentTabsService.bindTab(token, restoreInput);
				}
			}
		}
	} catch {
		// 作り直したタブを開けなかった。共有は引き継がない（切り替え自体は済んでいる）。
	}
	return { replacement, sharedPanes: tokens.length, carriedPanes };
}

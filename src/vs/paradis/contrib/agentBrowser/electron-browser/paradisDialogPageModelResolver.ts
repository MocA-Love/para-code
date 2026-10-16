/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorsOrder } from '../../../../workbench/common/editor.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IParadisBrowserScopeService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { IParadisDialogPageCandidate, ParadisDialogPageResult, paradisResolveDialogPage, paradisResolveToolbarPage } from './paradisDialogPageResolver.js';

function toCandidate(input: BrowserEditorInput): IParadisDialogPageCandidate<IBrowserViewModel> {
	return {
		id: input.id,
		get page() { return input.model; },
		resolve: () => input.resolve(),
	};
}

/** Browser tabs in the editor groups of every window, most recently active first. */
function getBrowserInputsByRecency(editorService: IEditorService): BrowserEditorInput[] {
	const inputs: BrowserEditorInput[] = [];
	for (const { editor } of editorService.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
		if (editor instanceof BrowserEditorInput && !inputs.includes(editor)) {
			inputs.push(editor);
		}
	}
	return inputs;
}

/**
 * バインディングダイアログの対象ページを解決する（ペインの印・コマンドパレットから開くとき）。
 * サービス参照は待機前に取得し、ServicesAccessor の呼び出し寿命を非同期処理へ持ち越さない。
 */
export function resolveDialogPageModel(accessor: ServicesAccessor, instanceId?: number): Promise<ParadisDialogPageResult<IBrowserViewModel>> {
	const browserViewWorkbenchService = accessor.get(IBrowserViewWorkbenchService);
	const browserScopeService = accessor.get(IParadisBrowserScopeService);
	const editorService = accessor.get(IEditorService);
	let exactPageId: string | undefined;
	if (instanceId !== undefined) {
		const bindingModel = accessor.get(IParadisAgentBrowserBindingModel);
		const paneTokenService = accessor.get(IParadisPaneTokenService);
		const token = paneTokenService.getTokenForInstance(instanceId);
		exactPageId = token ? bindingModel.getBindingForToken(token)?.pageId : undefined;
	}

	return paradisResolveDialogPage({
		exactPageId,
		getKnownCandidate: pageId => {
			const input = browserViewWorkbenchService.getKnownBrowserViews().get(pageId);
			return input ? toCandidate(input) : undefined;
		},
		initializationBarrier: browserScopeService.initializationBarrier,
		getVisibleCandidates: () => {
			const visible = new Set(editorService.visibleEditors);
			return getBrowserInputsByRecency(editorService).filter(input => visible.has(input)).map(toCandidate);
		},
		getContextualCandidates: () => {
			// 作った順（Map の挿入順）ではなく最後に見た順。グループに無いビューはその後ろに足す。
			const inputs = getBrowserInputsByRecency(editorService);
			for (const input of browserViewWorkbenchService.getContextualBrowserViews().values()) {
				if (!inputs.includes(input)) {
					inputs.push(input);
				}
			}
			return inputs.map(toCandidate);
		},
		getStability: pageId => {
			// 先に pending を見る。スコープのフィルタは pending のビューを文脈から外すので、逆だと別スペースと区別できない。
			if (browserScopeService.resolveScope(pageId).kind === 'pending') {
				return 'pending';
			}
			return browserViewWorkbenchService.getContextualBrowserViews().has(pageId) ? 'stable' : 'outOfScope';
		},
	});
}

/**
 * ツールバーの共有ボタンの対象ページ。ツールバーは押されたブラウザエディタを引数で渡す
 * （browserNavigationFeatures.ts の `context = editor`）。ボタンを押してもフォーカスは動かず、
 * アクティブなエディタは直前に触った別のブラウザのままのことがあるので、引数を優先する。
 * 引数が無い（キーバインドから実行した）ときだけアクティブなエディタを使う。
 */
export function resolveToolbarPageModel(accessor: ServicesAccessor, argument: unknown): Promise<ParadisDialogPageResult<IBrowserViewModel>> {
	const clicked = argument instanceof BrowserEditor && argument.input instanceof BrowserEditorInput ? argument.input : undefined;
	const activeEditor = argument === undefined ? accessor.get(IEditorService).activeEditor : undefined;
	const active = activeEditor instanceof BrowserEditorInput ? activeEditor : undefined;
	return paradisResolveToolbarPage(clicked && toCandidate(clicked), active && toCandidate(active));
}

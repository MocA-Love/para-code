/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 統合のモーダルを開く入口。各領域のコマンド（`paradis.usage.showDashboard` など）はここを通して開く。

import * as dom from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ParadisHubAreaId, paradisHubAreas } from './paradisHub.js';
import { IParadisHubClosedState, ParadisHubDialog } from './paradisHubDialog.js';

/** 同時に 1 つだけ開く。同じ窓で開いているときは、その器のまま領域と節を切り替える。 */
let activeDialog: ParadisHubDialog | undefined;

/** 窓ごとの、最後に閉じたときの領域と場所（メモリだけ。窓を閉じれば消える）。 */
const closedStates = new WeakMap<Window, IParadisHubClosedState>();

/**
 * 開き直すときに戻す場所。開く領域が最後に閉じた領域と同じで、節を指定していないときだけ戻す
 * （コマンドが別の領域や節を指定したら、そちらを優先する）。
 */
export function paradisHubResumeTarget(closed: IParadisHubClosedState | undefined, area: ParadisHubAreaId, section: string | undefined): IParadisHubClosedState['view'] {
	return closed && closed.area === area && section === undefined ? closed.view : undefined;
}

/** 統合のモーダルを、領域（と節）を指定して開く。 */
export function paradisOpenHub(accessor: ServicesAccessor, area: ParadisHubAreaId, section?: string): void {
	// 登録されていない領域を渡されたら、別の領域で代わりに開かず、開かなかったことを残す
	if (!paradisHubAreas().some(descriptor => descriptor.id === area)) {
		accessor.get(ILogService).warn(`[ParadisHub] the area '${area}' is not registered; the modal was not opened`);
		return;
	}
	if (activeDialog?.isShownIn(accessor.get(ILayoutService).activeContainer)) {
		activeDialog.open(area, section);
		return;
	}
	// 別の窓で開いていたものは閉じて、いま操作している窓で開き直す
	activeDialog?.dispose();
	const targetWindow = dom.getWindow(accessor.get(ILayoutService).activeContainer);
	const resume = paradisHubResumeTarget(closedStates.get(targetWindow), area, section);
	const dialog = accessor.get(IInstantiationService).createInstance(ParadisHubDialog, area, resume?.section ?? section, resume);
	activeDialog = dialog;
	// 閉じた後も参照を持ち続けると、DOM ごと次に開くまで残る
	Event.once(dialog.onDidDispose)(() => {
		if (dialog.closedState) {
			closedStates.set(targetWindow, dialog.closedState);
		}
		if (activeDialog === dialog) {
			activeDialog = undefined;
		}
	});
}

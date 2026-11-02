/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 使用量の登録。統合のモーダルに「使用量」の領域を登録し、コマンドからその領域を開く。
//
// 引数でタブを指定して開けるので、ccusage / GitHub / rtk それぞれのステータスバーからは
// 対応するタブを指定して開く（3機能の contribution 側が `paradis.usage.showDashboard` を該当タブ付きで呼ぶ）。
//
// 3 つはもともとエディタのタブ (EditorPane) でも開けた。そのタブを開いたまま終えた窓では、復元のときに
// 古いタブの代わりに統合のモーダルの使用量を開く（Q537 の 36 A）。

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { ParadisHubAreaId, paradisRegisterHubArea } from '../../paradisHub/electron-browser/paradisHub.js';
import { paradisOpenHub } from '../../paradisHub/electron-browser/paradisHubOpen.js';
import { ParadisUsageArea, ParadisUsageDashboardTab } from './paradisUsageArea.js';

export const PARADIS_USAGE_DASHBOARD_COMMAND_ID = 'paradis.usage.showDashboard';

paradisRegisterHubArea({
	id: ParadisHubAreaId.Usage,
	// allow-any-unicode-next-line
	label: localize('paradis.usage.areaLabel', "使用量"),
	order: 10,
	create: (instantiationService, containers, host) => instantiationService.createInstance(ParadisUsageArea, containers, host),
});

/** 別 contribution（各ステータスバー）からタブ指定で開くための入口。 */
export function paradisOpenUsageDashboard(accessor: ServicesAccessor, tab?: ParadisUsageDashboardTab): void {
	paradisOpenHub(accessor, ParadisHubAreaId.Usage, tab);
}

class ParadisShowUsageDashboardAction extends Action2 {
	constructor() {
		super({
			id: PARADIS_USAGE_DASHBOARD_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.usage.showDashboard', "使用量ダッシュボードを開く"),
			// allow-any-unicode-next-line
			category: localize2('paradis.usage.category', "Para Code"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor, tab?: ParadisUsageDashboardTab): void {
		paradisOpenUsageDashboard(accessor, tab);
	}
}

registerAction2(ParadisShowUsageDashboardAction);

// ---------- 以前のエディタのタブの復元 ----------

/** 以前のエディタのタブの種類（EditorInput の typeId）と、代わりに開くタブ。 */
const LEGACY_EDITOR_TABS: readonly (readonly [typeId: string, tab: ParadisUsageDashboardTab])[] = [
	['paradis.input.ccusageDashboard', 'ccusage'],
	['paradis.input.githubMetricsDashboard', 'github'],
	['paradis.input.rtkDashboard', 'rtk'],
];

/** 同じ窓で古いタブが複数あっても、モーダルは 1 回だけ開く。 */
let legacyOpenScheduled = false;

/**
 * 古いタブを復元しない（`undefined` を返すとそのタブは捨てられる）代わりに、統合のモーダルの使用量を開く。
 * 復元の途中で開くと窓の組み立てと重なるので、復元が終わった後に開く。
 */
class ParadisLegacyUsageEditorSerializer implements IEditorSerializer {

	constructor(private readonly tab: ParadisUsageDashboardTab) { }

	canSerialize(): boolean {
		return false;
	}

	serialize(): string | undefined {
		return undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput | undefined {
		if (!legacyOpenScheduled) {
			legacyOpenScheduled = true;
			const tab = this.tab;
			setTimeout(() => instantiationService.invokeFunction(accessor => paradisOpenUsageDashboard(accessor, tab)), 0);
		}
		return undefined;
	}
}

for (const [typeId, tab] of LEGACY_EDITOR_TABS) {
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(typeId, class extends ParadisLegacyUsageEditorSerializer {
		constructor() {
			super(tab);
		}
	});
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 左サイドバーの新しいアイコン「資料」（ビューコンテナ。「スペース」の隣）と、そのビュー・まとめ方のメニューを登録する。
// あわせて、利用者が Para Code のプレビューで開いた HTML・Markdown を、持ち主なしで台帳へ載せる（Q664-8: 機能を入れる前に
// 作られた資料は、開いたときに「このセッションの資料にする」を選べる）。登録は書き方を paradisWorkspaceSwitch.contribution.ts の
// 「スペース」と同じにし、本家のファイルには触らない。

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../../workbench/common/views.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { PARADIS_HTML_INPUT_TYPE_ID, PARADIS_MARKDOWN_INPUT_TYPE_ID } from '../../fileViewers/browser/paradisFileViewers.js';
import { paradisDocKind, paradisIsVcsInternalPath } from '../common/paradisAgentDocs.js';
import { PARADIS_AGENT_DOCS_VIEW_CHANNEL, ParadisAgentDocsViewCall, ParadisDocsGrouping } from '../common/paradisAgentDocsView.js';
import { PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY, PARADIS_AGENT_DOCS_VIEW_ID, ParadisAgentDocsView, paradisDocTargetOf, paradisReadDocsGrouping, paradisWindowDocHostId } from './paradisAgentDocsView.js';

const PARADIS_AGENT_DOCS_CONTAINER_ID = 'workbench.view.paradisAgentDocs';

const paradisAgentDocsViewIcon = registerIcon('paradis-agent-docs-view-icon', Codicon.notebook, localize('paradisAgentDocsViewIcon', "Para Code の「資料」ビューのアイコン。"));

const paradisAgentDocsViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: PARADIS_AGENT_DOCS_CONTAINER_ID,
	title: localize2('paradis.agentDocs.viewContainer', "資料"),
	icon: paradisAgentDocsViewIcon,
	// 「スペース」（order 0）のすぐ後ろ
	order: 0.5,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [PARADIS_AGENT_DOCS_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: `${PARADIS_AGENT_DOCS_CONTAINER_ID}.state`,
	hideIfEmpty: false,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: PARADIS_AGENT_DOCS_VIEW_ID,
	name: localize2('paradis.agentDocs.viewName', "資料"),
	containerIcon: paradisAgentDocsViewIcon,
	canMoveView: true,
	canToggleVisibility: false,
	ctorDescriptor: new SyncDescriptor(ParadisAgentDocsView),
	openCommandActionDescriptor: {
		id: 'paradis.agentDocs.showView',
		order: 0,
	},
}], paradisAgentDocsViewContainer);

// --- まとめ方（ビューのタイトルのメニュー） ------------------------------------------------------

const GROUPING_CONTEXT_KEY = new RawContextKey<ParadisDocsGrouping>('paradisAgentDocsGrouping', 'session');
const GROUPING_MENU = new MenuId('ParadisAgentDocsGrouping');

MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
	submenu: GROUPING_MENU,
	title: localize('paradis.agentDocs.grouping', "まとめ方"),
	icon: Codicon.groupByRefType,
	when: ContextKeyExpr.equals('view', PARADIS_AGENT_DOCS_VIEW_ID),
	group: 'navigation',
	order: 1,
});

const GROUPINGS: readonly { readonly value: ParadisDocsGrouping; readonly title: string }[] = [
	{ value: 'session', title: localize('paradis.agentDocs.grouping.session', "セッションごと") },
	{ value: 'date', title: localize('paradis.agentDocs.grouping.date', "日付ごと") },
	{ value: 'folder', title: localize('paradis.agentDocs.grouping.folder', "フォルダごと") },
];

GROUPINGS.forEach(({ value, title }, index) => {
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: `paradis.agentDocs.groupBy.${value}`,
				title,
				toggled: GROUPING_CONTEXT_KEY.isEqualTo(value),
				menu: [{ id: GROUPING_MENU, group: 'navigation', order: index }],
			});
		}

		run(accessor: ServicesAccessor): void {
			accessor.get(IStorageService).store(PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY, value, StorageScope.PROFILE, StorageTarget.USER);
		}
	});
});

// --- 窓ごとの仕事: まとめ方の印と、利用者が開いた資料の登録 ---------------------------------------

class ParadisAgentDocsViewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisAgentDocsView';

	constructor(
		@IStorageService storageService: IStorageService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly _editorService: IEditorService,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		const grouping = GROUPING_CONTEXT_KEY.bindTo(contextKeyService);
		grouping.set(paradisReadDocsGrouping(storageService));
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, PARADIS_AGENT_DOCS_GROUPING_STORAGE_KEY, this._store)(() => grouping.set(paradisReadDocsGrouping(storageService))));

		const windowHostId = paradisWindowDocHostId(environmentService.remoteAuthority);
		const registerActive = () => this._registerOpened(windowHostId);
		this._register(_editorService.onDidActiveEditorChange(registerActive));
		registerActive();
	}

	/** 表示中のエディタが Para Code の Markdown・HTML のプレビューなら、まだ台帳に無いときだけ持ち主なしで載せる。 */
	private _registerOpened(windowHostId: string): void {
		const editor = this._editorService.activeEditor;
		if (editor === undefined || (editor.typeId !== PARADIS_MARKDOWN_INPUT_TYPE_ID && editor.typeId !== PARADIS_HTML_INPUT_TYPE_ID) || editor.resource === undefined) {
			return;
		}
		const target = paradisDocTargetOf(editor.resource, windowHostId);
		if (target === undefined || paradisDocKind(target.path) === undefined || paradisIsVcsInternalPath(target.path)) {
			return;
		}
		this._sharedProcessService.getChannel(PARADIS_AGENT_DOCS_VIEW_CHANNEL).call(ParadisAgentDocsViewCall.RegisterOpened, [target.hostId, target.path]).catch(() => undefined);
	}
}

registerWorkbenchContribution2(ParadisAgentDocsViewContribution.ID, ParadisAgentDocsViewContribution, WorkbenchPhase.AfterRestored);

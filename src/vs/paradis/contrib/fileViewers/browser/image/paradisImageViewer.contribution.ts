/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 画像ビューア（web/desktop 両対応）の登録入り口。paradis.common.contribution.ts から import される。
// EditorPane / シリアライザ / 設定 / EditorResolver / コマンドをここで登録する。
// upstream の画像プレビュー（extensions/media-preview）は触らずに残し、設定でオフにすればそちらで開く。

import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../../workbench/browser/editor.js';
import { ActiveEditorContext, ResourceContextKey } from '../../../../../workbench/common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { DEFAULT_EDITOR_ASSOCIATION, EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { DiffEditorInput } from '../../../../../workbench/common/editor/diffEditorInput.js';
import { TEXT_FILE_EDITOR_ID } from '../../../../../workbench/contrib/files/common/files.js';
import { IEditorResolverService } from '../../../../../workbench/services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_IMAGE_VIEWER_LABEL, registerParadisImageEditors } from './paradisImageEditorRegistration.js';
import { formatParadisImageScale, getActiveParadisImageEditor, PARADIS_IMAGE_SELECT_ZOOM_COMMAND_ID, ParadisImageFileEditor } from './paradisImageFileEditor.js';
import { ParadisImageInput, ParadisImageInputSerializer } from './paradisImageInput.js';
import { PARADIS_IMAGE_EDITOR_ID, PARADIS_IMAGE_INPUT_TYPE_ID, PARADIS_IMAGE_PICKABLE_SCALES, PARADIS_IMAGE_VIEWER_ENABLED_KEY, ParadisImageScale } from './paradisImagePreview.js';

/**
 * upstream の画像プレビューが「SVG のテキストエディタに『画像プレビューとして開き直す』を出すか」に使う
 * context key（`!hasCustomImagePreview` のときだけ出す）。こちらのビューアが有効なあいだは true にして、
 * upstream のボタンの代わりにこちらのボタンを出す。
 */
const HAS_CUSTOM_IMAGE_PREVIEW = new RawContextKey<boolean>('hasCustomImagePreview', false);

// allow-any-unicode-next-line
const CATEGORY = localize2('paradis.imagePreview.category', "画像プレビュー");
const imageEditorActive = ActiveEditorContext.isEqualTo(PARADIS_IMAGE_EDITOR_ID);
const isSvg = ResourceContextKey.Extension.isEqualTo('.svg');

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'paradis',
	order: 999,
	title: localize('paradisConfigurationTitle', "Para Code"),
	type: 'object',
	properties: {
		[PARADIS_IMAGE_VIEWER_ENABLED_KEY]: {
			type: 'boolean',
			default: true,
			// allow-any-unicode-next-line
			description: localize('paradis.imageViewer.enabled', "画像（PNG・JPEG・GIF・WebP・SVG など）を Para Code の画像ビューアで開きます。オフにすると、従来の画像プレビュー（拡張機能）で開きます。"),
		},
	},
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(ParadisImageFileEditor, PARADIS_IMAGE_EDITOR_ID, PARADIS_IMAGE_VIEWER_LABEL),
	[new SyncDescriptor(ParadisImageInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	PARADIS_IMAGE_INPUT_TYPE_ID,
	ParadisImageInputSerializer
);

class ParadisImageViewerResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'paradis.contrib.imageViewerResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IFileService fileService: IFileService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const isEnabled = () => configurationService.getValue<boolean>(PARADIS_IMAGE_VIEWER_ENABLED_KEY) !== false;
		this._register(registerParadisImageEditors(editorResolverService, {
			isEnabled,
			canRead: resource => resource.scheme !== Schemas.untitled && fileService.hasProvider(resource),
			createInput: resource => instantiationService.createInstance(ParadisImageInput, resource),
			createDiffInput: (label, description, original, modified) => instantiationService.createInstance(DiffEditorInput, label, description, original, modified, true),
		}));

		const hasCustomImagePreview = HAS_CUSTOM_IMAGE_PREVIEW.bindTo(contextKeyService);
		hasCustomImagePreview.set(isEnabled());
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_IMAGE_VIEWER_ENABLED_KEY)) {
				hasCustomImagePreview.set(isEnabled());
			}
		}));
	}
}

registerWorkbenchContribution2(ParadisImageViewerResolverContribution.ID, ParadisImageViewerResolverContribution, WorkbenchPhase.BlockStartup);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.imagePreview.zoomIn',
			// allow-any-unicode-next-line
			title: localize2('paradis.imagePreview.zoomIn', "拡大"),
			category: CATEGORY,
			f1: true,
			precondition: imageEditorActive,
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveParadisImageEditor(accessor.get(IEditorService))?.zoomIn();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.imagePreview.zoomOut',
			// allow-any-unicode-next-line
			title: localize2('paradis.imagePreview.zoomOut', "縮小"),
			category: CATEGORY,
			f1: true,
			precondition: imageEditorActive,
		});
	}

	override run(accessor: ServicesAccessor): void {
		getActiveParadisImageEditor(accessor.get(IEditorService))?.zoomOut();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PARADIS_IMAGE_SELECT_ZOOM_COMMAND_ID,
			// allow-any-unicode-next-line
			title: localize2('paradis.imagePreview.selectZoomLevel', "ズーム レベルの選択"),
			category: CATEGORY,
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editor = getActiveParadisImageEditor(accessor.get(IEditorService));
		if (!editor) {
			return;
		}
		const items: (IQuickPickItem & { scale: ParadisImageScale })[] = PARADIS_IMAGE_PICKABLE_SCALES.map(scale => ({ label: formatParadisImageScale(scale), scale }));
		const pick = await accessor.get(IQuickInputService).pick(items, {
			// allow-any-unicode-next-line
			placeHolder: localize('paradis.imagePreview.selectZoomLevelPlaceholder', "ズーム レベルの選択"),
		});
		if (pick) {
			editor.setScale(pick.scale);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'paradis.imagePreview.reopenAsText',
			// allow-any-unicode-next-line
			title: localize2('paradis.imagePreview.reopenAsText', "ソース テキストとして開き直す"),
			category: CATEGORY,
			icon: Codicon.goToFile,
			f1: true,
			precondition: ContextKeyExpr.and(imageEditorActive, isSvg),
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: ContextKeyExpr.and(imageEditorActive, isSvg) }],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('reopenActiveEditorWith', DEFAULT_EDITOR_ASSOCIATION.id);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		const when = ContextKeyExpr.and(ActiveEditorContext.isEqualTo(TEXT_FILE_EDITOR_ID), isSvg, HAS_CUSTOM_IMAGE_PREVIEW);
		super({
			id: 'paradis.imagePreview.reopenAsPreview',
			// allow-any-unicode-next-line
			title: localize2('paradis.imagePreview.reopenAsPreview', "画像プレビューとして開き直す"),
			category: CATEGORY,
			icon: Codicon.preview,
			f1: true,
			precondition: when,
			menu: [{ id: MenuId.EditorTitle, group: 'navigation', when }],
		});
	}

	override run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand('reopenActiveEditorWith', PARADIS_IMAGE_EDITOR_ID);
	}
});

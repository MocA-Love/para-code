/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 通常のテキストエディタ(Raw)で .md/.html を開いているとき、エディタ右上(minimapの左)に
// 「Rendered | Raw」のセグメントトグルを IOverlayWidget として常時表示する。
// Raw 側にはペイン内ツールバーが無く、タイトルバーの Show Preview アクションが「…」に畳まれると
// Rendered に戻れなくなるため、ビューア側ツールバーと見た目を揃えたトグルをここで補う。

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ICodeEditor, IOverlayWidget, IOverlayWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { PARADIS_HTML_EDITOR_ID, PARADIS_MARKDOWN_EDITOR_ID, isParadisHtmlResource, isParadisMarkdownResource } from './paradisFileViewers.js';

const $ = dom.$;

export class ParadisFileViewerEditorToggle extends Disposable implements IEditorContribution {

	static readonly ID = 'paradis.fileViewer.editorToggle';

	private readonly _domNode: HTMLElement;
	private _added = false;

	constructor(
		private readonly _editor: ICodeEditor,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super();

		this._domNode = $('.paradis-editor-toggle');
		const renderedBtn = dom.append(this._domNode, $('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		renderedBtn.textContent = localize('paradis.fileViewer.rendered', "Rendered");
		this._register(dom.addDisposableListener(renderedBtn, dom.EventType.CLICK, () => this._openRendered()));
		const rawBtn = dom.append(this._domNode, $('button.paradis-file-viewer-toggle-item.active')) as HTMLButtonElement;
		rawBtn.textContent = localize('paradis.fileViewer.raw', "Raw");

		this._register(this._editor.onDidChangeModel(() => this._update()));
		this._register(this._editor.onDidChangeConfiguration(e => {
			if (e.hasChanged(EditorOption.inDiffEditor)) {
				this._update();
			}
		}));
		this._register(this._editor.onDidLayoutChange(() => {
			if (this._added) {
				this._editor.layoutOverlayWidget(this._overlayWidget);
			}
		}));

		this._update();
	}

	/** 現在のリソースが対象(.md/.html を通常テキストで表示中)なら、開き直す override(ビューアID)を返す。 */
	private _viewableOverride(): string | undefined {
		const model = this._editor.getModel();
		if (!model) {
			return undefined;
		}
		// diff 内エディタ・埋め込み/出力等には出さない(対象は file/vscode-remote スキームの通常テキストのみ)。
		if (this._editor.getOption(EditorOption.inDiffEditor)) {
			return undefined;
		}
		const resource = model.uri;
		if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.vscodeRemote) {
			return undefined;
		}
		if (isParadisHtmlResource(resource)) {
			return PARADIS_HTML_EDITOR_ID;
		}
		if (isParadisMarkdownResource(resource)) {
			return PARADIS_MARKDOWN_EDITOR_ID;
		}
		return undefined;
	}

	private _update(): void {
		const shouldShow = !!this._viewableOverride();
		if (shouldShow && !this._added) {
			this._editor.addOverlayWidget(this._overlayWidget);
			this._added = true;
		} else if (!shouldShow && this._added) {
			this._editor.removeOverlayWidget(this._overlayWidget);
			this._added = false;
		}
	}

	private _openRendered(): void {
		const override = this._viewableOverride();
		const resource = this._editor.getModel()?.uri;
		if (!override || !resource) {
			return;
		}
		void this._editorService.openEditor({ resource, options: { override } });
	}

	private readonly _overlayWidget: IOverlayWidget = {
		getId: () => `${ParadisFileViewerEditorToggle.ID}.widget`,
		getDomNode: () => this._domNode,
		getPosition: (): IOverlayWidgetPosition => {
			const info = this._editor.getLayoutInfo();
			const width = this._domNode.offsetWidth || 96;
			// コンテンツ領域右上角にぴったり寄せ、minimap/縦スクロールバーの左に 5px の余白で隣接させる。
			return {
				preference: {
					top: 4,
					left: Math.max(0, info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth - width - 5)
				}
			};
		},
	};

	override dispose(): void {
		if (this._added) {
			this._editor.removeOverlayWidget(this._overlayWidget);
			this._added = false;
		}
		super.dispose();
	}
}

registerEditorContribution(ParadisFileViewerEditorToggle.ID, ParadisFileViewerEditorToggle, EditorContributionInstantiation.AfterFirstRender);

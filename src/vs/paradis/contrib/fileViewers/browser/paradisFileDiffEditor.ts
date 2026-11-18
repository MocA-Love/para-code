/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MD/HTML ビューア共用の差分 EditorPane。本体は標準の DiffEditorWidget を埋め込む（テキスト差分）。
// Markdown では上にバーを置き、描いた見た目どうしの「プレビュー差分」に切り替えられる
// （paradisMarkdownRenderedDiffView）。HTML のプレビュー差分はデスクトップだけで、electron-browser から
// paradisRenderedDiffViews に登録される。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IReference, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { paradisFollowModelReadonly } from './paradisModelReadonly.js';
import { URI } from '../../../../base/common/uri.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { isParadisMarkdownResource, PARADIS_FILE_DIFF_EDITOR_ID } from './paradisFileViewers.js';
import { ParadisFileDiffInput } from './paradisFileDiffInput.js';
import { ParadisMarkdownRenderedDiffView } from './paradisMarkdownRenderedDiffView.js';
import { IParadisRenderedDiffViewFactory, paradisRenderedDiffViewFactoryFor } from './paradisRenderedDiffViews.js';

/** Markdown のプレビュー差分（ほかの種類は paradisRenderedDiffViews に登録される）。 */
const MARKDOWN_RENDERED_DIFF: IParadisRenderedDiffViewFactory = {
	matches: isParadisMarkdownResource,
	create: (instantiationService, host) => instantiationService.createInstance(ParadisMarkdownRenderedDiffView, host),
};

import './media/paradisFileViewer.css';

export class ParadisFileDiffEditor extends EditorPane {

	static readonly ID = PARADIS_FILE_DIFF_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _contentElement: HTMLElement | undefined;
	private _diffContainer: HTMLElement | undefined;
	private _widget: DiffEditorWidget | undefined;
	/** いまの差分のバーとプレビュー差分（Markdown・HTML。プレビュー差分の無い種類では `undefined`）。 */
	private _rendered: ParadisMarkdownRenderedDiffView | undefined;
	/** 種類ごとに、最初にその種類の差分を開いたときに作った部品。 */
	private readonly _renderedViews = new Map<IParadisRenderedDiffViewFactory, ParadisMarkdownRenderedDiffView>();
	/** 最後に受け取った幅（後から使い始めた部品にも渡す。狭い幅で 1 列にする判定に使う）。 */
	private _width = 0;
	private readonly _modelRefs = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
	) {
		super(PARADIS_FILE_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-file-viewer'));

		// バーは Markdown のときだけ、プレビュー差分の部品が content の上に置く。
		this._contentElement = dom.append(this._rootElement, dom.$('.paradis-file-viewer-content'));
		this._diffContainer = dom.append(this._contentElement, dom.$('.paradis-file-viewer-editor.active'));
	}

	private _ensureRendered(factory: IParadisRenderedDiffViewFactory): ParadisMarkdownRenderedDiffView {
		let view = this._renderedViews.get(factory);
		if (!view) {
			view = this._register(factory.create(this._instantiationService, {
				root: this._rootElement!,
				content: this._contentElement!,
				window: () => this.window,
				setTextVisible: visible => {
					// visibility だけでは差分の部品の中の要素が見えたまま残るので、プレビュー差分の間は置かない。
					this._diffContainer?.classList.toggle('active', visible);
					this._diffContainer?.classList.toggle('paradis-rendered-diff-text-hidden', !visible);
				},
			}));
			this._renderedViews.set(factory, view);
		}
		if (this._rendered !== view) {
			this._rendered?.clearInput();
			this._rendered = view;
			view.layout(this._width);
			view.setVisible(this.isVisible());
		}
		return view;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const diffInput = input as ParadisFileDiffInput;
		const store = new DisposableStore();
		this._modelRefs.value = store;

		const acquireModelReference = async (resource: URI): Promise<IReference<IResolvedTextEditorModel> | undefined> => {
			const reference = await this._textModelService.createModelReference(resource);
			if (token.isCancellationRequested || this.input !== input || this._modelRefs.value !== store) {
				reference.dispose();
				return undefined;
			}
			store.add(reference);
			return reference;
		};

		let originalRef: IReference<IResolvedTextEditorModel> | undefined;
		let modifiedRef: IReference<IResolvedTextEditorModel> | undefined;
		try {
			[originalRef, modifiedRef] = await Promise.all([
				acquireModelReference(diffInput.originalResource),
				acquireModelReference(diffInput.modifiedResource),
			]);
		} catch (error) {
			// 自分がまだ現役の store のときだけ共有状態を破棄する。
			// 後続 setInput に差し替えられていれば触らない（その store は後続が管理する）。
			if (this._modelRefs.value === store) {
				this._modelRefs.clear();
			}
			throw error;
		}

		if (!originalRef || !modifiedRef || token.isCancellationRequested || this.input !== input || this._modelRefs.value !== store) {
			if (this._modelRefs.value === store) {
				this._modelRefs.clear();
			} else {
				store.dispose();
			}
			return;
		}

		const widget = this._ensureWidget();
		widget.setModel({
			original: originalRef.object.textEditorModel,
			modified: modifiedRef.object.textEditorModel,
		});
		// 変更後の側は編集できる。読み取り専用のファイルなら編集させない（編集しても保存されずに消えるため）
		store.add(paradisFollowModelReadonly(modifiedRef.object, options => widget.updateOptions(options)));
		const factory = MARKDOWN_RENDERED_DIFF.matches(diffInput.modifiedResource) ? MARKDOWN_RENDERED_DIFF : paradisRenderedDiffViewFactoryFor(diffInput.modifiedResource);
		if (factory) {
			this._ensureRendered(factory).setInput(diffInput.originalResource, diffInput.modifiedResource, originalRef.object.textEditorModel, modifiedRef.object.textEditorModel);
		} else {
			this._rendered?.clearInput();
			this._rendered = undefined;
		}
	}

	private _ensureWidget(): DiffEditorWidget {
		if (!this._widget) {
			this._widget = this._register(this._instantiationService.createInstance(
				DiffEditorWidget,
				this._diffContainer!,
				{
					automaticLayout: true,
					scrollBeyondLastLine: false,
					originalEditable: false,
					readOnly: false,
				},
				{}
			));
		}
		return this._widget;
	}

	override clearInput(): void {
		this._rendered?.clearInput();
		this._widget?.setModel(null);
		this._modelRefs.clear();
		super.clearInput();
	}

	override getControl(): IDiffEditor | undefined {
		// プレビュー差分を出している間は、テキスト差分の操作（AI メモ・差分の移動など）を隠れた部品へ向けない。
		return this._rendered?.mode === 'rendered' ? undefined : this._widget;
	}

	override focus(): void {
		super.focus();
		if (this._rendered?.mode === 'rendered') {
			this._rendered.focus();
		} else {
			this._widget?.focus();
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		this._rendered?.setVisible(visible);
		super.setEditorVisible(visible);
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		// DiffEditorWidget は automaticLayout: true でコンテナへ自動追従する。
		this._width = dimension.width;
		this._rendered?.layout(dimension.width);
		// タブの切り替えでペインが 0x0 に畳まれる経路でも、プレビュー差分の webview を手放す。
		this._rendered?.setVisible(this.isVisible() && dimension.width > 0 && dimension.height > 0);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MD/HTML ビューア共用のテキスト差分 EditorPane。通常ビューアと同じ見た目のヘッダー
// (paradisFileViewer.css のツールバー)を上に載せ、本体は標準の DiffEditorWidget を埋め込む。
// レンダリング済みの見た目同士の差分(変更ハイライト付き)は対応しない方針(コスト対効果が合わない)。
// 将来「Rendered 並列表示」を足す場合はこのヘッダーのトグルに追加する。

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, IReference, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
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
import { PARADIS_FILE_DIFF_EDITOR_ID } from './paradisFileViewers.js';
import { ParadisFileDiffInput } from './paradisFileDiffInput.js';

import './media/paradisFileViewer.css';

export class ParadisFileDiffEditor extends EditorPane {

	static readonly ID = PARADIS_FILE_DIFF_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _diffContainer: HTMLElement | undefined;
	private _widget: DiffEditorWidget | undefined;
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

		// 通常ビューアと同じ見た目のヘッダー。現状は Raw(テキスト差分)のみなので表示だけのトグルを置く。
		const toolbar = dom.append(this._rootElement, dom.$('.paradis-file-viewer-toolbar'));
		const toggle = dom.append(toolbar, dom.$('.paradis-file-viewer-toggle'));
		const rawBtn = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item.active')) as HTMLButtonElement;
		rawBtn.textContent = localize('paradis.fileViewer.rawDiff', "Raw Diff");
		rawBtn.disabled = true;
		dom.append(toolbar, dom.$('.paradis-file-viewer-toolbar-right'));

		const content = dom.append(this._rootElement, dom.$('.paradis-file-viewer-content'));
		this._diffContainer = dom.append(content, dom.$('.paradis-file-viewer-editor.active'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		const diffInput = input as ParadisFileDiffInput;
		const store = new DisposableStore();
		this._modelRefs.value = store;

		let originalRef: IReference<IResolvedTextEditorModel>;
		let modifiedRef: IReference<IResolvedTextEditorModel>;
		try {
			[originalRef, modifiedRef] = await Promise.all([
				this._textModelService.createModelReference(diffInput.originalResource),
				this._textModelService.createModelReference(diffInput.modifiedResource),
			]);
		} catch (error) {
			// 自分がまだ現役の store のときだけ共有状態を破棄する。
			// 後続 setInput に差し替えられていれば触らない（その store は後続が管理する）。
			if (this._modelRefs.value === store) {
				this._modelRefs.clear();
			}
			throw error;
		}

		// await 中に入力が切り替わった/キャンセルされた場合、共有の _modelRefs は既に
		// 後続 setInput の store を指している可能性がある。共有状態には触れず、自分が
		// 取得した参照だけを破棄して return する（誤破棄・リークの両方を防ぐ）。
		if (token.isCancellationRequested || this.input !== input || this._modelRefs.value !== store) {
			originalRef.dispose();
			modifiedRef.dispose();
			return;
		}

		store.add(originalRef);
		store.add(modifiedRef);

		const widget = this._ensureWidget();
		widget.setModel({
			original: originalRef.object.textEditorModel,
			modified: modifiedRef.object.textEditorModel,
		});
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
		this._widget?.setModel(null);
		this._modelRefs.clear();
		super.clearInput();
	}

	override getControl(): IDiffEditor | undefined {
		return this._widget;
	}

	override focus(): void {
		super.focus();
		this._widget?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		// DiffEditorWidget は automaticLayout: true でコンテナへ自動追従する。
	}
}

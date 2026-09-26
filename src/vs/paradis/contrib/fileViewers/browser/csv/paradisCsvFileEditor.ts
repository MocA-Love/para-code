/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV / TSV ビューアの EditorPane。Markdown ビューアと同じ「単一ペイン内蔵方式」で、1 つのペインに
// 表（ParadisCsvTableView、読み取り専用）とテキスト（埋め込み CodeEditorWidget、編集・保存できる）を持ち、
// 上部の「表 | テキスト」で切り替える（開き直さないのでタブは常に 1 つ）。
//
// 表の元になる文字列は、テキスト側に未保存の変更があればそのモデルの値、無ければディスクの内容。
// ディスク上の変更は correlated watcher で拾い、表を表示中なら読み直す（スクロール位置・並べ替え・列幅は保つ）。
// 大きなファイルは先頭 PARADIS_CSV_MAX_BYTES バイト / PARADIS_CSV_MAX_RECORDS 行だけを表にし、その旨と
// 「テキストで開く」を表の上に出す。索引作りは少しずつ区切って行い、その間も UI を止めない。

import * as dom from '../../../../../base/browser/dom.js';
import { RunOnceScheduler, timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { DisposableStore, IReference, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extname, isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IEditorConstructionOptions } from '../../../../../editor/browser/config/editorConfiguration.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../../workbench/services/textfile/common/textfiles.js';
import {
	detectParadisCsvDelimiter,
	PARADIS_CSV_MAX_BYTES,
	ParadisCsvIndexer,
	type ParadisCsvDelimiter,
	type ParadisCsvDocument,
} from '../../common/csv/paradisCsv.js';
import { ParadisCsvFileInput, PARADIS_CSV_EDITOR_ID, rememberParadisCsvViewMode, type ParadisCsvViewMode } from './paradisCsvFileInput.js';
import { ParadisCsvTableView } from './paradisCsvTableView.js';

import '../media/paradisFileViewer.css';

const TEXT_EDITOR_OPTIONS: IEditorConstructionOptions = {
	automaticLayout: true,
	scrollBeyondLastLine: false,
	readOnly: false,
};

/** 1 回の区切りで索引を作る文字数。数十 ms で UI へ戻れる量。 */
const INDEX_CHUNK_CODE_UNITS = 4_000_000;

interface LoadedText {
	readonly text: string;
	/** ファイルの先頭の一部だけを読んだ。 */
	readonly truncated: boolean;
}

export class ParadisCsvFileEditor extends EditorPane {

	static readonly ID = PARADIS_CSV_EDITOR_ID;

	private _rootElement: HTMLElement | undefined;
	private _tableButton: HTMLButtonElement | undefined;
	private _textButton: HTMLButtonElement | undefined;
	private _noticeElement: HTMLElement | undefined;
	private _noticeText: HTMLElement | undefined;
	private _tableArea: HTMLElement | undefined;
	private _messageElement: HTMLElement | undefined;
	private _editorContainer: HTMLElement | undefined;
	private _footerElement: HTMLElement | undefined;
	private _tableView: ParadisCsvTableView | undefined;

	private _codeEditor: ICodeEditor | undefined;
	private readonly _modelRef = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly _modelListener = this._register(new MutableDisposable());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _loadRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _messageListener = this._register(new MutableDisposable());

	private _currentResource: URI | undefined;
	private _mode: ParadisCsvViewMode = 'table';
	private _loadGeneration = 0;
	/** 表が今の内容より古い（テキスト側の編集やディスクの変更をまだ反映していない）。 */
	private _tableStale = true;
	private _missingResource: URI | undefined;
	private _delimiter: ParadisCsvDelimiter = ',';
	private _loading = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super(PARADIS_CSV_EDITOR_ID, group, telemetryService, themeService, _storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._rootElement = dom.append(parent, dom.$('.paradis-file-viewer.paradis-csv-viewer'));

		// Markdown ビューアの「プレビュー | ソース」と同じ部品・同じ位置に「表 | テキスト」を置く。
		const toolbar = dom.append(this._rootElement, dom.$('.paradis-file-viewer-toolbar'));
		const toggle = dom.append(toolbar, dom.$('.paradis-file-viewer-toggle'));
		this._tableButton = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		this._tableButton.textContent = localize('paradis.csv.table', "表");
		this._register(dom.addDisposableListener(this._tableButton, dom.EventType.CLICK, () => this.setViewMode('table')));
		this._textButton = dom.append(toggle, dom.$('button.paradis-file-viewer-toggle-item')) as HTMLButtonElement;
		this._textButton.textContent = localize('paradis.csv.text', "テキスト");
		this._register(dom.addDisposableListener(this._textButton, dom.EventType.CLICK, () => this.setViewMode('text')));
		dom.append(toolbar, dom.$('.paradis-file-viewer-toolbar-right'));

		this._noticeElement = dom.append(this._rootElement, dom.$('.paradis-csv-notice'));
		this._noticeText = dom.append(this._noticeElement, dom.$('span'));
		const openAsText = dom.append(this._noticeElement, dom.$('button.paradis-csv-link-button')) as HTMLButtonElement;
		openAsText.textContent = localize('paradis.csv.openAsText', "テキストで開く");
		this._register(dom.addDisposableListener(openAsText, dom.EventType.CLICK, () => this.setViewMode('text')));

		const content = dom.append(this._rootElement, dom.$('.paradis-file-viewer-content'));
		this._tableArea = dom.append(content, dom.$('.paradis-csv-table-area'));
		this._tableView = this._register(new ParadisCsvTableView(this._tableArea, {
			writeClipboard: text => this._clipboardService.writeText(text),
			notify: message => this._notificationService.notify({ severity: Severity.Info, message }),
			onDidChangeState: () => this._updateFooter(),
		}));
		this._messageElement = dom.append(this._tableArea, dom.$('.paradis-csv-message'));
		this._editorContainer = dom.append(content, dom.$('.paradis-file-viewer-editor'));

		this._footerElement = dom.append(this._rootElement, dom.$('.paradis-csv-footer'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const csvInput = input as ParadisCsvFileInput;
		const resource = csvInput.resource;
		const sameResource = isEqual(this._currentResource, resource);
		this._currentResource = resource;
		this._missingResource = undefined;
		if (!sameResource) {
			this._cancelLoad();
			this._modelListener.clear();
			this._modelRef.clear();
			this._codeEditor?.setModel(null);
			this._tableView?.setDocument(undefined, false);
			this._tableStale = true;
			this._updateNotice(undefined);
		}

		const store = new DisposableStore();
		this._inputDisposables.value = store;
		const reload = () => {
			if (!isEqual(this._currentResource, resource)) {
				return;
			}
			this._tableStale = true;
			if (this._mode === 'table') {
				this._loadTable(resource, true).catch(onUnexpectedError);
			}
		};
		const reloadScheduler = store.add(new RunOnceScheduler(reload, 100));
		// watch エラーはワークスペース全体から連続して届く場合があるため、通常の変更通知より長くまとめる。
		const watchRecoveryScheduler = store.add(new RunOnceScheduler(reload, 1000));
		try {
			const watcher = store.add(this._fileService.createWatcher(resource, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource)) {
					reloadScheduler.schedule();
				}
			}));
		} catch {
			// watcher を作れなくても表示自体は続けられる。
		}
		store.add(this._fileService.onDidWatchError(() => {
			if (!isEqual(this._missingResource, resource) && !watchRecoveryScheduler.isScheduled()) {
				watchRecoveryScheduler.schedule();
			}
		}));

		// 表の読み込み（大きなファイルでは時間がかかる）はタブを開く処理から切り離し、その間は「読み込み中…」を出す。
		const applied = this._applyViewMode(csvInput.csvViewMode, resource, false);
		if (csvInput.csvViewMode === 'text') {
			await applied;
		} else {
			applied.catch(onUnexpectedError);
		}
	}

	/** 「表 | テキスト」をユーザーが切り替えた。ファイルごとに覚え、次に開いたときも同じ表示にする。 */
	setViewMode(mode: ParadisCsvViewMode): void {
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		if (this.input instanceof ParadisCsvFileInput) {
			this.input.setCsvViewMode(mode);
		}
		rememberParadisCsvViewMode(this._storageService, resource, mode);
		this._applyViewMode(mode, resource, true).catch(onUnexpectedError);
	}

	getViewMode(): ParadisCsvViewMode {
		return this._mode;
	}

	/** 表示を切り替える。`focus` はユーザーが切り替えたときだけ true（開いただけでフォーカスを奪わない）。 */
	private async _applyViewMode(mode: ParadisCsvViewMode, resource: URI, focus: boolean): Promise<void> {
		this._mode = mode;
		this._tableButton?.classList.toggle('active', mode === 'table');
		this._textButton?.classList.toggle('active', mode === 'text');
		this._tableArea?.classList.toggle('hidden', mode !== 'table');
		this._footerElement?.classList.toggle('hidden', mode !== 'table');
		this._noticeElement?.classList.toggle('visible', mode === 'table' && !!this._noticeText?.textContent);

		if (mode === 'text') {
			await this._ensureTextEditor(resource);
			if (!isEqual(this._currentResource, resource) || this._mode !== mode) {
				return;
			}
			this._editorContainer?.classList.add('active');
			// ステータスバー（行・列、改行コード等）や拡張機能が見る「アクティブなエディタ」を切り替える。
			this._onDidChangeControl.fire();
			if (focus) {
				this._codeEditor?.focus();
			}
			return;
		}

		this._editorContainer?.classList.remove('active');
		this._onDidChangeControl.fire();
		if (this._tableStale || !this._tableView?.document) {
			await this._loadTable(resource, !!this._tableView?.document);
		} else {
			this._tableView?.layout();
		}
		if (focus && isEqual(this._currentResource, resource) && this._mode === mode) {
			this._tableView?.focus();
		}
	}

	private async _ensureTextEditor(resource: URI): Promise<void> {
		if (!this._codeEditor) {
			this._codeEditor = this._register(this._instantiationService.createInstance(CodeEditorWidget, this._editorContainer!, TEXT_EDITOR_OPTIONS, {}));
		}
		if (this._modelRef.value && isEqual(this._modelRef.value.object.textEditorModel.uri, resource)) {
			return;
		}
		const ref = await this._textModelService.createModelReference(resource);
		if (!isEqual(this._currentResource, resource)) {
			ref.dispose();
			return;
		}
		this._modelRef.value = ref;
		const model = ref.object.textEditorModel;
		this._codeEditor.setModel(model);
		// テキスト側で編集したら、次に表へ戻ったとき読み直す。
		this._modelListener.value = model.onDidChangeContent(() => this._tableStale = true);
	}

	private _cancelLoad(): void {
		this._loadGeneration++;
		this._loadRequest.value?.cancel();
		this._loadRequest.clear();
		this._loading = false;
	}

	/** 表を読み直す。`preserveView` なら同じファイルの再読込として表示状態を引き継ぐ。 */
	private async _loadTable(resource: URI, preserveView: boolean): Promise<void> {
		this._cancelLoad();
		const generation = this._loadGeneration;
		const request = new CancellationTokenSource();
		this._loadRequest.value = request;
		const token = request.token;
		const isCurrent = () => generation === this._loadGeneration && !token.isCancellationRequested && isEqual(this._currentResource, resource);
		this._tableStale = false;
		this._loading = true;
		if (!this._tableView?.document) {
			this._showMessage(localize('paradis.csv.loading', "読み込み中…"));
		}
		this._updateFooter();
		try {
			const loaded = await this._readText(resource);
			if (!isCurrent()) {
				return;
			}
			this._missingResource = undefined;
			const delimiter = extname(resource).toLowerCase() === '.tsv' ? '\t' : detectParadisCsvDelimiter(loaded.text);
			const indexer = new ParadisCsvIndexer(loaded.text, delimiter, { contentTruncated: loaded.truncated });
			while (!indexer.step(INDEX_CHUNK_CODE_UNITS)) {
				await timeout(0);
				if (!isCurrent()) {
					return;
				}
			}
			const document = indexer.finish();
			this._loading = false;
			this._delimiter = delimiter;
			if (document.recordCount === 0) {
				this._tableView?.setDocument(undefined, false);
				this._showMessage(localize('paradis.csv.empty', "空のファイルです。"));
			} else {
				this._hideMessage();
				this._tableView?.setDocument(document, preserveView);
				this._tableView?.layout();
			}
			this._updateNotice(document);
			this._updateFooter();
		} catch (error) {
			if (!isCurrent() || isCancellationError(error)) {
				return;
			}
			this._loading = false;
			this._tableView?.setDocument(undefined, false);
			this._updateNotice(undefined);
			this._updateFooter();
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				this._missingResource = resource;
				this._showMessage(localize('paradis.csv.notFound', "ファイルが見つかりません。"));
			} else if (error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
				this._showMessage(localize('paradis.csv.binary', "バイナリファイルのため表として表示できません。"), true);
			} else {
				this._showMessage(localize('paradis.csv.loadFailed', "表として表示できませんでした: {0}", toErrorMessage(error)), true);
			}
		} finally {
			if (this._loadRequest.value === request) {
				this._loadRequest.clear();
			}
		}
	}

	private async _readText(resource: URI): Promise<LoadedText> {
		// テキスト側に未保存の変更があれば、ディスクではなくその内容を表にする。
		const fileModel = this._textFileService.files.get(resource);
		const textModel = fileModel?.isDirty() ? fileModel.textEditorModel : undefined;
		if (textModel && !textModel.isDisposed()) {
			const value = textModel.getValue();
			return value.length > PARADIS_CSV_MAX_BYTES ? { text: value.slice(0, PARADIS_CSV_MAX_BYTES), truncated: true } : { text: value, truncated: false };
		}
		const content = await this._textFileService.read(resource, { acceptTextOnly: true, length: PARADIS_CSV_MAX_BYTES });
		return { text: content.value, truncated: content.size > PARADIS_CSV_MAX_BYTES };
	}

	private _showMessage(message: string, offerText = false): void {
		const element = this._messageElement;
		if (!element) {
			return;
		}
		this._messageListener.clear();
		dom.clearNode(element);
		dom.append(element, dom.$('span')).textContent = message;
		if (offerText) {
			const button = dom.append(element, dom.$('button.paradis-csv-link-button')) as HTMLButtonElement;
			button.textContent = localize('paradis.csv.openAsText', "テキストで開く");
			this._messageListener.value = dom.addDisposableListener(button, dom.EventType.CLICK, () => this.setViewMode('text'));
		}
		element.classList.add('visible');
	}

	private _hideMessage(): void {
		this._messageElement?.classList.remove('visible');
	}

	private _updateNotice(document: ParadisCsvDocument | undefined): void {
		let message = '';
		if (document?.flags.truncatedRecords) {
			message = localize('paradis.csv.truncatedRows', "ファイルが大きいため、先頭の {0} 行だけを表にしています。全体はテキストで確認できます。", document.dataRowCount.toLocaleString());
		} else if (document?.flags.truncatedColumns) {
			message = localize('paradis.csv.truncatedColumns', "列が多いため、先頭の {0} 列だけを表にしています。全体はテキストで確認できます。", document.columnCount.toLocaleString());
		}
		if (this._noticeText) {
			this._noticeText.textContent = message;
		}
		this._noticeElement?.classList.toggle('visible', !!message && this._mode === 'table');
	}

	private _updateFooter(): void {
		const footer = this._footerElement;
		if (!footer) {
			return;
		}
		const document = this._tableView?.document;
		const parts: string[] = [];
		if (this._loading && !document) {
			parts.push(localize('paradis.csv.footerLoading', "読み込み中…"));
		}
		if (document) {
			parts.push(localize('paradis.csv.footerSize', "{0} 行 × {1} 列", document.dataRowCount.toLocaleString(), document.columnCount.toLocaleString()));
			parts.push(localize('paradis.csv.footerDelimiter', "区切り: {0}", this._delimiterLabel(this._delimiter)));
			const sort = this._tableView?.sortState;
			if (sort) {
				const column = this._tableView!.columnName(sort.column);
				parts.push(sort.pending
					? localize('paradis.csv.footerSorting', "並べ替え中: {0}", column)
					: sort.direction === 'asc'
						? localize('paradis.csv.footerSortAsc', "並べ替え: {0} 昇順", column)
						: localize('paradis.csv.footerSortDesc', "並べ替え: {0} 降順", column));
			}
		}
		footer.textContent = parts.join('   ');
	}

	private _delimiterLabel(delimiter: ParadisCsvDelimiter): string {
		switch (delimiter) {
			case '\t': return localize('paradis.csv.delimiterTab', "タブ");
			case ';': return localize('paradis.csv.delimiterSemicolon', "セミコロン");
			default: return localize('paradis.csv.delimiterComma', "カンマ");
		}
	}

	override clearInput(): void {
		this._inputDisposables.clear();
		this._cancelLoad();
		this._currentResource = undefined;
		this._missingResource = undefined;
		this._modelListener.clear();
		this._codeEditor?.setModel(null);
		this._modelRef.clear();
		this._tableView?.setDocument(undefined, false);
		this._tableStale = true;
		this._updateNotice(undefined);
		this._hideMessage();
		super.clearInput();
	}

	override getControl(): ICodeEditor | undefined {
		return this._mode === 'text' ? this._codeEditor : undefined;
	}

	override focus(): void {
		super.focus();
		if (this._mode === 'text') {
			this._codeEditor?.focus();
		} else {
			this._tableView?.focus();
		}
	}

	override layout(dimension: dom.Dimension): void {
		if (this._rootElement) {
			this._rootElement.style.width = `${dimension.width}px`;
			this._rootElement.style.height = `${dimension.height}px`;
		}
		if (this._mode === 'table') {
			this._tableView?.layout();
		}
	}
}


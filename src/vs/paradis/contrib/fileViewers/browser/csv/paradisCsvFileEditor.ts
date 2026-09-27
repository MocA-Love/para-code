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
// 表の元になる文字列は、同じファイルのテキストモデルに未保存の変更があればその値、無ければディスクの内容
// （テキストモデルが開いていればそのエンコーディングで読む）。ディスクの変更は correlated watcher で、未保存の
// 編集はテキストファイルモデルの変更通知で拾い、表を表示中なら読み直す（スクロール位置・並べ替え・列幅は保つ）。
// 大きなファイルは先頭の一部だけを表にし、その旨と「テキストで開く」を表の上に出す。上限は 64 MB と
// `workbench.editorLargeFileConfirmation`（SSH 先は既定 10 MB）の小さい方。テキスト表示もこの上限を超える
// ファイルは確認してから開く（本家のテキストエディタと同じ扱い）。
//
// 行を指定して開かれたとき（検索結果・問題パネル・`data.csv:120` のリンク等）は、その開き方に限ってテキストで
// 開き、指定の位置へ移動する（ユーザーの「表 / テキスト」の記憶は変えない）。

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
import { ScrollType } from '../../../../../editor/common/editorCommon.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService, isConfigured } from '../../../../../platform/configuration/common/configuration.js';
import { IEditorOptions, ITextEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ByteSize, FileOperationResult, getLargeFileConfirmationLimit, IFileService, toFileOperationResult } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { applyTextEditorOptions } from '../../../../../workbench/common/editor/editorOptions.js';
import { IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IFilesConfigurationService } from '../../../../../workbench/services/filesConfiguration/common/filesConfigurationService.js';
import { ITextFileEditorModel, ITextFileService, TextFileOperationError, TextFileOperationResult } from '../../../../../workbench/services/textfile/common/textfiles.js';
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
/** 変更が続くときの読み直しの間隔。大きなファイルほど間を空け、書き込み中のファイルで CPU を使い続けない。 */
const RELOAD_DELAY_MS = 100;
const RELOAD_DELAY_LARGE_MS = 1_000;
const LARGE_DOCUMENT_CODE_UNITS = 8 * 1024 * 1024;
/** 未保存の編集を表へ反映するまでの待ち時間（打鍵ごとに読み直さないため）。 */
const MODEL_RELOAD_DELAY_MS = 400;

interface FileStamp {
	readonly mtime: number;
	readonly size: number;
}

interface LoadedText {
	readonly text: string;
	/** ファイルの先頭の一部だけを読んだ。 */
	readonly truncated: boolean;
	/** ディスクから読んだときの時刻と大きさ（未保存のモデルから作ったときは無い）。 */
	readonly stamp?: FileStamp;
}

interface MessageAction {
	readonly label: string;
	readonly run: () => void;
}

/** 行や範囲を指定した開き方か（検索結果・問題パネル・行番号付きリンク等）。 */
function hasTextSelection(options: IEditorOptions | undefined): options is ITextEditorOptions {
	return !!(options as ITextEditorOptions | undefined)?.selection;
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
	private _textMessageElement: HTMLElement | undefined;
	private _editorContainer: HTMLElement | undefined;
	private _footerElement: HTMLElement | undefined;
	private _tableView: ParadisCsvTableView | undefined;

	private _codeEditor: ICodeEditor | undefined;
	private readonly _modelRef = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _loadRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _messageListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly _textMessageListeners = this._register(new MutableDisposable<DisposableStore>());

	private _currentResource: URI | undefined;
	private _mode: ParadisCsvViewMode = 'table';
	private _loadGeneration = 0;
	/** 表が今の内容より古い（テキスト側の編集やディスクの変更をまだ反映していない）。 */
	private _tableStale = true;
	private _missingResource: URI | undefined;
	private _delimiter: ParadisCsvDelimiter = ',';
	private _loading = false;
	/**
	 * 表が保持している文書のファイルと、その読み込み時のディスク上の状態。タブを切り替えて戻ったときに
	 * ファイルが変わっていなければ読み直さず、スクロール位置・並べ替え・列幅もそのまま使う。
	 */
	private _documentResource: URI | undefined;
	private _loadedStamp: FileStamp | undefined;
	/** 行を指定して開かれたときの位置。テキストエディタの準備ができたら当てる。 */
	private _pendingTextOptions: ITextEditorOptions | undefined;
	/** 大きいファイルをテキストで開くことをユーザーが確認したファイル。 */
	private readonly _largeFileConfirmed = new Set<string>();

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
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFilesConfigurationService private readonly _filesConfigurationService: IFilesConfigurationService,
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
		// テキスト表示に切り替えられなかったとき（大きすぎる・読めない）の案内。表の案内とは別に持つ。
		this._textMessageElement = dom.append(content, dom.$('.paradis-csv-message'));

		this._footerElement = dom.append(this._rootElement, dom.$('.paradis-csv-footer'));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		const csvInput = input as ParadisCsvFileInput;
		const resource = csvInput.resource;
		this._currentResource = resource;
		this._missingResource = undefined;
		if (!isEqual(this._documentResource, resource)) {
			this._cancelLoad();
			this._tableView?.setDocument(undefined, false);
			this._documentResource = undefined;
			this._loadedStamp = undefined;
			this._tableStale = true;
			this._updateNotice(undefined);
			this._hideMessage();
		}
		if (this._modelRef.value && !isEqual(this._modelRef.value.object.textEditorModel.uri, resource)) {
			this._codeEditor?.setModel(null);
			this._modelRef.clear();
		}

		const store = new DisposableStore();
		this._inputDisposables.value = store;
		const reloadScheduler = store.add(new RunOnceScheduler(() => {
			if (isEqual(this._currentResource, resource) && this._mode === 'table') {
				this._loadTable(resource, true).catch(onUnexpectedError);
			}
		}, RELOAD_DELAY_MS));
		const scheduleReload = (delay: number) => {
			this._tableStale = true;
			if (this._mode === 'table') {
				reloadScheduler.schedule(Math.max(delay, this._reloadDelay()));
			}
		};
		try {
			const watcher = store.add(this._fileService.createWatcher(resource, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(e => {
				if (e.contains(resource)) {
					scheduleReload(RELOAD_DELAY_MS);
				}
			}));
		} catch {
			// watcher を作れなくても表示自体は続けられる。
		}
		// watch エラーはワークスペースのどこからでも届くので、このファイルが実際に変わったときだけ読み直す。
		const watchRecoveryScheduler = store.add(new RunOnceScheduler(() => this._reloadIfChangedOnDisk(resource, scheduleReload), 1000));
		store.add(this._fileService.onDidWatchError(() => {
			if (!isEqual(this._missingResource, resource) && !watchRecoveryScheduler.isScheduled()) {
				watchRecoveryScheduler.schedule();
			}
		}));

		// 同じファイルのテキストモデル（別のグループのテキストエディタやこのペインのテキスト表示）の編集と、
		// 「エンコード付きで再度開く」を表へ反映する。
		const modelListener = store.add(new MutableDisposable());
		const attachModel = (model: ITextFileEditorModel) => {
			if (isEqual(model.resource, resource)) {
				modelListener.value = model.onDidChangeContent(() => scheduleReload(MODEL_RELOAD_DELAY_MS));
			}
		};
		const existingModel = this._textFileService.files.get(resource);
		if (existingModel) {
			attachModel(existingModel);
		}
		store.add(this._textFileService.files.onDidResolve(e => attachModel(e.model)));
		store.add(this._textFileService.files.onDidChangeEncoding(model => {
			if (isEqual(model.resource, resource)) {
				scheduleReload(0);
			}
		}));
		store.add(this._textFileService.files.onDidChangeReadonly(model => {
			if (isEqual(model.resource, resource)) {
				this._updateReadonly(resource);
			}
		}));
		store.add(this._filesConfigurationService.onDidChangeReadonly(() => this._updateReadonly(resource)));

		if (hasTextSelection(options)) {
			// 行を指定された開き方は、テキストで開いてその位置へ移動する（記憶は変えない）。
			csvInput.setCsvViewMode('text');
			this._pendingTextOptions = options;
		}

		// 表の読み込み（大きなファイルでは時間がかかる）はタブを開く処理から切り離し、その間は「読み込み中…」を出す。
		const mode = csvInput.csvViewMode;
		const applied = this._applyViewMode(mode, resource, false);
		if (mode === 'text') {
			await applied;
		} else {
			applied.catch(onUnexpectedError);
		}
	}

	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		const resource = this._currentResource;
		if (!resource || !hasTextSelection(options)) {
			return;
		}
		this._pendingTextOptions = options;
		if (this.input instanceof ParadisCsvFileInput) {
			this.input.setCsvViewMode('text');
		}
		this._applyViewMode('text', resource, false).catch(onUnexpectedError);
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
		// ウィンドウ透過では、表の表示中だけ Excel ビューアと同じく不透明な下地にする。
		this._rootElement?.classList.toggle('paradis-csv-table-mode', mode === 'table');
		this._tableArea?.classList.toggle('hidden', mode !== 'table');
		this._footerElement?.classList.toggle('hidden', mode !== 'table');
		this._noticeElement?.classList.toggle('visible', mode === 'table' && !!this._noticeText?.textContent);
		const isCurrent = () => isEqual(this._currentResource, resource) && this._mode === mode;

		if (mode === 'text') {
			const shown = await this._showTextEditor(resource);
			if (!isCurrent()) {
				return;
			}
			// ステータスバー（行・列、改行コード等）や拡張機能が見る「アクティブなエディタ」を切り替える。
			this._onDidChangeControl.fire();
			if (!shown || !this._codeEditor) {
				return;
			}
			if (this._pendingTextOptions) {
				applyTextEditorOptions(this._pendingTextOptions, this._codeEditor, ScrollType.Immediate);
				this._pendingTextOptions = undefined;
			}
			if (focus) {
				this._codeEditor.focus();
			}
			return;
		}

		this._editorContainer?.classList.remove('active');
		this._hideTextMessage();
		this._onDidChangeControl.fire();
		const hasDocument = !!this._tableView?.document && isEqual(this._documentResource, resource);
		const reusable = hasDocument && !this._tableStale && await this._isDocumentCurrent(resource);
		if (!isCurrent()) {
			return;
		}
		if (reusable) {
			this._tableView?.layout();
		} else {
			await this._loadTable(resource, hasDocument);
		}
		if (focus && isCurrent()) {
			this._tableView?.focus();
		}
	}

	/** テキストエディタを出す。出せなかったときは理由と次の操作を表示して false を返す。 */
	private async _showTextEditor(resource: URI): Promise<boolean> {
		const isCurrent = () => isEqual(this._currentResource, resource) && this._mode === 'text';
		try {
			if (!this._codeEditor) {
				this._codeEditor = this._register(this._instantiationService.createInstance(CodeEditorWidget, this._editorContainer!, TEXT_EDITOR_OPTIONS, {}));
			}
			if (!this._modelRef.value || !isEqual(this._modelRef.value.object.textEditorModel.uri, resource)) {
				// 本家のテキストエディタと同じく、大きいファイル（SSH 先は既定 10 MB）は確認してから読み込む。
				if (!this._textFileService.files.get(resource)?.isResolved() && !this._largeFileConfirmed.has(resource.toString())) {
					const stat = await this._fileService.stat(resource);
					if (!isCurrent()) {
						return false;
					}
					if (stat.size > this._largeFileLimit(resource)) {
						this._editorContainer?.classList.remove('active');
						this._showTextMessage(localize('paradis.csv.textTooLarge', "ファイルが大きいため（{0}）、テキストでは開いていません。", ByteSize.formatSize(stat.size)), [
							{
								label: localize('paradis.csv.openAnyway', "それでも開く"), run: () => {
									this._largeFileConfirmed.add(resource.toString());
									this._applyViewMode('text', resource, true).catch(onUnexpectedError);
								}
							},
							{ label: localize('paradis.csv.showTable', "表で表示"), run: () => this.setViewMode('table') },
						]);
						return false;
					}
				}
				const ref = await this._textModelService.createModelReference(resource);
				if (!isEqual(this._currentResource, resource)) {
					ref.dispose();
					return false;
				}
				this._modelRef.value = ref;
				this._codeEditor.setModel(ref.object.textEditorModel);
			}
			if (!isCurrent()) {
				return false;
			}
			this._updateReadonly(resource);
			this._hideTextMessage();
			this._editorContainer?.classList.add('active');
			return true;
		} catch (error) {
			if (isCurrent()) {
				this._editorContainer?.classList.remove('active');
				this._showTextMessage(localize('paradis.csv.textFailed', "テキストで開けませんでした: {0}", toErrorMessage(error)), [
					{ label: localize('paradis.csv.showTable', "表で表示"), run: () => this.setViewMode('table') },
				]);
			}
			return false;
		}
	}

	/** 読み取り専用の設定（`files.readonlyInclude` 等）と、読み取り専用のファイルシステムを反映する。 */
	private _updateReadonly(resource: URI): void {
		if (!this._codeEditor || !isEqual(this._modelRef.value?.object.textEditorModel.uri, resource)) {
			return;
		}
		const readonly = this._filesConfigurationService.isReadonly(resource) || this._textFileService.files.get(resource)?.isReadonly();
		this._codeEditor.updateOptions({ readOnly: !!readonly, readOnlyMessage: typeof readonly === 'object' ? readonly : undefined });
	}

	/** `workbench.editorLargeFileConfirmation`（明示されていなければ本家と同じ既定値）をバイト数で返す。 */
	private _largeFileLimit(resource: URI): number {
		const configured = this._configurationService.inspect<number>('workbench.editorLargeFileConfirmation', { resource });
		return isConfigured(configured) && configured.value > 0 ? configured.value * ByteSize.MB : getLargeFileConfirmationLimit(resource);
	}

	private _reloadDelay(): number {
		const length = this._tableView?.document?.text.length ?? 0;
		return length > LARGE_DOCUMENT_CODE_UNITS ? RELOAD_DELAY_LARGE_MS : RELOAD_DELAY_MS;
	}

	/** 表の文書が今のファイルの内容と同じか（未保存の変更が無く、ディスクの時刻と大きさが読み込み時のまま）。 */
	private async _isDocumentCurrent(resource: URI): Promise<boolean> {
		const stamp = this._loadedStamp;
		if (!stamp || this._textFileService.files.get(resource)?.isDirty()) {
			return false;
		}
		try {
			const stat = await this._fileService.stat(resource);
			return stat.mtime === stamp.mtime && stat.size === stamp.size;
		} catch {
			return false;
		}
	}

	private async _reloadIfChangedOnDisk(resource: URI, scheduleReload: (delay: number) => void): Promise<void> {
		if (!isEqual(this._currentResource, resource) || !this._tableView?.document) {
			return;
		}
		if (!await this._isDocumentCurrent(resource) && isEqual(this._currentResource, resource)) {
			scheduleReload(RELOAD_DELAY_MS);
		}
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
			this._documentResource = resource;
			this._loadedStamp = loaded.stamp;
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
			this._documentResource = undefined;
			this._loadedStamp = undefined;
			this._updateNotice(undefined);
			this._updateFooter();
			if (toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND) {
				this._missingResource = resource;
				this._showMessage(localize('paradis.csv.notFound', "ファイルが見つかりません。"));
			} else if (error instanceof TextFileOperationError && error.textFileOperationResult === TextFileOperationResult.FILE_IS_BINARY) {
				// バイナリを文字として読み込ませないよう、テキストで開く案内は出さない。
				this._showMessage(localize('paradis.csv.binary', "バイナリファイルのため表として表示できません。"));
			} else {
				this._showMessage(localize('paradis.csv.loadFailed', "表として表示できませんでした: {0}", toErrorMessage(error)), [
					{ label: localize('paradis.csv.openAsText', "テキストで開く"), run: () => this.setViewMode('text') },
				]);
			}
		} finally {
			if (this._loadRequest.value === request) {
				this._loadRequest.clear();
			}
		}
	}

	private async _readText(resource: URI): Promise<LoadedText> {
		const limit = Math.min(PARADIS_CSV_MAX_BYTES, this._largeFileLimit(resource));
		const fileModel = this._textFileService.files.get(resource);
		// 未保存の変更があれば、ディスクではなくその内容を表にする。上限はここでは UTF-16 のコード単位で数える
		// （バイト数ではないが、大きなモデルの全文を一度に文字列にしないための目安として十分）。
		const textModel = fileModel?.isDirty() ? fileModel.textEditorModel : undefined;
		if (textModel && !textModel.isDisposed()) {
			if (textModel.getValueLength() > limit) {
				const end = textModel.getPositionAt(limit);
				return { text: textModel.getValueInRange(new Range(1, 1, end.lineNumber, end.column)), truncated: true };
			}
			return { text: textModel.getValue(), truncated: false };
		}
		// テキスト側で「エンコード付きで再度開く」を選んでいれば、そのエンコーディングで読む。
		const content = await this._textFileService.read(resource, { acceptTextOnly: true, length: limit, encoding: fileModel?.getEncoding() });
		return { text: content.value, truncated: content.size > limit, stamp: { mtime: content.mtime, size: content.size } };
	}

	private _showMessage(message: string, actions: readonly MessageAction[] = []): void {
		this._renderMessage(this._messageElement, this._messageListeners, message, actions);
	}

	private _hideMessage(): void {
		this._messageListeners.clear();
		this._messageElement?.classList.remove('visible');
	}

	private _showTextMessage(message: string, actions: readonly MessageAction[]): void {
		this._renderMessage(this._textMessageElement, this._textMessageListeners, message, actions);
	}

	private _hideTextMessage(): void {
		this._textMessageListeners.clear();
		this._textMessageElement?.classList.remove('visible');
	}

	private _renderMessage(element: HTMLElement | undefined, listeners: MutableDisposable<DisposableStore>, message: string, actions: readonly MessageAction[]): void {
		if (!element) {
			return;
		}
		const store = new DisposableStore();
		listeners.value = store;
		dom.clearNode(element);
		dom.append(element, dom.$('span')).textContent = message;
		if (actions.length > 0) {
			const row = dom.append(element, dom.$('.paradis-csv-message-actions'));
			for (const action of actions) {
				const button = dom.append(row, dom.$('button.paradis-csv-link-button')) as HTMLButtonElement;
				button.textContent = action.label;
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => action.run()));
			}
		}
		element.classList.add('visible');
	}

	private _updateNotice(document: ParadisCsvDocument | undefined): void {
		let message = '';
		if (document?.flags.truncatedRecords) {
			message = localize('paradis.csv.truncatedRows', "ファイルが大きいため、先頭の {0} 行だけを表にしています。全体はテキストで確認できます。", document.dataRowCount.toLocaleString());
		} else if (document?.flags.truncatedColumns) {
			message = localize('paradis.csv.truncatedColumns', "列が多いため、先頭の {0} 列だけを表にしています。全体はテキストで確認できます。", document.columnCount.toLocaleString());
		} else if (document?.flags.unterminatedQuote) {
			message = localize('paradis.csv.unterminatedQuote', "閉じていない引用符があり、そこからファイルの終わりまでが 1 つのセルになっています。テキストで確認してください。");
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
		this._pendingTextOptions = undefined;
		this._codeEditor?.setModel(null);
		this._modelRef.clear();
		this._hideTextMessage();
		// 表の文書は捨てない。同じファイルへ戻ったとき、ディスクの内容が変わっていなければそのまま使う
		// （大きなファイルを読み直さず、スクロール位置・並べ替え・列幅も残る）。別のファイルを開いたときに捨てる。
		super.clearInput();
	}

	override dispose(): void {
		// MutableDisposable は CancellationTokenSource を取り消さずに捨てるので、先に取り消して読み込みを止める。
		this._cancelLoad();
		super.dispose();
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

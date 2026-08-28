/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Word(.docx)差分ビューアの EditorPane。
//
// 構成:
//   ツールバー（件数・凡例・書式トグル・ズーム・Prev/Next）は renderer 側の DOM で描き、
//   本文（左右2ペインの Word 描画）は1枚の OverlayWebview の中で docx-preview が描く。
//   差分の計算は renderer 側（common/paradisDocxDiff.ts）で行い、注釈だけを webview へ渡す。
//
// なぜ .docx を webview に fetch させず renderer で読むのか:
// SCM の「変更前バージョン」は `git:` スキーム（git 拡張の readonly FS プロバイダ）で渡ってくる。
// asWebviewUri 経由の fetch は service worker のリソース解決に依存し、git: の query(JSON) を
// 通す経路が不確実。IFileService はどのスキームでも読めるので、renderer で読んで postMessage で
// 渡す方が確実で、サイズ上限も掛けやすい。
//
// webview のライフサイクル（OverlayWebview + claim/release）は paradisDocxFileEditor.ts と同方式。

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess, Schemas } from '../../../../base/common/network.js';
import { basename, isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService, type IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../../../workbench/contrib/webview/browser/webview.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { ParadisWebviewOriginPool } from '../browser/paradisWebviewOriginPool.js';
import { resolveParadisViewerLibBase } from './paradisViewerAssets.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_DOCX_DIFF_EDITOR_ID } from '../browser/paradisFileViewers.js';
import { ParadisOfficeAccessibility, applyParadisOfficeChangeLegendSemantics, applyParadisOfficeWebviewAccessibility } from '../browser/paradisOfficeAccessibility.js';
import { ParadisOfficeFindWidget } from '../browser/paradisOfficeFindWidget.js';
import {
	IParadisDocxChange,
	IParadisDocxDiffResult,
	IParadisDocxOutline,
	PARADIS_DOCX_ERROR_LIBRARY_MISSING,
	PARADIS_DOCX_MAX_BYTES,
	ParadisDocxChangeStatus,
	ParadisDocxSide,
	ParadisDocxWebviewMessage,
} from '../common/paradisDocx.js';
import { buildDocxDiff } from '../common/paradisDocxDiff.js';
import type { ParadisOfficeChange, ParadisOfficeCompletenessManifest, ParadisOfficeOutcome, ParadisOfficePlaceholder, ParadisOfficeRenderCoverage } from '../common/paradisOfficeProtocol.js';
import { beginParadisOfficeRecovery, createParadisOfficeRecoveryState, reduceParadisOfficeRecovery, type IParadisOfficeRecoveryState, type ParadisOfficeRecoveryEffect } from '../common/paradisOfficeRecovery.js';
import { describeDocxChangeStatus, localizeDocxAnnotations } from '../common/paradisDocxDiffPresentation.js';
import { ParadisDocxDiffInput } from './paradisDocxInput.js';
import { buildParadisDocxDiffHtml, sanitizeParadisDocxBytesForRenderer } from './paradisDocxDiffWebview.js';
import { createLegacyWordPrintModel, createParadisWordSourceDescriptor, isParadisWordV1Enabled } from './paradisDocxFileEditor.js';
import { createParadisOfficeSearchPrintCallbacks, snapshotParadisOfficeRuntimeConfiguration, type ParadisOfficeConfigurationReader, type ParadisOfficeRuntimeConfiguration } from '../common/paradisOfficeCapabilities.js';
import { PARADIS_WORD_CHANGE_CATEGORIES, ParadisWordChangeInspector, restoreParadisWordViewState, type ParadisWordDisplayMode, type ParadisWordViewState } from './word/paradisWordChangeInspector.js';
import { renderWordDiagnosticsRibbon } from './word/paradisWordDiagnostics.js';
import { printParadisOfficeModelInBrowser, withParadisOfficePrintResult } from './paradisOfficePrintService.js';
import './media/paradisDocxDiff.css';

const $ = dom.$;

/** vendored docx-preview / jszip の配置ディレクトリ（webview に許可するリソースの根）。 */
const DOCX_MEDIA_ROOT = 'vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview' as const;

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;

export const PARADIS_WORD_LEGACY_CHANGE_LIMIT = 5_000;

export interface ParadisWordLegacyChangeSet {
	readonly changes: readonly ParadisOfficeChange[];
	readonly completeness: ParadisOfficeCompletenessManifest;
	readonly outcome: ParadisOfficeOutcome;
	readonly truncated: boolean;
}

/** A bounded compatibility projection. It intentionally never claims Kernel completeness. */
export function adaptLegacyWordInspectorChangeSet(result: IParadisDocxDiffResult): ParadisWordLegacyChangeSet {
	const selected = result.changes.slice(0, PARADIS_WORD_LEGACY_CHANGE_LIMIT);
	const changes = selected.map((change): ParadisOfficeChange => {
		const category = change.status === 'formatChanged' ? 'formatting' : change.status === 'moved' ? 'structure' : 'content';
		const node = change.modifiedIndex ?? change.originalIndex ?? change.id;
		return {
			id: `legacy-word:${change.id}`,
			category,
			subject: { kind: `legacy.paragraph.${change.status}`, locator: `story:body:/word/document.xml:legacy/node:${node}` },
			before: { kind: 'none' },
			after: { kind: 'scalar', valueType: 'text', value: change.excerpt },
			certainty: 'degraded',
			sourceParts: ['/word/document.xml'],
			navigableAnchor: `legacy-change:${change.id}`,
		};
	});
	return {
		changes,
		completeness: {
			expectedParts: 1, visitedParts: 1, parsedParts: 1, opaqueParts: 0, failedParts: 0,
			omittedParts: result.changes.length - selected.length,
			expectedSemanticUnits: Math.max(1, result.changes.length), visitedSemanticUnits: selected.length, terminal: false,
		},
		outcome: 'degraded',
		truncated: selected.length !== result.changes.length,
	};
}

function snapshotWordDiffRuntimeConfiguration(configurationService: IConfigurationService): ParadisOfficeRuntimeConfiguration {
	const reader: ParadisOfficeConfigurationReader = {
		getValue: <T>(key: string) => configurationService.getValue<T>(key),
		inspect: <T>(key: string) => configurationService.inspect<T>(key) as IConfigurationValue<T> | undefined,
	};
	return snapshotParadisOfficeRuntimeConfiguration(reader);
}

/**
 * 凡例に出す色。値は webview 側の CSS（paradisDocxDiffWebview.ts）と揃えること。
 * 文言は presentation 層と共有し、同じ意味を2か所で訳さないようにする。
 */
const LEGEND: readonly { readonly color: string; readonly status: ParadisDocxChangeStatus; readonly marker: string }[] = [
	{ color: '#22c55e', status: 'added', marker: '+' },
	{ color: '#ef4444', status: 'removed', marker: '−' },
	{ color: '#3b82f6', status: 'modified', marker: '~' },
	{ color: '#a855f7', status: 'moved', marker: '↔' },
];

export class ParadisDocxDiffEditor extends EditorPane {

	static readonly ID = PARADIS_DOCX_DIFF_EDITOR_ID;

	private _root: HTMLElement | undefined;
	private _countEl: HTMLElement | undefined;
	private _noticeEl: HTMLElement | undefined;
	private _diagnosticsEl: HTMLElement | undefined;
	private _inspectorToggle: HTMLButtonElement | undefined;
	private _inspectorPanel: HTMLElement | undefined;
	private _navPositionEl: HTMLElement | undefined;
	private _percentEl: HTMLButtonElement | undefined;
	private _formatToggle: HTMLButtonElement | undefined;
	private _openAppEl: HTMLElement | undefined;
	private _webviewContainer: HTMLElement | undefined;
	private _webview: IOverlayWebview | undefined;
	private readonly _originPool: ParadisWebviewOriginPool;
	private _webviewClaimed = false;
	private _editorVisible = false;

	private _originalResource: URI | undefined;
	private _modifiedResource: URI | undefined;
	private _changes: readonly IParadisDocxChange[] = [];
	private _modifiedOutline: IParadisDocxOutline | undefined;
	private _currentIndex = -1;
	private _scale = 1;
	private _displayMode: ParadisWordDisplayMode = 'final';
	private _showFormatChanges = true;
	private _runtimeConfiguration: ParadisOfficeRuntimeConfiguration | undefined;
	private _wordViewState: ParadisWordViewState = Object.freeze({ zoom: 1, displayMode: 'final', activeStory: 'all', categories: PARADIS_WORD_CHANGE_CATEGORIES });
	/** 応答の逆順到着で古い結果が新しい結果を上書きしないようにする世代トークン。 */
	private _loadGeneration = 0;
	/** 並行して走る setInput の取り違えを防ぐための世代トークン。 */
	private _inputEpoch = 0;
	private _disposed = false;

	private readonly _headerDisposables = this._register(new DisposableStore());
	private readonly _inputDisposables = this._register(new MutableDisposable<DisposableStore>());
	private readonly _webviewStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly _assetSanitization = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly _changeInspector = this._register(new MutableDisposable<ParadisWordChangeInspector>());
	private readonly _findWidget = this._register(new MutableDisposable<ParadisOfficeFindWidget>());
	private _accessibility: ParadisOfficeAccessibility | undefined;
	private _assetPlaceholders: readonly ParadisOfficePlaceholder[] = [];
	private _recoveryState: IParadisOfficeRecoveryState = createParadisOfficeRecoveryState();
	private _recoveryGeneration = 0;
	private _webviewRecoveryGeneration = 0;
	private _sentRecoveryGeneration = 0;
	private _documentSnapshot: { readonly original: Uint8Array; readonly modified: Uint8Array; readonly placeholders: readonly ParadisOfficePlaceholder[] } | undefined;
	private _recreatingForRecovery = false;

	constructor(group: IEditorGroup, sharedProcessService: ISharedProcessService, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService, webviewService: IWebviewService, fileService: IFileService, nativeHostService: INativeHostService, layoutService: IWorkbenchLayoutService);
	constructor(group: IEditorGroup, sharedProcessService: ISharedProcessService, telemetryService: ITelemetryService, themeService: IThemeService, storageService: IStorageService, webviewService: IWebviewService, fileService: IFileService, nativeHostService: INativeHostService, layoutService: IWorkbenchLayoutService, configurationService: IConfigurationService);
	constructor(
		group: IEditorGroup,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IWorkbenchLayoutService private readonly _layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly _configurationService: IConfigurationService = undefined!,
	) {
		super(PARADIS_DOCX_DIFF_EDITOR_ID, group, telemetryService, themeService, storageService);
		// ライブラリの置き場は入力に依らないので、ここで先に決めておく。開く操作が
		// 共有プロセスの応答を待たされる最悪値が、そのぶん短くなる。
		void this._resolveLibBase();
		this._originPool = ParadisWebviewOriginPool.getShared(storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._root = dom.append(parent, $('.paradis-docx-diff'));
		this._root.style.position = 'relative';
		this._accessibility = this._register(new ParadisOfficeAccessibility(this._root, {
			label: localize('paradis.word.diffViewer', "Word 文書の比較"),
		}));
		this._findWidget.value = new ParadisOfficeFindWidget(this._root, {
			unavailableMessage: localize('paradis.word.diffSearchUnavailable', "この比較では文書内の検索を利用できません。"),
			isActive: () => !!this._webview?.isFocused,
		});

		const toolbar = dom.append(this._root, $('.paradis-docx-diff-toolbar'));
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', localize('paradis.word.diffToolbar', "Word 比較のツールバー"));
		const left = dom.append(toolbar, $('.paradis-docx-diff-toolbar-left'));
		this._countEl = dom.append(left, $('span.paradis-docx-diff-count'));
		this._noticeEl = dom.append(left, $('span.paradis-docx-diff-notice'));
		this._noticeEl.style.display = 'none';
		this._diagnosticsEl = dom.append(left, $('span.paradis-word-diff-diagnostics'));
		const legend = dom.append(left, $('.paradis-docx-diff-legend'));
		for (const entry of LEGEND) {
			const item = dom.append(legend, $('span.paradis-docx-diff-legend-item'));
			const swatch = dom.append(item, $('span.paradis-docx-diff-legend-swatch'));
			swatch.style.backgroundColor = entry.color;
			const label = describeDocxChangeStatus(entry.status);
			dom.append(item, $('span')).textContent = label;
			applyParadisOfficeChangeLegendSemantics(item, swatch, { category: entry.status, label, marker: entry.marker });
		}

		const right = dom.append(toolbar, $('.paradis-docx-diff-toolbar-right'));
		this._inspectorToggle = dom.append(right, $('button.paradis-docx-diff-toggle')) as HTMLButtonElement;
		this._inspectorToggle.type = 'button';
		this._inspectorToggle.textContent = localize('paradis.word.diffInspector', "変更点");
		this._accessibility.labelButton(this._inspectorToggle, localize('paradis.word.diffInspector', "変更点"));
		this._inspectorToggle.style.display = 'none';
		this._inspectorToggle.setAttribute('aria-expanded', 'false');
		this._headerDisposables.add(dom.addDisposableListener(this._inspectorToggle, dom.EventType.CLICK, () => {
			if (!this._inspectorPanel || !this._inspectorToggle) {
				return;
			}
			const visible = this._inspectorPanel.style.display === 'none';
			this._inspectorPanel.style.display = visible ? 'block' : 'none';
			this._inspectorToggle.setAttribute('aria-expanded', String(visible));
		}));

		this._formatToggle = dom.append(right, $('button.paradis-docx-diff-toggle')) as HTMLButtonElement;
		this._accessibility.labelButton(this._formatToggle, localize('paradis.docxDiff.formatToggle', "書式の変更"));
		dom.append(this._formatToggle, $(`span${ThemeIcon.asCSSSelector(Codicon.symbolText)}`));
		// allow-any-unicode-next-line
		dom.append(this._formatToggle, $('span')).textContent = localize('paradis.docxDiff.formatToggle', "書式の変更");
		this._headerDisposables.add(dom.addDisposableListener(this._formatToggle, dom.EventType.CLICK, () => this._setShowFormatChanges(!this._showFormatChanges)));

		const zoom = dom.append(right, $('.paradis-docx-diff-zoom'));
		this._appendIconButton(zoom, Codicon.zoomOut, localize('paradis.docxDiff.zoomOut', "ズームアウト"), this._headerDisposables, () => this._zoom(1 / ZOOM_STEP));
		this._percentEl = dom.append(zoom, $('button.paradis-docx-diff-percent')) as HTMLButtonElement;
		this._percentEl.title = localize('paradis.docxDiff.resetZoom', "ズームをリセット");
		this._accessibility.labelButton(this._percentEl, localize('paradis.docxDiff.resetZoom', "ズームをリセット"));
		this._headerDisposables.add(dom.addDisposableListener(this._percentEl, dom.EventType.CLICK, () => this._setScale(1)));
		this._appendIconButton(zoom, Codicon.zoomIn, localize('paradis.docxDiff.zoomIn', "ズームイン"), this._headerDisposables, () => this._zoom(ZOOM_STEP));

		const nav = dom.append(right, $('.paradis-docx-diff-nav'));
		const previous = dom.append(nav, $('button.paradis-docx-diff-navbtn')) as HTMLButtonElement;
		previous.textContent = localize('paradis.docxDiff.previous', "前へ");
		this._navPositionEl = dom.append(nav, $('span.paradis-docx-diff-navpos'));
		const next = dom.append(nav, $('button.paradis-docx-diff-navbtn')) as HTMLButtonElement;
		next.textContent = localize('paradis.docxDiff.next', "次へ");
		this._accessibility.labelButton(previous, localize('paradis.word.previousChange', "前の変更"));
		this._accessibility.labelButton(next, localize('paradis.word.nextChange', "次の変更"));
		this._headerDisposables.add(dom.addDisposableListener(previous, dom.EventType.CLICK, () => this._navigate(-1)));
		this._headerDisposables.add(dom.addDisposableListener(next, dom.EventType.CLICK, () => this._navigate(1)));
		this._openAppEl = dom.append(nav, $('.paradis-docx-diff-openapp'));

		this._webviewContainer = dom.append(this._root, $('.paradis-docx-diff-body'));
		this._webviewContainer.setAttribute('role', 'region');
		this._webviewContainer.setAttribute('aria-label', localize('paradis.word.comparisonContent', "Word 比較の内容"));
		this._inspectorPanel = dom.append(this._root, $('.paradis-word-diff-inspector-panel'));
		this._inspectorPanel.style.position = 'absolute';
		this._inspectorPanel.style.top = '42px';
		this._inspectorPanel.style.right = '8px';
		this._inspectorPanel.style.zIndex = '20';
		this._inspectorPanel.style.width = '360px';
		this._inspectorPanel.style.maxHeight = '70%';
		this._inspectorPanel.style.overflow = 'auto';
		this._inspectorPanel.style.background = 'var(--vscode-editorWidget-background)';
		this._inspectorPanel.style.display = 'none';
		this._updateScaleLabel();
		this._updateFormatToggle();
		this._updateNav();
	}

	/**
	 * ヘッダーのアイコンボタンを作る。
	 * `disposables` には**そのボタンの寿命に合う store** を渡すこと。入力ごとに作り直すボタンを
	 * pane 寿命の store に登録すると、入力を切り替えるたびにリスナーが溜まる。
	 */
	private _appendIconButton(parent: HTMLElement, icon: ThemeIcon, title: string, disposables: DisposableStore, onClick: () => void): HTMLButtonElement {
		const button = dom.append(parent, $('button.paradis-docx-diff-iconbtn')) as HTMLButtonElement;
		button.title = title;
		this._accessibility?.labelButton(button, title);
		dom.append(button, $(`span${ThemeIcon.asCSSSelector(icon)}`));
		disposables.add(dom.addDisposableListener(button, dom.EventType.CLICK, onClick));
		return button;
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		const invocationEpoch = ++this._inputEpoch;
		const previousInput = this._input;
		const previousOptions = this._options;
		await super.setInput(input, options, context, token);
		if (this._disposed || invocationEpoch !== this._inputEpoch) {
			return;
		}
		if (token.isCancellationRequested) {
			// 入力を戻さないと、_input だけ新しくリソースは旧いままの食い違いが残る。
			this._input = previousInput;
			this._options = previousOptions;
			return;
		}

		const diffInput = input as ParadisDocxDiffInput;
		this._runtimeConfiguration = this._configurationService ? snapshotWordDiffRuntimeConfiguration(this._configurationService) : undefined;
		const nestedState = options?.viewState && Object.prototype.hasOwnProperty.call(options.viewState, 'viewState')
			? (options.viewState as { readonly viewState?: unknown }).viewState
			: options?.viewState;
		this._wordViewState = restoreParadisWordViewState(nestedState, this._currentWordViewState());
		this._originalResource = diffInput.originalResource;
		this._modifiedResource = diffInput.modifiedResource;
		this._changes = [];
		this._modifiedOutline = undefined;
		this._currentIndex = -1;
		this._scale = this._wordViewState.zoom;
		this._displayMode = this._wordViewState.displayMode;
		this._showFormatChanges = true;
		this._clearSemanticUi();
		this._updateScaleLabel();
		this._updateFormatToggle();
		this._updateNav();
		this._setNotice(undefined);
		this._setCount(undefined);
		this._recoveryState = beginParadisOfficeRecovery(this._recoveryState, {
			source: {
				mode: 'comparison',
				original: createParadisWordSourceDescriptor(this._originalResource, 'original'),
				modified: createParadisWordSourceDescriptor(this._modifiedResource, 'modified'),
			},
			viewState: {
				zoom: this._wordViewState.zoom,
				displayMode: this._wordViewState.displayMode,
				activeStory: this._wordViewState.activeStory,
				categories: [...this._wordViewState.categories],
				...(this._wordViewState.selectedChangeId ? { selectedChangeId: this._wordViewState.selectedChangeId } : {}),
			},
		}).state;
		this._recoveryGeneration = this._recoveryState.generation;

		const store = new DisposableStore();
		this._inputDisposables.value = store;

		if (this._openAppEl) {
			dom.clearNode(this._openAppEl);
			if (this._modifiedResource.scheme === Schemas.file) {
				const resource = this._modifiedResource;
				// リスナーは入力ごとの store に載せる（pane 寿命に載せると切り替えるたびに溜まる）。
				// allow-any-unicode-next-line
				this._appendIconButton(this._openAppEl, Codicon.linkExternal, localize('paradis.docxDiff.openInApp', "既定のアプリで開く"), store, () => {
					void this._nativeHostService.openExternal(resource.toString(true));
				});
			}
		}

		// 新版がワーキングコピーならディスク更新で自動的に取り直す。
		if (this._modifiedResource.scheme === Schemas.file || this._modifiedResource.scheme === Schemas.vscodeRemote) {
			try {
				const watched = this._modifiedResource;
				const watcher = this._fileService.createWatcher(watched, { recursive: false, excludes: [] });
				store.add(watcher);
				const scheduler = store.add(new RunOnceScheduler(() => this._onWatchedResourceChanged(watched), 50));
				store.add(watcher.onDidChange(event => {
					if (event.contains(watched) && isEqual(this._modifiedResource, watched)) {
						scheduler.schedule();
					}
				}));
			} catch {
				// watcher が作れなくても表示は続けられる。
			}
		}

		// 既に claim 済みならここで読み直す。未 claim なら _updateWebviewPlacement が claim して
		// そこから1回だけ読み込む。**逆順にすると新規オープンで必ず2回読み込む**（claim 時に1回、
		// その直後にもう1回）ので、この並びを崩さないこと。
		if (this._webviewClaimed) {
			this._reload();
		}
		this._updateWebviewPlacement();
	}

	// ── webview ───────────────────────────────────────────────────────────

	/**
	 * 同梱ライブラリをローカルサーバに載せた結果。**ペインにつき一度だけ**決める
	 * （`disableServiceWorker` は webview の生成時にしか渡せない。paradisViewerAssets.ts 参照）。
	 * 文書そのものは postMessage で渡すので、ここで載せるのはライブラリだけ。
	 */
	private _libBase: Promise<string | undefined> | undefined;
	private _libBaseResolved = false;
	private _resolvedLibBase: string | undefined;

	private async _resolveLibBase(): Promise<string | undefined> {
		this._libBase ??= resolveParadisViewerLibBase(this._sharedProcessService, FileAccess.asFileUri(DOCX_MEDIA_ROOT));
		const libBase = await this._libBase;
		this._resolvedLibBase = libBase;
		this._libBaseResolved = true;
		return libBase;
	}

	private _ensureWebview(): IOverlayWebview {
		if (this._webview) {
			return this._webview;
		}
		// origin を渡さないと webview ごとに service worker 登録が増え、二度と消えない。
		const store = new DisposableStore();
		this._webviewStore.value = store;
		const lease = store.add(this._originPool.acquire(PARADIS_DOCX_DIFF_EDITOR_ID));
		const webview = this._webviewService.createWebviewOverlay({
			origin: lease.origin,
			title: undefined,
			options: {
				purpose: WebviewContentPurpose.CustomEditor,
				enableFindWidget: false,
				tryRestoreScrollPosition: true,
				// 隠すたびに service worker 登録からやり直すと白紙で止まる窓ができる。
				retainContextWhenHidden: true,
				// ローカルサーバから配れるなら service worker は要らない。
				disableServiceWorker: !!this._resolvedLibBase
			},
			contentOptions: {
				allowScripts: true,
				// .docx 本体は postMessage で渡すので、許可するのは vendored ライブラリだけでよい。
				localResourceRoots: [FileAccess.asFileUri(DOCX_MEDIA_ROOT)]
			},
			extension: undefined
		});
		this._webview = webview;
		store.add(webview);
		store.add(webview.onMessage(event => this._onWebviewMessage(event.message as ParadisDocxWebviewMessage)));
		return webview;
	}

	private _disposeWebview(): void {
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
		}
		this._webviewClaimed = false;
		this._webview = undefined;
		this._webviewStore.clear();
	}

	/** webview を作り直して読み込みからやり直す。 */
	private _reload(recoveryGeneration = this._recoveryGeneration): void {
		void this._reloadAfterAssets(recoveryGeneration);
	}

	private _onWatchedResourceChanged(resource: URI): void {
		if (!isEqual(this._modifiedResource, resource)) {
			return;
		}
		const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'watchChanged' });
		this._recoveryState = transition.state;
		this._applyRecoveryEffects(transition.effects);
	}

	private _applyRecoveryEffects(effects: readonly ParadisOfficeRecoveryEffect[]): void {
		for (const effect of effects) {
			switch (effect.type) {
				case 'load':
					this._reload(effect.generation);
					break;
				case 'remount':
					this._remountDocumentSnapshot(effect.generation);
					break;
				case 'recreate':
					this._disposeWebview();
					this._recreatingForRecovery = true;
					this._updateWebviewPlacement();
					this._recreatingForRecovery = false;
					this._remountDocumentSnapshot(effect.generation);
					break;
				case 'restore':
					// A failed watcher preflight never replaces the committed webview DOM.
					break;
				case 'showError':
					this._renderRecoveryError();
					break;
			}
		}
	}

	private _remountDocumentSnapshot(recoveryGeneration: number): void {
		if (!this._documentSnapshot || !this._webviewClaimed) {
			return;
		}
		this._recoveryGeneration = recoveryGeneration;
		this._loadGeneration++;
		this._webviewRecoveryGeneration = recoveryGeneration;
		this._webview?.setHtml(applyParadisOfficeWebviewAccessibility(buildParadisDocxDiffHtml({
			original: localize('paradis.docxDiff.paneOriginal', "旧版 — {0}", basename(this._originalResource!)),
			modified: localize('paradis.docxDiff.paneModified', "新版 — {0}", basename(this._modifiedResource!)),
			loading: localize('paradis.docxDiff.loading', "読み込み中…"),
		}, this._resolvedLibBase)));
	}

	private async _reloadAfterAssets(recoveryGeneration: number): Promise<void> {
		const libBase = await this._resolveLibBase();
		const original = this._originalResource;
		const modified = this._modifiedResource;
		if (!original || !modified || !this._webviewClaimed) {
			return;
		}
		const loadGeneration = ++this._loadGeneration;
		this._assetSanitization.value?.cancel();
		const sanitization = new CancellationTokenSource(); this._assetSanitization.value = sanitization;
		try {
			const [originalPackage, modifiedPackage] = await Promise.all([
				this._readDocument(original, sanitization.token),
				this._readDocument(modified, sanitization.token),
			]);
			if (loadGeneration !== this._loadGeneration || this._disposed || sanitization.token.isCancellationRequested
				|| !isEqual(this._originalResource, original) || !isEqual(this._modifiedResource, modified)) {
				return;
			}
			this._documentSnapshot = {
				original: new Uint8Array(originalPackage.buffer),
				modified: new Uint8Array(modifiedPackage.buffer),
				placeholders: [...originalPackage.placeholders, ...modifiedPackage.placeholders],
			};
			this._assetPlaceholders = this._documentSnapshot.placeholders;
		} catch (error) {
			if (loadGeneration === this._loadGeneration && !sanitization.token.isCancellationRequested) {
				const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'sourceUnavailable', generation: recoveryGeneration });
				this._recoveryState = transition.state;
				if (!transition.state.committed) {
					this._setNotice(this._describeError(error));
				}
			}
			return;
		}
		this._recoveryGeneration = recoveryGeneration;
		const webview = this._ensureWebview();
		this._webviewRecoveryGeneration = recoveryGeneration;
		webview.setHtml(applyParadisOfficeWebviewAccessibility(buildParadisDocxDiffHtml({
			// allow-any-unicode-next-line
			original: localize('paradis.docxDiff.paneOriginal', "旧版 — {0}", basename(original)),
			// allow-any-unicode-next-line
			modified: localize('paradis.docxDiff.paneModified', "新版 — {0}", basename(modified)),
			// allow-any-unicode-next-line
			loading: localize('paradis.docxDiff.loading', "読み込み中…"),
		}, libBase)));
	}

	/** webview の受信準備ができてから .docx の中身を送る（先に送ると取りこぼす）。 */
	private async _sendDocuments(): Promise<void> {
		const webview = this._webview;
		const snapshot = this._documentSnapshot;
		if (!webview || !snapshot) {
			return;
		}
		if (this._webviewRecoveryGeneration !== this._recoveryState.generation) {
			return;
		}
		this._sentRecoveryGeneration = this._webviewRecoveryGeneration;
		const generation = this._loadGeneration;
		// 読み直しの前にツールバーの状態を送り直す。webview は作り直されるたびに
		// 倍率 1・書式表示 ON に戻るので、送らないとツールバーの表示と本文が食い違う。
		void webview.postMessage({ type: 'zoom', scale: this._scale });
		void webview.postMessage({ type: 'showFormatChanges', enabled: this._showFormatChanges });
		void webview.postMessage({ type: 'revisionMode', mode: this._displayMode });
		const originalBuffer = snapshot.original.buffer.slice(snapshot.original.byteOffset, snapshot.original.byteOffset + snapshot.original.byteLength) as ArrayBuffer;
		const modifiedBuffer = snapshot.modified.buffer.slice(snapshot.modified.byteOffset, snapshot.modified.byteOffset + snapshot.modified.byteLength) as ArrayBuffer;
		// Retry copies only the already-sanitized bytes; semantic trees and geometry are not reparsed on the host.
		void webview.postMessage(
			{ type: 'load', generation, original: originalBuffer, modified: modifiedBuffer, assetPlaceholders: snapshot.placeholders },
			[originalBuffer, modifiedBuffer]
		);
	}

	private async _readDocument(resource: URI, token: CancellationToken): Promise<{ readonly buffer: ArrayBuffer; readonly placeholders: readonly ParadisOfficePlaceholder[] }> {
		// 上限は readFile に渡す。読み切ってから判定すると、巨大なファイルを一度メモリに載せてしまう。
		const content = await this._fileService.readFile(resource, { limits: { size: PARADIS_DOCX_MAX_BYTES } });
		const sanitized = await sanitizeParadisDocxBytesForRenderer(content.value.buffer, `diff_${this._loadGeneration}`, token);
		const bytes = sanitized.bytes;
		return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, placeholders: sanitized.placeholders };
	}

	/** 例外を利用者に見せる文言にする。ファイルが大きすぎる場合だけ専用の案内を出す。 */
	private _describeError(error: unknown): string {
		if (error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_TOO_LARGE) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.tooLarge', "ファイルが大きすぎるため比較できません");
		}
		return error instanceof Error ? error.message : String(error);
	}

	private _onWebviewMessage(message: ParadisDocxWebviewMessage): void {
		if (this._disposed || !message) {
			return;
		}
		switch (message.type) {
			case 'ready':
				void this._sendDocuments();
				return;
			case 'outline':
				// 読み直しをまたいで届いた古い概要は捨てる（旧文書の差分を新文書へ当ててしまうため）。
				if (message.generation !== this._loadGeneration) {
					return;
				}
				this._onOutline(message.original, message.modified);
				return;
			case 'rendered':
				{
					if (this._sentRecoveryGeneration !== this._recoveryState.generation) {
						return;
					}
					const transition = reduceParadisOfficeRecovery(this._recoveryState, {
						type: 'rendered', generation: this._recoveryGeneration, hasExpectedRoot: true,
					});
					this._recoveryState = transition.state;
					this._applyRecoveryEffects(transition.effects);
				}
				this._updateNav();
				return;
			case 'activeChange': {
				const index = this._changes.findIndex(change => change.id === message.changeId);
				if (index >= 0 && index !== this._currentIndex) {
					this._currentIndex = index;
					this._updateNav();
				}
				return;
			}
			case 'error':
				this._setNotice(this._describeWebviewError(message));
				{
					const transition = reduceParadisOfficeRecovery(this._recoveryState, {
						type: 'sourceUnavailable', generation: this._recoveryState.generation,
					});
					this._recoveryState = transition.state;
					this._applyRecoveryEffects(transition.effects);
				}
				return;
			default:
				return;
		}
	}

	private _renderRecoveryError(): void {
		this._setNotice(localize('paradis.docxDiff.blank', "比較結果を表示できませんでした。"));
		const resource = this._modifiedResource;
		if (!this._noticeEl || !resource) {
			return;
		}
		const retry = dom.append(this._noticeEl, $('button')) as HTMLButtonElement;
		retry.type = 'button';
		retry.textContent = localize('paradis.docxDiff.retry', "再試行");
		this._inputDisposables.value?.add(dom.addDisposableListener(retry, dom.EventType.CLICK, () => {
			const transition = reduceParadisOfficeRecovery(this._recoveryState, { type: 'retry' });
			this._recoveryState = transition.state;
			this._applyRecoveryEffects(transition.effects);
		}));
		if (resource.scheme === Schemas.file) {
			const open = dom.append(this._noticeEl, $('button')) as HTMLButtonElement;
			open.type = 'button';
			open.textContent = localize('paradis.docxDiff.openAfterBlank', "既定のアプリで開く");
			this._inputDisposables.value?.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
				void this._nativeHostService.openExternal(resource.toString(true));
			}));
		}
	}

	/** webview からのエラーを利用者向けの文言にする。既知のものは翻訳し、それ以外は生のまま出す。 */
	private _describeWebviewError(message: { readonly side?: ParadisDocxSide; readonly message: string }): string {
		if (message.message === PARADIS_DOCX_ERROR_LIBRARY_MISSING) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.library', "表示用のライブラリを読み込めませんでした");
		}
		if (message.side === 'original') {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.original', "旧版を読み込めませんでした: {0}", message.message);
		}
		if (message.side === 'modified') {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.error.modified', "新版を読み込めませんでした: {0}", message.message);
		}
		// allow-any-unicode-next-line
		return localize('paradis.docxDiff.error.generic', "Word 文書を比較できませんでした: {0}", message.message);
	}

	private _onOutline(original: IParadisDocxOutline, modified: IParadisDocxOutline): void {
		let result: IParadisDocxDiffResult;
		try {
			result = buildDocxDiff(original, modified);
		} catch (error) {
			this._setNotice(error instanceof Error ? error.message : String(error));
			return;
		}
		this._changes = result.changes;
		this._modifiedOutline = modified;
		this._currentIndex = -1;
		this._setCount(result.changes.length);
		this._setNotice(this._degradedNotice(result));
		this._updateNav();
		this._renderSemanticUi(result);
		// 文言（書式変更のツールチップ）は webview では作れないので、送る直前にここで埋める。
		void this._webview?.postMessage({
			type: 'annotate',
			annotations: localizeDocxAnnotations(result.annotations),
			fillers: result.fillers,
		});
	}

	private _currentWordViewState(): ParadisWordViewState {
		const inspector = this._changeInspector.value?.getViewState();
		return {
			zoom: this._scale,
			displayMode: this._displayMode,
			activeStory: inspector?.activeStory ?? this._wordViewState.activeStory,
			categories: inspector?.categories ?? this._wordViewState.categories,
			...(inspector?.selectedChangeId ? { selectedChangeId: inspector.selectedChangeId } : {}),
		};
	}

	private _clearSemanticUi(): void {
		this._changeInspector.clear();
		this._findWidget.value?.setSearchProvider(undefined, localize('paradis.word.diffSearchDisabled', "この比較では検索を利用できません。"));
		if (this._diagnosticsEl) {
			dom.clearNode(this._diagnosticsEl);
		}
		if (this._inspectorPanel) {
			dom.clearNode(this._inspectorPanel);
			this._inspectorPanel.style.display = 'none';
		}
		if (this._inspectorToggle) {
			this._inspectorToggle.style.display = 'none';
			this._inspectorToggle.setAttribute('aria-expanded', 'false');
		}
	}

	private _renderSemanticUi(result: IParadisDocxDiffResult): void {
		const configuration = this._runtimeConfiguration;
		if (!configuration) {
			this._clearSemanticUi();
			return;
		}
		const v1Enabled = isParadisWordV1Enabled(configuration);
		const callbacks = createParadisOfficeSearchPrintCallbacks(configuration, v1Enabled, {
			search: () => undefined,
			print: () => async () => {
				const model = createLegacyWordPrintModel(basename(this._modifiedResource ?? URI.file('document.docx')), this._assetPlaceholders, this._modifiedOutline);
				const result = await printParadisOfficeModelInBrowser(model, this.window);
				return withParadisOfficePrintResult(model, result);
			},
		});
		if (!v1Enabled) {
			this._clearSemanticUi();
			return;
		}
		this._findWidget.value?.setSearchProvider(callbacks.search, callbacks.print
			? localize('paradis.word.diffSearchUnavailable', "この比較では文書内の検索を利用できません。")
			: localize('paradis.word.searchDisabled', "検索は設定で無効になっています。"));
		const adapted = adaptLegacyWordInspectorChangeSet(result);
		const coverages: ParadisOfficeRenderCoverage[] = ['approximated', ...this._assetPlaceholders.map(() => 'placeholder' as const)];
		if (adapted.truncated || result.degraded?.length) {
			coverages.push('noAnchor');
		}
		if (this._diagnosticsEl) {
			renderWordDiagnosticsRibbon(this._diagnosticsEl, {
				outcome: adapted.outcome,
				coverages,
				warnings: [{
					code: 'word.diff.legacyProjection',
					message: localize('paradis.word.diffLegacyProjection', "互換表示で比較を表示していますが、詳細な解析は完了していません。"),
				}],
			});
		}
		if (!this._inspectorPanel || !this._inspectorToggle) {
			return;
		}
		this._inspectorToggle.style.display = '';
		dom.clearNode(this._inspectorPanel);
		const inspector = new ParadisWordChangeInspector(this._inspectorPanel, {
			searchUnavailable: callbacks.print
				? localize('paradis.word.diffSearchUnavailable', "この比較では文書内の検索を利用できません。")
				: localize('paradis.word.searchDisabled', "検索は設定で無効になっています。"),
			...(callbacks.print ? {
				getPrintModel: callbacks.print,
			} : { printUnavailable: localize('paradis.word.printDisabled', "印刷プレビューは設定で無効になっています。") }),
			onNavigate: target => {
				const match = /^legacy-change:(\d+)$/.exec(target.anchor ?? '');
				if (match) {
					const changeId = Number(match[1]);
					const index = this._changes.findIndex(change => change.id === changeId);
					if (index >= 0) {
						this._currentIndex = index;
						this._updateNav();
					}
					void this._webview?.postMessage({ type: 'reveal', changeId });
				}
			},
			onDidChangeViewState: state => {
				this._wordViewState = state;
				this._displayMode = state.displayMode;
				this._setScale(state.zoom);
				void this._webview?.postMessage({ type: 'revisionMode', mode: state.displayMode });
			},
		});
		this._changeInspector.value = inspector;
		inspector.setViewState(this._wordViewState);
		inspector.setComparison(adapted.changes, adapted.completeness, adapted.outcome);
		inspector.setPlaceholders(this._assetPlaceholders);
	}

	private _degradedNotice(result: IParadisDocxDiffResult): string | undefined {
		if (!result.degraded?.length) {
			return undefined;
		}
		if (result.degraded.includes('blocks')) {
			// allow-any-unicode-next-line
			return localize('paradis.docxDiff.degraded.blocks', "文書が大きいため、途中までを比較しています");
		}
		// allow-any-unicode-next-line
		return localize('paradis.docxDiff.degraded.simple', "変更が多いため、一部を簡易表示しています");
	}

	// ── ツールバーの状態 ──────────────────────────────────────────────────

	private _setCount(count: number | undefined): void {
		if (!this._countEl) {
			return;
		}
		if (count === undefined) {
			this._countEl.textContent = '';
		} else if (count === 0 && !(this._runtimeConfiguration && isParadisWordV1Enabled(this._runtimeConfiguration))) {
			// allow-any-unicode-next-line
			this._countEl.textContent = localize('paradis.docxDiff.noChanges', "変更はありません");
		} else {
			// allow-any-unicode-next-line
			this._countEl.textContent = localize('paradis.docxDiff.changeCount', "{0} 件の変更", count);
		}
		if (count !== undefined) {
			this._accessibility?.announceChangeCount(count);
		}
	}

	private _setNotice(text: string | undefined): void {
		if (!this._noticeEl) {
			return;
		}
		this._noticeEl.textContent = text ?? '';
		// 横幅が足りないと省略記号で切れるので、全文はツールチップで読めるようにする。
		this._noticeEl.title = text ?? '';
		this._noticeEl.style.display = text ? '' : 'none';
	}

	private _updateNav(): void {
		if (this._navPositionEl) {
			this._navPositionEl.textContent = this._changes.length === 0
				? '-'
				: `${this._currentIndex + 1} / ${this._changes.length}`;
		}
	}

	private _navigate(delta: number): void {
		if (this._changes.length === 0) {
			return;
		}
		const next = this._currentIndex < 0
			? (delta > 0 ? 0 : this._changes.length - 1)
			: (this._currentIndex + delta + this._changes.length) % this._changes.length;
		this._currentIndex = next;
		this._updateNav();
		this._accessibility?.announceChangeLabel(describeDocxChangeStatus(this._changes[next].status), next, this._changes.length);
		void this._webview?.postMessage({ type: 'reveal', changeId: this._changes[next].id });
	}

	private _zoom(factor: number): void {
		this._setScale(this._scale * factor);
	}

	private _setScale(scale: number): void {
		const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
		if (clamped === this._scale) {
			return;
		}
		this._scale = clamped;
		this._wordViewState = { ...this._wordViewState, zoom: clamped };
		const inspector = this._changeInspector.value;
		if (inspector && inspector.getViewState().zoom !== clamped) {
			inspector.setViewState({ ...inspector.getViewState(), zoom: clamped });
		}
		this._updateScaleLabel();
		void this._webview?.postMessage({ type: 'zoom', scale: clamped });
	}

	private _updateScaleLabel(): void {
		if (this._percentEl) {
			this._percentEl.textContent = `${Math.round(this._scale * 100)}%`;
		}
	}

	private _setShowFormatChanges(enabled: boolean): void {
		this._showFormatChanges = enabled;
		this._updateFormatToggle();
		void this._webview?.postMessage({ type: 'showFormatChanges', enabled });
	}

	private _updateFormatToggle(): void {
		if (!this._formatToggle) {
			return;
		}
		this._formatToggle.classList.toggle('active', this._showFormatChanges);
		this._formatToggle.setAttribute('aria-pressed', String(this._showFormatChanges));
	}

	// ── ライフサイクル ────────────────────────────────────────────────────

	private _updateWebviewPlacement(): void {
		const shouldShow = this._editorVisible && !!this._originalResource && !!this._modifiedResource;
		if (!shouldShow) {
			if (this._webview && this._webviewClaimed) {
				this._webview.release(this);
				this._webviewClaimed = false;
			}
			return;
		}
		if (!this._webview && !this._libBaseResolved) {
			// 配信先が決まる前に作ると service worker の要否を間違える。ここで自分で解決を蹴る。
			void this._resolveLibBase().then(() => this._updateWebviewPlacement());
			return;
		}
		const webview = this._ensureWebview();
		const justClaimed = !this._webviewClaimed;
		if (justClaimed) {
			webview.claim(this, this.window, undefined);
			this._webviewClaimed = true;
		}
		dom.setParentFlowTo(webview.container, this._webviewContainer!);
		webview.setAnchorElement(this._webviewContainer!, this._layoutService.getContainer(this.window, Parts.EDITOR_PART));
		if (justClaimed && !this._recreatingForRecovery) {
			this._reload();
		}
	}

	override clearInput(): void {
		this._assetSanitization.value?.cancel();
		this._inputEpoch++;
		this._loadGeneration++;
		this._inputDisposables.clear();
		this._clearSemanticUi();
		this._originalResource = undefined;
		this._modifiedResource = undefined;
		this._runtimeConfiguration = undefined;
		this._changes = [];
		this._modifiedOutline = undefined;
		this._currentIndex = -1;
		this._documentSnapshot = undefined;
		this._recoveryState = createParadisOfficeRecoveryState();
		this._recoveryGeneration = 0;
		this._webviewRecoveryGeneration = 0;
		this._sentRecoveryGeneration = 0;
		if (this._webview && this._webviewClaimed) {
			this._webview.release(this);
			this._webviewClaimed = false;
		}
		// retainContextWhenHidden なので release だけでは webview は生きたまま残る。
		// 左右2文書ぶんのパース済み AST と描画済み DOM を抱えたままになるので、中身を捨てる。
		this._webview?.setHtml('');
		super.clearInput();
	}

	override getViewState(): object | undefined {
		if (!this._originalResource || !this._modifiedResource) {
			return undefined;
		}
		return {
			original: createParadisWordSourceDescriptor(this._originalResource, 'original'),
			modified: createParadisWordSourceDescriptor(this._modifiedResource, 'modified'),
			viewState: this._currentWordViewState(),
		};
	}

	override dispose(): void {
		this._assetSanitization.value?.cancel();
		this._disposed = true;
		this._loadGeneration++;
		super.dispose();
	}

	protected override setEditorVisible(visible: boolean): void {
		if (visible !== this._editorVisible) {
			this._editorVisible = visible;
			this._updateWebviewPlacement();
		}
		super.setEditorVisible(visible);
	}

	override focus(): void {
		super.focus();
		this._webview?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._root) {
			this._root.style.width = `${dimension.width}px`;
			this._root.style.height = `${dimension.height}px`;
		}
		this.setEditorVisible(dimension.width > 0 && dimension.height > 0);
	}
}

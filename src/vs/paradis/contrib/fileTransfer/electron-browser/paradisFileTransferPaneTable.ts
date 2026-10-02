/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の片側の表。WorkbenchTable に、2 段の名前の列（名前の下に権限）と、
// 列の見出しを押して並べ替える仕掛けを足す。

import * as dom from '../../../../base/browser/dom.js';
import { IListDragAndDrop } from '../../../../base/browser/ui/list/list.js';
import { ITableColumn, ITableRenderer, ITableVirtualDelegate } from '../../../../base/browser/ui/table/table.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { getIconClasses } from '../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../platform/list/browser/listService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { paradisFormatMode, ParadisFileTypeChar } from '../common/paradisFileTransfer.js';
import { paradisIsTransferTempName } from '../common/paradisFileTransferQueueTypes.js';
import {
	IParadisPaneEntry,
	IParadisSortState,
	paradisFormatDate,
	paradisFormatSize,
	paradisIsHiddenName,
	paradisKindLabel,
	paradisMatchRange,
	paradisNextSort,
	ParadisSortKey,
	PARADIS_DEFAULT_SORT,
} from '../common/paradisFileTransferListing.js';

const $ = dom.$;

/** 2 段の行（名前の下に権限）の高さ。 */
const ROW_HEIGHT_TWO_LINES = 32;
/** 権限を出さないとき（古い REH）の行の高さ。 */
const ROW_HEIGHT_ONE_LINE = 24;
const HEADER_ROW_HEIGHT = 24;
/** 見出しの列の順に対応する並べ替えの鍵。 */
const SORT_KEYS: readonly ParadisSortKey[] = ['name', 'mtime', 'size', 'kind'];

interface INameTemplate {
	readonly icon: HTMLElement;
	readonly name: HTMLElement;
	readonly permissions: HTMLElement;
}

interface ITextTemplate {
	readonly element: HTMLElement;
}

/** 一覧の 1 文字目（`d` / `l` / `-`）。 */
export function paradisTypeCharOf(entry: Pick<IParadisPaneEntry, 'kind'>): ParadisFileTypeChar {
	return entry.kind === 'symlink' ? 'l' : entry.kind === 'directory' ? 'd' : '-';
}

export interface IParadisPaneTableOptions {
	readonly user: string;
	readonly container: HTMLElement;
	readonly ariaLabel: string;
	/** 権限を 2 段目に出すか（権限のチャネルを持つ相手だけ）。 */
	readonly twoLines: () => boolean;
	/** 名前の中で強調する絞り込みの文字。 */
	readonly filterText: () => string;
	readonly dnd: IListDragAndDrop<IParadisPaneEntry>;
}

export class ParadisFileTransferPaneTable extends Disposable {

	readonly table: WorkbenchTable<IParadisPaneEntry>;

	private _sort: IParadisSortState = PARADIS_DEFAULT_SORT;
	private readonly _onDidChangeSort = this._register(new Emitter<void>());
	readonly onDidChangeSort = this._onDidChangeSort.event;

	constructor(
		private readonly options: IParadisPaneTableOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService private readonly themeService: IThemeService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		const delegate: ITableVirtualDelegate<IParadisPaneEntry> = {
			headerRowHeight: HEADER_ROW_HEIGHT,
			getHeight: () => options.twoLines() ? ROW_HEIGHT_TWO_LINES : ROW_HEIGHT_ONE_LINE,
		};
		this.table = this._register(instantiationService.createInstance(WorkbenchTable<IParadisPaneEntry>,
			options.user,
			options.container,
			delegate,
			this.columns(),
			this.renderers(),
			{
				multipleSelectionSupport: true,
				openOnSingleClick: false,
				horizontalScrolling: false,
				dnd: options.dnd,
				keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: (entry: IParadisPaneEntry) => entry.name },
				accessibilityProvider: {
					getAriaLabel: (entry: IParadisPaneEntry) => entry.mode !== undefined ? `${entry.name} ${paradisFormatMode(entry.mode, paradisTypeCharOf(entry))}` : entry.name,
					getWidgetAriaLabel: () => options.ariaLabel,
				},
			},
		)) as WorkbenchTable<IParadisPaneEntry>;
		this.installSortHeaders();
	}

	get sort(): IParadisSortState {
		return this._sort;
	}

	private columns(): ITableColumn<IParadisPaneEntry, IParadisPaneEntry>[] {
		return [
			{ label: localize('paradis.fileTransfer.column.name', "名前"), weight: 3, minimumWidth: 140, templateId: 'name', project: row => row },
			{ label: localize('paradis.fileTransfer.column.mtime', "更新日時"), weight: 1.25, minimumWidth: 110, templateId: 'mtime', project: row => row },
			{ label: localize('paradis.fileTransfer.column.size', "サイズ"), weight: 0.7, minimumWidth: 64, templateId: 'size', project: row => row },
			{ label: localize('paradis.fileTransfer.column.kind', "種類"), weight: 0.9, minimumWidth: 70, templateId: 'kind', project: row => row },
		];
	}

	private renderers(): ITableRenderer<IParadisPaneEntry, INameTemplate | ITextTemplate>[] {
		const nameRenderer: ITableRenderer<IParadisPaneEntry, INameTemplate> = {
			templateId: 'name',
			renderTemplate: container => {
				const cell = dom.append(container, $('.para-ft-name'));
				const icon = dom.append(cell, $('span.para-ft-icon'));
				const text = dom.append(cell, $('.para-ft-name-text'));
				return { icon, name: dom.append(text, $('.para-ft-name-line')), permissions: dom.append(text, $('.para-ft-perm')) };
			},
			renderElement: (entry, _index, template) => this.renderName(entry, template),
			disposeTemplate: () => { },
		};
		const textRenderer = (templateId: string, className: string, text: (entry: IParadisPaneEntry) => string): ITableRenderer<IParadisPaneEntry, ITextTemplate> => ({
			templateId,
			renderTemplate: container => ({ element: dom.append(container, $(`.para-ft-cell${className}`)) }),
			renderElement: (entry, _index, template) => {
				template.element.textContent = text(entry);
			},
			disposeTemplate: () => { },
		});
		return [
			nameRenderer,
			textRenderer('mtime', '', entry => entry.mtime !== undefined ? paradisFormatDate(entry.mtime) : ''),
			textRenderer('size', '.right', entry => entry.isDirectory || entry.size === undefined ? '—' : paradisFormatSize(entry.size)),
			textRenderer('kind', '', entry => paradisKindLabel(entry)),
		] as ITableRenderer<IParadisPaneEntry, INameTemplate | ITextTemplate>[];
	}

	private renderName(entry: IParadisPaneEntry, template: INameTemplate): void {
		template.icon.className = 'para-ft-icon';
		// アイコンのテーマにフォルダー（またはファイル）の絵が無いときは、空欄にせず codicon を出す
		const theme = this.themeService.getFileIconTheme();
		const themed = entry.isDirectory ? theme.hasFolderIcons : theme.hasFileIcons;
		template.icon.classList.add(...(themed
			? getIconClasses(this.modelService, this.languageService, entry.resource, entry.isDirectory ? FileKind.FOLDER : FileKind.FILE)
			: ThemeIcon.asClassNameArray(entry.isDirectory ? Codicon.folder : Codicon.file)));
		dom.clearNode(template.name);
		const range = paradisMatchRange(entry.name, this.options.filterText());
		if (range) {
			template.name.append(entry.name.slice(0, range.start));
			dom.append(template.name, $('span.para-ft-highlight')).textContent = entry.name.slice(range.start, range.end);
			template.name.append(entry.name.slice(range.end));
		} else {
			template.name.textContent = entry.name;
		}
		if (entry.kind === 'symlink') {
			dom.append(template.name, $(`span.para-ft-link${ThemeIcon.asCSSSelector(Codicon.fileSymlinkFile)}`)).setAttribute('aria-hidden', 'true');
		}
		if (paradisIsTransferTempName(entry.name)) {
			// 転送が途中で止まって残った一時ファイル。「操作」から消せる
			dom.append(template.name, $('span.para-ft-partial')).textContent = localize('paradis.fileTransfer.partial', "書きかけ");
		}
		template.permissions.textContent = entry.mode !== undefined ? paradisFormatMode(entry.mode, paradisTypeCharOf(entry)) : '';
		template.icon.parentElement?.parentElement?.parentElement?.classList.toggle('para-ft-hidden-row', paradisIsHiddenName(entry.name));
	}

	// --- 並べ替えの見出し ----------------------------------------------------------------------------

	private installSortHeaders(): void {
		this.headerCells().forEach((header, index) => {
			const key = SORT_KEYS[index];
			if (!key) {
				return;
			}
			header.classList.add('para-ft-sortable');
			header.setAttribute('role', 'columnheader');
			header.tabIndex = 0;
			header.dataset.label = header.textContent ?? '';
			const activate = () => {
				this._sort = paradisNextSort(this._sort, key);
				this.updateSortHeaders();
				this._onDidChangeSort.fire();
			};
			this._register(dom.addDisposableListener(header, 'click', activate));
			this._register(dom.addDisposableListener(header, 'keydown', e => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					activate();
				}
			}));
		});
		this.updateSortHeaders();
	}

	/** 表の見出しのマス（列の順）。表の部品は見出しの要素を外に出さないので、クラス名で拾う。 */
	private headerCells(): HTMLElement[] {
		// eslint-disable-next-line no-restricted-syntax -- the Table widget does not expose its header cells
		return Array.from(this.table.domNode.getElementsByClassName('monaco-table-th')).filter(dom.isHTMLElement);
	}

	private updateSortHeaders(): void {
		this.headerCells().forEach((header, index) => {
			const key = SORT_KEYS[index];
			if (!key) {
				return;
			}
			const active = key === this._sort.key;
			header.textContent = header.dataset.label ?? '';
			header.classList.toggle('active', active);
			header.classList.toggle('right', key === 'size');
			header.setAttribute('aria-sort', active ? (this._sort.descending ? 'descending' : 'ascending') : 'none');
			if (active) {
				dom.append(header, $(`span.para-ft-sort-arrow${ThemeIcon.asCSSSelector(this._sort.descending ? Codicon.arrowDown : Codicon.arrowUp)}`));
			}
		});
	}
}

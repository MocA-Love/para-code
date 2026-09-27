/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// CSV / TSV ビューアの EditorInput と、ファイルごとの「表 / テキスト」の選択の記憶。
// Markdown ビューアと同じく 1 つのペインに表とテキストエディタを内蔵する方式なので、Input は
// ParadisFileViewerInput（resource + 表示モード、dirty/save はテキストファイルへ委譲）をそのまま使う。
// 表示モードの対応: 'rendered' = 表、'raw' = テキスト。

import { Codicon } from '../../../../../base/common/codicons.js';
import { extname } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import { ITextEditorService } from '../../../../../workbench/services/textfile/common/textEditorService.js';
import { ParadisFileViewerInput, ParadisFileViewerInputSerializer } from '../paradisFileViewerInput.js';

/** CSV ビューアの EditorPane / EditorInput 識別子。 */
export const PARADIS_CSV_EDITOR_ID = 'paradis.editor.csvTable';
export const PARADIS_CSV_INPUT_TYPE_ID = 'paradis.input.csvTable';

/** 表で開く拡張子（小文字・ドット付き）。 */
export const PARADIS_CSV_EXTENSIONS: readonly string[] = ['.csv', '.tsv'];

/** 既定で表ビューアを使うか（false なら従来どおりテキストエディタで開く）。 */
export const PARADIS_CSV_VIEWER_ENABLED_KEY = 'paradis.csvViewer.enabled';

export type ParadisCsvViewMode = 'table' | 'text';

export function isParadisCsvResource(resource: URI): boolean {
	return PARADIS_CSV_EXTENSIONS.includes(extname(resource).toLowerCase());
}

export class ParadisCsvFileInput extends ParadisFileViewerInput {

	override get typeId(): string {
		return PARADIS_CSV_INPUT_TYPE_ID;
	}

	override get editorId(): string {
		return PARADIS_CSV_EDITOR_ID;
	}

	override getIcon(): ThemeIcon {
		return Codicon.table;
	}

	get csvViewMode(): ParadisCsvViewMode {
		return this.viewMode === 'raw' ? 'text' : 'table';
	}

	setCsvViewMode(mode: ParadisCsvViewMode): void {
		this.setViewMode(mode === 'text' ? 'raw' : 'rendered');
	}
}

export class ParadisCsvFileInputSerializer extends ParadisFileViewerInputSerializer {
	protected override createInput(instantiationService: IInstantiationService, resource: URI): ParadisFileViewerInput {
		return instantiationService.createInstance(ParadisCsvFileInput, resource);
	}

	override deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		// 表ビューアを設定で切った後の復元は、表ではなく通常のテキストエディタで開く。
		const disabled = instantiationService.invokeFunction(accessor => accessor.get(IConfigurationService).getValue<boolean>(PARADIS_CSV_VIEWER_ENABLED_KEY) === false);
		if (!disabled) {
			return super.deserialize(instantiationService, serializedEditor);
		}
		try {
			const data = JSON.parse(serializedEditor) as { resource?: string };
			if (typeof data.resource !== 'string') {
				return undefined;
			}
			const resource = URI.parse(data.resource);
			return instantiationService.invokeFunction(accessor => accessor.get(ITextEditorService).createTextEditor({ resource }));
		} catch {
			return undefined;
		}
	}
}

// ユーザーが「テキスト」を選んだファイルの一覧。次に開いたときもテキストで開く（他のファイルは表のまま）。
// 古いものから捨てて件数を抑える。
const TEXT_MODE_STORAGE_KEY = 'paradis.csvViewer.textModeResources';
const TEXT_MODE_MEMORY_LIMIT = 200;

function readTextModeResources(storageService: IStorageService): string[] {
	try {
		const value = JSON.parse(storageService.get(TEXT_MODE_STORAGE_KEY, StorageScope.PROFILE, '[]'));
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

/** このファイルを前回テキストで見ていたか。 */
export function isParadisCsvTextModePreferred(storageService: IStorageService, resource: URI): boolean {
	return readTextModeResources(storageService).includes(resource.toString());
}

/** ユーザーが選んだ表示を覚える（テキストなら一覧へ足し、表なら一覧から外す）。 */
export function rememberParadisCsvViewMode(storageService: IStorageService, resource: URI, mode: ParadisCsvViewMode): void {
	const key = resource.toString();
	const resources = readTextModeResources(storageService).filter(item => item !== key);
	if (mode === 'text') {
		resources.push(key);
	}
	const trimmed = resources.slice(-TEXT_MODE_MEMORY_LIMIT);
	if (trimmed.length === 0) {
		storageService.remove(TEXT_MODE_STORAGE_KEY, StorageScope.PROFILE);
	} else {
		storageService.store(TEXT_MODE_STORAGE_KEY, JSON.stringify(trimmed), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

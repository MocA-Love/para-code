/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の左右の間のドラッグ＆ドロップ。反対側の表から来た行だけを受け、
// 同じ側の中の移動はエクスプローラーの仕事として引き受けない。Finder などアプリの外から来たファイルは、
// 外部のファイルを受ける側（接続先）だけがアップロードとして受ける。

import { DataTransfers, IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IListDragAndDrop, IListDragOverReaction, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { containsDragType, getPathForFile } from '../../../../platform/dnd/browser/dnd.js';
import { IParadisPaneEntry } from '../common/paradisFileTransferListing.js';
import { IParadisTransferSource } from '../common/paradisFileTransferQueueTypes.js';

/** ドロップを受ける側（片側の画面）。 */
export interface IParadisPaneDropTarget {
	readonly location: URI | undefined;
	/** その URI がこの側のものか（同じ側から来たものは受けない）。 */
	owns(resource: URI): boolean;
	canReceive(): boolean;
	showDropCaption(targetDirectory: URI, count: number): void;
	hideDropCaption(): void;
	receive(entries: readonly IParadisPaneEntry[], targetDirectory: URI): void;
	/** アプリの外（Finder など）から来たファイルを受けるか（接続先の側だけ）。 */
	acceptsExternalFiles(): boolean;
	/** アプリの外から落とされたファイル・フォルダー（手元の絶対パス）を受ける。パスが取れなければ空で呼ぶ。 */
	receiveExternalFiles(paths: readonly string[], targetDirectory: URI): void;
}

/** アプリの外（Finder など）からファイルを持ってきたドラッグか。表どうしのドラッグは `Files` を持たない。 */
export function paradisIsExternalFileDrag(event: DragEvent | undefined): boolean {
	return !!event && containsDragType(event, DataTransfers.FILES);
}

/** dragover の間に分かる、持ってきたファイルの数（文字列などの項目は数えない）。 */
export function paradisExternalFileCount(items: DataTransferItemList | undefined): number {
	let count = 0;
	if (!items) {
		return count;
	}
	for (let i = 0; i < items.length; i++) {
		if (items[i].kind === 'file') {
			count++;
		}
	}
	return count;
}

/**
 * 落とされたファイルの手元のパス。パスの取れないもの（ブラウザーの中の画像など）は飛ばし、重ねては数えない。
 * `NativeDragAndDropData.files` は大きさも種類も無いもの（フォルダー・空のファイル）を落とすので、元の `FileList` を渡す。
 */
export function paradisExternalDropPaths(files: ArrayLike<File> | undefined, getPath: (file: File) => string | undefined): string[] {
	const paths: string[] = [];
	if (!files) {
		return paths;
	}
	for (let i = 0; i < files.length; i++) {
		const path = getPath(files[i]);
		if (path && !paths.includes(path)) {
			paths.push(path);
		}
	}
	return paths;
}

/** 落とされた手元のパスと、その stat から転送の元を作る（左の表から送るときと同じ形）。 */
export function paradisExternalTransferSource(path: string, stat: { readonly isDirectory: boolean; readonly size?: number; readonly mtime?: number }): IParadisTransferSource {
	const resource = URI.file(path);
	return {
		resource,
		name: basename(resource),
		isDirectory: stat.isDirectory,
		size: stat.isDirectory ? undefined : stat.size,
		mtime: stat.mtime,
	};
}

/** 反対側の表から来た行。違うもの（同じ側・ファイルの外部ドロップ）なら undefined。 */
export function paradisDroppedEntries(data: IDragAndDropData, owns: (resource: URI) => boolean): IParadisPaneEntry[] | undefined {
	if (!(data instanceof ElementsDragAndDropData)) {
		return undefined;
	}
	const elements = data.elements as IParadisPaneEntry[];
	return elements.length > 0 && elements.every(element => element && URI.isUri(element.resource) && !owns(element.resource)) ? elements : undefined;
}

export function createParadisPaneDragAndDrop(target: IParadisPaneDropTarget, getPath: (file: File) => string | undefined = getPathForFile): IListDragAndDrop<IParadisPaneEntry> {
	const targetDirectoryOf = (element: IParadisPaneEntry | undefined): URI | undefined =>
		element?.isDirectory ? element.resource : target.location;
	return {
		getDragURI: entry => entry.resource.toString(),
		getDragLabel: entries => entries.length === 1
			? entries[0].name
			: localize('paradis.fileTransfer.dragLabel', "{0} ほか {1} 件", entries[0].name, entries.length - 1),
		onDragStart: (_data, originalEvent) => {
			if (originalEvent.dataTransfer) {
				originalEvent.dataTransfer.effectAllowed = 'copy';
			}
		},
		onDragOver: (data, targetElement, targetIndex, _targetSector, originalEvent): boolean | IListDragOverReaction => {
			const targetDirectory = targetDirectoryOf(targetElement);
			// dragover の間は外から来たファイルの中身を読めない（数は items で分かる）
			const count = paradisIsExternalFileDrag(originalEvent)
				? (target.acceptsExternalFiles() ? paradisExternalFileCount(originalEvent?.dataTransfer?.items) : 0)
				: paradisDroppedEntries(data, resource => target.owns(resource))?.length ?? 0;
			if (!count || !targetDirectory || !target.canReceive()) {
				target.hideDropCaption();
				return false;
			}
			target.showDropCaption(targetDirectory, count);
			return {
				accept: true,
				effect: { type: ListDragOverEffectType.Copy, position: ListDragOverEffectPosition.Over },
				feedback: targetElement?.isDirectory && targetIndex !== undefined ? [targetIndex] : [-1],
			};
		},
		onDragLeave: () => target.hideDropCaption(),
		drop: (data, targetElement, _targetIndex, _targetSector, originalEvent) => {
			target.hideDropCaption();
			const targetDirectory = targetDirectoryOf(targetElement);
			if (!targetDirectory || !target.canReceive()) {
				return;
			}
			if (paradisIsExternalFileDrag(originalEvent)) {
				// DataTransfer はイベントを返すと読めなくなるので、ここでパスを取り切る
				if (target.acceptsExternalFiles()) {
					// パスが 1 件も取れなくても渡す（受ける側が「送れない」と知らせる）
					target.receiveExternalFiles(paradisExternalDropPaths(originalEvent?.dataTransfer?.files, getPath), targetDirectory);
				}
				return;
			}
			const sources = paradisDroppedEntries(data, resource => target.owns(resource));
			if (sources) {
				target.receive(sources, targetDirectory);
			}
		},
		onDragEnd: () => target.hideDropCaption(),
		dispose: () => { },
	};
}

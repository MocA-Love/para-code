/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の左右の間のドラッグ＆ドロップ。反対側の表から来た行だけを受け、
// 同じ側の中の移動はエクスプローラーの仕事として引き受けない。

import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { IListDragAndDrop, IListDragOverReaction, ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData } from '../../../../base/browser/ui/list/listView.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IParadisPaneEntry } from '../common/paradisFileTransferListing.js';

/** ドロップを受ける側（片側の画面）。 */
export interface IParadisPaneDropTarget {
	readonly location: URI | undefined;
	/** その URI がこの側のものか（同じ側から来たものは受けない）。 */
	owns(resource: URI): boolean;
	canReceive(): boolean;
	showDropCaption(targetDirectory: URI, count: number): void;
	hideDropCaption(): void;
	receive(entries: readonly IParadisPaneEntry[], targetDirectory: URI): void;
}

/** 反対側の表から来た行。違うもの（同じ側・ファイルの外部ドロップ）なら undefined。 */
export function paradisDroppedEntries(data: IDragAndDropData, owns: (resource: URI) => boolean): IParadisPaneEntry[] | undefined {
	if (!(data instanceof ElementsDragAndDropData)) {
		return undefined;
	}
	const elements = data.elements as IParadisPaneEntry[];
	return elements.length > 0 && elements.every(element => element && URI.isUri(element.resource) && !owns(element.resource)) ? elements : undefined;
}

export function createParadisPaneDragAndDrop(target: IParadisPaneDropTarget): IListDragAndDrop<IParadisPaneEntry> {
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
		onDragOver: (data, targetElement, targetIndex): boolean | IListDragOverReaction => {
			const sources = paradisDroppedEntries(data, resource => target.owns(resource));
			const targetDirectory = targetDirectoryOf(targetElement);
			if (!sources || !targetDirectory || !target.canReceive()) {
				target.hideDropCaption();
				return false;
			}
			target.showDropCaption(targetDirectory, sources.length);
			return {
				accept: true,
				effect: { type: ListDragOverEffectType.Copy, position: ListDragOverEffectPosition.Over },
				feedback: targetElement?.isDirectory && targetIndex !== undefined ? [targetIndex] : [-1],
			};
		},
		onDragLeave: () => target.hideDropCaption(),
		drop: (data, targetElement) => {
			target.hideDropCaption();
			const sources = paradisDroppedEntries(data, resource => target.owns(resource));
			const targetDirectory = targetDirectoryOf(targetElement);
			if (sources && targetDirectory && target.canReceive()) {
				target.receive(sources, targetDirectory);
			}
		},
		onDragEnd: () => target.hideDropCaption(),
		dispose: () => { },
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { getComparisonKey } from '../../../../base/common/resources.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ISessionFileChange } from '../../../services/sessions/common/session.js';

export interface IChangesEditorLabels {
	readonly label: string;
	readonly description: string;
}

export interface IChangesEditorFileStats {
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * 変更配列から「候補URIの比較キー → 行数stats」の索引を1回だけ作る。
 *
 * 各ファイルラベルの autorun が線形 find（両辺で比較キーを構築する isEqual）を回す O(N²) を、
 * 索引構築 O(N) + ラベル側 O(1) 参照に変える。変更配列はエージェント実行中に高頻度で更新される
 * ため、数百ファイル規模のdiffでは無視できないCPUコストになっていた。
 *
 * 先勝ちルール: 同じURIに複数のchangeが紐づく場合は最初の要素を採用する（旧 find と同一）。
 */
export function buildChangesEditorFileStatsIndex(changes: readonly ISessionFileChange[]): Map<string, IChangesEditorFileStats> {
	const index = new Map<string, IChangesEditorFileStats>();
	for (const change of changes) {
		const resources = isIChatSessionFileChange2(change)
			? [change.uri, change.modifiedUri, change.originalUri]
			: [change.modifiedUri, change.originalUri];
		const stats: IChangesEditorFileStats = { insertions: change.insertions, deletions: change.deletions };
		for (const candidate of resources) {
			if (!candidate) {
				continue;
			}
			const key = getComparisonKey(candidate);
			if (!index.has(key)) {
				index.set(key, stats);
			}
		}
	}
	return index;
}

/** 索引からリソースの行数statsを取り出す（索引に無いURIは undefined）。 */
export function lookupChangesEditorFileStats(index: ReadonlyMap<string, IChangesEditorFileStats>, resource: URI): IChangesEditorFileStats | undefined {
	return index.get(getComparisonKey(resource));
}

export function getChangesEditorFileStats(resource: URI, changes: readonly ISessionFileChange[]): IChangesEditorFileStats | undefined {
	return lookupChangesEditorFileStats(buildChangesEditorFileStatsIndex(changes), resource);
}

function getChangesEditorDescription(uri: URI, label: string, labelService: Pick<ILabelService, 'getUriLabel' | 'getSeparator'>): string {
	const fullLabel = labelService.getUriLabel(uri, { relative: true });
	const separator = labelService.getSeparator(uri.scheme, uri.authority);
	const lastSeparatorIndex = fullLabel.lastIndexOf(separator);

	if (lastSeparatorIndex < 0) {
		return fullLabel === label ? '' : fullLabel;
	}

	return fullLabel.slice(0, lastSeparatorIndex);
}

export function getChangesEditorLabels(uri: URI, labelService: Pick<ILabelService, 'getUriBasenameLabel' | 'getUriLabel' | 'getSeparator'>): IChangesEditorLabels {
	const label = labelService.getUriBasenameLabel(uri);
	return {
		label,
		description: getChangesEditorDescription(uri, label, labelService),
	};
}

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
 * PARA-PATCH: upstream resolves the stats of every file label with a linear `find` over the
 * whole change array, which is O(N^2) per refresh and showed up on large agent changesets.
 * The index below (plus {@link lookupChangesEditorFileStats}) replaces that; the original
 * `getChangesEditorFileStats` is kept as a wrapper so upstream callers are untouched.
 *
 * Builds a "comparison key of a candidate URI -> line stats" index once per change array.
 *
 * Every file label used to autorun a linear find (an isEqual that builds a comparison key on both
 * sides), which is O(N^2). This turns it into O(N) to build plus an O(1) lookup per label. The
 * change array is updated at a high rate while an agent runs, so a few hundred files were enough
 * for that to cost real CPU.
 *
 * First one wins: when several changes point at the same URI the first is kept (same as the
 * find it replaces).
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

/** Reads a resource's line stats out of the index (undefined when the URI is not in it). */
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { PARADIS_OFFICE_CHANNEL, type ParadisOfficeV1Negotiation } from '../../fileViewers/common/paradisOfficeChannel.js';

/**
 * shared process の Office の窓口と v1 で話せるかを確かめる（比較・表示の範囲・資産の取り出しが揃っていること）。
 * 話せなければ undefined。fs の `office/hello`・`office/wordDiff`（provider）と scm の `wordDiff`（`paradisMobileWordDiffRequests.ts`）が使う。
 */
export async function paradisNegotiateMobileOfficeHost(sharedProcessService: ISharedProcessService): Promise<ParadisOfficeV1Negotiation | undefined> {
	try {
		const value = await sharedProcessService.getChannel(PARADIS_OFFICE_CHANNEL).call<unknown>('negotiate', { versions: [1, 0] });
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return undefined;
		}
		const candidate = value as Partial<ParadisOfficeV1Negotiation>;
		const authorityValid = candidate.ownerCapability === undefined && candidate.connectionEpoch === undefined
			|| typeof candidate.ownerCapability === 'string' && /^[a-f\d]{64}$/.test(candidate.ownerCapability)
			&& typeof candidate.connectionEpoch === 'number' && Number.isSafeInteger(candidate.connectionEpoch) && candidate.connectionEpoch > 0;
		return candidate.version === 1 && candidate.channel === PARADIS_OFFICE_CHANNEL && Array.isArray(candidate.capabilities)
			&& candidate.capabilities.includes('compare') && candidate.capabilities.includes('getViewport') && candidate.capabilities.includes('getRenderableAsset')
			&& authorityValid
			? candidate as ParadisOfficeV1Negotiation
			: undefined;
	} catch {
		return undefined;
	}
}

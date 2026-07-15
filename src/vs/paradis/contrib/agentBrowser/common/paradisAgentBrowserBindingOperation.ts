/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisBindEligibility, paradisRequireBindingScopeEligibility } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

/**
 * Final scope gate and ordered bind operation. The eligibility check is deliberately synchronous
 * and first so neither sharing state nor shared-process IPC can start for a stale selection.
 */
export async function paradisBindPageToPaneOperation(
	eligibility: IParadisBindEligibility,
	sharePage: () => Promise<boolean>,
	bindOverIpc: () => Promise<void>,
): Promise<boolean> {
	paradisRequireBindingScopeEligibility(eligibility);
	const shared = await sharePage();
	if (!shared) {
		return false;
	}
	await bindOverIpc();
	return true;
}

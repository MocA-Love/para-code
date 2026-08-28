/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ownWordSemanticAdapterInput, parseWordSemantic, sanitizeWordPackageError, type ParadisWordSemanticParseOptions } from '../../common/word/paradisWordSemanticParser.js';
import type { ParadisWordDocument } from '../../common/word/paradisWordSemantic.js';
import { createParadisOfficeNodeArchive } from '../office/paradisOfficeNodeArchive.js';

/** Owns package bytes and caller graphs before entering the Node ZIP runtime. */
export async function parseWordSemanticNode(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisWordSemanticParseOptions = {},
	executionProfile: Exclude<ParadisOfficeInventory['budgetProfile'], 'browser'> = 'desktopLocal',
): Promise<ParadisWordDocument> {
	try {
		const input = ownWordSemanticAdapterInput(bytes, inventory, options, token, executionProfile);
		return parseWordSemantic(await createParadisOfficeNodeArchive(input.bytes), input.inventory, token, input.options);
	} catch (error) {
		throw sanitizeWordPackageError(error);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeInventory } from '../../common/paradisOfficeProtocol.js';
import { ownWordSemanticAdapterInput, parseWordSemantic, sanitizeWordPackageError, type ParadisWordSemanticParseOptions } from '../../common/word/paradisWordSemanticParser.js';
import type { ParadisWordDocument } from '../../common/word/paradisWordSemantic.js';
import { createParadisOfficeWebArchive } from '../office/paradisOfficeWebArchive.js';

/** Owns package bytes and caller graphs before entering the browser/Worker ZIP runtime. */
export async function parseWordSemanticWeb(
	bytes: Uint8Array,
	inventory: ParadisOfficeInventory,
	token?: CancellationToken,
	options: ParadisWordSemanticParseOptions = {},
): Promise<ParadisWordDocument> {
	try {
		const input = ownWordSemanticAdapterInput(bytes, inventory, options, token, 'browser');
		return parseWordSemantic(await createParadisOfficeWebArchive(input.bytes), input.inventory, token, input.options);
	} catch (error) {
		throw sanitizeWordPackageError(error);
	}
}

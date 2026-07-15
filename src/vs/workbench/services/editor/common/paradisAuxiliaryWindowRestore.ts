/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IEditorPart } from './editorGroupsService.js';

type ParadisAuxiliaryWindowRestoreHandler = (part: IEditorPart) => Promise<boolean>;

let currentHandler: ParadisAuxiliaryWindowRestoreHandler | undefined;
let currentCloseHandler: ((part: IEditorPart) => string | undefined) | undefined;

/** Registers the Para Code owner-aware path for returning an auxiliary editor part. */
export function paradisRegisterAuxiliaryWindowRestoreHandler(handler: ParadisAuxiliaryWindowRestoreHandler): IDisposable {
	currentHandler = handler;
	return toDisposable(() => {
		if (currentHandler === handler) {
			currentHandler = undefined;
		}
	});
}

/** Lets the upstream restore action delegate to Para Code when the part has a scoped owner. */
export async function paradisHandleAuxiliaryWindowRestore(part: IEditorPart): Promise<boolean> {
	return currentHandler ? currentHandler(part) : false;
}

/** Registers a synchronous data-protection check for auxiliary window closure. */
export function paradisRegisterAuxiliaryWindowCloseHandler(handler: (part: IEditorPart) => string | undefined): IDisposable {
	currentCloseHandler = handler;
	return toDisposable(() => {
		if (currentCloseHandler === handler) {
			currentCloseHandler = undefined;
		}
	});
}

/** Returns a veto reason when closing the part could lose scoped state. */
export function paradisValidateAuxiliaryWindowClose(part: IEditorPart): string | undefined {
	return currentCloseHandler?.(part);
}

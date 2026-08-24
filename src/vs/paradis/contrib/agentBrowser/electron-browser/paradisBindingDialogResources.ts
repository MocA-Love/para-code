/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';

/** Owns the mobile-device polling lease while the binding dialog's devices tab is visible. */
export class ParadisBindingDialogDevicePollLease extends Disposable {
	private readonly pollLease = this._register(new MutableDisposable<IDisposable>());

	constructor(private readonly beginPolling: () => IDisposable) {
		super();
	}

	setDevicesVisible(visible: boolean): void {
		if (visible === (this.pollLease.value !== undefined)) {
			return;
		}
		this.pollLease.value = visible ? this.beginPolling() : undefined;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';

export type ParadisBindingDialogTab = 'panes' | 'devices' | 'mcp';

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

/** Coordinates active-tab state, device polling ownership, and rendering for one binding dialog. */
export class ParadisBindingDialogTabController extends Disposable {
	private readonly devicePollLease: ParadisBindingDialogDevicePollLease;
	private currentTab: ParadisBindingDialogTab = 'panes';

	constructor(beginPolling: () => IDisposable, private readonly render: () => void) {
		super();
		this.devicePollLease = this._register(new ParadisBindingDialogDevicePollLease(beginPolling));
	}

	get activeTab(): ParadisBindingDialogTab { return this.currentTab; }

	initialize(hasPage: boolean): void {
		this.setActiveTab(hasPage ? 'panes' : 'devices');
	}

	setActiveTab(tab: ParadisBindingDialogTab): void {
		this.currentTab = tab;
		this.devicePollLease.setDevicesVisible(tab === 'devices');
		this.render();
	}
}

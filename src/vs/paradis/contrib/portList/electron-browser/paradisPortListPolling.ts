/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';

const PANEL_OPEN_POLL_INTERVAL_MS = 15_000;

export interface IParadisPortListPollTimer {
	cancel(): void;
	cancelAndSet(runner: () => void, interval: number): void;
}

export class ParadisPortListPolling extends Disposable {

	private open = false;

	constructor(private readonly timer: IParadisPortListPollTimer, private readonly poll: () => void) {
		super();
	}

	setPanelOpen(open: boolean): void {
		if (open === this.open) {
			return;
		}
		this.open = open;
		this.timer.cancel();
		if (open) {
			this.timer.cancelAndSet(this.poll, PANEL_OPEN_POLL_INTERVAL_MS);
		}
	}

	override dispose(): void {
		this.timer.cancel();
		super.dispose();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisChangelogLifecycleModal extends IDisposable {
	readonly onDidDispose: Event<void>;
}

export interface IParadisChangelogGeneration<TModal extends IParadisChangelogLifecycleModal> {
	readonly modal: TModal;
	readonly token: CancellationToken;
	isCurrent(): boolean;
	finishFetch(): void;
}

interface IParadisChangelogEntry<TModal extends IParadisChangelogLifecycleModal> {
	readonly modal: TModal;
	readonly cts: CancellationTokenSource;
	closeListener: IDisposable;
	retired: boolean;
	fetchFinished: boolean;
}

export class ParadisChangelogLifecycle<TModal extends IParadisChangelogLifecycleModal> extends Disposable {

	private active: IParadisChangelogEntry<TModal> | undefined;

	open(factory: () => TModal): IParadisChangelogGeneration<TModal> {
		if (this.active) {
			this.retire(this.active, true);
		}

		const modal = factory();
		const entry: IParadisChangelogEntry<TModal> = {
			modal,
			cts: new CancellationTokenSource(),
			closeListener: Disposable.None,
			retired: false,
			fetchFinished: false,
		};
		entry.closeListener = modal.onDidDispose(() => this.retire(entry, false));
		this.active = entry;

		return {
			modal,
			token: entry.cts.token,
			isCurrent: () => this.active === entry && !entry.retired,
			finishFetch: () => this.finishFetch(entry),
		};
	}

	private finishFetch(entry: IParadisChangelogEntry<TModal>): void {
		if (this.active !== entry || entry.retired || entry.fetchFinished) {
			return;
		}
		entry.fetchFinished = true;
		entry.cts.dispose();
	}

	private retire(entry: IParadisChangelogEntry<TModal>, disposeModal: boolean): void {
		if (entry.retired) {
			return;
		}
		entry.retired = true;
		if (this.active === entry) {
			this.active = undefined;
		}
		entry.cts.cancel();
		entry.cts.dispose();
		entry.fetchFinished = true;
		entry.closeListener.dispose();
		if (disposeModal) {
			entry.modal.dispose();
		}
	}

	override dispose(): void {
		if (this.active) {
			this.retire(this.active, true);
		}
		super.dispose();
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkingCopyIdentifier } from './workingCopy.js';

export const IWorkingCopyBackupRestoreRouter = createDecorator<IWorkingCopyBackupRestoreRouter>('workingCopyBackupRestoreRouter');

export const enum WorkingCopyBackupRestoreDecision {
	Restore,
	Defer
}

export interface IWorkingCopyBackupRestoreRouteProvider {
	route(identifier: IWorkingCopyIdentifier): WorkingCopyBackupRestoreDecision | Promise<WorkingCopyBackupRestoreDecision>;
}

export interface IWorkingCopyBackupRestoreRouter {
	readonly _serviceBrand: undefined;

	registerProvider(provider: IWorkingCopyBackupRestoreRouteProvider): IDisposable;
	registerRestorer(restorer: () => Promise<void>): IDisposable;
	route(identifier: IWorkingCopyIdentifier): Promise<WorkingCopyBackupRestoreDecision>;
	requestRestore(): Promise<void>;
}

/**
 * Opt-in routing authority for Working Copy backup restoration. Without a
 * provider every backup follows the upstream restore behavior.
 */
export class WorkingCopyBackupRestoreRouter extends Disposable implements IWorkingCopyBackupRestoreRouter {

	declare readonly _serviceBrand: undefined;

	private readonly providers = new Set<IWorkingCopyBackupRestoreRouteProvider>();
	private readonly restorers = new Set<() => Promise<void>>();
	private readonly restoreSequencer = new Sequencer();

	registerProvider(provider: IWorkingCopyBackupRestoreRouteProvider): IDisposable {
		this.providers.add(provider);
		return toDisposable(() => this.providers.delete(provider));
	}

	registerRestorer(restorer: () => Promise<void>): IDisposable {
		this.restorers.add(restorer);
		return toDisposable(() => this.restorers.delete(restorer));
	}

	async route(identifier: IWorkingCopyIdentifier): Promise<WorkingCopyBackupRestoreDecision> {
		for (const provider of this.providers) {
			if (await provider.route(identifier) === WorkingCopyBackupRestoreDecision.Defer) {
				return WorkingCopyBackupRestoreDecision.Defer;
			}
		}

		return WorkingCopyBackupRestoreDecision.Restore;
	}

	requestRestore(): Promise<void> {
		return this.restoreSequencer.queue(async () => {
			await Promise.allSettled([...this.restorers].map(restorer => restorer()));
		});
	}
}

registerSingleton(IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter, InstantiationType.Delayed);

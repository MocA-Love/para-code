/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

const LOG_PREFIX = '[SessionParaGithubSettingsMigration]';

/**
 * One-shot migration that force-disables the per-repository GitHub background
 * traffic sources once, as part of the "hundreds of worktrees must not trip
 * GitHub's rate limits" work:
 *
 * - `git.autofetch` — used to default to ON in the agents window; with N open
 *   repositories it issues N `git fetch` calls every 180s. The agents-window
 *   default is now OFF, but an explicit user-level value from the old default
 *   era would keep the behavior alive, so it is removed once.
 * - `github.branchProtection` — issues 2+ GraphQL queries per repository at
 *   startup. Its agents-window default is now OFF likewise.
 *
 * Only explicit **user-level** values other than `false` are removed (the
 * settings then fall back to their defaults). Workspace-level values are left
 * alone — those are deliberate, narrowly-scoped choices. Users can re-enable
 * either setting afterwards; once every removal succeeded the migration never
 * runs again (tracked by an application-scoped storage flag; on failure it
 * retries at the next startup).
 *
 * Registered at `BlockRestore` so the settings are (best-effort) rewritten
 * before the git/github extensions activate and read them. A first launch
 * right after the update may still see one burst from requests the extensions
 * fired before the rewrite landed; from the next window on the state is clean.
 */
export class SessionParaGithubSettingsMigration extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.paraGithubSettingsMigration';

	private static readonly STORAGE_KEY = 'para.githubTraffic.forceOffMigration';

	private static readonly SETTINGS_TO_RESET: readonly string[] = [
		'git.autofetch',
		'github.branchProtection',
	];

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._run();
	}

	private async _run(): Promise<void> {
		if (this._storageService.getBoolean(SessionParaGithubSettingsMigration.STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		let allSucceeded = true;
		for (const settingKey of SessionParaGithubSettingsMigration.SETTINGS_TO_RESET) {
			const inspected = this._configurationService.inspect(settingKey);
			// Remove local and remote user values individually — `USER` alone would
			// leave the other layer's value in effect.
			const targets: [unknown, ConfigurationTarget][] = [
				[inspected.userLocalValue, ConfigurationTarget.USER_LOCAL],
				[inspected.userRemoteValue, ConfigurationTarget.USER_REMOTE],
			];
			for (const [value, target] of targets) {
				if (value === undefined || value === false) {
					continue;
				}
				try {
					this._logService.info(`${LOG_PREFIX} Removing explicit user setting ${settingKey}=${JSON.stringify(value)} (one-shot migration; the setting falls back to its default and can be re-enabled)`);
					await this._configurationService.updateValue(settingKey, undefined, target);
				} catch (err) {
					allSucceeded = false;
					this._logService.error(`${LOG_PREFIX} Failed to reset ${settingKey}; will retry at the next startup`, err);
				}
			}
		}

		if (allSucceeded) {
			this._storageService.store(SessionParaGithubSettingsMigration.STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}
}

registerWorkbenchContribution2(SessionParaGithubSettingsMigration.ID, SessionParaGithubSettingsMigration, WorkbenchPhase.BlockRestore);

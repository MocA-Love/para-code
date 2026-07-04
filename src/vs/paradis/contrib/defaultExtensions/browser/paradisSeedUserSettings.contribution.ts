/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// user settings.json へ既定値を「一度だけ」シードする contribution。
//
// 通常の既定値配布は paradisDefaultSettings.contribution.ts（設定レジストリの default レイヤー）で
// 行うが、一部の消費者はレジストリの default 値を読まない。代表例が同梱Copilot拡張のカスタム指示
// (`github.copilot.chat.commitMessageGeneration.instructions` 等): customInstructionsService の
// fetchInstructionsFromSetting は inspect の workspaceFolder/workspace/global 値だけを集め、
// default 値を意図的に無視する。こうした設定はユーザー設定ファイルに実値が無い限り効かないため、
// ここで user settings.json へ実際に書き込む。
//
// 方針:
// - シードは設定キーごとに「一度だけ」（storage(APPLICATION) に記録）。ユーザーが後から値を変更・
//   削除しても、二度と上書き・再注入しない
// - ユーザー（またはワークスペース）が既に値を持っている場合はシードせず、そのキーを処理済みにする
// - 拡張の設定キーは、拡張ホストがスキーマを登録するまで configurationEditing が ERROR_UNKNOWN_KEY で
//   書き込みを拒否する（しかも donotNotifyError なしでは通知だけ出して正常 resolve する）ため、
//   キーが設定レジストリに現れるのを待ってから書き込み、失敗はエラーとして受け取って次回起動で再試行する

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

interface IParadisSettingSeed {
	readonly key: string;
	readonly value: unknown;
}

const SETTING_SEEDS: readonly IParadisSettingSeed[] = [
	{
		// SCMの「コミットメッセージを生成」(同梱Copilot拡張) の出力を日本語に
		key: 'github.copilot.chat.commitMessageGeneration.instructions',
		value: [
			// allow-any-unicode-next-line
			{ text: 'コミットメッセージは日本語で書いてください。1行目は変更内容の簡潔な要約にしてください。' }
		]
	}
];

const SEEDED_KEYS_STORAGE_KEY = 'paradis.seededUserSettings';

class ParadisSeedUserSettingsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisSeedUserSettings';

	private readonly seeded: Set<string>;
	private readonly pending: Map<string, IParadisSettingSeed>;
	/** 同一キーへの多重書き込み防止（onDidUpdateConfiguration はシード中にも発火しうる）。 */
	private readonly inflight = new Set<string>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		try {
			this.seeded = new Set<string>(JSON.parse(this.storageService.get(SEEDED_KEYS_STORAGE_KEY, StorageScope.APPLICATION, '[]')));
		} catch {
			this.seeded = new Set<string>();
		}

		this.pending = new Map(SETTING_SEEDS.filter(seed => !this.seeded.has(seed.key)).map(seed => [seed.key, seed]));
		if (this.pending.size === 0) {
			return; // 全キーをシード済み
		}

		void this.seedKnownKeys();

		// まだレジストリに現れていないキー（拡張のスキーマ登録待ち）は、レジストリの更新を待って再試行する。
		// このウィンドウの生存中に登録されなければ何もしない（seeded 未記録のため次回起動で再試行される）。
		// 全キーのシードが済んだら購読ごと破棄する（起動直後はレジストリ更新が頻発するため）。
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		this._register(registry.onDidUpdateConfiguration(() => {
			void this.seedKnownKeys().then(() => {
				if (this.pending.size === 0) {
					this.dispose();
				}
			});
		}));
	}

	private async seedKnownKeys(): Promise<void> {
		const properties = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties();
		let changed = false;
		for (const seed of [...this.pending.values()]) {
			if (properties[seed.key] === undefined || this.inflight.has(seed.key)) {
				continue; // スキーマ未登録（拡張の起動待ち）または書き込み中
			}
			this.inflight.add(seed.key);
			try {
				const inspect = this.configurationService.inspect(seed.key);
				// ユーザー/ワークスペースがどこかで既に設定済みなら尊重してシードしない
				const hasExplicitValue = inspect.userValue !== undefined || inspect.workspaceValue !== undefined || inspect.workspaceFolderValue !== undefined;
				if (!hasExplicitValue) {
					// donotNotifyError: 既定では configurationEditing がエラーを通知トーストへ流して
					// 正常 resolve してしまい、失敗を検知できない（ERROR_UNKNOWN_KEY 等）。
					await this.configurationService.updateValue(seed.key, seed.value, {}, ConfigurationTarget.USER, { donotNotifyError: true });
				}
				this.pending.delete(seed.key);
				this.seeded.add(seed.key);
				changed = true;
			} catch (error) {
				// 書き込み失敗（settings.jsonの構文エラー等）は次回起動時（または次のレジストリ更新時）に再試行する
				this.logService.warn(`[ParadisSeedUserSettings] failed to seed ${seed.key}`, error);
			} finally {
				this.inflight.delete(seed.key);
			}
		}

		if (changed) {
			this.storageService.store(SEEDED_KEYS_STORAGE_KEY, JSON.stringify([...this.seeded]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}
}

registerWorkbenchContribution2(ParadisSeedUserSettingsContribution.ID, ParadisSeedUserSettingsContribution, WorkbenchPhase.Eventually);

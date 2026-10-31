/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationOverrides } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullManagedSettingsService } from '../../../../../platform/policy/common/copilotManagedSettings.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ParadisAgentHostEnablementService, paradisAgentHostAllowedInWindow } from '../../browser/paradisRemoteCopilotEnablement.js';
import { PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING } from '../../browser/paradisRemoteCopilotSettings.contribution.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';

class FlatTestConfigurationService extends TestConfigurationService {
	constructor(private readonly values: ReadonlyMap<string, boolean>) {
		super();
	}

	override getValue<T>(arg1?: string | IConfigurationOverrides): T | undefined {
		return (typeof arg1 === 'string' ? this.values.get(arg1) : undefined) as T | undefined;
	}
}

suite('ParadisRemoteCopilot', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function enabledIn(remoteAuthority: string | undefined, settings: { readonly aiDisabled: boolean; readonly copilotInSsh: boolean }): boolean {
		const configurationService = new FlatTestConfigurationService(new Map([
			[ChatAIDisabledSettingId, settings.aiDisabled],
			[PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING, settings.copilotInSsh],
		]));
		const service = disposables.add(new ParadisAgentHostEnablementService(
			configurationService,
			disposables.add(new MockContextKeyService()),
			new NullManagedSettingsService(),
			{ remoteAuthority } satisfies Partial<IWorkbenchEnvironmentService> as IWorkbenchEnvironmentService,
		));
		return service.enabled.get();
	}

	test('the setting is off by default', () => {
		const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()[PARADIS_REMOTE_COPILOT_AGENT_HOST_SETTING];
		assert.strictEqual(schema?.default, false);
	});

	test('only SSH windows are gated by the setting', () => {
		assert.deepStrictEqual({
			local: [paradisAgentHostAllowedInWindow(undefined, false), paradisAgentHostAllowedInWindow(undefined, true)],
			ssh: [paradisAgentHostAllowedInWindow('ssh-remote+example', false), paradisAgentHostAllowedInWindow('ssh-remote+example', true)],
			wsl: [paradisAgentHostAllowedInWindow('wsl+Ubuntu', false), paradisAgentHostAllowedInWindow('wsl+Ubuntu', true)],
		}, {
			local: [true, true],
			ssh: [false, true],
			wsl: [true, true],
		});
	});

	test('the agent host runs in an SSH window only when AI features are on and the setting is on', () => {
		const ssh = 'ssh-remote+example';
		assert.deepStrictEqual({
			sshDefault: enabledIn(ssh, { aiDisabled: false, copilotInSsh: false }),
			sshOn: enabledIn(ssh, { aiDisabled: false, copilotInSsh: true }),
			sshOnButAiOff: enabledIn(ssh, { aiDisabled: true, copilotInSsh: true }),
			localDefault: enabledIn(undefined, { aiDisabled: false, copilotInSsh: false }),
			localAiOff: enabledIn(undefined, { aiDisabled: true, copilotInSsh: true }),
		}, {
			sshDefault: false,
			sshOn: true,
			sshOnButAiOff: false,
			localDefault: true,
			localAiOff: false,
		});
	});
});

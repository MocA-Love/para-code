/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../common/paradisWorktreeCreate.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';
import { paradisLaunchAgentInWorkspace, paradisResumeAgentInWorkspace } from '../../electron-browser/paradisWorktreeHeadlessCreate.js';

suite('paradisLaunchAgentInWorkspace', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(activeStateKey: string) {
		const sent: string[] = [];
		const calls: string[] = [];
		const instance = upcastPartial<ITerminalInstance>({
			instanceId: 7,
			processReady: Promise.resolve(),
			shellType: undefined,
			sendText: async (text: string) => { sent.push(text); },
		});
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IConfigurationService, new TestConfigurationService());
		instantiationService.stub(ITerminalService, {
			createTerminal: async (options?: { location?: unknown }) => { calls.push(`create:${JSON.stringify(options?.location)}`); return instance; },
			setActiveInstance: () => { calls.push('setActive'); },
		});
		instantiationService.stub(ITerminalEditorService, { openEditor: async (_instance: unknown, location?: unknown) => { calls.push(`open:${JSON.stringify(location)}`); } });
		instantiationService.stub(IParadisTerminalScopeService, { assignInstanceScope: (_id: number, stateKey: string) => { calls.push(`assign:${stateKey}`); } });
		instantiationService.stub(IParadisWorkspaceSwitchService, { activeStateKey });
		instantiationService.stub(IParadisPaneTokenService, { getTokenForInstance: (instanceId: number) => instanceId === 7 ? 'pane-token-7' : undefined });
		instantiationService.stub(IParadisAgentModelCatalogService, { getAgentTemplates: () => PARADIS_DEFAULT_AGENT_COMMANDS });
		return { instantiationService, sent, calls };
	}

	test('起動したターミナルのインスタンス ID とペイントークンを返す', async () => {
		const { instantiationService, sent } = setup('repo-1');
		const launched = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
			rootUri: URI.file('/tmp/repo'),
			stateKey: 'repo-1',
			agentId: 'claude',
		});
		assert.deepStrictEqual({ launched, sentCount: sent.length }, {
			launched: { instanceId: 7, paneToken: 'pane-token-7' },
			sentCount: 1,
		});
	});

	test('preserveFocus opens a background tab without taking focus or activating it, even in the active space', async () => {
		const { instantiationService, calls } = setup('repo-1');
		await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
			rootUri: URI.file('/tmp/repo'),
			stateKey: 'repo-1',
			agentId: 'claude',
			preserveFocus: true,
		});
		assert.deepStrictEqual(calls, [
			'create:{"viewColumn":-1,"preserveFocus":true,"paradisInactive":true}',
			'open:{"viewColumn":-1,"preserveFocus":true,"paradisInactive":true}',
			'assign:repo-1',
		]);
	});

	test('resume でも同じ形で返す（非表示のスペース宛て）', async () => {
		const { instantiationService, sent } = setup('another-space');
		const launched = await instantiationService.invokeFunction(paradisResumeAgentInWorkspace, {
			rootUri: URI.file('/tmp/repo'),
			stateKey: 'repo-1',
			agent: 'codex',
			sessionId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
		});
		assert.deepStrictEqual({ launched, sent }, {
			launched: { instanceId: 7, paneToken: 'pane-token-7' },
			sent: ['codex resume 0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'],
		});
	});
});

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
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ITerminalEditorService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisAgentModelCatalogService } from '../../../agentModelCatalog/common/paradisAgentModelCatalog.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../common/paradisWorktreeCreate.js';
import { IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';
import { paradisLaunchAgentInWorkspace, paradisResumeAgentInWorkspace } from '../../electron-browser/paradisWorktreeHeadlessCreate.js';
import { paradisParkTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope, paradisTerminalEditorOpening } from '../../browser/paradisTerminalEditorPark.js';

suite('paradisLaunchAgentInWorkspace', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(activeStateKey: string) {
		const sent: string[] = [];
		const calls: string[] = [];
		const instance = upcastPartial<ITerminalInstance>({
			instanceId: 7,
			isDisposed: false,
			onDisposed: Event.None,
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

	// 開いている途中にスペースの切り替えが端末を park すると、エディタを開き直す処理は別のウィンドウの
	// 端末と見なされて失敗する。端末は行き先の台帳で生きているので、起動は失敗させない。
	test('keeps launching when a space switch parks the terminal while it is being opened', async () => {
		const { instantiationService, sent, calls } = setup('another-space');
		const onDisposed = store.add(new Emitter<ITerminalInstance>());
		const parked = upcastPartial<ITerminalInstance>({
			instanceId: 8,
			persistentProcessId: 80,
			shouldPersist: true,
			shellIntegrationNonce: '33333333-3333-4333-8333-333333333333',
			isDisposed: false,
			onDisposed: onDisposed.event,
			processReady: Promise.resolve(),
			shellType: undefined,
			sendText: async (text: string) => { sent.push(text); },
		});
		const openingScopes: (string | undefined)[] = [];
		instantiationService.stub(ITerminalService, { createTerminal: async () => parked });
		instantiationService.stub(ITerminalEditorService, {
			openEditor: async (instance: ITerminalInstance) => {
				openingScopes.push(paradisTerminalEditorOpening(instance)?.stateKey);
				paradisParkTerminalEditorInstance(instance, 'repo-1');
				throw new Error('No terminal persistent process to attach');
			},
		});
		try {
			const launched = await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
				rootUri: URI.file('/tmp/repo'),
				stateKey: 'repo-1',
				agentId: 'claude',
				preserveFocus: true,
			});
			assert.deepStrictEqual({ launched: launched.instanceId, calls, sentCount: sent.length, openingScopes, openingAfter: paradisTerminalEditorOpening(parked) }, {
				launched: 8,
				calls: ['assign:repo-1'],
				sentCount: 1,
				openingScopes: ['repo-1'],
				openingAfter: undefined,
			});
		} finally {
			paradisTakeParkedTerminalEditorInstancesForScope('repo-1');
		}
	});

	// 起動前に閉じられた端末の `processReady` は解決しない。待ち続けると MCP・スマホの呼び出しが返らない。
	test('fails instead of hanging when the terminal is closed before its shell starts', async () => {
		const { instantiationService, calls } = setup('another-space');
		const onDisposed = store.add(new Emitter<ITerminalInstance>());
		let isDisposed = false;
		const closed = upcastPartial<ITerminalInstance>({
			instanceId: 9,
			get isDisposed() { return isDisposed; },
			onDisposed: onDisposed.event,
			processReady: new Promise<void>(() => { }),
		});
		instantiationService.stub(ITerminalService, { createTerminal: async () => closed });
		const launch = instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, {
			rootUri: URI.file('/tmp/repo'),
			stateKey: 'repo-1',
			agentId: 'claude',
			preserveFocus: true,
		});
		await Promise.resolve();
		isDisposed = true;
		onDisposed.fire(closed);
		const error = await launch.then(() => undefined, (e: Error) => e.message);
		assert.deepStrictEqual({ error, calls, opening: paradisTerminalEditorOpening(closed) }, {
			error: 'The terminal was closed before it started.',
			calls: [],
			opening: undefined,
		});
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroup, IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IParadisAgentStatusStore, IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisPresetService } from '../../browser/paradisPresetService.js';
import { IParadisResolvedPreset } from '../../common/paradisTerminalPresets.js';

suite('ParadisPresetService space switch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 1 つ目のターミナルの準備を待っている間に、メインのウィンドウのスペースを A から B へ切り替える。
	 * `pinnedTo` を渡すと、プリセットを実行するグループはそのスペースに固定した補助ウィンドウにある。
	 */
	async function runAcrossSwitch(pinnedTo?: string): Promise<string[]> {
		const state = { activeStateKey: 'space-a', folders: [] as URI[] };
		const log: string[] = [];
		const processReady: DeferredPromise<void>[] = [];
		const group = upcastPartial<IEditorGroup>({ id: 1 });
		let instanceId = 0;
		const service = store.add(new ParadisPresetService(
			upcastPartial<IConfigurationService>({ onDidChangeConfiguration: Event.None, getValue: () => undefined }),
			upcastPartial<IWorkspaceContextService>({
				onDidChangeWorkspaceFolders: Event.None,
				getWorkspace: () => upcastPartial<IWorkspace>({ folders: state.folders.map(uri => upcastPartial<IWorkspaceFolder>({ uri })) }),
			}),
			upcastPartial<IFileService>({}),
			upcastPartial<ITerminalService>({
				instances: [],
				onDidCreateInstance: Event.None,
				createTerminal: async (options?: ICreateTerminalOptions) => {
					const id = ++instanceId;
					log.push(`terminal:${id}:${URI.isUri(options?.cwd) ? options.cwd.path : options?.cwd}`);
					const ready = new DeferredPromise<void>();
					processReady.push(ready);
					return upcastPartial<ITerminalInstance>({
						instanceId: id,
						shellLaunchConfig: {},
						processReady: ready.p,
						isDisposed: false,
						sendText: async (text: string) => { log.push(`send:${id}:${text}`); },
						focus: () => { },
					});
				},
			}),
			upcastPartial<IEditorGroupsService>({ activeGroup: group, getGroups: () => [group] }),
			upcastPartial<IWorkspaceTrustManagementService>({ onDidChangeTrust: Event.None }),
			new NullLogService(),
			upcastPartial<IParadisTerminalScopeService>({ assignInstanceScope: (id: number, stateKey: string) => { log.push(`scope:${id}:${stateKey}`); } }),
			store.add(new InMemoryStorageService()),
			upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: undefined }),
			upcastPartial<IParadisAgentStatusStore>({}),
			upcastPartial<IParadisAuxiliaryWindowScopeService>({ resolveGroup: () => ({ kind: 'managed', stateKey: pinnedTo ?? state.activeStateKey }) }),
		));
		// フォルダの監視を張らせないよう、サービスを作った後でスペース A のフォルダを開いた状態にする。
		state.folders = [URI.file('/repos/a')];
		const preset: IParadisResolvedPreset = {
			key: 'user:dev',
			name: 'dev',
			source: 'user',
			sourceIndex: 0,
			layout: 'tabs',
			tasks: [{ commands: ['npm run server'], cwd: 'server' }, { commands: ['npm run web'] }],
		};

		const running = service.runPreset(preset);
		await Promise.resolve();
		state.activeStateKey = 'space-b';
		state.folders = [URI.file('/repos/b')];
		processReady[0].complete();
		await new Promise(resolve => setTimeout(resolve, 0));
		processReady[1].complete();
		await running;
		return log;
	}

	test('later commands of a multi-command preset run in the space and folder it started in', async () => {
		assert.deepStrictEqual(await runAcrossSwitch(), [
			'terminal:1:/repos/a/server',
			'scope:1:space-a',
			'send:1:npm run server',
			'terminal:2:/repos/a',
			'scope:2:space-a',
			'send:2:npm run web',
		]);
	});

	test('terminals opened in a window pinned to another space belong to that space', async () => {
		const log = await runAcrossSwitch('space-c');
		assert.deepStrictEqual(log.filter(entry => entry.startsWith('scope:')), ['scope:1:space-c', 'scope:2:space-c']);
	});
});

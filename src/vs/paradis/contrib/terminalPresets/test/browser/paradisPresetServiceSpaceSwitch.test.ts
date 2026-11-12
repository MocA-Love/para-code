/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
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
import { IParadisAgentStatusStore, IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisPresetService } from '../../browser/paradisPresetService.js';
import { IParadisResolvedPreset } from '../../common/paradisTerminalPresets.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';

suite('ParadisPresetService space switch', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 1 つ目のターミナルの準備を待っている間に、メインのウィンドウのスペースを A から B へ切り替える。
	 * `pinnedTo` を渡すと、プリセットを実行するグループはそのスペースに固定した補助ウィンドウにある。
	 */
	function createService(pinnedTo?: string) {
		const state = { activeStateKey: 'space-a', folders: [] as URI[] };
		const log: string[] = [];
		const processReady: DeferredPromise<void>[] = [];
		/** 起動の前に端末を閉じる（`processReady` は解決しないまま）。 */
		const closeTerminal: (() => void)[] = [];
		/** 1 つ目の端末を作った。 */
		const firstCreated = new DeferredPromise<void>();
		/** 作ったターミナルの開き方（フォーカスを移さないか）と、フォーカスしたターミナル。 */
		const focus = { opened: [] as string[], focused: [] as number[] };
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
					const location = options?.location as { preserveFocus?: boolean; paradisInactive?: boolean } | undefined;
					focus.opened.push(`${id}:${location?.preserveFocus === true}:${location?.paradisInactive === true}`);
					const ready = new DeferredPromise<void>();
					processReady.push(ready);
					const onDisposed = store.add(new Emitter<ITerminalInstance>());
					const instance = upcastPartial<ITerminalInstance>({
						instanceId: id,
						shellLaunchConfig: {},
						processReady: ready.p,
						isDisposed: false,
						onDisposed: onDisposed.event,
						sendText: async (text: string) => { log.push(`send:${id}:${text}`); },
						focus: () => { focus.focused.push(id); },
					});
					closeTerminal.push(() => {
						(instance as { isDisposed: boolean }).isDisposed = true;
						onDisposed.fire(instance);
					});
					firstCreated.complete();
					return instance;
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
			upcastPartial<IParadisWorkspaceSwitchService>({
				onDidChangeRepositories: Event.None,
				get activeStateKey() { return state.activeStateKey; },
				repositories: [
					upcastPartial<IParadisWorkspaceRepository>({ id: 'space-a', name: 'a', uri: URI.file('/repos/a') }),
					upcastPartial<IParadisWorkspaceRepository>({ id: 'space-c', name: 'c', uri: URI.file('/repos/c') }),
				],
			}),
			upcastPartial<IParadisWorktreeService>({ onDidChangeWorktrees: Event.None, getWorktrees: () => [] }),
			upcastPartial<ILayoutService>({}),
			upcastPartial<ILabelService>({}),
		));
		// フォルダの監視を張らせないよう、サービスを作った後でスペース A のフォルダを開いた状態にする。
		state.folders = [URI.file('/repos/a')];
		return { service, state, log, processReady, closeTerminal, firstCreated, focus };
	}

	const preset: IParadisResolvedPreset = {
		key: 'user:dev',
		name: 'dev',
		source: 'user',
		sourceIndex: 0,
		layout: 'tabs',
		tasks: [{ commands: ['npm run server'], cwd: 'server' }, { commands: ['npm run web'] }],
	};

	async function runAcrossSwitch(pinnedTo?: string): Promise<string[]> {
		const { service, state, log, processReady } = createService(pinnedTo);
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

	test('terminals opened in a window pinned to another space belong to that space and start in its folder', async () => {
		assert.deepStrictEqual(await runAcrossSwitch('space-c'), [
			'terminal:1:/repos/c/server',
			'scope:1:space-c',
			'send:1:npm run server',
			'terminal:2:/repos/c',
			'scope:2:space-c',
			'send:2:npm run web',
		]);
	});

	test('auto-run in a space made in the background opens the terminals as background tabs and does not take the focus', async () => {
		const run = async (layout: 'tabs' | 'current', preserveFocus: boolean) => {
			const { service, processReady, firstCreated, focus } = createService();
			const running = service.runPreset({ ...preset, layout }, { forceNewTerminal: true, preserveFocus });
			await firstCreated.p;
			// タスクごとに次のターミナルの準備を待つので、作られた分を順に起動済みにする
			let done = false;
			void running.finally(() => { done = true; });
			while (!done) {
				processReady.forEach(ready => ready.complete());
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			await running;
			return focus;
		};
		assert.deepStrictEqual({
			tabsBackground: await run('tabs', true),
			currentBackground: await run('current', true),
			tabsForeground: await run('tabs', false),
		}, {
			tabsBackground: { opened: ['1:true:true', '2:true:true'], focused: [] },
			currentBackground: { opened: ['1:true:true'], focused: [] },
			tabsForeground: { opened: ['1:false:false', '2:false:false'], focused: [1] },
		});
	});

	test('stops the remaining tasks when the first terminal is closed before it starts', async () => {
		const { service, log, closeTerminal, firstCreated } = createService();
		const running = service.runPreset(preset);
		await firstCreated.p;
		// processReady は解決しないまま閉じる。
		closeTerminal[0]();
		await assert.rejects(running);
		assert.deepStrictEqual(log, [
			'terminal:1:/repos/a/server',
			'scope:1:space-a',
		]);
	});
});

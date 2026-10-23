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
import { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspace, IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IEditorGroup, IEditorGroupsService, IEditorPart } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisTerminalScopeService, IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktreeService, ParadisBindingScope } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisLayoutPresetDefinition, ParadisLayoutApplyMode } from '../../common/paradisLayoutPresets.js';
import { ParadisLayoutPresetService } from '../../electron-browser/paradisLayoutPresetService.js';

suite('ParadisLayoutPresetService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** 2 枠のターミナル（`cwd` 未指定と相対）とファイル 1 枠。1 枠目はコマンドを送るのでプロセスの準備を待つ。 */
	const preset: IParadisLayoutPresetDefinition = {
		name: 'work',
		root: [
			{ slot: { kind: 'terminal', command: 'npm run watch' } },
			{ slot: { kind: 'terminal', cwd: 'app' } },
			{ slot: { kind: 'file', path: 'README.md' } },
		],
	};

	function createService(options: { aux?: ParadisBindingScope; onCloseAllEditors?: (state: { activeStateKey: string; isSwitching: boolean; folder: URI }) => void }) {
		const state = { activeStateKey: 'space-a', isSwitching: false, folder: URI.file('/repos/a') };
		const repositories: IParadisWorkspaceRepository[] = [
			upcastPartial<IParadisWorkspaceRepository>({ id: 'space-a', name: 'a', uri: URI.file('/repos/a') }),
			upcastPartial<IParadisWorkspaceRepository>({ id: 'space-c', name: 'c', uri: URI.file('/repos/c') }),
		];
		const log: string[] = [];
		const processReady: DeferredPromise<void>[] = [];
		const makePart = (windowId: number): IEditorPart => {
			const groups = [0, 1, 2].map(index => upcastPartial<IEditorGroup>({ id: windowId * 10 + index, windowId, focus: () => { }, closeAllEditors: (async () => { options.onCloseAllEditors?.(state); return true; }) as IEditorGroup['closeAllEditors'] }));
			return upcastPartial<IEditorPart>({
				windowId,
				groups,
				applyLayout: () => { },
				getGroups: () => groups,
				getGroup: (id: number) => groups.find(group => group.id === id),
			});
		};
		const mainPart = makePart(1);
		const auxPart = makePart(2);
		const targetPart = options.aux ? auxPart : mainPart;
		let instanceId = 0;
		const service = store.add(new ParadisLayoutPresetService(
			upcastPartial<IConfigurationService>({ onDidChangeConfiguration: Event.None }),
			upcastPartial<IEditorGroupsService>({ mainPart, activeGroup: targetPart.groups[0], getPart: () => targetPart }),
			upcastPartial<IEditorService>({ openEditor: (async (input: IResourceEditorInput) => { log.push(`file:${input.resource.path}`); return undefined; }) as IEditorService['openEditor'] }),
			upcastPartial<ITerminalService>({
				createTerminal: async (createOptions?: ICreateTerminalOptions) => {
					const id = ++instanceId;
					log.push(`terminal:${id}:${URI.isUri(createOptions?.cwd) ? createOptions.cwd.path : createOptions?.cwd}`);
					const ready = new DeferredPromise<void>();
					processReady.push(ready);
					return upcastPartial<ITerminalInstance>({
						instanceId: id,
						processReady: ready.p,
						isDisposed: false,
						sendText: async (text: string) => { log.push(`send:${id}:${text}`); },
					});
				},
			}),
			upcastPartial<IWorkspaceContextService>({ getWorkspace: () => upcastPartial<IWorkspace>({ folders: [upcastPartial<IWorkspaceFolder>({ uri: state.folder })] }) }),
			upcastPartial<IParadisWorkspaceSwitchService>({
				get activeStateKey() { return state.activeStateKey; },
				get isSwitching() { return state.isSwitching; },
				repositories,
			}),
			upcastPartial<IParadisTerminalScopeService>({ assignInstanceScope: (id: number, stateKey: string) => { log.push(`scope:${id}:${stateKey}`); } }),
			upcastPartial<INotificationService>({
				info: (message: string) => { log.push(`info:${message}`); },
				warn: (message: string) => { log.push(`warn:${message}`); },
			}),
			new NullLogService(),
			upcastPartial<IParadisAuxiliaryWindowScopeService>({ resolvePart: () => options.aux ?? { kind: 'managed', stateKey: state.activeStateKey } }),
			upcastPartial<IParadisWorktreeService>({ getWorktrees: () => [] }),
			upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: undefined }),
		));
		return { service, state, log, processReady };
	}

	/** スペースの切り替えを写す: 切り替え中になり、フォルダとアクティブなスペースが入れ替わる。 */
	function switchToSpaceB(state: { activeStateKey: string; isSwitching: boolean; folder: URI }): void {
		state.isSwitching = true;
		state.activeStateKey = 'space-b';
		state.folder = URI.file('/repos/b');
	}

	test('stops the remaining slots when the space switches while the first terminal starts', async () => {
		const { service, state, log, processReady } = createService({});
		const applying = service.applyPreset(preset, { mode: ParadisLayoutApplyMode.Add });
		switchToSpaceB(state);
		processReady[0].complete();
		await applying;
		assert.deepStrictEqual(log.filter(entry => !entry.startsWith('info:')), [
			'terminal:1:/repos/a',
			'scope:1:space-a',
			'send:1:npm run watch',
		]);
		assert.strictEqual(log.filter(entry => entry.startsWith('info:')).length, 1);
	});

	test('a window pinned to another space uses that space and its folder', async () => {
		const { service, log, processReady } = createService({ aux: { kind: 'managed', stateKey: 'space-c' } });
		const applying = service.applyPreset(preset, { mode: ParadisLayoutApplyMode.Add });
		processReady[0].complete();
		await applying;
		assert.deepStrictEqual(log, [
			'terminal:1:/repos/c',
			'scope:1:space-c',
			'send:1:npm run watch',
			'terminal:2:/repos/c/app',
			'scope:2:space-c',
			'file:/repos/c/README.md',
		]);
	});

	test('a switch of the main window does not stop applying to a window pinned to its own space', async () => {
		const { service, state, log, processReady } = createService({ aux: { kind: 'managed', stateKey: 'space-c' } });
		const applying = service.applyPreset(preset, { mode: ParadisLayoutApplyMode.Add });
		switchToSpaceB(state);
		processReady[0].complete();
		await applying;
		assert.deepStrictEqual(log.filter(entry => entry.startsWith('terminal:') || entry.startsWith('file:')), [
			'terminal:1:/repos/c',
			'terminal:2:/repos/c/app',
			'file:/repos/c/README.md',
		]);
	});

	test('says nothing was applied when the space switches while confirming to close the editors', async () => {
		const { service, log } = createService({ onCloseAllEditors: state => switchToSpaceB(state) });
		await service.applyPreset(preset, { mode: ParadisLayoutApplyMode.Replace });
		// allow-any-unicode-next-line
		assert.deepStrictEqual(log, ['info:スペースが切り替わったので、レイアウト「work」は適用しませんでした。']);
	});

	test('does not apply to a window whose space is not known yet', async () => {
		const { service, log } = createService({ aux: { kind: 'pending' } });
		await service.applyPreset(preset, { mode: ParadisLayoutApplyMode.Add });
		assert.deepStrictEqual(log.map(entry => entry.split(':')[0]), ['warn']);
	});
});

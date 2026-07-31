/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkspaceFolderCreationData } from '../../../../../platform/workspaces/common/workspaces.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkspaceEditingService } from '../../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ITerminalEditorService, ITerminalInstance } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisEditorScopeService } from '../../browser/paradisEditorScopeService.js';
import { paradisGetParkedTerminalEditorStateKey, paradisTakeParkedTerminalEditorInstance } from '../../browser/paradisTerminalEditorPark.js';
import { paradisCreateDeserializedTerminalEditorInput } from './paradisTerminalEditorInputFixture.js';
import { ParadisWorkspaceSwitchService } from '../../browser/paradisWorkspaceSwitchService.js';
import { IParadisAuxiliaryWindowScopeService, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisWorkspaceSwitchService integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('restores only the source live editor and preserves its parked terminal ownership after a round trip', async () => {
		const testDisposables = new DisposableStore();
		const terminalIds = createUniqueTerminalIds();
		let sourceTerminal: ITerminalInstance | undefined;
		let didPark = false;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;

		try {
			const preexisting = paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(terminalIds.persistentProcessId, terminalIds.shellIntegrationNonce));
			try {
				assert.strictEqual(preexisting, undefined);
			} finally {
				preexisting?.dispose();
			}
			harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const sourceEditor = harness.createEditor('/workspace-a/unsaved.txt', true);
			const terminalInput = harness.createEditor('/workspace-a/terminal', false);
			await harness.parts.activeGroup.openEditor(sourceEditor, { pinned: true });
			await harness.parts.activeGroup.openEditor(terminalInput, { pinned: true });
			sourceTerminal = harness.addTerminal(terminalInput, terminalIds.instanceId, terminalIds.persistentProcessId, terminalIds.shellIntegrationNonce);

			await harness.workspaceSwitchService.switchRepository('space-b');
			didPark = paradisGetParkedTerminalEditorStateKey(sourceTerminal.instanceId) === 'space-a';

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				sourceEditorVisible: harness.parts.activeGroup.contains(sourceEditor),
				sourceEditorOwned: harness.editorScopeService.hasLiveState('space-a'),
				sourceTerminalOwner: paradisGetParkedTerminalEditorStateKey(sourceTerminal.instanceId),
				detachedTerminalInstanceIds: harness.detachedTerminalInstanceIds,
				terminalServiceInstanceIds: harness.terminalEditorService.instances.map(instance => instance.instanceId),
			}, {
				activeStateKey: 'space-b',
				sourceEditorVisible: false,
				sourceEditorOwned: true,
				sourceTerminalOwner: 'space-a',
				detachedTerminalInstanceIds: [terminalIds.instanceId],
				terminalServiceInstanceIds: [],
			});

			const targetEditor = harness.createEditor('/workspace-b/unsaved.txt', true);
			await harness.parts.activeGroup.openEditor(targetEditor, { pinned: true });
			await harness.workspaceSwitchService.switchRepository('space-a');

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				sourceEditorVisible: harness.parts.activeGroup.contains(sourceEditor),
				targetEditorVisible: harness.parts.activeGroup.contains(targetEditor),
				sourceEditorOwned: harness.editorScopeService.hasLiveState('space-a'),
				targetEditorOwned: harness.editorScopeService.hasLiveState('space-b'),
				sourceTerminalOwner: paradisGetParkedTerminalEditorStateKey(sourceTerminal.instanceId),
				detachedTerminalInstanceIds: harness.detachedTerminalInstanceIds,
				terminalServiceInstanceIds: harness.terminalEditorService.instances.map(instance => instance.instanceId),
			}, {
				activeStateKey: 'space-a',
				sourceEditorVisible: true,
				targetEditorVisible: false,
				sourceEditorOwned: false,
				targetEditorOwned: true,
				sourceTerminalOwner: 'space-a',
				detachedTerminalInstanceIds: [terminalIds.instanceId],
				terminalServiceInstanceIds: [],
			});
		} finally {
			const parked = paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(terminalIds.persistentProcessId, terminalIds.shellIntegrationNonce));
			try {
				if (didPark && sourceTerminal !== undefined) {
					assert.strictEqual(parked, sourceTerminal);
				}
			} finally {
				parked?.dispose();
				if (sourceTerminal !== undefined && parked !== sourceTerminal) {
					sourceTerminal.dispose();
				}
				try {
					await harness?.parts.activeGroup.closeAllEditors();
				} finally {
					testDisposables.dispose();
				}
			}
		}
	});

	test('does not begin a competing folder mutation until the active switch completes', async () => {
		const testDisposables = new DisposableStore();
		const firstUpdateStarted = new DeferredPromise<void>();
		const releaseFirstUpdate = new DeferredPromise<void>();
		const secondUpdateStarted = new DeferredPromise<void>();
		const timeline: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b', 'space-c'],
				testDisposables,
				async (phase, uri, updateIndex) => {
					timeline.push(`update:${uri.path}:${phase}`);
					if (phase === 'start' && updateIndex === 0) {
						firstUpdateStarted.complete();
						await releaseFirstUpdate.p;
					} else if (phase === 'start' && updateIndex === 1) {
						secondUpdateStarted.complete();
					}
				}
			);
			testDisposables.add(harness.workspaceSwitchService.onDidSwitchScope(stateKey => {
				timeline.push(`event:${stateKey}:active=${harness.workspaceSwitchService.activeStateKey}:switching=${harness.workspaceSwitchService.isSwitching}`);
			}));

			const firstSwitch = harness.workspaceSwitchService.switchRepository('space-b');
			const competingSwitch = harness.workspaceSwitchService.switchRepository('space-c');
			let switchResults: PromiseSettledResult<void>[];
			try {
				await Promise.race([
					firstUpdateStarted.p,
					firstSwitch.then(() => {
						throw new Error('The first switch completed before its folder update started');
					}),
				]);

				assert.deepStrictEqual({
					isSwitching: harness.workspaceSwitchService.isSwitching,
					timeline,
					secondUpdateStarted: secondUpdateStarted.isSettled,
				}, {
					isSwitching: true,
					timeline: ['update:/workspace-b:start'],
					secondUpdateStarted: false,
				});
			} finally {
				releaseFirstUpdate.complete();
				switchResults = await Promise.allSettled([firstSwitch, competingSwitch]);
			}

			assert.deepStrictEqual({
				switchResults: switchResults.map(result => result.status),
				secondUpdateStarted: secondUpdateStarted.isSettled,
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				isSwitching: harness.workspaceSwitchService.isSwitching,
			}, {
				switchResults: ['fulfilled', 'fulfilled'],
				secondUpdateStarted: true,
				timeline: [
					'update:/workspace-b:start',
					'update:/workspace-b:end',
					'event:space-b:active=space-b:switching=false',
					'update:/workspace-c:start',
					'update:/workspace-c:end',
					'event:space-c:active=space-c:switching=false',
				],
				activeStateKey: 'space-c',
				isSwitching: false,
			});
		} finally {
			releaseFirstUpdate.complete();
			testDisposables.dispose();
		}
	});
});

interface IWorkspaceSwitchIntegrationHarness {
	readonly workspaceSwitchService: ParadisWorkspaceSwitchService;
	readonly editorScopeService: ParadisEditorScopeService;
	readonly parts: IEditorGroupsService;
	readonly terminalEditorService: Pick<ITerminalEditorService, 'instances'>;
	readonly detachedTerminalInstanceIds: readonly number[];
	createEditor(path: string, modified: boolean): TestFileEditorInput;
	addTerminal(input: TestFileEditorInput, instanceId: number, persistentProcessId: number, shellIntegrationNonce: string): ITerminalInstance;
}

function createUniqueTerminalIds(): { readonly instanceId: number; readonly persistentProcessId: number; readonly shellIntegrationNonce: string } {
	const randomHex = generateUuid().replaceAll('-', '');
	return {
		instanceId: Number.parseInt(randomHex.slice(0, 8), 16),
		persistentProcessId: Number.parseInt(randomHex.slice(8, 21), 16),
		shellIntegrationNonce: generateUuid(),
	};
}

async function createHarness(
	stateKeys: readonly string[],
	testDisposables: DisposableStore,
	onFolderUpdate: (phase: 'start' | 'end', uri: URI, updateIndex: number) => Promise<void> = async () => { },
): Promise<IWorkspaceSwitchIntegrationHarness> {
	const repositories = stateKeys.map(stateKey => ({
		id: stateKey,
		name: stateKey,
		uri: URI.file(`/workspace-${stateKey.slice('space-'.length)}`)
	}));
	const workspace = new Workspace(
		'paradis-switch-integration',
		[toWorkspaceFolder(repositories[0].uri)],
		URI.file('/paradis.code-workspace')
	);
	const contextService = new TestContextService(workspace);
	const instantiationService = workbenchInstantiationService(undefined, testDisposables);
	instantiationService.stub(IWorkspaceContextService, contextService);
	const storageService = instantiationService.get(IStorageService);
	storageService.store(
		PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY,
		JSON.stringify(repositories.map(repository => ({
			id: repository.id,
			name: repository.name,
			uri: repository.uri.toString()
		}))),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE
	);

	const editorTypeId = `paradisWorkspaceSwitchIntegration.${stateKeys.join('.')}`;
	testDisposables.add(registerTestEditor(
		`${editorTypeId}.editor`,
		[new SyncDescriptor(TestFileEditorInput)],
		editorTypeId
	));
	instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
	const parts = await createEditorParts(instantiationService, testDisposables);
	instantiationService.stub(IEditorGroupsService, parts);
	instantiationService.stub(IWorkingCopyBackupRestoreRouter, testDisposables.add(new WorkingCopyBackupRestoreRouter()));

	let mainStateKey = repositories[0].id;
	const auxiliaryWindowScopeService = {
		initializationBarrier: Promise.resolve(),
		setMainScope: (stateKey: string | undefined) => {
			mainStateKey = stateKey ?? mainStateKey;
		},
		resolveWindow: () => ({ kind: 'managed', stateKey: mainStateKey }),
		resolvePart: () => ({ kind: 'managed', stateKey: mainStateKey }),
		resolveGroup: () => ({ kind: 'managed', stateKey: mainStateKey }),
		getPinnedParts: () => [],
		hasVisibleScope: () => false,
		closeScopeWindowsForRetirement: async () => true,
		commitScopeRetirement: () => { },
		retireScope: async () => true,
	} satisfies Omit<IParadisAuxiliaryWindowScopeService, '_serviceBrand'>;
	instantiationService.stub(IParadisAuxiliaryWindowScopeService, auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService);
	const editorScopeService = testDisposables.add(instantiationService.createInstance(ParadisEditorScopeService));

	let folderUpdateIndex = 0;
	const workspaceEditingService = {
		async updateFolders(_index: number, _deleteCount?: number, foldersToAdd: IWorkspaceFolderCreationData[] = []) {
			const uri = foldersToAdd[0].uri;
			const updateIndex = folderUpdateIndex++;
			await onFolderUpdate('start', uri, updateIndex);
			workspace.folders = [toWorkspaceFolder(uri)];
			await onFolderUpdate('end', uri, updateIndex);
		}
	} satisfies Pick<IWorkspaceEditingService, 'updateFolders'> as IWorkspaceEditingService;
	const workspaceTrustManagementService = {
		setUrisTrust: async () => { },
	} satisfies Pick<IWorkspaceTrustManagementService, 'setUrisTrust'>;
	const terminals: ITerminalInstance[] = [];
	const detachedTerminalInstanceIds: number[] = [];
	const inputs = new Map<string, TestFileEditorInput>();
	const terminalEditorService = {
		get instances() { return terminals; },
		getInputFromResource: (resource: URI) => inputs.get(resource.toString()) as unknown as ReturnType<ITerminalEditorService['getInputFromResource']>,
		detachInstance: (instance: ITerminalInstance) => {
			detachedTerminalInstanceIds.push(instance.instanceId);
			const index = terminals.indexOf(instance);
			if (index !== -1) {
				terminals.splice(index, 1);
			}
		},
	} satisfies Pick<ITerminalEditorService, 'instances' | 'getInputFromResource' | 'detachInstance'>;

	const workspaceSwitchService = testDisposables.add(new ParadisWorkspaceSwitchService(
		storageService,
		contextService,
		workspaceEditingService,
		workspaceTrustManagementService as unknown as IWorkspaceTrustManagementService,
		parts,
		instantiationService.get(IWorkbenchLayoutService),
		terminalEditorService as unknown as ITerminalEditorService,
		editorScopeService,
		auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService,
		instantiationService.get(ILogService),
	));

	return {
		workspaceSwitchService,
		editorScopeService,
		parts,
		terminalEditorService,
		detachedTerminalInstanceIds,
		createEditor(path: string, modified: boolean): TestFileEditorInput {
			const editor = testDisposables.add(new TestFileEditorInput(URI.file(path), editorTypeId));
			editor.modified = modified;
			inputs.set(editor.resource.toString(), editor);
			return editor;
		},
		addTerminal(input: TestFileEditorInput, instanceId: number, persistentProcessId: number, shellIntegrationNonce: string): ITerminalInstance {
			const onDisposed = testDisposables.add(new Emitter<ITerminalInstance>());
			const instance = {
				instanceId,
				persistentProcessId,
				shellIntegrationNonce,
				resource: input.resource,
				shouldPersist: true,
				isDisposed: false,
				onDisposed: onDisposed.event,
				dispose: () => onDisposed.fire(instance),
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminals.push(instance);
			return instance;
		}
	};
}

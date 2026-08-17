/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
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
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkspaceEditingService } from '../../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { ITerminalEditorService, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService, TerminalConnectionState } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisEditorScopeService } from '../../browser/paradisEditorScopeService.js';
import { paradisGetParkedTerminalEditorStateKey, paradisParkTerminalEditorInstance, paradisTakeParkedTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope } from '../../browser/paradisTerminalEditorPark.js';
import { paradisCreateDeserializedTerminalEditorInput } from './paradisTerminalEditorInputFixture.js';
import { ParadisTerminalWorkspaceScope } from '../../browser/paradisTerminalScope.contribution.js';
import { ParadisWorkspaceSwitchService } from '../../browser/paradisWorkspaceSwitchService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisWorktreeService, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY } from '../../common/paradisWorkspaceSwitch.js';

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

	test('skips superseded coalescing switches and lands on the last requested space', async () => {
		const testDisposables = new DisposableStore();
		const firstUpdateStarted = new DeferredPromise<void>();
		const releaseFirstUpdate = new DeferredPromise<void>();
		const timeline: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b', 'space-c', 'space-d'],
				testDisposables,
				async (phase, uri, updateIndex) => {
					timeline.push(`update:${uri.path}:${phase}`);
					if (phase === 'start' && updateIndex === 0) {
						firstUpdateStarted.complete();
						await releaseFirstUpdate.p;
					}
				}
			);

			// 連打の1回目は既に実行が始まっているので止められない。畳み込まれるのは、待機中の
			// space-c (space-d に追い越される) だけで、着地点は最後に押された space-d になる。
			const firstSwitch = harness.workspaceSwitchService.switchRepository('space-b', { coalesce: true });
			await firstUpdateStarted.p;
			const supersededSwitch = harness.workspaceSwitchService.switchRepository('space-c', { coalesce: true });
			const lastSwitch = harness.workspaceSwitchService.switchRepository('space-d', { coalesce: true });

			releaseFirstUpdate.complete();
			const switchResults = await Promise.allSettled([firstSwitch, supersededSwitch, lastSwitch]);

			assert.deepStrictEqual({
				switchResults: switchResults.map(result => result.status),
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				isSwitching: harness.workspaceSwitchService.isSwitching,
			}, {
				switchResults: ['fulfilled', 'fulfilled', 'fulfilled'],
				// space-c への folders 入れ替えが一切走っていないことが畳み込みの成立条件。
				timeline: [
					'update:/workspace-b:start',
					'update:/workspace-b:end',
					'update:/workspace-d:start',
					'update:/workspace-d:end',
				],
				activeStateKey: 'space-d',
				isSwitching: false,
			});
		} finally {
			releaseFirstUpdate.complete();
			testDisposables.dispose();
		}
	});

	test('never skips an internal switch that a caller depends on completing', async () => {
		const testDisposables = new DisposableStore();
		const firstUpdateStarted = new DeferredPromise<void>();
		const releaseFirstUpdate = new DeferredPromise<void>();
		const timeline: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b', 'space-c', 'space-d'],
				testDisposables,
				async (phase, uri, updateIndex) => {
					timeline.push(`update:${uri.path}:${phase}`);
					if (phase === 'start' && updateIndex === 0) {
						firstUpdateStarted.complete();
						await releaseFirstUpdate.p;
					}
				}
			);

			const firstSwitch = harness.workspaceSwitchService.switchRepository('space-b', { coalesce: true });
			await firstUpdateStarted.p;
			// coalesce なしの切り替え (退役のロールバックや worktree 作成直後の切り替えに相当) は、
			// 後から新しい要求が来ても飛ばしてはいけない。
			const internalSwitch = harness.workspaceSwitchService.switchRepository('space-c');
			const lastSwitch = harness.workspaceSwitchService.switchRepository('space-d', { coalesce: true });

			releaseFirstUpdate.complete();
			const switchResults = await Promise.allSettled([firstSwitch, internalSwitch, lastSwitch]);

			assert.deepStrictEqual({
				switchResults: switchResults.map(result => result.status),
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
			}, {
				switchResults: ['fulfilled', 'fulfilled', 'fulfilled'],
				timeline: [
					'update:/workspace-b:start',
					'update:/workspace-b:end',
					'update:/workspace-c:start',
					'update:/workspace-c:end',
					'update:/workspace-d:start',
					'update:/workspace-d:end',
				],
				activeStateKey: 'space-d',
			});
		} finally {
			releaseFirstUpdate.complete();
			testDisposables.dispose();
		}
	});

	test('waits for completion participants before releasing the next space switch', async () => {
		const testDisposables = new DisposableStore();
		const participantStarted = new DeferredPromise<void>();
		const releaseParticipant = new DeferredPromise<void>();
		const secondUpdateStarted = new DeferredPromise<void>();
		const completionEvents: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b', 'space-c'],
				testDisposables,
				async (phase, _uri, updateIndex) => {
					if (phase === 'start' && updateIndex === 1) {
						secondUpdateStarted.complete();
					}
				}
			);
			testDisposables.add(harness.workspaceSwitchService.onDidSwitchScope(stateKey => completionEvents.push(stateKey)));
			testDisposables.add(harness.workspaceSwitchService.registerSwitchCompletionParticipant(async stateKey => {
				if (stateKey === 'space-b') {
					participantStarted.complete();
					await releaseParticipant.p;
				}
			}));

			const firstSwitch = harness.workspaceSwitchService.switchRepository('space-b');
			const competingSwitch = harness.workspaceSwitchService.switchRepository('space-c');
			let switchResults: PromiseSettledResult<void>[];
			try {
				await Promise.race([
					participantStarted.p,
					firstSwitch.then(() => {
						throw new Error('The first switch completed before its completion participant started');
					}),
				]);

				assert.deepStrictEqual({
					activeStateKey: harness.workspaceSwitchService.activeStateKey,
					completionEvents,
					secondUpdateStarted: secondUpdateStarted.isSettled,
				}, {
					activeStateKey: 'space-b',
					completionEvents: [],
					secondUpdateStarted: false,
				});
			} finally {
				releaseParticipant.complete();
				switchResults = await Promise.allSettled([firstSwitch, competingSwitch]);
			}

			assert.deepStrictEqual({
				switchResults: switchResults.map(result => result.status),
				completionEvents,
				secondUpdateStarted: secondUpdateStarted.isSettled,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
			}, {
				switchResults: ['fulfilled', 'fulfilled'],
				completionEvents: ['space-b', 'space-c'],
				secondUpdateStarted: true,
				activeStateKey: 'space-c',
			});
		} finally {
			releaseParticipant.complete();
			testDisposables.dispose();
		}
	});

	test('keeps the sequencer held while the terminal scope opens a parked editor', async () => {
		const testDisposables = new DisposableStore();
		const openStarted = new DeferredPromise<void>();
		const releaseOpen = new DeferredPromise<void>();
		const secondUpdateStarted = new DeferredPromise<void>();
		const completionEvents: string[] = [];
		const fake = createFakeTerminalInstance(createUniqueTerminalIds());
		try {
			const harness = await createHarness(
				['space-a', 'space-b', 'space-c'],
				testDisposables,
				async (phase, _uri, updateIndex) => {
					if (phase === 'start' && updateIndex === 1) {
						secondUpdateStarted.complete();
					}
				}
			);
			harness.installTerminalScope(async instance => {
				assert.strictEqual(instance, fake.instance);
				assert.strictEqual(harness.workspaceSwitchService.activeStateKey, 'space-b');
				openStarted.complete();
				await releaseOpen.p;
			});
			testDisposables.add(harness.workspaceSwitchService.onDidSwitchScope(stateKey => completionEvents.push(stateKey)));
			assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'space-b'), true);

			const firstSwitch = harness.workspaceSwitchService.switchRepository('space-b');
			const competingSwitch = harness.workspaceSwitchService.switchRepository('space-c');
			let switchResults: PromiseSettledResult<void>[];
			try {
				await Promise.race([
					openStarted.p,
					firstSwitch.then(() => {
						throw new Error('The first switch completed before its parked terminal editor began opening');
					}),
				]);
				// openEditor が detached execution に戻っている場合、open開始の直後にparticipantと
				// 先行switchが完了する。次のmacrotaskまで進めて、その誤った完了を観測可能にする。
				await timeout(0);

				assert.deepStrictEqual({
					completionEvents,
					secondUpdateStarted: secondUpdateStarted.isSettled,
					activeStateKey: harness.workspaceSwitchService.activeStateKey,
				}, {
					completionEvents: [],
					secondUpdateStarted: false,
					activeStateKey: 'space-b',
				});
			} finally {
				releaseOpen.complete();
				switchResults = await Promise.allSettled([firstSwitch, competingSwitch]);
			}

			assert.deepStrictEqual({
				switchResults: switchResults.map(result => result.status),
				completionEvents,
				secondUpdateStarted: secondUpdateStarted.isSettled,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
			}, {
				switchResults: ['fulfilled', 'fulfilled'],
				completionEvents: ['space-b', 'space-c'],
				secondUpdateStarted: true,
				activeStateKey: 'space-c',
			});
		} finally {
			releaseOpen.complete();
			for (const parked of paradisTakeParkedTerminalEditorInstancesForScope('space-b')) {
				parked.dispose();
			}
			fake.instance.dispose();
			testDisposables.dispose();
		}
	});

	test('reparks a live terminal editor under the same scope when opening fails', async () => {
		const testDisposables = new DisposableStore();
		const fake = createFakeTerminalInstance(createUniqueTerminalIds());
		const originalUnexpectedErrorHandler = errorHandler.getUnexpectedErrorHandler();
		setUnexpectedErrorHandler(() => undefined);
		testDisposables.add({ dispose: () => setUnexpectedErrorHandler(originalUnexpectedErrorHandler) });
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			harness.installTerminalScope(async () => { throw new Error('open failed'); });
			assert.strictEqual(paradisParkTerminalEditorInstance(fake.instance, 'space-b'), true);

			await harness.workspaceSwitchService.switchRepository('space-b');

			assert.deepStrictEqual(paradisTakeParkedTerminalEditorInstancesForScope('space-b'), [fake.instance]);
		} finally {
			for (const parked of paradisTakeParkedTerminalEditorInstancesForScope('space-b')) {
				parked.dispose();
			}
			fake.instance.dispose();
			testDisposables.dispose();
		}
	});

	test('restores source editor and terminal ownership when the target disappears during folder mutation', async () => {
		const testDisposables = new DisposableStore();
		const terminalIds = createUniqueTerminalIds();
		const terminalOpenStarted = new DeferredPromise<void>();
		const releaseTerminalOpen = new DeferredPromise<void>();
		const switchEvents: string[] = [];
		let sourceTerminal: ITerminalInstance | undefined;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;
		try {
			harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				async (phase, uri) => {
					if (phase === 'end' && uri.path === '/workspace-b') {
						throw new Error('target deleted');
					}
				}
			);
			testDisposables.add(harness.workspaceSwitchService.onDidSwitchScope(stateKey => switchEvents.push(stateKey)));
			harness.installTerminalScope(async instance => {
				assert.strictEqual(instance, sourceTerminal);
				terminalOpenStarted.complete();
				await releaseTerminalOpen.p;
			});
			const sourceEditor = harness.createEditor('/workspace-a/rollback.txt', true);
			const terminalInput = harness.createEditor('/workspace-a/rollback-terminal', false);
			await harness.parts.activeGroup.openEditor(sourceEditor, { pinned: true });
			await harness.parts.activeGroup.openEditor(terminalInput, { pinned: true });
			sourceTerminal = harness.addTerminal(terminalInput, terminalIds.instanceId, terminalIds.persistentProcessId, terminalIds.shellIntegrationNonce);

			const switchPromise = harness.workspaceSwitchService.switchRepository('space-b');
			const switchSettled = switchPromise.then(() => true, () => true);
			await Promise.race([
				terminalOpenStarted.p,
				switchSettled.then(() => { throw new Error('The failed switch settled before its rollback completion participant finished'); }),
			]);
			await timeout(0);
			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				isSwitching: harness.workspaceSwitchService.isSwitching,
				switchEvents,
				sourceTerminalOwner: paradisGetParkedTerminalEditorStateKey(sourceTerminal.instanceId),
			}, {
				activeStateKey: 'space-a',
				isSwitching: false,
				switchEvents: [],
				sourceTerminalOwner: undefined,
			});

			releaseTerminalOpen.complete();
			const result = await Promise.allSettled([switchPromise]);

			assert.deepStrictEqual({
				switchStatus: result[0].status,
				switchError: result[0].status === 'rejected' ? result[0].reason.message : undefined,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				isSwitching: harness.workspaceSwitchService.isSwitching,
				switchEvents,
				sourceEditorVisible: harness.parts.activeGroup.contains(sourceEditor),
				sourceEditorOwned: harness.editorScopeService.hasLiveState('space-a'),
				sourceTerminalOwner: paradisGetParkedTerminalEditorStateKey(sourceTerminal.instanceId),
				detachedTerminalInstanceIds: harness.detachedTerminalInstanceIds,
				terminalServiceInstanceIds: harness.terminalEditorService.instances.map(instance => instance.instanceId),
			}, {
				switchStatus: 'rejected',
				switchError: 'target deleted',
				activeStateKey: 'space-a',
				isSwitching: false,
				switchEvents: ['space-a'],
				sourceEditorVisible: true,
				sourceEditorOwned: false,
				sourceTerminalOwner: undefined,
				detachedTerminalInstanceIds: [terminalIds.instanceId],
				terminalServiceInstanceIds: [],
			});
		} finally {
			releaseTerminalOpen.complete();
			const parked = paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(terminalIds.persistentProcessId, terminalIds.shellIntegrationNonce));
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
	});

	test('cancels earlier prepared retirements and keeps the repository when a descendant vetoes removal', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const timeline: string[] = [];
			harness.editorScopeService.prepareScopeRetirement = async stateKey => {
				timeline.push(`prepare:${stateKey}`);
				return stateKey !== 'worktree:veto';
			};
			harness.editorScopeService.cancelScopeRetirement = async stateKey => { timeline.push(`cancel:${stateKey}`); };

			await harness.workspaceSwitchService.removeRepository('space-a', ['worktree:veto']);

			assert.deepStrictEqual({
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				repositoryIds: harness.workspaceSwitchService.repositories.map(repository => repository.id),
			}, {
				timeline: ['prepare:space-a', 'prepare:worktree:veto', 'cancel:space-a'],
				activeStateKey: 'space-a',
				repositoryIds: ['space-a', 'space-b'],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('cancels earlier prepared retirements and keeps the repository when descendant preparation throws', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const timeline: string[] = [];
			harness.editorScopeService.prepareScopeRetirement = async stateKey => {
				timeline.push(`prepare:${stateKey}`);
				if (stateKey === 'worktree:error') {
					throw new Error('prepare failed');
				}
				return true;
			};
			harness.editorScopeService.cancelScopeRetirement = async stateKey => { timeline.push(`cancel:${stateKey}`); };

			await harness.workspaceSwitchService.removeRepository('space-a', ['worktree:error']);

			assert.deepStrictEqual({
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				repositoryIds: harness.workspaceSwitchService.repositories.map(repository => repository.id),
			}, {
				timeline: ['prepare:space-a', 'prepare:worktree:error', 'cancel:space-a'],
				activeStateKey: 'space-a',
				repositoryIds: ['space-a', 'space-b'],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('switches back before cancellation and keeps the repository when discard fails after fallback', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const timeline: string[] = [];
			testDisposables.add(harness.workspaceSwitchService.onDidSwitchScope(stateKey => timeline.push(`switch:${stateKey}`)));
			harness.editorScopeService.prepareScopeRetirement = async stateKey => {
				timeline.push(`prepare:${stateKey}`);
				return true;
			};
			harness.editorScopeService.retireScopes = async stateKeys => {
				timeline.push(`retire:${stateKeys.join(',')}`);
				return false;
			};
			harness.editorScopeService.cancelScopeRetirement = async stateKey => { timeline.push(`cancel:${stateKey}`); };

			await harness.workspaceSwitchService.removeRepository('space-a');

			assert.deepStrictEqual({
				timeline,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				repositoryIds: harness.workspaceSwitchService.repositories.map(repository => repository.id),
			}, {
				timeline: [
					'prepare:space-a',
					'switch:space-b',
					'prepare:space-a',
					'retire:space-a',
					'switch:space-a',
					'cancel:space-a',
				],
				activeStateKey: 'space-a',
				repositoryIds: ['space-a', 'space-b'],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('does not invoke a completion participant after its registration is disposed', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const completionEvents: string[] = [];
			const registration = harness.workspaceSwitchService.registerSwitchCompletionParticipant(stateKey => { completionEvents.push(stateKey); });

			await harness.workspaceSwitchService.switchRepository('space-b');
			registration.dispose();
			await harness.workspaceSwitchService.switchRepository('space-a');

			assert.deepStrictEqual({
				completionEvents,
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				isSwitching: harness.workspaceSwitchService.isSwitching,
			}, {
				completionEvents: ['space-b'],
				activeStateKey: 'space-a',
				isSwitching: false,
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('keeps spaces from another host out of this list', async () => {
		const testDisposables = new DisposableStore();
		try {
			// 1ウィンドウは1つの接続先しか見られない。開けないスペースを並べると、開き直すたびに
			// 見え方が変わって混乱するだけなので、繋がっている先のものだけを出す
			const harness = await createHarness(['space-a'], testDisposables, undefined, [
				{ id: 'space-x', name: 'x', uri: 'vscode-remote://ssh-remote%2Bparadis-pc/home/user/develop/x' }
			]);

			assert.deepStrictEqual(
				harness.workspaceSwitchService.repositories.map(repository => ({ id: repository.id, scheme: repository.uri.scheme })),
				[{ id: 'space-a', scheme: 'file' }]
			);
		} finally {
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
	installTerminalScope(onOpenEditor: (instance: ITerminalInstance) => Promise<void>): ParadisTerminalWorkspaceScope;
	createEditor(path: string, modified: boolean): TestFileEditorInput;
	addTerminal(input: TestFileEditorInput, instanceId: number, persistentProcessId: number, shellIntegrationNonce: string): ITerminalInstance;
}

function createFakeTerminalInstance(ids: ReturnType<typeof createUniqueTerminalIds>): { readonly instance: ITerminalInstance } {
	const onDisposed = new Emitter<ITerminalInstance>();
	let isDisposed = false;
	const instance = {
		instanceId: ids.instanceId,
		persistentProcessId: ids.persistentProcessId,
		shellIntegrationNonce: ids.shellIntegrationNonce,
		shouldPersist: true,
		get isDisposed() { return isDisposed; },
		onDisposed: onDisposed.event,
		dispose: () => {
			if (!isDisposed) {
				isDisposed = true;
				onDisposed.fire(instance);
				onDisposed.dispose();
			}
		},
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
	return { instance };
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
	/** 保存済み一覧に混ざっている、別の接続先のスペース。 */
	foreignRepositories: readonly { id: string; name: string; uri: string }[] = [],
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
		JSON.stringify([...repositories.map(repository => ({
			id: repository.id,
			name: repository.name,
			uri: repository.uri.toString()
		})), ...foreignRepositories]),
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
		registerScopelessWindow: () => Disposable.None,
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
	let onOpenTerminalEditor: (instance: ITerminalInstance) => Promise<void> = async () => { };
	const terminalEditorService = {
		get instances() { return terminals; },
		openEditor: (instance: ITerminalInstance) => onOpenTerminalEditor(instance),
		getInputFromResource: (resource: URI) => inputs.get(resource.toString()) as unknown as ReturnType<ITerminalEditorService['getInputFromResource']>,
		detachInstance: (instance: ITerminalInstance) => {
			detachedTerminalInstanceIds.push(instance.instanceId);
			const index = terminals.indexOf(instance);
			if (index !== -1) {
				terminals.splice(index, 1);
			}
		},
	} satisfies Pick<ITerminalEditorService, 'instances' | 'openEditor' | 'getInputFromResource' | 'detachInstance'>;

	const workspaceSwitchService = testDisposables.add(new ParadisWorkspaceSwitchService(
		storageService,
		contextService,
		workspaceEditingService,
		workspaceTrustManagementService as unknown as IWorkspaceTrustManagementService,
		parts,
		instantiationService.get(IWorkbenchLayoutService),
		terminalEditorService as unknown as ITerminalEditorService,
		// 切り替え先フォルダの事前確認。ディレクトリを返せば upstream 側の stat が省かれる経路に
		// 入り、返さなければ従来どおり upstream が自分で確かめる。
		{ stat: async () => ({ isDirectory: true }) } as unknown as IFileService,
		editorScopeService,
		auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService,
		instantiationService.get(ILogService),
		// 一覧を絞る基準になる。ここは「どこにも繋がっていない」ウィンドウとして振る舞わせる
		{ remoteAuthority: undefined } as unknown as IWorkbenchEnvironmentService,
	));

	return {
		workspaceSwitchService,
		editorScopeService,
		parts,
		terminalEditorService,
		detachedTerminalInstanceIds,
		installTerminalScope(onOpenEditor: (instance: ITerminalInstance) => Promise<void>): ParadisTerminalWorkspaceScope {
			onOpenTerminalEditor = onOpenEditor;
			const terminalGroupService = Object.create(TerminalGroupService.prototype) as TerminalGroupService;
			Object.defineProperties(terminalGroupService, {
				groups: { get: () => [] },
				paradisParkedGroups: { get: () => [] },
				onDidChangeGroups: { value: Event.None },
				onDidDisposeGroup: { value: Event.None },
			});
			const terminalService = {
				instances: [],
				whenConnected: new Promise<void>(() => { }),
				connectionState: TerminalConnectionState.Connecting,
				onDidChangeInstances: Event.None,
				onDidChangeConnectionState: Event.None,
				onAnyInstanceProcessIdReady: Event.None,
			} satisfies Partial<ITerminalService> as unknown as ITerminalService;
			const worktreeService = {
				initializationBarrier: new Promise<void>(() => { }),
				onDidChangeWorktrees: Event.None,
			} satisfies Partial<IParadisWorktreeService> as unknown as IParadisWorktreeService;
			const scope = new ParadisTerminalWorkspaceScope(
				terminalGroupService as unknown as ITerminalGroupService,
				terminalService,
				terminalEditorService as unknown as ITerminalEditorService,
				workspaceSwitchService,
				auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService,
				worktreeService,
				storageService,
				{ getBackend: async () => undefined } as ITerminalInstanceService,
				{} as IWorkbenchEnvironmentService,
				contextService,
				parts,
			);
			testDisposables.add(scope);
			return scope;
		},
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

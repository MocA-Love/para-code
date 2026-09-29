/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IShellLaunchConfig, TerminalExitReason, TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { INotificationHandle, INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { paradisResetSharedPanelStartupValueForTest, paradisSharedPanelEnabledAtStartup } from '../../../terminalSharedPanel/common/paradisTerminalSharedPanel.js';
import { IWorkspaceContextService, toWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IWorkspaceFolderCreationData } from '../../../../../platform/workspaces/common/workspaces.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { paradisIsTerminalInputBlocked, paradisResetTerminalInputGateForTest } from '../../browser/paradisTerminalInputGate.js';
import { IWorkingCopyBackupRestoreRouter, WorkingCopyBackupRestoreRouter } from '../../../../../workbench/services/workingCopy/common/workingCopyBackupRestoreRouter.js';
import { IWorkspaceEditingService } from '../../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/common/environmentService.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { ITerminalEditorService, ITerminalGroup, ITerminalGroupService, ITerminalInstance, ITerminalInstanceService, ITerminalService, TerminalConnectionState, TerminalEditorLocation } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../../../../workbench/contrib/terminal/browser/terminalGroupService.js';
import { ACTIVE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { TestContextService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { ParadisEditorScopeService } from '../../browser/paradisEditorScopeService.js';
import { paradisGetParkedTerminalEditorStateKey, paradisIsOrphanTerminalRevivalComplete, paradisMarkTerminalEditorOpeningForScope, paradisParkTerminalEditorInstance, paradisResetOrphanTerminalRevivalForTest, paradisTakeParkedTerminalEditorInstance, paradisTakeParkedTerminalEditorInstancesForScope } from '../../browser/paradisTerminalEditorPark.js';
import { paradisCreateDeserializedTerminalEditorInput } from './paradisTerminalEditorInputFixture.js';
import { ParadisTerminalWorkspaceScope } from '../../browser/paradisTerminalScope.contribution.js';
import { paradisParseTerminalNonceScopeStorage } from '../../common/paradisTerminalNonceScope.js';
import { paradisClearTerminalReviveIndex, paradisRefreshTerminalReviveIndex } from '../../browser/paradisTerminalEditorRevive.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ParadisWorkspaceSwitchService } from '../../browser/paradisWorkspaceSwitchService.js';
import { IParadisAuxiliaryWindowScopeService, IParadisWorktree, IParadisWorktreeService, PARADIS_WORKSPACE_REPOSITORIES_STORAGE_KEY, paradisWorktreeStateKey } from '../../common/paradisWorkspaceSwitch.js';
import { PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions } from '../../common/paradisWorkspaceSwitchTransaction.js';
import { paradisPrepareRestartedTerminalLaunch, paradisRegisterRestartedTerminalCwdResolver, paradisResetRestartedTerminalsForTest } from '../../common/paradisTerminalLaunchPreparers.js';
import { paradisLookupRestartedShellScope } from '../../common/paradisTerminalSpaceFolder.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';

suite('ParadisWorkspaceSwitchService integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// 入力ゲートはモジュールスコープの状態なので、途中で落ちた回に立てっぱなしのまま残ると
	// 最大20秒(実時間)ほかの suite のターミナル入力まで塞ぐ。suite 単位でも必ず戻す。
	teardown(() => paradisResetTerminalInputGateForTest());

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

	test('parks editor terminals left behind by the park loop instead of letting the working set close them', async () => {
		const testDisposables = new DisposableStore();
		const startingIds = createUniqueTerminalIds();
		const lateIds = createUniqueTerminalIds();
		const terminals: ITerminalInstance[] = [];
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const startingInput = harness.createEditor('/workspace-a/starting-terminal', false);
			const lateInput = harness.createEditor('/workspace-a/late-terminal', false);
			await harness.parts.activeGroup.openEditor(startingInput, { pinned: true });
			// 1本目は PTY ID がまだ無い（作った直後）。2本目は park ループの後に開かれる。
			// どちらも PTY の起動を待たれたときに初めて進むので、待たない実装ではどちらも park されない。
			const starting = harness.addTerminal(startingInput, startingIds.instanceId, undefined, startingIds.shellIntegrationNonce, async () => {
				Object.assign(starting, { persistentProcessId: startingIds.persistentProcessId });
				if (terminals.length === 1) {
					await harness.parts.activeGroup.openEditor(lateInput, { pinned: true });
					terminals.push(harness.addTerminal(lateInput, lateIds.instanceId, lateIds.persistentProcessId, lateIds.shellIntegrationNonce));
				}
			});
			terminals.push(starting);

			await harness.workspaceSwitchService.switchRepository('space-b');

			assert.deepStrictEqual({
				owners: terminals.map(terminal => paradisGetParkedTerminalEditorStateKey(terminal.instanceId)),
				detachedTerminalInstanceIds: harness.detachedTerminalInstanceIds,
			}, {
				owners: ['space-a', 'space-a'],
				detachedTerminalInstanceIds: [startingIds.instanceId, lateIds.instanceId],
			});
		} finally {
			for (const ids of [startingIds, lateIds]) {
				paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(ids.persistentProcessId, ids.shellIntegrationNonce));
			}
			testDisposables.dispose();
		}
	});

	test('gives up waiting for a terminal whose PTY never starts, and leaves it to the working set', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
		const testDisposables = new DisposableStore();
		const ids = createUniqueTerminalIds();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			const input = harness.createEditor('/workspace-a/stuck-terminal', false);
			await harness.parts.activeGroup.openEditor(input, { pinned: true });
			const stuck = harness.addTerminal(input, ids.instanceId, undefined, ids.shellIntegrationNonce, () => new Promise<void>(() => { }));

			await harness.workspaceSwitchService.switchRepository('space-b');

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				owner: paradisGetParkedTerminalEditorStateKey(stuck.instanceId),
				detachedTerminalInstanceIds: harness.detachedTerminalInstanceIds,
			}, {
				activeStateKey: 'space-b',
				owner: undefined,
				detachedTerminalInstanceIds: [],
			});
		} finally {
			testDisposables.dispose();
		}
	}));

	// MCP やスマホが別のスペース宛てに開いた端末が、切り替えの最中だったために切り替え元へ入ると、
	// タブは行き先に出ず、切り替え元を削除したときに巻き添えで閉じられる。
	test('puts terminals assigned to another space during a switch into that space, not the one being left', async () => {
		const testDisposables = new DisposableStore();
		const seedIds = createUniqueTerminalIds();
		const openingIds = createUniqueTerminalIds();
		const assignedIds = createUniqueTerminalIds();
		const disposedIds: number[] = [];
		const terminals: ITerminalInstance[] = [];
		try {
			let assignDuringSwitch: (() => void) | undefined;
			const harness = await createHarness(['space-a', 'space-b', 'space-c'], testDisposables, async phase => {
				if (phase === 'start') {
					assignDuringSwitch?.();
					assignDuringSwitch = undefined;
				}
			});
			await harness.workspaceSwitchService.switchRepository('space-a');
			const scope = harness.installTerminalScope(async () => { }, { worktreeReady: true, connected: true });
			await settle();
			const track = (terminal: ITerminalInstance) => {
				testDisposables.add(terminal.onDisposed(() => disposedIds.push(terminal.instanceId)));
				terminals.push(terminal);
				return terminal;
			};
			const seedInput = harness.createEditor('/workspace-a/seed-terminal', false);
			const openingInput = harness.createEditor('/workspace-a/opening-terminal', false);
			const assignedInput = harness.createEditor('/workspace-a/assigned-terminal', false);
			await harness.parts.activeGroup.openEditor(seedInput, { pinned: true });
			await harness.parts.activeGroup.openEditor(assignedInput, { pinned: true });
			// 1本目は切り替え元のもの。PTY の起動を待たれている間に、2本目がスペース B 宛てに開かれる
			// （MCP の create_terminal と同じ手順: 開いている途中だと知らせてから、開き終えて割り当てる）。
			const seed = track(harness.addTerminal(seedInput, seedIds.instanceId, undefined, seedIds.shellIntegrationNonce, async () => {
				Object.assign(seed, { persistentProcessId: seedIds.persistentProcessId });
				await harness.parts.activeGroup.openEditor(openingInput, { pinned: true });
				const opening = track(harness.addTerminal(openingInput, openingIds.instanceId, openingIds.persistentProcessId, openingIds.shellIntegrationNonce));
				const settled = new DeferredPromise<void>();
				const marker = paradisMarkTerminalEditorOpeningForScope(opening, 'space-b', settled.p);
				setTimeout(() => {
					scope.assignInstanceScope(opening.instanceId, 'space-b');
					marker.dispose();
					settled.complete();
				}, 0);
			}));
			// 3本目は最初のループで切り替え元へ入った後、切り替えの最中にスペース B へ割り当てられる。
			const assigned = track(harness.addTerminal(assignedInput, assignedIds.instanceId, assignedIds.persistentProcessId, assignedIds.shellIntegrationNonce));
			assignDuringSwitch = () => scope.assignInstanceScope(assigned.instanceId, 'space-b');

			await harness.workspaceSwitchService.switchRepository('space-c');
			await settle();
			const owners = terminals.map(terminal => paradisGetParkedTerminalEditorStateKey(terminal.instanceId));
			const stateKeys = terminals.map(terminal => scope.getStateKeyForInstance(terminal.instanceId));
			await harness.workspaceSwitchService.removeRepository('space-a');
			await settle();

			assert.deepStrictEqual({
				owners,
				stateKeys,
				disposedWithSpaceA: [...new Set(disposedIds)],
			}, {
				owners: ['space-a', 'space-b', 'space-b'],
				stateKeys: ['space-a', 'space-b', 'space-b'],
				disposedWithSpaceA: [seedIds.instanceId],
			});
		} finally {
			for (const ids of [seedIds, openingIds, assignedIds]) {
				paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(ids.persistentProcessId, ids.shellIntegrationNonce));
			}
			testDisposables.dispose();
		}
	});

	// 開いている途中の端末は、最初のループでは行き先が分からない。そこで切り替え元へ入れると、
	// 行き先へは誰も移さない（割り当てがまだ来ていない）。
	test('leaves a terminal that is still being opened for another space to the later passes', async () => {
		const testDisposables = new DisposableStore();
		const ids = createUniqueTerminalIds();
		try {
			const harness = await createHarness(['space-a', 'space-b', 'space-c'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			const input = harness.createEditor('/workspace-a/opening-terminal', false);
			await harness.parts.activeGroup.openEditor(input, { pinned: true });
			const terminal = harness.addTerminal(input, ids.instanceId, ids.persistentProcessId, ids.shellIntegrationNonce);
			const settled = new DeferredPromise<void>();
			const marker = paradisMarkTerminalEditorOpeningForScope(terminal, 'space-b', settled.p);
			setTimeout(() => settled.complete(), 0);

			await harness.workspaceSwitchService.switchRepository('space-c');
			marker.dispose();

			assert.deepStrictEqual(paradisGetParkedTerminalEditorStateKey(terminal.instanceId), 'space-b');
		} finally {
			paradisTakeParkedTerminalEditorInstance(paradisCreateDeserializedTerminalEditorInput(ids.persistentProcessId, ids.shellIntegrationNonce));
			testDisposables.dispose();
		}
	});

	// 今のスペースへ割り当て直された park 中の端末は、その1本だけを裏のタブで開く（同じスペースに
	// 待避中の他の端末まで開いたり、フォーカスを奪ったりしない）。
	test('opens only the reassigned terminal, in the background, when it is moved to the current space', async () => {
		const testDisposables = new DisposableStore();
		const moved = createFakeTerminalInstance(createUniqueTerminalIds()).instance;
		const stays = createFakeTerminalInstance(createUniqueTerminalIds()).instance;
		const opened: [number, TerminalEditorLocation | undefined][] = [];
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			const scope = harness.installTerminalScope(async (instance, location) => { opened.push([instance.instanceId, location]); }, { worktreeReady: true, connected: true });
			await settle();
			paradisParkTerminalEditorInstance(moved, 'space-b');
			paradisParkTerminalEditorInstance(stays, 'space-b');

			scope.assignInstanceScope(moved.instanceId, 'space-a');
			await settle();

			assert.deepStrictEqual({
				opened,
				owners: [paradisGetParkedTerminalEditorStateKey(moved.instanceId), paradisGetParkedTerminalEditorStateKey(stays.instanceId)],
			}, {
				opened: [[moved.instanceId, { viewColumn: ACTIVE_GROUP, preserveFocus: true, paradisInactive: true }]],
				owners: [undefined, 'space-b'],
			});
		} finally {
			paradisTakeParkedTerminalEditorInstancesForScope('space-b');
			moved.dispose();
			stays.dispose();
			testDisposables.dispose();
		}
	});

	test('stops reattaching an orphaned terminal after two failures instead of spawning a shell on every switch', async () => {
		const testDisposables = new DisposableStore();
		const created: number[] = [];
		const disposed: string[] = [];
		paradisResetOrphanTerminalRevivalForTest();
		try {
			// 孤児判定に使う項目だけ。一覧の残りの項目は参照されない。
			const orphan = {
				id: 9001,
				pid: 1,
				cwd: '/workspace-c',
				title: 'zsh',
				workspaceId: 'paradis-switch-integration',
				isOrphan: true,
				shellIntegrationNonce: generateUuid(),
			};
			const harness = await createHarness(['space-a', 'space-b', 'space-c'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			harness.installTerminalScope(async () => { }, {
				worktreeReady: true,
				connected: true,
				persistentProcessScopes: [[orphan.id, 'space-c']],
				terminalInstanceService: {
					getBackend: async () => ({ listProcesses: async () => [orphan] }) as unknown as Awaited<ReturnType<ITerminalInstanceService['getBackend']>>,
					createInstance: () => {
						// 繋ぎ直しに失敗して、upstream が新しいシェルを起こした状態（ID が孤児のものと違う）。
						const instanceId = 9100 + created.length;
						created.push(instanceId);
						return {
							instanceId,
							persistentProcessId: 7000 + instanceId,
							shellIntegrationNonce: generateUuid(),
							shouldPersist: true,
							isDisposed: false,
							processReady: Promise.resolve(),
							onDisposed: Event.None,
							dispose: (reason?: TerminalExitReason) => { disposed.push(`${instanceId}:${reason}`); },
						} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
					},
				},
			});
			await settle();
			await harness.workspaceSwitchService.switchRepository('space-b');
			await settle();
			await harness.workspaceSwitchService.switchRepository('space-a');
			await settle();

			assert.deepStrictEqual({
				created,
				disposed,
				complete: paradisIsOrphanTerminalRevivalComplete(),
				parkedInSpaceC: paradisTakeParkedTerminalEditorInstancesForScope('space-c').map(instance => instance.instanceId),
			}, {
				created: [9100, 9101],
				disposed: [`9100:${TerminalExitReason.Shutdown}`, `9101:${TerminalExitReason.Shutdown}`],
				complete: true,
				parkedInSpaceC: [],
			});
		} finally {
			paradisResetOrphanTerminalRevivalForTest();
			testDisposables.dispose();
		}
	});

	test('points at the target space for the whole switch, including after the switching flag drops', async () => {
		const testDisposables = new DisposableStore();
		const updateStarted = new DeferredPromise<void>();
		const releaseUpdate = new DeferredPromise<void>();
		const timeline: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				async (phase, uri) => {
					if (phase === 'start' && uri.path === '/workspace-b') {
						updateStarted.complete();
						await releaseUpdate.p;
					}
				}
			);
			const service = harness.workspaceSwitchService;
			const snapshot = (label: string) => timeline.push(
				`${label}:pending=${service.pendingSwitchTargetKey}:active=${service.activeStateKey}:switching=${service.isSwitching}`);
			testDisposables.add(service.onDidChangeSwitchState(() => snapshot('changed')));
			testDisposables.add(service.onWillSwitchScope(() => snapshot('will')));
			testDisposables.add(service.onDidSwitchScope(() => snapshot('did')));

			const switchPromise = service.switchRepository('space-b');
			await updateStarted.p;
			snapshot('mid-folders');
			releaseUpdate.complete();
			await switchPromise;
			snapshot('settled');

			assert.deepStrictEqual(timeline, [
				// 退避を始める前から行き先を指す (一覧のチェックを前倒しできる)
				'changed:pending=space-b:active=space-a:switching=false',
				'will:pending=space-b:active=space-a:switching=true',
				'mid-folders:pending=space-b:active=space-a:switching=true',
				// **ここが肝**: 完了通知の時点で isSwitching は既に false だが、パネル端末の
				// 出し入れはこの通知の中で走る。行き先を指し続けているのはこちらだけ
				'did:pending=space-b:active=space-b:switching=false',
				'changed:pending=undefined:active=space-b:switching=false',
				'settled:pending=undefined:active=space-b:switching=false',
			]);
		} finally {
			releaseUpdate.complete();
			testDisposables.dispose();
		}
	});

	test('keeps terminal keystrokes out until the completion participants have run', async () => {
		const testDisposables = new DisposableStore();
		const updateStarted = new DeferredPromise<void>();
		const releaseUpdate = new DeferredPromise<void>();
		const timeline: string[] = [];
		try {
			const harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				async (phase, uri) => {
					if (phase === 'start' && uri.path === '/workspace-b') {
						updateStarted.complete();
						await releaseUpdate.p;
					}
				}
			);
			const service = harness.workspaceSwitchService;
			const snapshot = (label: string) => timeline.push(
				`${label}:blocked=${paradisIsTerminalInputBlocked()}:switching=${service.isSwitching}`);
			testDisposables.add(service.registerSwitchCompletionParticipant(() => { snapshot('participant'); }));

			snapshot('before');
			const switchPromise = service.switchRepository('space-b');
			await updateStarted.p;
			snapshot('mid-folders');
			releaseUpdate.complete();
			await switchPromise;
			snapshot('settled');

			assert.deepStrictEqual(timeline, [
				'before:blocked=false:switching=false',
				'mid-folders:blocked=true:switching=true',
				// **ここが肝**: 完了 participant の時点で isSwitching は既に false なのに、
				// パネル端末の park/unpark はこの中で走る。ゲートを isSwitching に乗せると
				// 「一番混ざっている区間」が素通しになり、前のスペースでコマンドが走る
				'participant:blocked=true:switching=false',
				'settled:blocked=false:switching=false',
			]);
		} finally {
			releaseUpdate.complete();
			paradisResetTerminalInputGateForTest();
			testDisposables.dispose();
		}
	});

	test('lets terminal input back in when the switch fails', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				async (phase, uri) => {
					if (phase === 'end' && uri.path === '/workspace-b') {
						throw new Error('target deleted');
					}
				}
			);
			const result = await Promise.allSettled([harness.workspaceSwitchService.switchRepository('space-b')]);

			// 降ろし損ねると、このレンダラーの全ターミナルが入力不能のまま残る
			assert.deepStrictEqual(
				{ switchStatus: result[0].status, blocked: paradisIsTerminalInputBlocked() },
				{ switchStatus: 'rejected', blocked: false });
		} finally {
			paradisResetTerminalInputGateForTest();
			testDisposables.dispose();
		}
	});

	// 先行 stat の締め切り (1500ms) を実時間で待つので、この suite の中では遅いテスト。
	// 締め切りを注入可能にすると本番側に本番で使わない口が増えるので、待つ側を選んでいる。
	test('completes the switch even when the target folder stat never answers', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				undefined,
				undefined,
				() => new Promise<Partial<IFileStat>>(() => { })
			);
			await harness.workspaceSwitchService.switchRepository('space-b');

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				blocked: paradisIsTerminalInputBlocked(),
			}, {
				activeStateKey: 'space-b',
				blocked: false,
			});
		} finally {
			paradisResetTerminalInputGateForTest();
			testDisposables.dispose();
		}
	});

	test('stops pointing at the target space when the switch fails', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(
				['space-a', 'space-b'],
				testDisposables,
				async (phase, uri) => {
					if (phase === 'end' && uri.path === '/workspace-b') {
						throw new Error('target deleted');
					}
				}
			);
			const service = harness.workspaceSwitchService;
			const result = await Promise.allSettled([service.switchRepository('space-b')]);

			// 解除し損ねると、二度と消えない嘘のチェックが一覧に残る
			assert.deepStrictEqual({
				switchStatus: result[0].status,
				pendingSwitchTargetKey: service.pendingSwitchTargetKey,
				activeStateKey: service.activeStateKey,
			}, {
				switchStatus: 'rejected',
				pendingSwitchTargetKey: undefined,
				activeStateKey: 'space-a',
			});
		} finally {
			testDisposables.dispose();
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

	test('refuses to switch by state key to a worktree whose folder is gone, and still switches to one that exists', async () => {
		const testDisposables = new DisposableStore();
		try {
			const gone = URI.file('/workspace-a-worktrees/gone');
			const present = URI.file('/workspace-a-worktrees/present');
			const harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], async uri => {
				if (uri?.toString() === gone.toString()) {
					throw new FileOperationError('not found', FileOperationResult.FILE_NOT_FOUND);
				}
				return { isDirectory: true };
			});

			let refusal: string | undefined;
			try {
				await harness.workspaceSwitchService.switchToStateKey(paradisWorktreeStateKey(gone));
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			const afterRefusal = harness.workspaceSwitchService.activeStateKey;
			await harness.workspaceSwitchService.switchToStateKey(paradisWorktreeStateKey(present));

			assert.deepStrictEqual({ refusal, afterRefusal, afterPresent: harness.workspaceSwitchService.activeStateKey }, {
				refusal: `Para Code worktree is missing on disk: ${gone.fsPath}`,
				afterRefusal: 'space-a',
				afterPresent: paradisWorktreeStateKey(present),
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// 存在確認と先行 stat の締め切り (1500ms ずつ) を実時間で待つので遅いテスト。
	test('still switches by state key to a worktree when the existence check never answers', async function () {
		this.timeout(10_000);
		const testDisposables = new DisposableStore();
		try {
			const stuck = URI.file('/workspace-a-worktrees/stuck');
			const harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], () => new Promise<Partial<IFileStat>>(() => { }));

			await harness.workspaceSwitchService.switchToStateKey(paradisWorktreeStateKey(stuck));

			assert.strictEqual(harness.workspaceSwitchService.activeStateKey, paradisWorktreeStateKey(stuck));
		} finally {
			paradisResetTerminalInputGateForTest();
			testDisposables.dispose();
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
				{ id: 'space-x', name: 'x', uri: 'vscode-remote://ssh-remote%2Bdev-pc/home/user/develop/x' }
			]);

			assert.deepStrictEqual(
				harness.workspaceSwitchService.repositories.map(repository => ({ id: repository.id, scheme: repository.uri.scheme })),
				[{ id: 'space-a', scheme: 'file' }]
			);
		} finally {
			testDisposables.dispose();
		}
	});

	test('recovers the source Working Set when shutdown persisted the target before folders changed', async () => {
		const testDisposables = new DisposableStore();
		let sourceEditor: TestFileEditorInput | undefined;
		let targetEditor: TestFileEditorInput | undefined;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;
		try {
			harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], undefined, async context => {
				sourceEditor = context.createEditor('/workspace-a/source.txt', false);
				targetEditor = context.createEditor('/workspace-b/target.txt', false);
				await context.parts.activeGroup.openEditor(sourceEditor, { pinned: true });
				const sourceWorkingSet = context.parts.saveWorkingSet('source-before-interruption');
				await context.parts.applyWorkingSet('empty');
				await context.parts.activeGroup.openEditor(targetEditor, { pinned: true });
				const targetWorkingSet = context.parts.saveWorkingSet('target-before-interruption');
				context.storageService.store('paradis.workspaceSwitch.workingSets', JSON.stringify([
					{ repositoryId: 'space-a', workingSet: sourceWorkingSet, terminalEditors: 0, terminalNonces: [] },
					{ repositoryId: 'space-b', workingSet: targetWorkingSet, terminalEditors: 0, terminalNonces: [] },
				]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				context.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions([{
					version: 1,
					id: 'interrupted-test-switch',
					createdAt: 1,
					fromStateKey: 'space-a',
					fromUri: URI.file('/workspace-a').toString(),
					toStateKey: 'space-b',
					toUri: URI.file('/workspace-b').toString(),
					phase: 'targetApplied',
				}, {
					version: 1,
					id: 'newer-started-test-switch',
					createdAt: 2,
					fromStateKey: 'space-a',
					fromUri: URI.file('/workspace-a').toString(),
					toStateKey: 'space-b',
					toUri: URI.file('/workspace-b').toString(),
					phase: 'started',
				}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			});

			await harness.workspaceSwitchService.recoverInterruptedSwitch();

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				sourceVisible: harness.parts.activeGroup.contains(sourceEditor!),
				targetVisible: harness.parts.activeGroup.contains(targetEditor!),
				transaction: harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE),
			}, { activeStateKey: 'space-a', sourceVisible: true, targetVisible: false, transaction: undefined });
		} finally {
			await harness?.parts.activeGroup.closeAllEditors();
			testDisposables.dispose();
		}
	});

	// 失敗した復旧のジャーナルは残さない。残すと storage 永続なので、起動のたび・切り替えのたびに
	// 同じ場所で落ち続け、スペース切り替えがそのウィンドウで二度と成立しなくなる。
	test('discards the journal when a recovery phase fails so the failure cannot repeat forever', async () => {
		const testDisposables = new DisposableStore();
		let sourceEditor: TestFileEditorInput | undefined;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;
		try {
			harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], undefined, async context => {
				sourceEditor = context.createEditor('/workspace-a/source.txt', false);
				await context.parts.activeGroup.openEditor(sourceEditor, { pinned: true });
				const sourceWorkingSet = context.parts.saveWorkingSet('source-before-failed-recovery');
				context.storageService.store('paradis.workspaceSwitch.workingSets', JSON.stringify([
					{ repositoryId: 'space-a', workingSet: sourceWorkingSet, terminalEditors: 0, terminalNonces: [] },
				]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				context.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions([{
					version: 1,
					id: 'failed-recovery-switch',
					createdAt: 1,
					fromStateKey: 'space-a',
					fromUri: URI.file('/workspace-a').toString(),
					toStateKey: 'space-b',
					toUri: URI.file('/workspace-b').toString(),
					phase: 'targetApplied',
				}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			});
			const recoveryEditorScope = (harness.workspaceSwitchService as unknown as {
				editorScopeService: { restoreScope(stateKey: string): Promise<void> };
			}).editorScopeService;
			recoveryEditorScope.restoreScope = async () => { throw new Error('restore scope failed'); };

			await assert.rejects(harness.workspaceSwitchService.recoverInterruptedSwitch(), /restore scope failed/);

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				sourceVisible: harness.parts.activeGroup.contains(sourceEditor!),
				isSwitching: harness.workspaceSwitchService.isSwitching,
				journalPresent: harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE) !== undefined,
			}, { activeStateKey: 'space-a', sourceVisible: true, isSwitching: false, journalPresent: false });
		} finally {
			await harness?.parts.activeGroup.closeAllEditors();
			testDisposables.dispose();
		}
	});

	test('discards a started journal without replacing the current editor layout', async () => {
		const testDisposables = new DisposableStore();
		let staleEditor: TestFileEditorInput | undefined;
		let currentEditor: TestFileEditorInput | undefined;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;
		try {
			harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], undefined, async context => {
				staleEditor = context.createEditor('/workspace-a/stale.txt', false);
				currentEditor = context.createEditor('/workspace-a/current.txt', false);
				await context.parts.activeGroup.openEditor(staleEditor, { pinned: true });
				const staleWorkingSet = context.parts.saveWorkingSet('stale-before-start');
				await context.parts.applyWorkingSet('empty');
				await context.parts.activeGroup.openEditor(currentEditor, { pinned: true });
				context.storageService.store('paradis.workspaceSwitch.workingSets', JSON.stringify([
					{ repositoryId: 'space-a', workingSet: staleWorkingSet, terminalEditors: 0, terminalNonces: [] },
				]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				context.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions([{
					version: 1,
					id: 'started-test-switch',
					createdAt: 1,
					ownerWindowId: 999,
					fromStateKey: 'space-a',
					fromUri: URI.file('/workspace-a').toString(),
					toStateKey: 'space-b',
					toUri: URI.file('/workspace-b').toString(),
					phase: 'started',
				}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				// リースは張らない。**起動時でも生きたリースは尊重する**ようになったので、リースを
				// 張ると「他ウィンドウが処理中」として正しく見送られ、この test の主題（`started` は
				// UI を触らずジャーナルだけ捨てる）が確かめられなくなる。生きたリースの側は
				// 'does not recover a transaction whose other window owner still renews its lease' が見る。
			});

			await harness.workspaceSwitchService.recoverInterruptedSwitch();

			assert.deepStrictEqual({
				currentVisible: harness.parts.activeGroup.contains(currentEditor!),
				staleVisible: harness.parts.activeGroup.contains(staleEditor!),
				transaction: harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE),
			}, { currentVisible: true, staleVisible: false, transaction: undefined });
		} finally {
			await harness?.parts.activeGroup.closeAllEditors();
			testDisposables.dispose();
		}
	});

	// タイマーだけは、ロールバックが途中で失敗してジャーナルを消せなかった回でも必ず止める。
	// 止め損ねると 3 秒ごとの storage 書き込みがウィンドウを閉じるまで走り続ける。
	test('stops renewing the owner lease even when the rollback could not clear the journal', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables, async (phase, uri) => {
				if (phase === 'end' && uri.path === '/workspace-b') {
					throw new Error('target deleted');
				}
			});
			await harness.workspaceSwitchService.switchRepository('space-a');
			const editorScope = (harness.workspaceSwitchService as unknown as {
				editorScopeService: { rollbackSwitch(stateKey: string | undefined, uri: URI | undefined): Promise<void> };
			}).editorScopeService;
			// ロールバックも失敗させて `clearSwitchTransaction` へ到達させない（ジャーナルは残る）。
			editorScope.rollbackSwitch = async () => { throw new Error('rollback failed'); };

			await assert.rejects(harness.workspaceSwitchService.switchRepository('space-b'));

			assert.deepStrictEqual({
				leaseKeys: harness.storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)
					.filter(key => key.startsWith('paradis.workspaceSwitch.ownerLease.')),
				journalPresent: harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE) !== undefined,
			}, { leaseKeys: [], journalPresent: true });
		} finally {
			testDisposables.dispose();
		}
	});

	test('discards a journal whose state key does not match its URI', async () => {
		const testDisposables = new DisposableStore();
		let currentEditor: TestFileEditorInput | undefined;
		let harness: IWorkspaceSwitchIntegrationHarness | undefined;
		try {
			harness = await createHarness(['space-a', 'space-b'], testDisposables, undefined, [], undefined, async context => {
				currentEditor = context.createEditor('/workspace-a/current.txt', false);
				await context.parts.activeGroup.openEditor(currentEditor, { pinned: true });
				context.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions([{
					version: 1,
					id: 'mismatched-test-switch',
					createdAt: 1,
					fromStateKey: 'space-b',
					fromUri: URI.file('/workspace-a').toString(),
					toStateKey: 'space-a',
					toUri: URI.file('/workspace-b').toString(),
					phase: 'targetApplied',
				}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			});

			await harness.workspaceSwitchService.recoverInterruptedSwitch();

			assert.deepStrictEqual({
				currentVisible: harness.parts.activeGroup.contains(currentEditor!),
				transaction: harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE),
			}, { currentVisible: true, transaction: undefined });
		} finally {
			await harness?.parts.activeGroup.closeAllEditors();
			testDisposables.dispose();
		}
	});

	test('re-reads the journal after an earlier recovery completed with no entries', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.recoverInterruptedSwitch();
			harness.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, paradisSerializeWorkspaceSwitchTransactions([{
				version: 1,
				id: 'late-started-switch',
				createdAt: 1,
				fromStateKey: 'space-a',
				fromUri: URI.file('/workspace-a').toString(),
				toStateKey: 'space-b',
				toUri: URI.file('/workspace-b').toString(),
				phase: 'started',
			}]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

			await harness.workspaceSwitchService.recoverInterruptedSwitch();

			assert.strictEqual(
				harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE),
				undefined,
			);
		} finally {
			testDisposables.dispose();
		}
	});

	test('does not recover a transaction whose other window owner still renews its lease', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.recoverInterruptedSwitch();
			const transaction = paradisSerializeWorkspaceSwitchTransactions([{
				version: 1,
				id: 'foreign-live-switch',
				createdAt: 1,
				ownerWindowId: 999,
				fromStateKey: 'space-a',
				fromUri: URI.file('/workspace-a').toString(),
				toStateKey: 'space-b',
				toUri: URI.file('/workspace-b').toString(),
				phase: 'targetApplied',
			}]);
			harness.storageService.store(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, transaction, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			harness.storageService.store('paradis.workspaceSwitch.ownerLease.999', Date.now(), StorageScope.WORKSPACE, StorageTarget.MACHINE);

			await harness.workspaceSwitchService.recoverInterruptedSwitch();

			assert.strictEqual(
				harness.storageService.get(PARADIS_WORKSPACE_SWITCH_TRANSACTION_STORAGE_KEY, StorageScope.WORKSPACE),
				transaction,
			);
		} finally {
			testDisposables.dispose();
		}
	});


	// 所属の分からない復元ターミナルは、アクティブスペースへ推測で寄せず待避させる。
	// 待避の印を外し忘れると「台帳には所属があるのに resolveScope は pending」という
	// 食い違いが残り、モバイル・通知・binding authority からその端末が消える。
	test('recovers a parked terminal group even while parking is still deferred', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4001);
			const harness = await createHarness(['space-a'], testDisposables);
			// 待避には引き取り先（今のスペース）が要る。無ければ隠さない判断になる。
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			// cwd の解決も worktree バリアも非同期。材料が揃ってからタグ付けを走らせる。
			await settle();
			harness.fireGroupsChanged();
			await settle();

			// 復元中は park を保留する（先に park すると split が壊れるため）。保留中でも待避対象。
			assert.strictEqual(scope.countUnattributedTerminals(), 1, '待避対象として数えられる');

			const adopted = scope.adoptUnattributedTerminals();

			assert.deepStrictEqual({
				adopted,
				remaining: scope.countUnattributedTerminals(),
				// 引き取った端末の所属。待避の印が残っていると、台帳に所属があっても
				// `resolveScope` が pending を返し続け、モバイルや通知から消えたままになる。
				// （このハーネスはターミナル接続を Connecting のままにしているので、
				//   binding scope 側の判定ではなく台帳を直接見る）
				stateKey: scope.getStateKeyForInstance(4001),
			}, { adopted: 1, remaining: 0, stateKey: 'space-a' });
		} finally {
			testDisposables.dispose();
		}
	});

	test('restores the terminal group last selected in each space', async () => {
		const testDisposables = new DisposableStore();
		try {
			const firstA = createRestoredTerminalGroup(4101);
			const selectedA = createRestoredTerminalGroup(4102);
			const onlyB = createRestoredTerminalGroup(4103);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			harness.installTerminalScope(async () => { }, {
				groups: [firstA, selectedA, onlyB],
				worktreeReady: true,
				connected: true,
				persistentProcessScopes: [[4101, 'space-a'], [4102, 'space-a'], [4103, 'space-b']],
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();
			harness.setActiveTerminalGroup(selectedA);

			await harness.workspaceSwitchService.switchRepository('space-b');
			await harness.workspaceSwitchService.switchRepository('space-a');

			assert.strictEqual(harness.activeTerminalGroup(), selectedA);
		} finally {
			testDisposables.dispose();
		}
	});

	// 引き取りは所属を台帳へ確定させる操作で、確定した所属は次のセッションへ伝わる。
	// 間違ったスペースで引き取ったことに後から気付いても戻せない、を避けるための取り消し。
	test('undoes the last recovery and puts the terminals back out of the space', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4003);
			const harness = await createHarness(['space-a'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(scope.adoptUnattributedTerminals(), 1);

			const released = scope.undoLastTerminalAdoption();

			assert.deepStrictEqual({
				released,
				unattributed: scope.countUnattributedTerminals(),
				// 台帳に所属が残っていると、次の起動で「引き取り先のスペースの持ち物」として
				// 復活し、取り消したはずの誤りが戻ってくる。
				stateKey: scope.getStateKeyForInstance(4003),
				persistedNonces: harness.persistedNonceScopes(),
				// 2度目の取り消しは対象が無い（同じ操作を繰り返して待避を積み増さない）。
				secondUndo: scope.undoLastTerminalAdoption(),
			}, { released: 1, unattributed: 1, stateKey: undefined, persistedNonces: [], secondUndo: 0 });
		} finally {
			testDisposables.dispose();
		}
	});

	// グループの所属は最初に根拠の引けた1本から決まり、グループ全員に書き込まれる。分割ペインの
	// 片方がユーザーの作った新しい端末だと、同居しているだけの復元端末にもその所属が付く。
	// 表示単位がグループである以上この伝播は避けられないが、焼き付けてはいけない。
	test('does not persist a space onto a restored terminal that only shares a group with a new one', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createTerminalGroup([
				createRestoredTerminalInstance(4004),
				createRestoredTerminalInstance(4005, { restored: false }),
			]);
			const harness = await createHarness(['space-a'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();

			assert.deepStrictEqual({
				// 新しい端末を巻き添えに隠さない（グループごと待避はしない）。
				unattributed: scope.countUnattributedTerminals(),
				parked: harness.parkedGroups.has(group),
				restoredStateKey: scope.getStateKeyForInstance(4004),
				freshStateKey: scope.getStateKeyForInstance(4005),
				// 同居していただけの復元端末に、新しい端末のスペースを焼き付けない
				// （印を付けないと `nonce-4004` がここに残り、次の起動へ誤りが伝わる）。
				// 新しい端末の方も推測（作成時のアクティブスペース）なので保存されない。
				persistedNonces: harness.persistedNonceScopes(),
			}, {
				unattributed: 0,
				parked: false,
				restoredStateKey: 'space-a',
				freshStateKey: 'space-a',
				persistedNonces: [],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// エディタ領域の端末はスペースごとの working set の中にしか居ないので、そこから出てきたこと
	// 自体が所属の根拠になる（パネルのグループは全スペース分がまとめて復元されるので言えない）。
	// 根拠として記録しないと、所属が空のまま画面には出続ける端末になる。
	test('gives a restored editor terminal the space whose working set produced it', async () => {
		const testDisposables = new DisposableStore();
		try {
			const editorTerminal = createRestoredTerminalInstance(4006);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			// 切り替えでの復元中は「アクティブ＝切り替え元、復元先＝切り替え先」なので、
			// アクティブスペースを見ると必ず取り違える。復元先が勝つことをここで固定する。
			await paradisRefreshTerminalReviveIndex('space-b', { skipLookup: true, expectedNonces: new Set(['nonce-4006']) });
			const scope = harness.installTerminalScope(async () => { }, { editorInstances: [editorTerminal], worktreeReady: true });
			await settle();
			harness.fireInstancesChanged();
			await settle();

			assert.deepStrictEqual({
				activeStateKey: harness.workspaceSwitchService.activeStateKey,
				stateKey: scope.getStateKeyForInstance(4006),
				// 容れ物という根拠から確定させた所属なので、推測と違い台帳へ残してよい。
				persistedNonces: harness.persistedNonceScopes(),
			}, { activeStateKey: 'space-a', stateKey: 'space-b', persistedNonces: [['nonce-4006', 'space-b']] });
		} finally {
			paradisClearTerminalReviveIndex();
			testDisposables.dispose();
		}
	});

	// 復元先が分からない経路（起動時のエディタ復元、補助ウィンドウの復元）で「今アクティブな
	// スペース」に落とすのは根拠ではなく推測。確定として記録すると、別スペースに固定した補助
	// ウィンドウの端末がメインのスペースへ吸い込まれ、そこを離れた瞬間に detach される。
	test('does not stamp the active space onto a restored editor terminal with no working set to point at', async () => {
		const testDisposables = new DisposableStore();
		try {
			const editorTerminal = createRestoredTerminalInstance(4007);
			const harness = await createHarness(['space-a'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { editorInstances: [editorTerminal], worktreeReady: true });
			await settle();
			harness.fireInstancesChanged();
			await settle();

			assert.deepStrictEqual({
				stateKey: scope.getStateKeyForInstance(4007),
				persistedNonces: harness.persistedNonceScopes(),
			}, { stateKey: undefined, persistedNonces: [] });
		} finally {
			testDisposables.dispose();
		}
	});

	// 「最初に根拠の引けた1本」でグループ全員を上書きすると、別スペースの根拠を持つ端末が
	// 黙って別のスペースの持ち物にされる。表示単位は1つでも、答えまで混ぜる理由は無い。
	test('keeps a terminal in its own space when it disagrees with the group it sits in', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createTerminalGroup([
				createRestoredTerminalInstance(4008, { initialCwd: '/workspace-b/sub' }),
				createRestoredTerminalInstance(4009, { restored: false }),
			]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true, connected: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();

			assert.deepStrictEqual({
				// cwd という自前の根拠を持つ端末は、同居先のスペースに上書きされない。
				restoredStateKey: scope.getStateKeyForInstance(4008),
				// ユーザーが今のスペースで作った端末も、同居先へ引きずられない。
				freshStateKey: scope.getStateKeyForInstance(4009),
				// 焼き付けてよいのは根拠のある方だけ（新規端末の所属は作成時の推測なので保存しない）。
				persistedNonces: harness.persistedNonceScopes(),
				// 表示と待避はグループ単位でしか決められない。構成員の根拠が割れたときは、
				// 今見えているスペース (space-a) を主張する端末が居る側に置く。隠す方に倒すと、
				// ユーザーがたった今ここに開いた端末が、切り替えてもいないのに消える。
				parked: harness.parkedGroups.has(group),
				unattributed: scope.countUnattributedTerminals(),
			}, {
				restoredStateKey: 'space-b',
				freshStateKey: 'space-a',
				persistedNonces: [['nonce-4008', 'space-b']],
				parked: false,
				unattributed: 0,
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// 引き取ったグループを別スペースへ切り替えて park させてから取り消すと、park 台帳の
	// 元スペースと待避先の両方に載りうる。載ると、そのスペースへ戻ったとき画面には出るのに
	// 「待避中」として扱われ続け、本数も二重に数えられる。
	test('undoes a recovery without leaving the group in two park ledgers', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4010);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true, connected: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			// 待避の案内に出るボタンから引き取る（実際のユーザー操作と同じ経路）。
			const parkedNotice = harness.notifications[0];
			await parkedNotice.choices[0].run();
			assert.strictEqual(scope.countUnattributedTerminals(), 0, '今のスペースへ引き取れる');

			// 別スペースへ切り替えると、引き取り先スペースのものとして park される。
			await harness.workspaceSwitchService.switchRepository('space-b');
			const released = scope.undoLastTerminalAdoption();

			// 取り消しは「取り消せる間だけ」が価値なので、案内が自動で消えてはいけない。
			// 探すのは表示ラベルそのもの。`localize` はキー指定だと第2引数をそのまま返すので、
			// ここは実装に書いてある文言と一字一句同じでなければ**黙って1件も見つからない**。
			// 実際 045ae08122c で実装のラベルが英語から日本語になった際にここが追随せず、
			// 以下の assert は毎回 undefined と比較して失敗し続けていた。文言を変えるときは対で直すこと。
			// allow-any-unicode-next-line
			const undoLabel = '元に戻す';
			const undoNotice = harness.notifications.find(notification => notification.choices.some(choice => choice.label === undoLabel));
			assert.ok(undoNotice, `取り消しの案内が見つからない (出ていたラベル: ${JSON.stringify(harness.notifications.map(notification => notification.choices.map(choice => choice.label)))})`);
			assert.strictEqual(undoNotice.sticky, true, '取り消しの案内は自動で消さない');

			assert.deepStrictEqual({
				released,
				unattributed: scope.countUnattributedTerminals(),
				stateKey: scope.getStateKeyForInstance(4010),
				// 二重に載っていれば、ここで同じグループを2度処理して 2 が返る。
				readopted: scope.adoptUnattributedTerminals(),
				remaining: scope.countUnattributedTerminals(),
			}, { released: 1, unattributed: 1, stateKey: undefined, readopted: 1, remaining: 0 });
		} finally {
			testDisposables.dispose();
		}
	});

	// 待避のお知らせを1ウィンドウにつき1回きりにすると、2回目以降に隠れた端末はユーザーから
	// 黙って消えたようにしか見えない。閉じた後にまた待避が起きたら、改めて知らせる。
	test('tells the user again when more terminals are set aside after the notice was closed', async () => {
		const testDisposables = new DisposableStore();
		try {
			const harness = await createHarness(['space-a'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [createRestoredTerminalGroup(4011)], worktreeReady: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			const first = harness.notifications.length;

			// 出しっぱなしの間は重ねない。
			harness.addGroup(createRestoredTerminalGroup(4012));
			await settle();
			const whileOpen = harness.notifications.length;

			harness.notifications[0].close();
			harness.addGroup(createRestoredTerminalGroup(4013));
			await settle();

			assert.deepStrictEqual({
				first,
				whileOpen,
				afterClose: harness.notifications.length,
				// 復元直後、画面を見ていない時間帯に出るので自動では消さない。
				sticky: harness.notifications[0].sticky,
				unattributed: scope.countUnattributedTerminals(),
			}, { first: 1, whileOpen: 1, afterClose: 2, sticky: true, unattributed: 3 });
		} finally {
			testDisposables.dispose();
		}
	});

	// タグ付けはグループ単位で1度しか走らない。後から分割で加わった端末や、いったん背面へ
	// 回して戻した端末は別経路で所属を引くので、そこでも突き合わせないと、根拠ゼロの端末に
	// グループの所属が印なしで確定して台帳へ焼き付く。
	test('does not stamp a group space onto a terminal that joins it later', async () => {
		const testDisposables = new DisposableStore();
		try {
			const members = [createRestoredTerminalInstance(4014, { initialCwd: '/workspace-a/sub' })];
			const group = createTerminalGroup(members);
			const harness = await createHarness(['space-a'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(scope.getStateKeyForInstance(4014), 'space-a', 'cwd から所属が決まる');

			// タグ付け済みのグループへ、根拠を持たない復元端末が後から合流する。
			members.push(createRestoredTerminalInstance(4015));
			harness.fireInstancesChanged();
			await settle();

			assert.deepStrictEqual({
				// 表示はグループ単位なので所属自体は引き継ぐ。
				joinedStateKey: scope.getStateKeyForInstance(4015),
				// ただし借り物なので台帳へは残さない（残すと cwd での訂正が二度と来ない）。
				persistedNonces: harness.persistedNonceScopes(),
			}, {
				joinedStateKey: 'space-a',
				persistedNonces: [['nonce-4014', 'space-a']],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// 接続完了後の掃除は「pid が確定しておらず、復元中はタグ付けできなかったグループ」を
	// 台帳で直す経路。借り物が最も出やすい場所なので、ここで印を消すと直後の書き出しで焼き付く。
	//
	// 固定しているのは「この経路で借り物が台帳へ入らない」という不変条件であって、特定の引数
	// ミスではない。引数を取り違えた場合はガードが安全側へ倒して結果を保つので、このテストの
	// アサーションではなく `onUnexpectedError` を拾うエラーハンドラ側で落ちる。
	test('does not burn a swept-in space onto a group member with no evidence of its own', async () => {
		const testDisposables = new DisposableStore();
		try {
			// pty id は復元中まだ確定していない（台帳を引けないので untagged のまま残る）。
			const attachTarget: { id?: number } = {};
			const ledgerBacked = createRestoredTerminalInstance(4016);
			(ledgerBacked.shellLaunchConfig as { attachPersistentProcess?: unknown }).attachPersistentProcess = attachTarget;
			const group = createTerminalGroup([ledgerBacked, createRestoredTerminalInstance(4017)]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, {
				groups: [group],
				// worktree 一覧が未確定なので cwd でも引けず、待避の判定材料も揃わない。
				worktreeReady: false,
				connectLater: true,
				persistentProcessScopes: [[77, 'space-b']],
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(scope.getStateKeyForInstance(4016), undefined, '復元中はまだ所属が決まらない');

			// 接続が完了する頃には pty id が確定し、台帳から所属が引けるようになる。
			attachTarget.id = 77;
			harness.finishConnecting();
			await settle();
			// 掃除の後にも書き出しの契機は何度も来る。印が消えていれば、ここで焼き付く。
			harness.fireInstancesChanged();
			await settle();

			assert.deepStrictEqual({
				ledgerBackedStateKey: scope.getStateKeyForInstance(4016),
				// 同居しているだけの端末にも表示上の所属は伝わる。
				inheritedStateKey: scope.getStateKeyForInstance(4017),
				// 台帳へ残してよいのは、台帳から引けた側だけ。
				persistedNonces: harness.persistedNonceScopes(),
			}, {
				ledgerBackedStateKey: 'space-b',
				inheritedStateKey: 'space-b',
				persistedNonces: [['nonce-4016', 'space-b']],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('brings back the rest of a space\'s parked groups when one of them fails', async () => {
		const testDisposables = new DisposableStore();
		const originalUnexpectedErrorHandler = errorHandler.getUnexpectedErrorHandler();
		const errors: string[] = [];
		setUnexpectedErrorHandler(error => errors.push(String(error)));
		testDisposables.add({ dispose: () => setUnexpectedErrorHandler(originalUnexpectedErrorHandler) });
		try {
			const failing = createRestoredTerminalGroup(4801);
			const healthy = createRestoredTerminalGroup(4802);
			const failingUnparks = new Set([failing]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			harness.installTerminalScope(async () => { }, {
				groups: [failing, healthy],
				worktreeReady: true,
				connected: true,
				persistentProcessScopes: [[4801, 'space-b'], [4802, 'space-b']],
				failingUnparks,
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();
			const parkedInSpaceA = [harness.parkedGroups.has(failing), harness.parkedGroups.has(healthy)];

			await harness.workspaceSwitchService.switchRepository('space-b');
			const parkedAfterFailure = [harness.parkedGroups.has(failing), harness.parkedGroups.has(healthy)];

			// 途中まで戻って見えている分は、待避中の扱いに戻さない。次に離れたときに普通に待避される。
			failingUnparks.clear();
			await harness.workspaceSwitchService.switchRepository('space-a');
			const parkedAfterLeaving = [harness.parkedGroups.has(failing), harness.parkedGroups.has(healthy)];
			await harness.workspaceSwitchService.switchRepository('space-b');

			assert.deepStrictEqual({
				parkedInSpaceA,
				parkedAfterFailure,
				parkedAfterLeaving,
				parkedAfterReturning: [harness.parkedGroups.has(failing), harness.parkedGroups.has(healthy)],
				errors,
			}, {
				parkedInSpaceA: [true, true],
				parkedAfterFailure: [false, false],
				parkedAfterLeaving: [true, true],
				parkedAfterReturning: [false, false],
				errors: ['Error: unpark failed'],
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// リモートでは `whenConnected` が復元端末全ての replay 完了まで待つため、数分単位で遅れる。
	// それまで park を保留したままだと、切り替えたはずの前のスペースのターミナルが見えて操作でき、
	// 前のスペースの作業ディレクトリでコマンドを打つ事故になる。接続完了で先に打ち切る。
	test('parks other spaces once the remote connection is up, without waiting for the replay to finish', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4020);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, {
				groups: [group],
				worktreeReady: true,
				// `whenConnected` は解決させない。replay 待ちで残り続ける状況そのもの。
				persistentProcessScopes: [[4020, 'space-b']],
				remoteAuthority: 'ssh-remote+example',
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();
			const parkedWhileConnecting = harness.parkedGroups.has(group);

			// 接続完了だけが先に来る（`whenConnected` はまだ pending のまま）。
			harness.markTerminalsConnected();
			await settle();

			assert.deepStrictEqual({
				parkedWhileConnecting,
				parkedOnceConnected: harness.parkedGroups.has(group),
				stateKey: scope.getStateKeyForInstance(4020),
			}, {
				// 復元中の park は split を壊すので、接続が立つまでは保留のまま。
				parkedWhileConnecting: false,
				parkedOnceConnected: true,
				stateKey: 'space-b',
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// local では upstream の `_reconnectToLocalTerminals` が `_recreateTerminalGroups` を
	// await せずに接続完了を立てるため、接続完了はグループ構築の実行中に来る。ここで park を
	// 解除すると 2枚目以降の split が `Cannot split a terminal without a group` で落ちる。
	// 早期解除をリモート限定にしている理由がこれで、うっかり local へ広げると再発する。
	test('keeps parking deferred on a local connection, where groups are still being rebuilt', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4021);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, {
				groups: [group],
				worktreeReady: true,
				persistentProcessScopes: [[4021, 'space-b']],
				// remoteAuthority を渡さない = local。
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();

			harness.markTerminalsConnected();
			await settle();

			assert.deepStrictEqual({
				parkedOnceConnected: harness.parkedGroups.has(group),
				// 台帳は正しいままで、見え方だけが `whenConnected` まで遅れて追いつく。
				stateKey: scope.getStateKeyForInstance(4021),
			}, {
				parkedOnceConnected: false,
				stateKey: 'space-b',
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// 借り物の端末を cwd で訂正するとき、同居している「自前の根拠を持つ端末」を巻き添えに
	// 上書きしてはいけない。訂正はユーザーの明示指定ではないので、グループごと動かさない。
	test('correcting a borrowed space does not overwrite the space of the terminal beside it', async () => {
		const testDisposables = new DisposableStore();
		try {
			const borrowed = createRestoredTerminalInstance(4018, { initialCwd: '/worktree-b/sub' });
			const grounded = createRestoredTerminalInstance(4019, { initialCwd: '/workspace-a/sub' });
			const group = createTerminalGroup([grounded, borrowed]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(scope.getStateKeyForInstance(4018), 'space-a', '同居先から所属を借りている');

			// worktree が一覧に現れ、借り物の端末の cwd がそこに一致するようになる。
			harness.addWorktree('space-b', '/worktree-b');
			await settle();

			assert.deepStrictEqual({
				correctedStateKey: scope.getStateKeyForInstance(4018),
				// 訂正の巻き添えで、自前の根拠を持つ端末の所属が書き換わってはいけない。
				groundedStateKey: scope.getStateKeyForInstance(4019),
			}, {
				correctedStateKey: paradisWorktreeStateKey(URI.file('/worktree-b')),
				groundedStateKey: 'space-a',
			});
		} finally {
			testDisposables.dispose();
		}
	});

	// 訂正は端末1本だけを動かすので、グループの置き場所を直す契機を別に用意しないと、
	// 台帳は正しいのに別のスペースの端末が今のスペースに出続ける（1本しか入っていない
	// グループでは必ずこうなる）。
	test('moves a group out of the active space once its only terminal turns out to belong elsewhere', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createTerminalGroup([createRestoredTerminalInstance(4020, { restored: false, initialCwd: '/worktree-c/sub' })]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true, connected: true });
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(harness.parkedGroups.has(group), false, '作られた時のスペースにそのまま出ている');

			// worktree が一覧に現れ、この端末は別スペースのものだと分かる。
			harness.addWorktree('space-b', '/worktree-c');
			await settle();

			assert.deepStrictEqual({
				stateKey: scope.getStateKeyForInstance(4020),
				// 所属だけ直してグループを置き去りにすると、ここが false のまま＝混ざり続ける。
				parked: harness.parkedGroups.has(group),
			}, {
				stateKey: paradisWorktreeStateKey(URI.file('/worktree-c')),
				parked: true,
			});
		} finally {
			testDisposables.dispose();
		}
	});

	test('forgets a parked group once it is disposed', async () => {
		const testDisposables = new DisposableStore();
		try {
			const group = createRestoredTerminalGroup(4002);
			const harness = await createHarness(['space-b'], testDisposables);
			// 待避には引き取り先（今のスペース）が要る。無ければ隠さない判断になる。
			await harness.workspaceSwitchService.switchRepository('space-b');

			const scope = harness.installTerminalScope(async () => { }, { groups: [group], worktreeReady: true });
			// cwd の解決も worktree バリアも非同期。材料が揃ってからタグ付けを走らせる。
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.strictEqual(scope.countUnattributedTerminals(), 1);

			harness.disposeGroup(group);

			// 消し忘れるとグループと配下の端末の参照がウィンドウの寿命ぶん残り続ける。
			assert.strictEqual(scope.countUnattributedTerminals(), 0);
		} finally {
			testDisposables.dispose();
		}
	});

	// 下部パネルは「どのスペースにも属さない共通ターミナル」。前のバージョンが別のスペースの
	// 所属を台帳へ書いていても、切り替えで隠れず、そのスペースを消しても閉じない。設定を切ると従来どおり
	// スペースごとに退避することも同じシナリオで確かめる（台帳の書き方が変わっていないことの確認を兼ねる）。
	test('keeps the shared panel terminal visible across switches and alive when its old space is removed', async () => {
		const run = async (sharedPanel: boolean) => {
			const testDisposables = new DisposableStore();
			try {
				let disposed = false;
				const instance = createRestoredTerminalInstance(4301, { initialCwd: '/workspace-b' });
				Object.assign(instance, { target: TerminalLocation.Panel, dispose: () => { disposed = true; } });
				const group = createTerminalGroup([instance]);
				const harness = await createHarness(['space-a', 'space-b'], testDisposables);
				// 設定はウィンドウの起動時の値を1度だけ読む。ここでは所属の判定側が読む前に差し替える。
				paradisResetSharedPanelStartupValueForTest();
				await harness.configurationService.setUserConfiguration('paradis.terminal.sharedPanel.enabled', sharedPanel);
				await harness.workspaceSwitchService.switchRepository('space-a');
				const scope = harness.installTerminalScope(async () => { }, {
					groups: [group],
					worktreeReady: true,
					connected: true,
					connectionState: TerminalConnectionState.Connected,
					persistentProcessScopes: [[4301, 'space-b']],
				});
				await settle();
				harness.fireGroupsChanged();
				await settle();
				const parkedInSpaceA = harness.parkedGroups.has(group);
				// 設定をオフに戻したときのために、消した所属を控えてあるか。
				const formerScopes = harness.storageService.get('paradis.workspaceSwitch.sharedPanelFormerScopes', StorageScope.WORKSPACE);
				const resolvedInSpaceA = scope.resolveScope(4301);
				const scopeInSpaceA = resolvedInSpaceA.kind === 'managed' ? `managed:${resolvedInSpaceA.stateKey}` : resolvedInSpaceA.kind;
				await harness.workspaceSwitchService.switchRepository('space-b');
				const parkedInSpaceB = harness.parkedGroups.has(group);
				await harness.workspaceSwitchService.switchRepository('space-a');
				await harness.workspaceSwitchService.removeRepository('space-b');
				await settle();
				return {
					formerScopes: formerScopes === undefined ? undefined : [...(paradisParseTerminalNonceScopeStorage(formerScopes) ?? [])],
					// 消したスペースへの控えは一緒に消える（残すと設定を戻したときにそこへ隠れる）。
					formerScopesAfterRemoval: harness.storageService.get('paradis.workspaceSwitch.sharedPanelFormerScopes', StorageScope.WORKSPACE),
					parkedInSpaceA,
					parkedInSpaceB,
					scopeInSpaceA,
					stateKey: scope.getStateKeyForInstance(4301),
					disposedWithSpaceB: disposed,
				};
			} finally {
				paradisResetSharedPanelStartupValueForTest();
				testDisposables.dispose();
			}
		};

		assert.deepStrictEqual({ shared: await run(true), perSpace: await run(false) }, {
			// 共通ターミナルは台帳に所属を持たず、尋ねられたら今のスペース（最後は space-a）と答える。
			shared: { formerScopes: [['nonce-4301', 'space-b']], formerScopesAfterRemoval: undefined, parkedInSpaceA: false, parkedInSpaceB: false, scopeInSpaceA: 'managed:space-a', stateKey: 'space-a', disposedWithSpaceB: false },
			perSpace: { formerScopes: undefined, formerScopesAfterRemoval: undefined, parkedInSpaceA: true, parkedInSpaceB: false, scopeInSpaceA: 'managed:space-b', stateKey: undefined, disposedWithSpaceB: true },
		});
	});

	// 共通扱いはユーザーが開いたシェルだけ。パネルで動かしたタスクはそのスペースの作業の一部なので、
	// 切り替えで退避し、スペースを削除したら一緒に閉じる。
	test('keeps a task terminal in the panel owned by its space even while the panel is shared', async () => {
		const testDisposables = new DisposableStore();
		try {
			paradisResetSharedPanelStartupValueForTest();
			const instance = createRestoredTerminalInstance(4401, { initialCwd: '/workspace-b' });
			Object.assign(instance, { target: TerminalLocation.Panel, shellLaunchConfig: { attachPersistentProcess: { id: 4401, type: 'Task' } } });
			const group = createTerminalGroup([instance]);
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			const scope = harness.installTerminalScope(async () => { }, {
				groups: [group],
				worktreeReady: true,
				connected: true,
				connectionState: TerminalConnectionState.Connected,
				persistentProcessScopes: [[4401, 'space-b']],
			});
			await settle();
			harness.fireGroupsChanged();
			await settle();
			assert.deepStrictEqual({ parked: harness.parkedGroups.has(group), stateKey: scope.getStateKeyForInstance(4401) }, { parked: true, stateKey: 'space-b' });
		} finally {
			paradisResetSharedPanelStartupValueForTest();
			testDisposables.dispose();
		}
	});

	// 共通ターミナルを切っていると、パネルのターミナルはスペースごとに入れ替わる。パネルを開くのが
	// 入れ替えより先だと、切り替え元の（空の）並びが見えた瞬間に upstream が空のシェルを1本作り、
	// 往復のたびに溜まっていた。開閉は入れ替え（完了参加者）の後に戻す。失敗して戻す時も同じ順。
	test('restores the panel visibility only after the panel terminals of the destination are back', async () => {
		const testDisposables = new DisposableStore();
		try {
			paradisResetSharedPanelStartupValueForTest();
			paradisSharedPanelEnabledAtStartup({ getValue: () => false });
			let failNextSwitchToA = false;
			const harness = await createHarness(['space-a', 'space-b'], testDisposables, async (phase, uri) => {
				if (failNextSwitchToA && phase === 'end' && uri.path === '/workspace-a') {
					throw new Error('target deleted');
				}
			});
			let panelVisible = false;
			const events: string[] = [];
			Object.assign(harness.layoutService, {
				isVisible: (part: Parts) => part === Parts.PANEL_PART ? panelVisible : true,
				setPartHidden: async (hidden: boolean, part: Parts) => {
					if (part === Parts.PANEL_PART) {
						panelVisible = !hidden;
						events.push(hidden ? 'panel:hidden' : 'panel:shown');
					}
				},
			});
			testDisposables.add(harness.workspaceSwitchService.registerSwitchCompletionParticipant(stateKey => { events.push(`participants:${stateKey}`); }));

			await harness.workspaceSwitchService.switchRepository('space-b');
			panelVisible = true;
			await harness.workspaceSwitchService.switchRepository('space-a');
			await harness.workspaceSwitchService.switchRepository('space-b');
			failNextSwitchToA = true;
			const failed = await Promise.allSettled([harness.workspaceSwitchService.switchRepository('space-a')]);

			assert.deepStrictEqual({ events, failed: failed[0].status, activeStateKey: harness.workspaceSwitchService.activeStateKey }, {
				events: [
					'participants:space-b',
					'participants:space-a', 'panel:hidden',
					'participants:space-b', 'panel:shown',
					// ロールバックでも、元のスペースのパネル端末を戻してから開く。
					'participants:space-b', 'panel:shown',
				],
				failed: 'rejected',
				activeStateKey: 'space-b',
			});
		} finally {
			paradisResetSharedPanelStartupValueForTest();
			testDisposables.dispose();
		}
	});

	// 復元したタブが PTY へ繋げずシェルを起こし直すと、upstream はそのとき開いているフォルダ
	// （切り替え中なら切り替え元）で起こし、その cwd が所属の証拠になって台帳へ焼き付いていた。
	test('starts a shell that could not reattach in its own space and records that space, not the folder that happened to be open', async () => {
		const run = async (variant: 'restarted' | 'restartedWithStalePidLedger' | 'restartedWithoutResolver' | 'reattached') => {
			const testDisposables = new DisposableStore();
			const processReady = new DeferredPromise<void>();
			try {
				// 起こし直したシェルの cwd は、切り替え元の space-a のフォルダだったとする。
				const instance = createRestoredTerminalInstance(4501, { initialCwd: '/workspace-a' });
				Object.assign(instance, { processReady: processReady.p, resource: URI.from({ scheme: 'vscode-terminal', path: '/4501' }) });
				const harness = await createHarness(['space-a', 'space-b'], testDisposables);
				await harness.workspaceSwitchService.switchRepository('space-a');
				// space-b への切り替えで working set を復元している最中（フォルダはまだ space-a）。
				const restoreContext = testDisposables.add(await paradisRefreshTerminalReviveIndex('space-b', { skipLookup: true, expectedNonces: new Set(['nonce-4501']) }));
				if (variant === 'restarted' || variant === 'restartedWithStalePidLedger') {
					testDisposables.add(paradisRegisterRestartedTerminalCwdResolver(async launch => {
						const stateKey = paradisLookupRestartedShellScope(launch.instanceId, launch.nonce);
						return stateKey === undefined ? undefined : URI.file(`/workspace-${stateKey.slice('space-'.length)}`);
					}));
				}
				const scope = harness.installTerminalScope(async () => { }, {
					editorInstances: [instance],
					worktreeReady: true,
					// 何世代も前の working set の ID は、前回たまたま同じ番号だった別のスペースの端末を指しうる。
					persistentProcessScopes: variant === 'restartedWithStalePidLedger' ? [[4501, 'space-a']] : undefined,
				});
				await settle();
				harness.fireInstancesChanged();
				await settle();
				if (variant !== 'reattached') {
					// terminalProcessManager の attach 失敗の分岐と同じ順（問い合わせてから attach 情報を消す）。
					await paradisPrepareRestartedTerminalLaunch(instance.shellLaunchConfig, 4501, 'nonce-4501', undefined);
					instance.shellLaunchConfig.attachPersistentProcess = undefined;
				}
				// シェルが起動を知らせる前に切り替えは終わっている。
				restoreContext.dispose();
				processReady.complete();
				await settle();
				return {
					cwd: instance.shellLaunchConfig.cwd?.toString(),
					stateKey: scope.getStateKeyForInstance(4501),
					persistedNonces: harness.persistedNonceScopes(),
				};
			} finally {
				processReady.complete();
				paradisResetRestartedTerminalsForTest();
				paradisClearTerminalReviveIndex();
				testDisposables.dispose();
			}
		};

		assert.deepStrictEqual({
			restarted: await run('restarted'),
			restartedWithStalePidLedger: await run('restartedWithStalePidLedger'),
			restartedWithoutResolver: await run('restartedWithoutResolver'),
			reattached: await run('reattached'),
		}, {
			restarted: { cwd: 'file:///workspace-b', stateKey: 'space-b', persistedNonces: [['nonce-4501', 'space-b']] },
			// pid 台帳の古い番号より、タブが出てきた working set を採る（記録もそちらへ直す）。
			restartedWithStalePidLedger: { cwd: 'file:///workspace-b', stateKey: 'space-b', persistedNonces: [['nonce-4501', 'space-b']] },
			// フォルダを決められなかった回でも、起こし直したシェルの cwd は証拠にせず、出てきた working set を採る。
			restartedWithoutResolver: { cwd: undefined, stateKey: 'space-b', persistedNonces: [['nonce-4501', 'space-b']] },
			// 繋ぎ直せたシェルの cwd は、そのシェルが作られた場所なので従来どおり証拠になる。
			reattached: { cwd: undefined, stateKey: 'space-a', persistedNonces: [['nonce-4501', 'space-a']] },
		});
	});

	// 更新前のバージョンで溜まった空のシェルが、共通ターミナルへ移した直後にまとめて並ぶ。
	// 知らせから、使われていないものだけを閉じられるようにする（通知は 3 秒まとめてから出る）。
	test('offers to close only the never-used shells that moved into the shared panel', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
		const testDisposables = new DisposableStore();
		try {
			paradisResetSharedPanelStartupValueForTest();
			const panelShell = (instanceId: number, commandCount: number, title = 'zsh') => {
				const instance = createRestoredTerminalInstance(instanceId, { initialCwd: '/workspace-b' });
				const commandDetection = { commands: new Array(commandCount).fill({}), executingCommand: undefined, promptInputModel: { value: '' } };
				const lines = ['', '~/workspace-b %', ''];
				Object.assign(instance, {
					target: TerminalLocation.Panel,
					title,
					hasChildProcesses: false,
					processId: 7000 + instanceId,
					shellLaunchConfig: { attachPersistentProcess: { id: instanceId, pid: 7000 + instanceId } },
					capabilities: { get: (capability: TerminalCapability) => capability === TerminalCapability.CommandDetection ? commandDetection : undefined },
					xterm: { raw: { buffer: { normal: { length: lines.length, getLine: (y: number) => ({ translateToString: () => lines[y] }) } } } },
				});
				return instance;
			};
			const idle = panelShell(4601, 0);
			const used = panelShell(4602, 3);
			const agent = panelShell(4603, 0, 'Fix the login flow');
			// PC の再起動後に画面ごと起こし直したシェルは、コマンドの履歴を持たないので空に見える。
			const revived = panelShell(4604, 0);
			Object.assign(revived.shellLaunchConfig.attachPersistentProcess!, { paradisRevivedFromPersistentProcessId: 44 });
			const harness = await createHarness(['space-a', 'space-b'], testDisposables);
			await harness.workspaceSwitchService.switchRepository('space-a');
			harness.installTerminalScope(async () => { }, {
				groups: [createTerminalGroup([idle]), createTerminalGroup([used]), createTerminalGroup([agent]), createTerminalGroup([revived])],
				worktreeReady: true,
				connected: true,
				connectionState: TerminalConnectionState.Connected,
				persistentProcessScopes: [[4601, 'space-b'], [4602, 'space-b'], [4603, 'space-b'], [4604, 'space-b']],
			});
			await settle();
			harness.fireGroupsChanged();
			// 知らせは 3 秒まとめてから出る。仮想時間で進める。
			await timeout(3_100);
			const notice = harness.notifications.find(notification => notification.message.includes('共通ターミナル'));
			notice?.choices[0]?.run();
			await settle();

			assert.deepStrictEqual({
				// タグ付けのたびに同じ端末を数え直さない（PTY ID が決まる前は前の所属がまた見つかる）。
				migrated: notice?.message.match(/下部パネルの (?<count>\d+) 個/)?.groups?.count,
				choices: notice?.choices.map(choice => choice.label),
				closed: harness.safeDisposedTerminalIds,
			}, {
				migrated: '4',
				choices: ['使われていない空のシェル 1 個を閉じる'],
				closed: [4601],
			});
		} finally {
			paradisResetSharedPanelStartupValueForTest();
			testDisposables.dispose();
		}
	}));

});

interface IWorkspaceSwitchIntegrationHarness {
	readonly workspaceSwitchService: ParadisWorkspaceSwitchService;
	readonly configurationService: TestConfigurationService;
	readonly editorScopeService: ParadisEditorScopeService;
	readonly parts: IEditorGroupsService;
	readonly terminalEditorService: Pick<ITerminalEditorService, 'instances'>;
	readonly storageService: IStorageService;
	/** パネルの開閉を見るテストが差し替える（既定の TestLayoutService は開閉を覚えない）。 */
	readonly layoutService: IWorkbenchLayoutService;
	/** `safeDisposeTerminal` で閉じられたターミナル。 */
	readonly safeDisposedTerminalIds: readonly number[];
	readonly detachedTerminalInstanceIds: readonly number[];
	/** park 中のグループ。待避されたかを見るのに使う。 */
	readonly parkedGroups: ReadonlySet<ITerminalGroup>;
	/** 保存された nonce 台帳。所属が「焼き付いた」かどうかはここでしか見分けられない。 */
	persistedNonceScopes(): readonly (readonly [string, string])[];
	installTerminalScope(onOpenEditor: (instance: ITerminalInstance, location?: TerminalEditorLocation) => Promise<void>, options?: IParadisTerminalScopeHarnessOptions): ParadisTerminalWorkspaceScope;
	/** グループ構成が変わったことを知らせる（タグ付けを走らせる）。 */
	fireGroupsChanged(): void;
	/** ターミナルの増減を知らせる（所属の引き直しを走らせる）。 */
	fireInstancesChanged(): void;
	setActiveTerminalGroup(group: ITerminalGroup): void;
	activeTerminalGroup(): ITerminalGroup | undefined;
	/** 後からグループを増やす（タグ付けもあわせて走らせる）。 */
	addGroup(group: ITerminalGroup): void;
	/** `connectLater` で止めていたターミナルの復元完了を進める。 */
	finishConnecting(): void;
	/**
	 * ターミナルの接続完了だけを知らせる（`whenConnected` は進めない）。リモートで
	 * replay 待ちが長引き、接続完了だけが先に来る状況を踏むのに使う。
	 */
	markTerminalsConnected(): void;
	/** worktree を1つ増やして知らせる（cwd から所属を引けるようになる契機）。 */
	addWorktree(repositoryId: string, path: string): void;
	/** 出された通知。待避を知らせたか、閉じた後にまた知らせるかを見るのに使う。 */
	readonly notifications: IRecordedNotification[];
	disposeGroup(group: ITerminalGroup): void;
	createEditor(path: string, modified: boolean): TestFileEditorInput;
	/** `startPty` を渡すと、`processReady` を待たれた時点で初めて呼ばれる（PTY の起動が遅れた端末を作る）。 */
	addTerminal(input: TestFileEditorInput, instanceId: number, persistentProcessId: number | undefined, shellIntegrationNonce: string, startPty?: () => Promise<void>): ITerminalInstance;
}

interface IWorkspaceSwitchHarnessBootstrap {
	readonly parts: IEditorGroupsService;
	readonly storageService: IStorageService;
	createEditor(path: string, modified: boolean): TestFileEditorInput;
}

/** ターミナルスコープを組み立てるときの、テストごとに変えたい前提。 */
interface IParadisTerminalScopeHarnessOptions {
	readonly groups?: readonly ITerminalGroup[];
	/** worktree の初期化バリアを解決済みにするか（待避判定の材料の1つ）。 */
	readonly worktreeReady?: boolean;
	/** エディタ領域に復元済みとして置いておくターミナル。 */
	readonly editorInstances?: readonly ITerminalInstance[];
	/** ターミナルの復元を完了させるか（park の保留が解けて実際に待避が走る）。 */
	readonly connected?: boolean;
	/**
	 * 復元を「後から」完了させる。`harness.finishConnecting()` を呼ぶまで待つので、
	 * 接続完了時の掃除 (`sweepRestoredGroups`) だけを狙って踏める。
	 */
	readonly connectLater?: boolean;
	/** 前セッションから引き継いだ {pty id → スペース} の台帳。 */
	readonly persistentProcessScopes?: readonly (readonly [number, string])[];
	/**
	 * リモート接続 (SSH 等) として組み立てるか。park 保留の早期解除はリモートでしか
	 * 走らない（local は復元中に接続完了が立つため）。
	 */
	readonly remoteAuthority?: string;
	/** 組み立てた時点の接続状態。既に Connected な状態から始めるのに使う。 */
	readonly connectionState?: TerminalConnectionState;
	/** 待避から戻すと例外になるグループ。1件の失敗で残りを戻し損ねないかを見るのに使う。 */
	readonly failingUnparks?: ReadonlySet<ITerminalGroup>;
	/** 孤児 PTY の一覧と繋ぎ直しを差し替える（既定は backend 無し＝孤児なし）。 */
	readonly terminalInstanceService?: Pick<ITerminalInstanceService, 'getBackend' | 'createInstance'>;
}

/** マイクロタスクとタイマーを数回まわして、非同期の解決を落ち着かせる。 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
}

/**
 * 復元されたターミナル1本だけを持つグループ。`attachPersistentProcess` の有無が
 * 「復元された端末か」の判別材料そのものなので、テストからも明示的に指定する。
 */
function createRestoredTerminalGroup(instanceId: number, options: { readonly restored?: boolean; readonly initialCwd?: string } = {}): ITerminalGroup {
	return createTerminalGroup([createRestoredTerminalInstance(instanceId, options)]);
}

/** 出された通知1件。押せるボタンと、閉じる操作をテストから触れるようにしておく。 */
interface IRecordedNotification {
	readonly severity: Severity;
	readonly message: string;
	readonly choices: readonly IPromptChoice[];
	readonly sticky: boolean;
	close(): void;
	isClosed(): boolean;
}

/**
 * 通知を記録するだけのサービス。待避の案内は「閉じたらまた出す」という寿命が仕様の一部なので、
 * 使い捨ての no-op ハンドルを返す TestNotificationService では検査できない。
 */
class RecordingNotificationService {
	constructor(private readonly recorded: IRecordedNotification[]) { }

	prompt(severity: Severity, message: string, choices: IPromptChoice[], options?: { sticky?: boolean }): INotificationHandle {
		const onDidClose = new Emitter<void>();
		let closed = false;
		const close = () => {
			if (!closed) {
				closed = true;
				onDidClose.fire();
				onDidClose.dispose();
			}
		};
		this.recorded.push({
			severity,
			message,
			choices,
			sticky: options?.sticky === true,
			close,
			isClosed: () => closed,
		});
		return {
			onDidClose: onDidClose.event,
			onDidChangeVisibility: Event.None,
			progress: undefined,
			close,
			updateSeverity: () => { },
			updateMessage: () => { },
			updateActions: () => { },
		} satisfies Partial<INotificationHandle> as unknown as INotificationHandle;
	}

	notify(): INotificationHandle { return this.prompt(Severity.Info, '', []); }
	info(message: string): INotificationHandle { return this.prompt(Severity.Info, message, []); }
	warn(message: string): INotificationHandle { return this.prompt(Severity.Warning, message, []); }
	error(error: string | Error): INotificationHandle { return this.prompt(Severity.Error, String(error), []); }
	status(): { close(): void } { return { close: () => { } }; }
}

function createTerminalGroup(instances: ITerminalInstance[]): ITerminalGroup {
	return { terminalInstances: instances } satisfies Partial<ITerminalGroup> as unknown as ITerminalGroup;
}

function createRestoredTerminalInstance(instanceId: number, options: { readonly restored?: boolean; readonly initialCwd?: string } = {}): ITerminalInstance {
	return {
		instanceId,
		shellIntegrationNonce: `nonce-${instanceId}`,
		isDisposed: false,
		shellLaunchConfig: (options.restored === false ? {} : { attachPersistentProcess: { id: instanceId } }) as IShellLaunchConfig,
		processReady: Promise.resolve(),
		getInitialCwd: async () => options.initialCwd ?? '/somewhere/unknown',
		onDisposed: Event.None,
		onDidChangeTarget: Event.None,
	} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
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
	/** 切り替え先フォルダの先行確認。答えない stat (リモートの詰まり) を作るために差し替える。 */
	statTargetFolder: (uri?: URI) => Promise<Partial<IFileStat>> = async () => ({ isDirectory: true }),
	bootstrap?: (context: IWorkspaceSwitchHarnessBootstrap) => Promise<void>,
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
	const configurationService = instantiationService.get(IConfigurationService) as TestConfigurationService;
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
	const createEditor = (path: string, modified: boolean): TestFileEditorInput => {
		const editor = testDisposables.add(new TestFileEditorInput(URI.file(path), editorTypeId));
		editor.modified = modified;
		inputs.set(editor.resource.toString(), editor);
		return editor;
	};
	await bootstrap?.({ parts, storageService, createEditor });
	let onOpenTerminalEditor: (instance: ITerminalInstance, location?: TerminalEditorLocation) => Promise<void> = async () => { };
	const terminalEditorService = {
		get instances() { return terminals; },
		openEditor: (instance: ITerminalInstance, location?: TerminalEditorLocation) => onOpenTerminalEditor(instance, location),
		getInputFromResource: (resource: URI) => inputs.get(resource.toString()) as unknown as ReturnType<ITerminalEditorService['getInputFromResource']>,
		detachInstance: (instance: ITerminalInstance) => {
			detachedTerminalInstanceIds.push(instance.instanceId);
			const index = terminals.indexOf(instance);
			if (index !== -1) {
				terminals.splice(index, 1);
			}
		},
	} satisfies Pick<ITerminalEditorService, 'instances' | 'openEditor' | 'getInputFromResource' | 'detachInstance'>;

	const notifications: IRecordedNotification[] = [];
	const notificationService = new RecordingNotificationService(notifications) as unknown as INotificationService;
	const layoutService = instantiationService.get(IWorkbenchLayoutService);
	const safeDisposedTerminalIds: number[] = [];

	const workspaceSwitchService = testDisposables.add(new ParadisWorkspaceSwitchService(
		storageService,
		contextService,
		workspaceEditingService,
		workspaceTrustManagementService as unknown as IWorkspaceTrustManagementService,
		parts,
		layoutService,
		terminalEditorService as unknown as ITerminalEditorService,
		// 切り替え先フォルダの事前確認。ディレクトリを返せば upstream 側の stat が省かれる経路に
		// 入り、返さなければ従来どおり upstream が自分で確かめる。
		{ stat: statTargetFolder } as unknown as IFileService,
		editorScopeService,
		auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService,
		instantiationService.get(ILogService),
		// 一覧を絞る基準になる。ここは「どこにも繋がっていない」ウィンドウとして振る舞わせる
		{ remoteAuthority: undefined } as unknown as IWorkbenchEnvironmentService,
		// 進行表示は素通し。切り替え本体を包む位置に居るので、包んだ結果が素の呼び出しと
		// 同じであることをここで担保する (表示そのものはこのハーネスの対象外)
		{ withProgress: (_options, task) => task({ report: () => { } }) } as IProgressService,
		notificationService,
		instantiationService.get(ILifecycleService),
		configurationService,
	));

	const parkedGroups = new Set<ITerminalGroup>();
	const onDidChangeGroups = testDisposables.add(new Emitter<void>());
	const onDidChangeActiveGroup = testDisposables.add(new Emitter<ITerminalGroup | undefined>());
	const onDidChangeInstances = testDisposables.add(new Emitter<void>());
	const liveGroups: ITerminalGroup[] = [];
	const deferredConnection = new DeferredPromise<void>();
	const onDidChangeConnectionState = testDisposables.add(new Emitter<void>());
	let connectionState = TerminalConnectionState.Connecting;
	const onDidChangeWorktrees = testDisposables.add(new Emitter<void>());
	const worktrees = new Map<string, IParadisWorktree[]>();
	const onDidDisposeGroup = testDisposables.add(new Emitter<ITerminalGroup>());
	let setActiveTerminalGroup = (_group: ITerminalGroup): void => { };
	let activeTerminalGroup = (): ITerminalGroup | undefined => undefined;

	return {
		workspaceSwitchService,
		configurationService,
		storageService,
		layoutService,
		safeDisposedTerminalIds,
		parkedGroups,
		persistedNonceScopes(): readonly (readonly [string, string])[] {
			const raw = storageService.get('paradis.workspaceSwitch.terminalScopesByNonce', StorageScope.WORKSPACE);
			const parsed = raw === undefined ? new Map<string, string>() : (paradisParseTerminalNonceScopeStorage(raw) ?? new Map<string, string>());
			return [...parsed].sort(([left], [right]) => left.localeCompare(right));
		},
		fireGroupsChanged: () => onDidChangeGroups.fire(),
		fireInstancesChanged: () => onDidChangeInstances.fire(),
		setActiveTerminalGroup: group => setActiveTerminalGroup(group),
		activeTerminalGroup: () => activeTerminalGroup(),
		finishConnecting: () => deferredConnection.complete(),
		markTerminalsConnected: () => {
			connectionState = TerminalConnectionState.Connected;
			onDidChangeConnectionState.fire();
		},
		addWorktree: (repositoryId: string, path: string) => {
			const existing = worktrees.get(repositoryId) ?? [];
			existing.push({ repositoryId, name: path, uri: URI.file(path), missing: false } satisfies Partial<IParadisWorktree> as unknown as IParadisWorktree);
			worktrees.set(repositoryId, existing);
			onDidChangeWorktrees.fire();
		},
		addGroup: (group: ITerminalGroup) => {
			liveGroups.push(group);
			onDidChangeGroups.fire();
		},
		notifications,
		disposeGroup: (group: ITerminalGroup) => onDidDisposeGroup.fire(group),
		editorScopeService,
		parts,
		terminalEditorService,
		detachedTerminalInstanceIds,
		installTerminalScope(onOpenEditor: (instance: ITerminalInstance, location?: TerminalEditorLocation) => Promise<void>, options: IParadisTerminalScopeHarnessOptions = {}): ParadisTerminalWorkspaceScope {
			onOpenTerminalEditor = onOpenEditor;
			const terminalGroupService = Object.create(TerminalGroupService.prototype) as TerminalGroupService;
			const groups = liveGroups;
			liveGroups.push(...(options.groups ?? []));
			let activeGroup: ITerminalGroup | undefined = groups[0];
			Object.defineProperties(terminalGroupService, {
				groups: { get: () => groups.filter(group => !parkedGroups.has(group)) },
				activeGroup: {
					get: () => activeGroup,
					set: (group: ITerminalGroup | undefined) => {
						activeGroup = group;
						onDidChangeActiveGroup.fire(group);
					},
				},
				paradisParkedGroups: { get: () => [...parkedGroups] },
				onDidChangeGroups: { value: onDidChangeGroups.event },
				onDidChangeActiveGroup: { value: onDidChangeActiveGroup.event },
				onDidDisposeGroup: { value: onDidDisposeGroup.event },
				paradisParkGroup: { value: (group: ITerminalGroup) => { parkedGroups.add(group); } },
				paradisUnparkGroup: {
					value: (group: ITerminalGroup) => {
						parkedGroups.delete(group);
						// 実物も groups へ戻した後の付け直し（attachToElement）で落ちる。
						if (options.failingUnparks?.has(group)) {
							throw new Error('unpark failed');
						}
						// 実物は復帰後に見えるグループが1件になった時点で `setActiveGroupByIndex(0, true)`
						// を呼び、`onDidChangeActiveGroup` を発火する。この副作用が active group 台帳を
						// 上書きしうるので、ハーネスでも再現する（省くと復元のリグレッションを検知できない）。
						const visible = groups.filter(candidate => !parkedGroups.has(candidate));
						if (visible.length === 1) {
							terminalGroupService.activeGroup = visible[0];
						}
					},
				},
			});
			setActiveTerminalGroup = group => { terminalGroupService.activeGroup = group; };
			activeTerminalGroup = () => terminalGroupService.activeGroup;
			for (const instance of options.editorInstances ?? []) {
				terminals.push(instance);
			}
			if (options.persistentProcessScopes !== undefined) {
				storageService.store(
					'paradis.workspaceSwitch.terminalRepositories',
					JSON.stringify(options.persistentProcessScopes.map(([persistentProcessId, repositoryId]) => ({ persistentProcessId, repositoryId }))),
					StorageScope.WORKSPACE,
					StorageTarget.MACHINE,
				);
			}
			// `connectionState` は後から Connected へ動かせるようにする。`whenConnected` が
			// 永久 pending でも接続完了だけが先に来る（リモートの実際の順序）を再現するため。
			connectionState = options.connectionState ?? TerminalConnectionState.Connecting;
			const terminalService = {
				// スナップショットにしない。グループを足したり分割したりした後の検査で嘘をつく。
				get instances() { return groups.flatMap(group => group.terminalInstances); },
				whenConnected: options.connectLater === true
					? deferredConnection.p
					: (options.connected === true ? Promise.resolve() : new Promise<void>(() => { })),
				get connectionState() { return connectionState; },
				onDidChangeInstances: onDidChangeInstances.event,
				onDidChangeConnectionState: onDidChangeConnectionState.event,
				onAnyInstanceProcessIdReady: Event.None,
				safeDisposeTerminal: async (instance: ITerminalInstance) => { safeDisposedTerminalIds.push(instance.instanceId); },
			} satisfies Partial<ITerminalService> as unknown as ITerminalService;
			const worktreeService = {
				initializationBarrier: options.worktreeReady === true ? Promise.resolve() : new Promise<void>(() => { }),
				onDidChangeWorktrees: onDidChangeWorktrees.event,
				getWorktrees: (repositoryId: string) => worktrees.get(repositoryId) ?? [],
			} satisfies Partial<IParadisWorktreeService> as unknown as IParadisWorktreeService;
			const scope = new ParadisTerminalWorkspaceScope(
				terminalGroupService as unknown as ITerminalGroupService,
				terminalService,
				terminalEditorService as unknown as ITerminalEditorService,
				workspaceSwitchService,
				auxiliaryWindowScopeService as unknown as IParadisAuxiliaryWindowScopeService,
				worktreeService,
				storageService,
				(options.terminalInstanceService ?? { getBackend: async () => undefined }) as ITerminalInstanceService,
				{ remoteAuthority: options.remoteAuthority } as IWorkbenchEnvironmentService,
				contextService,
				parts,
				new NullLogService(),
				notificationService,
				{ getConnection: () => null } as unknown as IRemoteAgentService,
				configurationService,
			);
			testDisposables.add(scope);
			return scope;
		},
		createEditor,
		addTerminal(input: TestFileEditorInput, instanceId: number, persistentProcessId: number | undefined, shellIntegrationNonce: string, startPty?: () => Promise<void>): ITerminalInstance {
			const onDisposed = testDisposables.add(new Emitter<ITerminalInstance>());
			const instance = {
				instanceId,
				persistentProcessId,
				shellIntegrationNonce,
				resource: input.resource,
				shouldPersist: true,
				isDisposed: false,
				onDisposed: onDisposed.event,
				get processReady() { return startPty?.() ?? Promise.resolve(); },
				dispose: () => onDisposed.fire(instance),
			} satisfies Partial<ITerminalInstance> as unknown as ITerminalInstance;
			terminals.push(instance);
			return instance;
		}
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ICreateTerminalOptions, ITerminalInstance } from '../../browser/terminal.js';
import { TerminalService } from '../../browser/terminalService.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { paradisGetTerminalCreationScopeLease, paradisRegisterTerminalCreationScopeProvider } from '../../browser/paradisTerminalCreationScope.js';
import { paradisResolveTerminalScopeCandidate } from '../../../../../paradis/contrib/workspaceSwitch/common/paradisTerminalProcessScope.js';

suite('Paradis TerminalService exact group integration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rechecks group identity after profilesReady and CWD async boundaries', async () => {
		for (const boundary of ['profilesReady', 'cwd'] as const) {
			const harness = createHarness();
			const deferred = new DeferredPromise<void>();
			if (boundary === 'profilesReady') {
				harness.availableProfiles.length = 0;
				harness.setProfilesReady(deferred.p);
			} else {
				harness.setResolveCwd(() => deferred.p);
			}

			const operation = harness.service.createTerminal(harness.options);
			harness.replaceGroup();
			deferred.complete();

			await assert.rejects(operation, /destination editor group is no longer available/i, boundary);
			assert.strictEqual(harness.createdInstances.length, 0, boundary);
		}
	});

	test('fails closed before launching a contributed profile', async () => {
		const harness = createHarness();
		harness.setDefaultProfile({ extensionIdentifier: 'publisher.extension', id: 'profile' });
		harness.setContributedProfile({ extensionIdentifier: 'publisher.extension', id: 'profile' });

		await assert.rejects(
			harness.service.createTerminal(harness.options),
			/Contributed terminal profiles cannot be opened with an exact editor group destination/,
		);
		assert.strictEqual(harness.contributedLaunches, 0);
		assert.strictEqual(harness.createdInstances.length, 0);
	});

	test('uses the built-in default when the exact caller skips contributed profile resolution', async () => {
		const harness = createHarness();
		harness.setDefaultProfile({ profileName: 'built-in' });
		harness.setContributedProfile({ extensionIdentifier: 'publisher.extension', id: 'profile' });

		const instance = await harness.service.createTerminal({
			...harness.options,
			skipContributedProfileCheck: true,
		});

		assert.strictEqual(instance, harness.createdInstances[0]);
		assert.strictEqual(harness.contributedLaunches, 0);
	});

	test('disposes the newly-created instance when exact editor open fails', async () => {
		const harness = createHarness();
		harness.setOpenEditor(() => Promise.reject(new Error('open failed')));

		await assert.rejects(harness.service.createTerminal(harness.options), /open failed/);
		assert.strictEqual(harness.createdInstances.length, 1);
		assert.strictEqual(harness.createdInstances[0].isDisposed, true);
	});

	test('keeps ordinary editor creation fire-and-forget while its editor open is pending', async () => {
		const harness = createHarness();
		const openStarted = new DeferredPromise<void>();
		const openGate = new DeferredPromise<void>();
		harness.setOpenEditor(() => {
			openStarted.complete();
			return openGate.p;
		});

		let created: ITerminalInstance | undefined;
		const operation = harness.service.createTerminal({ location: TerminalLocation.Editor });
		void operation.then(instance => created = instance);
		await openStarted.p;
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(created, harness.createdInstances[0]);
		assert.strictEqual(created?.isDisposed, false);
		openGate.complete();
	});

	test('keeps the scope captured before profiles and CWD waits when the active scope changes', async () => {
		const harness = createHarness();
		const profilesGate = new DeferredPromise<void>();
		const cwdGate = new DeferredPromise<void>();
		harness.availableProfiles.length = 0;
		harness.setProfilesReady(profilesGate.p);
		harness.setResolveCwd(() => cwdGate.p);
		let activeStateKey = 'scope:A';
		const registration = paradisRegisterTerminalCreationScopeProvider(() => activeStateKey);
		try {
			const operation = harness.service.createTerminal({ location: TerminalLocation.Editor });
			activeStateKey = 'scope:B';
			profilesGate.complete();
			cwdGate.complete();

			const instance = await operation;
			const capturedStateKey = paradisGetTerminalCreationScopeLease(instance.shellLaunchConfig);
			assert.strictEqual(capturedStateKey, 'scope:A');
			assert.deepStrictEqual(paradisResolveTerminalScopeCandidate({
				initialCwdResolved: true,
				worktreeSnapshotReady: true,
				activeStateKeyCandidate: capturedStateKey ?? activeStateKey,
			}), { status: 'resolved', stateKey: 'scope:A' });
		} finally {
			registration.dispose();
		}
	});

	test('re-associates a reused launch config when concurrent CWD waits complete out of order', async () => {
		const harness = createHarness();
		const firstCwdGate = new DeferredPromise<void>();
		const secondCwdGate = new DeferredPromise<void>();
		let cwdResolutionCount = 0;
		harness.setResolveCwd(() => ++cwdResolutionCount === 1 ? firstCwdGate.p : secondCwdGate.p);
		let activeStateKey = 'scope:A';
		const registration = paradisRegisterTerminalCreationScopeProvider(() => activeStateKey);
		const sharedConfig = {};
		try {
			const first = harness.service.createTerminal({ config: sharedConfig, location: TerminalLocation.Editor });
			activeStateKey = 'scope:B';
			const second = harness.service.createTerminal({ config: sharedConfig, location: TerminalLocation.Editor });

			secondCwdGate.complete();
			const secondInstance = await second;
			assert.strictEqual(paradisGetTerminalCreationScopeLease(secondInstance.shellLaunchConfig), 'scope:B');

			firstCwdGate.complete();
			const firstInstance = await first;
			assert.strictEqual(paradisGetTerminalCreationScopeLease(firstInstance.shellLaunchConfig), 'scope:A');
		} finally {
			registration.dispose();
		}
	});
});

function createHarness(): {
	service: TerminalService;
	options: ICreateTerminalOptions;
	availableProfiles: unknown[];
	createdInstances: ITerminalInstance[];
	readonly contributedLaunches: number;
	replaceGroup(): void;
	setProfilesReady(value: Promise<void>): void;
	setResolveCwd(value: () => Promise<void>): void;
	setDefaultProfile(value: unknown): void;
	setContributedProfile(value: unknown): void;
	setOpenEditor(value: () => Promise<void>): void;
} {
	const group = { id: 31 } as IEditorGroup;
	let liveGroup = group;
	let profilesReady: Promise<void> = Promise.resolve();
	let resolveCwd = () => Promise.resolve();
	let defaultProfile: unknown = {};
	let contributedProfile: unknown;
	let openEditor = () => Promise.resolve();
	let contributedLaunches = 0;
	const availableProfiles: unknown[] = [{}];
	const createdInstances: ITerminalInstance[] = [];
	const service = Object.create(TerminalService.prototype) as TerminalService;
	const internals = service as unknown as Record<string, unknown>;

	internals._editorGroupsService = { getGroup: () => liveGroup };
	internals._remoteAgentService = { getConnection: () => null };
	internals._terminalProfileService = {
		availableProfiles,
		get profilesReady() { return profilesReady; },
		getDefaultProfile: () => defaultProfile,
		getContributedDefaultProfile: () => contributedProfile,
		contributedProfiles: [],
	};
	internals._terminalInstanceService = {
		convertProfileToShellLaunchConfig: (shellLaunchConfig: object) => shellLaunchConfig,
		createInstance: (shellLaunchConfig: object) => {
			let disposed = false;
			const instance = {
				instanceId: createdInstances.length + 1,
				shellLaunchConfig,
				get isDisposed() { return disposed; },
				dispose: () => { disposed = true; },
			} as Partial<ITerminalInstance> as ITerminalInstance;
			createdInstances.push(instance);
			return instance;
		},
	};
	internals._terminalConfigurationService = { defaultLocation: TerminalLocation.Editor };
	internals._processSupportContextKey = { get: () => true };
	internals._environmentService = { isSessionsWindow: false };
	internals._contextKeyService = {};
	internals._terminalEditorService = { openEditor: () => openEditor() };
	internals._terminalGroupService = {};
	internals._terminalHasBeenCreated = { set() { } };
	internals._extensionService = { activateByEvent() { } };
	internals._connectionState = 2;
	internals._resolveCwd = () => resolveCwd();
	internals.createContributedTerminalProfile = async () => { contributedLaunches++; };

	return {
		service,
		options: { location: { viewColumn: group.id }, paradisExactEditorGroup: group },
		availableProfiles,
		createdInstances,
		get contributedLaunches() { return contributedLaunches; },
		replaceGroup: () => { liveGroup = { id: group.id } as IEditorGroup; },
		setProfilesReady: value => { profilesReady = value; },
		setResolveCwd: value => { resolveCwd = value; },
		setDefaultProfile: value => { defaultProfile = value; },
		setContributedProfile: value => { contributedProfile = value; },
		setOpenEditor: value => { openEditor = value; },
	};
}

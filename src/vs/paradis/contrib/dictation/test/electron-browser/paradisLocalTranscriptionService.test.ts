/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationError } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILocalTranscriptionService } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { IUtilityProcessWorkerProcess } from '../../../../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { INativeWorkbenchEnvironmentService } from '../../../../../workbench/services/environment/electron-browser/environmentService.js';
// upstream の登録（Foundry Local）→ Para の登録の順に読む。workbench.desktop.main.ts の中の順と同じ
// （upstream は :64、Para の集約 paradis.electron-browser.contribution.ts は後ろの方。順は build/next/test/paradisSpeechOverride.test.ts が見張る）。
import { LocalTranscriptionService } from '../../../../../workbench/services/localTranscription/electron-browser/localTranscriptionService.js';
import { IUtilityProcessWorkerWorkbenchService } from '../../../../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { ParadisLocalTranscriptionService } from '../../electron-browser/paradisLocalTranscriptionService.js';

/** OS だけを Mac にしたもの（テストを動かす機械の OS に依らず、補助プログラムの確かめを通す）。 */
class MacParadisLocalTranscriptionService extends ParadisLocalTranscriptionService {
	protected override get hostPlatform(): string {
		return 'darwin';
	}
}

/** 登録されている既定値の上書きのうち、`dictation.enabled` を false にするものの数（ほかのテストが読んだ集約の分も数える）。 */
function dictationOffDefaults(): number {
	return Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getRegisteredDefaultConfigurations().filter(defaults => defaults.overrides['dictation.enabled'] === false).length;
}

suite('Paradis local transcription service', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('is registered after upstream, so the workbench builds the Para implementation', () => {
		// workbench.ts は登録の順に serviceCollection.set するので、最後の登録が使われる
		const registered = getSingletonServiceDescriptors().filter(([id]) => id === ILocalTranscriptionService).map(([, descriptor]) => descriptor.ctor);
		assert.deepStrictEqual({
			upstreamRegistered: registered.includes(LocalTranscriptionService),
			last: registered[registered.length - 1] === ParadisLocalTranscriptionService,
		}, { upstreamRegistered: true, last: true });
	});

	function create(release: string, existing: readonly string[] = []) {
		const workers: IUtilityProcessWorkerProcess[] = [];
		const checked: string[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(INativeWorkbenchEnvironmentService, { os: { release, hostname: 'test', arch: 'arm64' }, appRoot: '/Applications/Para Code.app/Contents/Resources/app', isBuilt: true });
		instantiationService.stub(IFileService, {
			exists: async (resource: URI) => {
				checked.push(resource.path);
				return existing.includes(resource.path);
			},
		});
		instantiationService.stub(IUtilityProcessWorkerWorkbenchService, {
			createWorker: async (process: IUtilityProcessWorkerProcess) => {
				workers.push(process);
				throw new CancellationError();
			},
		});
		// IConfigurationService・IProductService（upstream の Foundry 向けのプロキシと dictationRuntime の読み先）は渡さない
		const service = disposables.add(instantiationService.createInstance(MacParadisLocalTranscriptionService));
		return { service, workers, checked };
	}

	test('starts the Para speech process, never the Foundry Local one, and refuses the Foundry model import', async () => {
		const { service, workers } = create('25.0.0');
		await assert.rejects(service.start({ cacheDir: '/tmp/models', model: 'nemotron-3.5-asr-streaming-0.6b', language: 'ja-JP', runtimeUrlTemplate: 'https://example.com/{target}.tgz' }));
		await assert.rejects(service.importModel({ sourcePath: '/tmp/pack.zip', cacheDir: '/tmp/models' }));
		assert.deepStrictEqual({ workers }, {
			workers: [{ moduleId: 'vs/paradis/contrib/dictation/node/paradisSpeechEngineMain', type: 'paradisSpeechEngine', name: 'paradis-speech' }],
		});
	});

	test('checks the packaged helper once at startup and turns dictation off by default when it is missing', async () => {
		const helper = '/Applications/Para Code.app/Contents/Helpers/ParadisSpeech';
		const before = dictationOffDefaults();
		const present = create('25.0.0', [helper]);
		const tooOld = create('24.6.0');
		const missing = create('25.0.0');
		await Promise.all([present.service.whenHelperChecked, tooOld.service.whenHelperChecked, missing.service.whenHelperChecked]);
		const whileMissing = dictationOffDefaults() - before;
		missing.service.dispose();
		assert.deepStrictEqual({
			present: { supported: present.service.isSupported, checked: present.checked, message: present.service.unavailableMessage },
			tooOld: { supported: tooOld.service.isSupported, checked: tooOld.checked, hasMessage: typeof tooOld.service.unavailableMessage },
			missing: { supported: missing.service.isSupported, checked: missing.checked, hasMessage: typeof missing.service.unavailableMessage },
			whileMissing,
			afterDispose: dictationOffDefaults() - before,
		}, {
			present: { supported: true, checked: [helper], message: undefined },
			tooOld: { supported: false, checked: [], hasMessage: 'string' },
			missing: { supported: false, checked: [helper], hasMessage: 'string' },
			// 既定値の層だけを変える（利用者が自分で設定した値はそのまま効く）
			whileMissing: 1,
			afterDispose: 0,
		});
	});
});

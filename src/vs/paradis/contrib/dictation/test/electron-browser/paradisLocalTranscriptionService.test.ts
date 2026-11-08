/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationError } from '../../../../../base/common/errors.js';
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

	function create(release: string) {
		const workers: IUtilityProcessWorkerProcess[] = [];
		const instantiationService = disposables.add(new TestInstantiationService());
		instantiationService.stub(INativeWorkbenchEnvironmentService, { os: { release, hostname: 'test', arch: 'arm64' } });
		instantiationService.stub(IUtilityProcessWorkerWorkbenchService, {
			createWorker: async (process: IUtilityProcessWorkerProcess) => {
				workers.push(process);
				throw new CancellationError();
			},
		});
		// IConfigurationService・IProductService（upstream の Foundry 向けのプロキシと dictationRuntime の読み先）は渡さない
		const service = disposables.add(instantiationService.createInstance(ParadisLocalTranscriptionService));
		return { service, workers };
	}

	test('starts the Para speech process, never the Foundry Local one, and refuses the Foundry model import', async () => {
		const { service, workers } = create('25.0.0');
		await assert.rejects(service.start({ cacheDir: '/tmp/models', model: 'nemotron-3.5-asr-streaming-0.6b', language: 'ja-JP', runtimeUrlTemplate: 'https://example.com/{target}.tgz' }));
		await assert.rejects(service.importModel({ sourcePath: '/tmp/pack.zip', cacheDir: '/tmp/models' }));
		// isSupported（macOS 26 以上の Mac だけ）は common の paradisSpeechEngineAvailability のテストで見る
		assert.deepStrictEqual({ workers }, {
			workers: [{ moduleId: 'vs/paradis/contrib/dictation/node/paradisSpeechEngineMain', type: 'paradisSpeechEngine', name: 'paradis-speech' }],
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// upstream の ILocalTranscriptionService（音声入力の認識の中身）を Para の実装に差し替える。
//
// upstream の登録は workbench.desktop.main.ts の localTranscriptionService の import（Foundry Local を
// utility process で動かすもの）。Para の集約（paradis.electron-browser.contribution.ts）は同じファイルの
// 後ろの方で読まれるので、ここの registerSingleton が後から登録される。workbench.ts は登録の順に
// serviceCollection.set するので、後から登録したものが勝つ（paradisContextMenuService と同じ差し替え方）。
//
// この実装は upstream の部品（Foundry Local の SDK・`product.dictationRuntime` の URL・
// localTranscriptionMain）を一切使わない。認識は Para の utility process（paradisSpeechEngineMain）から
// 起動する補助プログラムが行う。

import { getDelayedChannel, IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { platform } from '../../../../base/common/process.js';
import { localize } from '../../../../nls.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILocalTranscriptionModelImportResult, ILocalTranscriptionModelStatus, ILocalTranscriptionResult, ILocalTranscriptionService } from '../../../../platform/localTranscription/common/localTranscription.js';
import { INativeWorkbenchEnvironmentService } from '../../../../workbench/services/environment/electron-browser/environmentService.js';
import { IUtilityProcessWorker, IUtilityProcessWorkerWorkbenchService } from '../../../../workbench/services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js';
import { IParadisSpeechEngine, PARADIS_SPEECH_ENGINE_CHANNEL, PARADIS_SPEECH_ENGINE_MODULE_ID, paradisSpeechEngineAvailability, paradisSpeechHelperLocale } from '../common/paradisSpeechEngine.js';

export class ParadisLocalTranscriptionService extends Disposable implements ILocalTranscriptionService {

	declare readonly _serviceBrand: undefined;

	/** macOS 26 以上の Mac だけ。false だと upstream はマイクを出さない（音声入力の入口が閉じる）。 */
	readonly isSupported: boolean;

	private readonly _onDidChangeModelStatus = this._register(new Emitter<ILocalTranscriptionModelStatus>());
	readonly onDidChangeModelStatus = this._onDidChangeModelStatus.event;

	private readonly _onDidTranscribe = this._register(new Emitter<ILocalTranscriptionResult>());
	readonly onDidTranscribe = this._onDidTranscribe.event;

	private readonly worker = this._register(new MutableDisposable<IUtilityProcessWorker>());
	private readonly workerEvents = this._register(new DisposableStore());
	private channel: IChannel | undefined;
	private proxy: IParadisSpeechEngine | undefined;
	private workerGeneration = 0;

	constructor(
		@IUtilityProcessWorkerWorkbenchService private readonly utilityProcessWorkerWorkbenchService: IUtilityProcessWorkerWorkbenchService,
		@INativeWorkbenchEnvironmentService environmentService: INativeWorkbenchEnvironmentService,
	) {
		super();
		this.isSupported = paradisSpeechEngineAvailability(platform, environmentService.os.release) === 'available';
	}

	private getProxy(): IParadisSpeechEngine {
		if (!this.proxy) {
			this.channel = getDelayedChannel(this.createWorkerChannel(this.workerGeneration));
			this.proxy = ProxyChannel.toService<IParadisSpeechEngine>(this.channel, { disableMarshalling: true });
		}
		return this.proxy;
	}

	private async createWorkerChannel(generation: number): Promise<IChannel> {
		const worker = await this.utilityProcessWorkerWorkbenchService.createWorker({
			moduleId: PARADIS_SPEECH_ENGINE_MODULE_ID,
			type: 'paradisSpeechEngine',
			name: 'paradis-speech',
		});
		if (generation !== this.workerGeneration || this._store.isDisposed) {
			worker.dispose();
			throw new CancellationError();
		}
		this.worker.value = worker;
		const channel = worker.client.getChannel(PARADIS_SPEECH_ENGINE_CHANNEL);
		const proxy = ProxyChannel.toService<IParadisSpeechEngine>(channel, { disableMarshalling: true });
		this.workerEvents.clear();
		this.workerEvents.add(proxy.onDidChangeModelStatus(status => this._onDidChangeModelStatus.fire(status)));
		this.workerEvents.add(proxy.onDidTranscribe(result => this._onDidTranscribe.fire(result)));
		void worker.onDidTerminate.then(() => {
			if (this.worker.value === worker) {
				this.resetWorker();
			}
		});
		return channel;
	}

	private resetWorker(): void {
		this.workerGeneration++;
		this.channel = undefined;
		this.proxy = undefined;
		this.workerEvents.clear();
		this.worker.clear();
	}

	getModelStatus(): Promise<ILocalTranscriptionModelStatus> {
		return this.getProxy().getModelStatus();
	}

	/** upstream の Foundry のモデルの取り込み。Para の音声入力はモデルを取り込まない（言語データは OS が持つ）。 */
	async importModel(_options: Parameters<ILocalTranscriptionService['importModel']>[0]): Promise<ILocalTranscriptionModelImportResult> {
		throw new Error(localize('paradisSpeech.importUnsupported', "Para Code の音声入力は macOS の音声認識を使うため、モデルの取り込みは要りません。"));
	}

	/** upstream の引数のうち `language` だけを使う（`cacheDir`・プロキシ・`runtimeUrlTemplate` は Foundry 向けなので見ない）。 */
	start(options: Parameters<ILocalTranscriptionService['start']>[0]): Promise<void> {
		return this.getProxy().start({ locale: paradisSpeechHelperLocale(options.language) });
	}

	pushAudio(chunk: Parameters<ILocalTranscriptionService['pushAudio']>[0]): Promise<void> {
		return this.getProxy().pushAudio(chunk);
	}

	stop(): Promise<string> {
		return this.getProxy().stop();
	}

	async cancel(): Promise<void> {
		if (this.proxy) {
			await this.proxy.cancel();
		}
	}
}

registerSingleton(ILocalTranscriptionService, ParadisLocalTranscriptionService, InstantiationType.Delayed);

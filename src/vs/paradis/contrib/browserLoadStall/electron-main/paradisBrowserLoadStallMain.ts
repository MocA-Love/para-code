/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの「まだ応答がありません」の main 側の窓口（app.ts に登録を1行足す方式）。
// renderer へは、質問の出し入れのイベントと、今の質問の取得・答えの3つだけを見せる。
// 見張りが止まった回を終わったときに Sentry へ1件送る配線もここに置く（platform から vs/paradis を
// import しないよう、見張りには送り先を差し込むだけにしてある）。

import * as electron from 'electron';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ParaBrowserViewLoadStallResponse } from '../../../../platform/browserView/common/paraBrowserViewLoadStall.js';
import { IParaBrowserViewLoadStallReporter, ParaBrowserViewLoadWatchdogWebContents, paraGetBrowserViewLoadStall, paraOnDidChangeBrowserViewLoadStall, paraRespondToBrowserViewLoadStall, paraSetBrowserViewLoadStallReporter } from '../../../../platform/browserView/electron-main/paraBrowserViewLoadWatchdog.js';
import { captureParadisDiagnosticMessage } from '../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisBrowserLoadStallChange, PARADIS_BROWSER_LOAD_STALL_CHANNEL, paradisBuildBrowserLoadStallEvent } from '../common/paradisBrowserLoadStall.js';

const KB_PER_MB = 1024;

/** 止まった時点のメモリ（MB）。取れない数字は入れない。 */
function sampleMemory(webContents: ParaBrowserViewLoadWatchdogWebContents): Record<string, number> {
	const sample: Record<string, number> = {};
	try {
		sample.safe_main_rss_mb = process.memoryUsage().rss / (1024 * 1024);
	} catch {
		// 取れなくても送る。
	}
	try {
		const system = process.getSystemMemoryInfo();
		sample.safe_system_free_mb = system.free / KB_PER_MB;
		sample.safe_system_total_mb = system.total / KB_PER_MB;
	} catch {
		// 同上。
	}
	try {
		const metrics = electron.app.getAppMetrics();
		let total = 0;
		for (const metric of metrics) {
			total += metric.memory.workingSetSize;
		}
		sample.safe_app_memory_mb = total / KB_PER_MB;
		const pid = webContents.isDestroyed() ? undefined : webContents.getOSProcessId();
		const page = metrics.find(metric => metric.pid === pid);
		if (page) {
			sample.safe_page_memory_mb = page.memory.workingSetSize / KB_PER_MB;
		}
	} catch {
		// 同上。
	}
	return sample;
}

const sentryReporter: IParaBrowserViewLoadStallReporter = {
	sample: sampleMemory,
	report: facts => {
		const event = paradisBuildBrowserLoadStallEvent(facts);
		captureParadisDiagnosticMessage('browser-load', event.operation, event.tags, { name: 'para.browser_load', data: event.data }, 'warning');
	},
};

/** renderer に見せるチャネル。受け付けるのは `onDidChange` の購読と `get` / `respond` だけ。 */
export class ParadisBrowserLoadStallChannel implements IServerChannel<string> {

	listen<T>(_ctx: string, event: string): Event<T> {
		if (event === 'onDidChange') {
			return Event.map(paraOnDidChangeBrowserViewLoadStall, (change): IParadisBrowserLoadStallChange => ({ viewId: change.viewId, stall: change.stall })) as Event<T>;
		}
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		const viewId = args[0];
		if (typeof viewId !== 'string' || viewId.length === 0) {
			throw new Error('A view id is required.');
		}
		switch (command) {
			case 'get':
				return paraGetBrowserViewLoadStall(viewId) as T;
			case 'respond': {
				const response = args[1];
				if (response !== 'wait' && response !== 'stop') {
					throw new Error('Unknown response.');
				}
				return paraRespondToBrowserViewLoadStall(viewId, response satisfies ParaBrowserViewLoadStallResponse) as T;
			}
		}
		throw new Error(`Call not found: ${command}`);
	}
}

/** app.ts から呼ぶ。チャネルを登録し、止まった回を Sentry へ送る配線をつなぐ。 */
export function paradisRegisterBrowserLoadStall(channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void }): IDisposable {
	paraSetBrowserViewLoadStallReporter(sentryReporter);
	channelHost.registerChannel(PARADIS_BROWSER_LOAD_STALL_CHANNEL, new ParadisBrowserLoadStallChannel());
	return toDisposable(() => paraSetBrowserViewLoadStallReporter(undefined));
}

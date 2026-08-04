/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 定期ヘルスビーコンのウィンドウ側。main から要求が来たときだけ自分の状態を申告する。
//
// タイマーを持たないのは意図的。表示に関係しない計測をウィンドウごとに常時回すと、
// 「メモリ調査のための仕組みが常駐コストを増やす」という本末転倒になる。

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { process } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import {
	IParadisHealthBeaconMainService,
	IParadisHealthWindowReport,
	PARADIS_HEALTH_BEACON_CHANNEL,
} from '../common/paradisHealthBeacon.js';

/**
 * `performance.memory` は標準化されていないため lib の型に無い。
 * Chromium が粗く丸めた値しか返さないが、桁の異変を見るには足りる。
 */
interface IParadisPerformanceWithMemory {
	readonly memory?: {
		readonly usedJSHeapSize: number;
		readonly totalJSHeapSize: number;
		readonly jsHeapSizeLimit: number;
	};
}

/**
 * 生きているDOM要素数。レンダラー肥大の粗い指標。
 *
 * セレクタを使わないのは、この用途では「何が居るか」ではなく「いくつ居るか」しか要らないため
 * （codebase のガイドラインもセレクタ依存を避ける方針）。1時間に1回・数千要素の走査なので軽い。
 */
function countParadisDomElements(): number {
	const walker = mainWindow.document.createTreeWalker(mainWindow.document.documentElement, NodeFilter.SHOW_ELEMENT);
	let count = 1;
	while (walker.nextNode()) {
		count++;
	}
	return count;
}

class ParadisHealthBeaconContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.healthBeacon';

	private readonly beaconService: IParadisHealthBeaconMainService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.beaconService = ProxyChannel.toService<IParadisHealthBeaconMainService>(mainProcessService.getChannel(PARADIS_HEALTH_BEACON_CHANNEL));
		this._register(this.beaconService.onDidRequestReport(() => void this.report()));
	}

	private async report(): Promise<void> {
		try {
			await this.beaconService.reportWindow(await this.collect());
		} catch {
			/* 申告できなくても本体には影響させない */
		}
	}

	private async collect(): Promise<IParadisHealthWindowReport> {
		const memory = (performance as unknown as IParadisPerformanceWithMemory).memory;

		let privateMemory = 0;
		let residentMemory = 0;
		try {
			// Electron の ProcessMemoryInfo はKB単位。macOS では residentSet が返らないので private を主に見る。
			const info = await process.getProcessMemoryInfo();
			privateMemory = (info.private ?? 0) * 1024;
			residentMemory = (info.residentSet ?? 0) * 1024;
		} catch {
			/* 取れない環境では0のまま送る */
		}

		return {
			windowId: this.nativeHostService.windowId,
			jsHeapUsed: memory?.usedJSHeapSize ?? 0,
			jsHeapTotal: memory?.totalJSHeapSize ?? 0,
			jsHeapLimit: memory?.jsHeapSizeLimit ?? 0,
			privateMemory,
			residentMemory,
			domElements: countParadisDomElements(),
			terminals: this.terminalService.instances.length,
			editors: this.editorService.count,
		};
	}
}

registerWorkbenchContribution2(ParadisHealthBeaconContribution.ID, ParadisHealthBeaconContribution, WorkbenchPhase.AfterRestored);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルのブラウザのページ一覧を、モバイルで見ているスペースのページだけにする（browser.space.v1）。
// どのブラウザビューがどのスペースのものかは Renderer の IParadisBrowserScopeService だけが知っているので、
// このウィンドウの台帳を shared process（ミラーが居る所）へ送る。PC のブラウザ一覧
// （paradisBrowserLiveModel.ts）と同じく、切り替え中（どのビューも pending になる）は直前の台帳を保つ。

import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisBrowserScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisMobileBrowserScopeSnapshot, paradisMobileBrowserScopeSignature } from '../common/paradisMobileBrowserScope.js';

/** 連続する変化をまとめる待ち時間（ms）。 */
const SYNC_DELAY_MS = 100;
/** 受け取ってもらえなかったときに送り直すまでの待ち（ms）。 */
const RETRY_DELAY_MS = 5_000;
/**
 * 変化が無くても送り直す間隔（ms）。shared process が作り直されると台帳が消えるので、
 * それでも一覧が全件に戻ったままにならないようにする（送るのは小さな配列だけ）。
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * このウィンドウの「ブラウザビュー → スペース」の台帳を作り、変わったときだけ `send` で送る。
 * 受け取ってもらえなかった（shared process がまだこのウィンドウの lease を知らない等）ときは、少し置いて送り直す。
 */
export class ParadisMobileBrowserScopeSync extends Disposable {

	private readonly scheduler: RunOnceScheduler;
	private readonly retryScheduler: RunOnceScheduler;
	private lastSignature: string | undefined;

	constructor(
		private readonly send: (snapshot: IParadisMobileBrowserScopeSnapshot) => Promise<boolean>,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisBrowserScopeService private readonly browserScopeService: IParadisBrowserScopeService,
		@IParadisWorkspaceSwitchService private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();
		this.scheduler = this._register(new RunOnceScheduler(() => this.sync(), SYNC_DELAY_MS));
		this.retryScheduler = this._register(new RunOnceScheduler(() => this.resend(), RETRY_DELAY_MS));
		const refresh = this._register(new IntervalTimer());
		refresh.cancelAndSet(() => this.resend(), REFRESH_INTERVAL_MS);
		const schedule = () => this.scheduler.schedule();
		this._register(this.browserViewWorkbenchService.onDidChangeBrowserViews(schedule));
		this._register(this.browserScopeService.onDidChangeStableScope(schedule));
		this._register(this.workspaceSwitchService.onDidSwitchScope(schedule));
		this._register(this.workspaceSwitchService.onDidChangeRepositories(schedule));
		void this.browserScopeService.initializationBarrier.then(schedule, schedule);
		schedule();
	}

	private resend(): void {
		this.lastSignature = undefined;
		this.scheduler.schedule();
	}

	private sync(): void {
		if (this.workspaceSwitchService.isSwitching) {
			return; // 切り替えの完了（onDidSwitchScope）で組み直す
		}
		const snapshot = paradisCollectMobileBrowserScopes(
			this.browserViewWorkbenchService.getKnownBrowserViews().keys(),
			viewId => this.browserScopeService.resolveScope(viewId),
			this.workspaceSwitchService.isManagedWorkspaceWindow,
		);
		const signature = paradisMobileBrowserScopeSignature(snapshot);
		if (signature === this.lastSignature) {
			return;
		}
		this.lastSignature = signature;
		const retry = () => {
			if (this.lastSignature === signature) {
				this.retryScheduler.schedule();
			}
		};
		this.send(snapshot).then(accepted => {
			if (!accepted) {
				retry();
			}
		}, retry);
	}
}

/**
 * 台帳を作る。所属が決まっていない（pending）ビューは `stateKey` 無しで載せる
 * （スペースのウィンドウでは、どのスペースの一覧にも出ない）。
 */
export function paradisCollectMobileBrowserScopes(
	viewIds: Iterable<string>,
	resolveScope: (viewId: string) => { readonly kind: string; readonly stateKey?: string },
	managed: boolean,
): IParadisMobileBrowserScopeSnapshot {
	const views: { viewId: string; stateKey?: string }[] = [];
	for (const viewId of viewIds) {
		const scope = resolveScope(viewId);
		views.push(scope.kind === 'managed' && scope.stateKey !== undefined ? { viewId, stateKey: scope.stateKey } : { viewId });
	}
	return { managed, views };
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// webview の service worker が「起動を終えられない」ことを main プロセス側から観測する。
//
// なぜ main でしか取れないのか:
// 壊れているとき、ページから見えるのは「registration はあるが installing/waiting/active が
// すべて空」までで、理由は一切見えない。実機を CDP で覗くと Chromium 側の版は
// `status=new / runningStatus=starting` のまま止まっており、worker がスクリプトの起動を
// 終えられていない。この状態はページの API には表れないため、webview 側の health signal を
// いくら増やしても原因には届かない（実際に増やして届かなかった）。
//
// 観測に何を使うか（ここを間違えると「壊れた時だけ何も出ない」監視になる）:
//  - `running-status-changed` … `starting` / `running` / `stopping` / `stopped` を区別して通知する
//    唯一の入口。**狙っている `starting` で止まる版は、これでしか捕まえられない**
//  - `getAllRunning()` は名前のとおり *running* のものだけを返す。`starting` は含まれないので、
//    ここを起点にすると本命を取りこぼす
//  - `getInfoFromVersionID()` は「存在しない、または running でない」と**例外を投げる**。
//    起動中の worker のログを解決しようとすると必ずここで落ちるので、
//    `getWorkerFromVersionID()`（`stopped` になるまで有効）を使う
//
// これは診断専用で、service worker には一切手を触れない。実測で分かっているとおり、この状態の
// registration に `unregister()` を投げると返ってこず、ジョブキューを塞いで悪化させるため。

import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { type ParadisDiagnosticReporter, reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/** この時間 `starting` のままなら、起動が終わらないと見なす。 */
const PARADIS_SW_STUCK_THRESHOLD_MS = 20_000;

/** `starting` のまま居座っていないかを見にいく間隔。 */
const PARADIS_SW_POLL_INTERVAL_MS = 5_000;

/**
 * 1回の起動で送る「止まっている」報告の上限。
 *
 * Sentry 側にも指紋ごとのレート制限（10分あたり3件）があるので実効上限はそちらで決まるが、
 * 上限に達したらポーリング自体を止めるための目安として持つ。
 */
const PARADIS_SW_MAX_STUCK_REPORTS = 20;

/** `console-message` の level（0..3）を読める名前へ。 */
const PARADIS_SW_LEVEL_NAMES = ['verbose', 'info', 'warning', 'error'];

/**
 * 起動が止まる理由に関係し得る `source` だけを拾う。
 *
 * `console-api`（worker スクリプト自身の `console.*`）は日常的に出る。webview の破棄中や
 * 再読み込み中に client id が失効すると `service-worker.js` が error を出すのは想定内の分岐で、
 * これを送ると Sentry の指紋ごとのレート制限を良性のログで食い潰し、**本命が届かなくなる**。
 */
const PARADIS_SW_INTERESTING_SOURCES = new Set(['network', 'javascript', 'security', 'worker', 'other']);

/** 時刻の取得と監視間隔の所有権を、main プロセスとテストで同じ形に揃える。 */
export interface IParadisWebviewServiceWorkerWatchClock {
	now(): number;
	setInterval(callback: () => void, delay: number): IDisposable;
}

/** 監視対象と診断出力を、起動時の既定値を保ったまま差し替えるための依存性。 */
export interface IParadisWebviewServiceWorkerWatchDependencies {
	readonly eventSource?: Electron.ServiceWorkers;
	readonly reporter?: ParadisDiagnosticReporter;
	readonly clock?: IParadisWebviewServiceWorkerWatchClock;
}

const defaultWatchClock: IParadisWebviewServiceWorkerWatchClock = {
	now: () => Date.now(),
	setInterval: (callback, delay) => {
		const handle = setInterval(callback, delay);
		return toDisposable(() => clearInterval(handle));
	},
};

function isWebviewScope(value: string | undefined): boolean {
	return typeof value === 'string' && value.startsWith('vscode-webview://');
}

/** origin だけを取り出す。解釈できない値はキー空間を汚さないよう固定値へ寄せる。 */
function originOf(value: string | undefined): string {
	if (value === undefined) {
		return 'unresolved';
	}
	try {
		return new URL(value).host;
	} catch {
		return 'unparsed';
	}
}

/**
 * webview の service worker を観測して、起動が止まったものと worker のログを Sentry へ送る。
 *
 * 監視するだけで何も変更しない。失敗しても起動を止めない（診断のために本体を壊さない）。
 */
export function paradisWatchWebviewServiceWorkers(targetSession: Electron.Session, logService: ILogService, dependencies: IParadisWebviewServiceWorkerWatchDependencies = {}): IDisposable {
	const store = new DisposableStore();
	try {
		const serviceWorkers = dependencies.eventSource ?? targetSession.serviceWorkers;
		const reporter = dependencies.reporter ?? reportParadisDiagnosticError;
		const clock = dependencies.clock ?? defaultWatchClock;
		/** versionId → `starting` になった時刻。`running` 以降へ進んだら外す。 */
		const startingSince = new Map<number, number>();
		/** 一度でも scope を解決できた worker。消えたら registration 削除と見なせる。 */
		const resolvedStartingScopes = new Map<number, string>();
		/** 一度でも `running` に到達した版。健全に立ち上がった証拠なので候補から外す。 */
		const everRan = new Set<number>();
		/** 報告済みの versionId。同じ worker を何度も送らない。 */
		const reportedVersions = new Set<number>();
		let stuckReports = 0;

		/** 起動中でも scope を引ける唯一の経路。`getInfoFromVersionID` は running でないと投げる。 */
		const scopeOf = (versionId: number): string | undefined => {
			try {
				return serviceWorkers.getWorkerFromVersionID?.(versionId)?.scope;
			} catch {
				return undefined;
			}
		};

		let poll: IDisposable | undefined;
		const stopPolling = () => {
			poll?.dispose();
			poll = undefined;
		};
		const removeStartingWorker = (versionId: number) => {
			startingSince.delete(versionId);
			resolvedStartingScopes.delete(versionId);
			if (startingSince.size === 0) {
				stopPolling();
			}
		};
		const pollStartingWorkers = () => {
			try {
				const now = clock.now();
				for (const [versionId, since] of [...startingSince]) {
					if (stuckReports >= PARADIS_SW_MAX_STUCK_REPORTS) {
						stopPolling();
						return;
					}
					const scope = scopeOf(versionId);
					if (scope === undefined && resolvedStartingScopes.has(versionId)) {
						// 既に scope を取れていた worker が消えたなら registration は破棄済み。
						removeStartingWorker(versionId);
						continue;
					}
					if (scope !== undefined) {
						resolvedStartingScopes.set(versionId, scope);
						if (!isWebviewScope(scope)) {
							removeStartingWorker(versionId);
							continue;
						}
					}
					if (everRan.has(versionId) || reportedVersions.has(versionId) || now - since < PARADIS_SW_STUCK_THRESHOLD_MS) {
						continue;
					}
					reportedVersions.add(versionId);
					stuckReports++;
					reporter('patched', 'webview', 'sw-startup-stuck', new Error(
						'Webview service worker stayed in starting without ever running'), {
						duration_ms: now - since,
						safe_origin: originOf(scope),
						safe_starting_workers: startingSince.size,
						safe_ever_ran: everRan.size,
					});
				}
				if (stuckReports >= PARADIS_SW_MAX_STUCK_REPORTS) {
					// これ以上は送らないので、5秒ごとに main を起こし続ける意味が無い。
					stopPolling();
				}
			} catch (error) {
				logService.trace(`[ParadisWebviewServiceWorkerWatch] poll failed: ${error}`);
			}
		};
		const startPolling = () => {
			if (poll === undefined && stuckReports < PARADIS_SW_MAX_STUCK_REPORTS) {
				poll = clock.setInterval(pollStartingWorkers, PARADIS_SW_POLL_INTERVAL_MS);
			}
		};

		const onRunningStatusChanged = (details: { versionId: number; runningStatus: string }) => {
			try {
				const { versionId, runningStatus } = details ?? {};
				if (typeof versionId !== 'number') {
					return;
				}
				if (runningStatus === 'starting') {
					if (everRan.has(versionId) || startingSince.has(versionId) || startingSince.size >= PARADIS_SW_MAX_STUCK_REPORTS) {
						return;
					}
					const scope = scopeOf(versionId);
					if (scope !== undefined && !isWebviewScope(scope)) {
						return;
					}
					if (scope !== undefined) {
						resolvedStartingScopes.set(versionId, scope);
					}
					if (!startingSince.has(versionId)) {
						startingSince.set(versionId, clock.now());
						startPolling();
					}
					return;
				}
				// running / stopping / stopped はいずれも「起動待ちで固まってはいない」。
				removeStartingWorker(versionId);
				if (runningStatus === 'running') {
					everRan.add(versionId);
				}
			} catch (error) {
				logService.trace(`[ParadisWebviewServiceWorkerWatch] running-status handler failed: ${error}`);
			}
		};

		const onConsoleMessage = (_event: unknown, details: { message: string; versionId: number; source: string; level: number; lineNumber?: number }) => {
			try {
				if (typeof details?.level !== 'number' || details.level < 2) {
					return;
				}
				if (!PARADIS_SW_INTERESTING_SOURCES.has(details.source)) {
					return;
				}
				const scope = scopeOf(details.versionId);
				// scope を引けない＝ worker が既に停止している等。このセッションで service worker を
				// 登録できるスキームは `vscode-webview` だけ（内蔵ブラウザは別パーティション）なので、
				// 引けなくても捨てずに送る。**壊れているときほど引けない**ので、ここで捨てると
				// 本命のログが一番静かに消える。
				if (scope !== undefined && !isWebviewScope(scope)) {
					return;
				}
				// 指紋は operation まで含むので、source ごとに分けてレート制限の枠を独立させる。
				reporter('patched', 'webview', `sw-worker-console-${details.source}`, new Error(
					`Webview service worker logged: ${String(details.message).slice(0, 500)}`), {
					safe_level: PARADIS_SW_LEVEL_NAMES[details.level] ?? String(details.level),
					safe_source: String(details.source ?? 'unknown'),
					safe_origin: originOf(scope),
					safe_line: typeof details.lineNumber === 'number' ? details.lineNumber : undefined,
				});
			} catch (error) {
				logService.trace(`[ParadisWebviewServiceWorkerWatch] console handler failed: ${error}`);
			}
		};

		// `running-status-changed` は experimental なので、無い版でも他の観測を殺さない。
		let runningStatusAvailable = false;
		try {
			serviceWorkers.on('running-status-changed', onRunningStatusChanged as never);
			runningStatusAvailable = true;
		} catch (error) {
			logService.warn(`[ParadisWebviewServiceWorkerWatch] running-status-changed is unavailable: ${error}`);
		}
		serviceWorkers.on('console-message', onConsoleMessage);
		store.add(toDisposable(() => {
			try {
				if (runningStatusAvailable) {
					serviceWorkers.off('running-status-changed', onRunningStatusChanged as never);
				}
				serviceWorkers.off('console-message', onConsoleMessage);
			} catch {
				// 解除に失敗してもプロセス終了時なので実害は無い。
			}
		}));

		store.add(toDisposable(stopPolling));
	} catch (error) {
		logService.warn(`[ParadisWebviewServiceWorkerWatch] could not start watching webview service workers: ${error}`);
	}
	return store;
}

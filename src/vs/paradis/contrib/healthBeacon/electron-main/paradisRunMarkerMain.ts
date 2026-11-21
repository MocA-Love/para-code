/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Leaves a record when the main process ends without quitting: a crash, a forced quit or a kill
// from outside leaves no minidump and no event when Sentry was not running, and none at all for
// SIGKILL. The main process writes a small marker file at startup, rewrites it with a heartbeat
// every 30 seconds and removes it when it quits. A startup that finds a marker reports the last
// heartbeat once (to the main log always, to Sentry when it runs).
//
// Started from the health beacon's entry point, so there is no new patch point. Unlike the hang
// watchdog this also runs out of sources: there is no timing to misread while a debugger is paused.
//
// The marker format and the classification are in `common/paradisRunMarker.ts`.

import { app, powerMonitor } from 'electron';
import { promises as fs, unlinkSync } from 'fs';
import { freemem, loadavg, uptime } from 'os';
import { raceTimeout } from '../../../../base/common/async.js';
import { join } from '../../../../base/common/path.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisSentryMainState, whenParadisSentryMainSettled } from '../../sentry/electron-main/paradisSentryMain.js';
import { IParadisRunMarker, PARADIS_RUN_MARKER_BEAT_MS, paradisBuildRunMarker, paradisClassifyRunEnd, paradisParseRunMarker, paradisRunEndExtra } from '../common/paradisRunMarker.js';

/** How long the shutdown waits for the marker to say `quitting`. */
const QUIT_WRITE_TIMEOUT_MS = 1_000;

/** The marker file, directly under the user data folder. */
const MARKER_FILE_NAME = 'paradis-run-marker.json';

export interface IParadisRunMarkerBuild {
	readonly commit?: string;
}

/** Reads the marker of the previous run and removes it, so that it is reported once. */
async function takePreviousMarker(markerPath: string): Promise<IParadisRunMarker | undefined> {
	let text: string;
	try {
		text = await fs.readFile(markerPath, 'utf8');
	} catch {
		return undefined;
	}
	try {
		await fs.unlink(markerPath);
	} catch {
		// The next heartbeat replaces it.
	}
	return paradisParseRunMarker(text);
}

export function paradisStartRunMarker(
	lifecycleMainService: ILifecycleMainService,
	windowsMainService: IWindowsMainService,
	logService: ILogService,
	build: IParadisRunMarkerBuild,
): IDisposable {
	const store = new DisposableStore();
	const markerPath = join(app.getPath('userData'), MARKER_FILE_NAME);
	const tempPath = `${markerPath}.tmp`;
	const quitTempPath = `${markerPath}.quit.tmp`;
	const startedAt = Date.now();
	const appVersion = app.getVersion();
	let beats = 0;
	let phase: 'running' | 'quitting' = 'running';
	let suspended = false;
	let osShutdown = false;
	let writing = false;
	// Nothing is written until the marker of the previous run has been read and removed.
	let previousTaken = false;
	// Set once the shutdown owns the file: a heartbeat still in flight must not write over it.
	let stopped = false;

	const snapshot = (): string => {
		const memory = process.memoryUsage();
		const sentry = paradisSentryMainState();
		return JSON.stringify(paradisBuildRunMarker({
			now: Date.now(),
			pid: process.pid,
			startedAt,
			beats: ++beats,
			phase,
			appVersion,
			commit: build.commit,
			sentry: sentry.state,
			sentryError: sentry.errorCode,
			osUptimeSeconds: uptime(),
			suspended,
			osShutdown,
			rss: memory.rss,
			heapUsed: memory.heapUsed,
			heapTotal: memory.heapTotal,
			windowCount: windowsMainService.getWindowCount(),
			freeMem: freemem(),
			load1: loadavg()[0] ?? 0,
			metrics: app.getAppMetrics().map(metric => ({ type: metric.type, workingSetKb: metric.memory?.workingSetSize ?? 0 })),
		}));
	};

	// One small file, written to a temporary name and renamed over the marker, so that a reader never
	// sees half of it. Writes run one at a time; `stopped` is checked again before the rename so
	// that a heartbeat does not land over the marker the shutdown wrote.
	let lastWrite: Promise<void> = Promise.resolve();
	const write = async (temp: string, isCurrent: () => boolean): Promise<void> => {
		try {
			await fs.writeFile(temp, snapshot(), { mode: 0o600 });
			if (isCurrent()) {
				await fs.rename(temp, markerPath);
			}
		} catch {
			// The marker is diagnostics only: without it the next startup reports nothing.
		}
	};
	const beat = (): void => {
		if (stopped || writing || !previousTaken) {
			return;
		}
		writing = true;
		lastWrite = write(tempPath, () => !stopped).finally(() => { writing = false; });
	};

	const remove = (): void => {
		stopped = true;
		for (const path of [markerPath, tempPath, quitTempPath]) {
			try {
				// eslint-disable-next-line local/code-no-sync-fs -- Runs only at the end of the process (`quit` / `exit`), where nothing waits for asynchronous I/O.
				unlinkSync(path);
			} catch {
				// Not there.
			}
		}
	};

	void (async () => {
		// Read the previous marker before the first heartbeat replaces it.
		const previous = await takePreviousMarker(markerPath);
		previousTaken = true;
		if (previous) {
			reportPreviousRun(previous, { now: Date.now(), osUptimeSeconds: uptime(), appVersion, commit: build.commit }, logService);
		}
		if (stopped || store.isDisposed) {
			return;
		}
		beat();
		const timer = setInterval(() => beat(), PARADIS_RUN_MARKER_BEAT_MS);
		store.add(toDisposable(() => clearInterval(timer)));
	})();

	// Why Sentry is not running, once per startup. `mainImpl.ts` decides this before there is a log.
	void whenParadisSentryMainSettled().then(() => {
		const { state, errorCode } = paradisSentryMainState();
		logService.info(state === 'ready'
			? '[paradisSentry] Sentry is running in the main process.'
			: `[paradisSentry] Sentry is not running in the main process (reason: ${state}${errorCode ? `, ${errorCode}` : ''}). Crashes of this run are not reported.`);
		beat();
	});

	const onSuspend = () => {
		suspended = true;
		beat();
	};
	const onResume = () => {
		suspended = false;
		beat();
	};
	const onOsShutdown = () => {
		osShutdown = true;
		beat();
	};
	powerMonitor.on('suspend', onSuspend);
	powerMonitor.on('resume', onResume);
	// Only on macOS: on Linux a `shutdown` listener makes Electron hold a shutdown delay lock.
	if (process.platform === 'darwin') {
		powerMonitor.on('shutdown', onOsShutdown);
	}

	// The shutdown has begun: say so in the marker right away, and remove the marker when the process
	// really ends. A quit that hangs and is then forced leaves a marker that says `quitting`.
	store.add(lifecycleMainService.onWillShutdown(event => {
		const wasStopped = stopped;
		stopped = true;
		phase = 'quitting';
		if (wasStopped || !previousTaken) {
			return;
		}
		// After the heartbeat in flight, if any. The shutdown waits for this small write, but not
		// for a disk that does not answer.
		event.join('paradisRunMarker', raceTimeout(lastWrite.then(() => write(quitTempPath, () => true)), QUIT_WRITE_TIMEOUT_MS).then(() => undefined));
	}));
	// `quit` is the last Electron event of an orderly end; `exit` covers `process.exit()`.
	app.once('quit', remove);
	process.once('exit', remove);

	store.add(toDisposable(() => {
		powerMonitor.removeListener('suspend', onSuspend);
		powerMonitor.removeListener('resume', onResume);
		powerMonitor.removeListener('shutdown', onOsShutdown);
		app.removeListener('quit', remove);
		process.removeListener('exit', remove);
	}));
	return store;
}

function reportPreviousRun(previous: IParadisRunMarker, reader: Parameters<typeof paradisRunEndExtra>[1], logService: ILogService): void {
	const kind = paradisClassifyRunEnd(previous, reader);
	const extra = paradisRunEndExtra(previous, reader);
	// The log first and at once: this run may end the same way before Sentry is ready.
	logService.warn(`[paradisRunMarker] the previous run did not end normally (${kind}): ${JSON.stringify(extra)}`);
	void whenParadisSentryMainSettled().then(() => {
		const { state } = paradisSentryMainState();
		if (state !== 'ready') {
			logService.info(`[paradisRunMarker] not sent to Sentry: it is not running (${state}).`);
			return;
		}
		// The kind is part of the operation: the fingerprint of an explicit report is the operation.
		// An OS shutdown or restart is expected to leave a marker, so it is not a warning.
		reportParadisDiagnosticError('owned', 'run-marker', `ended:${kind}`, undefined, extra, kind === 'os-shutdown' || kind === 'os-restart' ? 'info' : 'warning');
		logService.info(`[paradisRunMarker] handed to Sentry as run-marker.ended:${kind}.`);
	});
}

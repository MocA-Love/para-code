/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The "this run is alive" marker of the main process, and what the next startup makes of a marker
// that was left behind. Pure: the file and Electron side is `electron-main/paradisRunMarkerMain.ts`.
//
// The marker holds numbers, fixed words and the build only: no paths, names or user content.

/** How often the main process rewrites the marker with a new heartbeat. */
export const PARADIS_RUN_MARKER_BEAT_MS = 30_000;

/**
 * The OS boot time is derived from the wall clock and the uptime, so it moves a little between
 * readings (rounding, clock corrections). A real restart moves it by far more than this.
 */
const OS_BOOT_TIME_SLACK_MS = 60_000;

export type ParadisRunProcessKind = 'browser' | 'renderer' | 'gpu' | 'utility' | 'other';

const PROCESS_KINDS: readonly ParadisRunProcessKind[] = ['browser', 'renderer', 'gpu', 'utility', 'other'];

export interface IParadisRunProcessGroup {
	readonly count: number;
	readonly mb: number;
}

/** Whether Sentry runs in the main process, or why it does not (see paradisSentryMain.ts). */
const SENTRY_STATES: readonly string[] = ['pending', 'ready', 'opted-out-argv', 'opted-out-flag', 'dev-build', 'load-failed'];

/** The marker file. */
export interface IParadisRunMarker {
	readonly version: 1;
	readonly pid: number;
	readonly startedAt: number;
	/** When the last heartbeat was taken (epoch milliseconds). */
	readonly beatAt: number;
	/** How many heartbeats this run wrote. */
	readonly beats: number;
	/** `quitting`: the application had begun its own shutdown. */
	readonly phase: 'running' | 'quitting';
	readonly appVersion: string;
	readonly commit: string;
	readonly sentry: string;
	/** The error code or name of a failed Sentry load, when it is identifier-shaped. */
	readonly sentryError: string;
	/** When the OS booted, as seen by this run. */
	readonly osBootAt: number;
	/** The OS announced a sleep and no wake-up followed. */
	readonly suspended: boolean;
	/** The OS announced a shutdown or restart. */
	readonly osShutdown: boolean;
	readonly rssMb: number;
	readonly heapUsedMb: number;
	readonly heapTotalMb: number;
	readonly windowCount: number;
	readonly freeMemMb: number;
	/** The one-minute load average. */
	readonly load1: number;
	readonly processes: Readonly<Record<ParadisRunProcessKind, IParadisRunProcessGroup>>;
}

/** What one heartbeat reads from the process and the OS. Sizes are in bytes unless named otherwise. */
export interface IParadisRunBeatInput {
	readonly now: number;
	readonly pid: number;
	readonly startedAt: number;
	readonly beats: number;
	readonly phase: 'running' | 'quitting';
	readonly appVersion: string;
	readonly commit: string | undefined;
	readonly sentry: string;
	readonly sentryError: string | undefined;
	readonly osUptimeSeconds: number;
	readonly suspended: boolean;
	readonly osShutdown: boolean;
	readonly rss: number;
	readonly heapUsed: number;
	readonly heapTotal: number;
	readonly windowCount: number;
	readonly freeMem: number;
	readonly load1: number;
	/** `app.getAppMetrics()`: the Electron process type and its working set in kilobytes. */
	readonly metrics: readonly { readonly type: string; readonly workingSetKb: number }[];
}

function toMb(bytes: number): number {
	return Math.round(bytes / (1024 * 1024));
}

function toProcessKind(type: string): ParadisRunProcessKind {
	switch (type) {
		case 'Browser': return 'browser';
		case 'Tab': return 'renderer';
		case 'GPU': return 'gpu';
		case 'Utility': return 'utility';
		default: return 'other';
	}
}

/** When the OS booted, from the wall clock and the uptime. */
export function paradisOsBootTime(now: number, osUptimeSeconds: number): number {
	return Math.round(now - osUptimeSeconds * 1_000);
}

/** Builds the marker one heartbeat writes. */
export function paradisBuildRunMarker(input: IParadisRunBeatInput): IParadisRunMarker {
	const kb: Record<ParadisRunProcessKind, { count: number; kb: number }> = {
		browser: { count: 0, kb: 0 },
		renderer: { count: 0, kb: 0 },
		gpu: { count: 0, kb: 0 },
		utility: { count: 0, kb: 0 },
		other: { count: 0, kb: 0 },
	};
	for (const metric of input.metrics) {
		const group = kb[toProcessKind(metric.type)];
		group.count++;
		group.kb += Number.isFinite(metric.workingSetKb) ? metric.workingSetKb : 0;
	}
	const group = (kind: ParadisRunProcessKind): IParadisRunProcessGroup => ({ count: kb[kind].count, mb: Math.round(kb[kind].kb / 1024) });
	return {
		version: 1,
		pid: input.pid,
		startedAt: input.startedAt,
		beatAt: input.now,
		beats: input.beats,
		phase: input.phase,
		appVersion: input.appVersion,
		commit: input.commit ?? '',
		sentry: input.sentry,
		sentryError: input.sentryError ?? '',
		osBootAt: paradisOsBootTime(input.now, input.osUptimeSeconds),
		suspended: input.suspended,
		osShutdown: input.osShutdown,
		rssMb: toMb(input.rss),
		heapUsedMb: toMb(input.heapUsed),
		heapTotalMb: toMb(input.heapTotal),
		windowCount: input.windowCount,
		freeMemMb: toMb(input.freeMem),
		load1: Math.round(input.load1 * 100) / 100,
		processes: {
			browser: group('browser'),
			renderer: group('renderer'),
			gpu: group('gpu'),
			utility: group('utility'),
			other: group('other'),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function word(value: unknown, shape: RegExp): string {
	return typeof value === 'string' && shape.test(value) ? value : '';
}

/**
 * Reads a marker file. The file sat on disk across a crash and its contents are sent on, so
 * every field is checked: a number that is not one becomes 0, a string that does not have the
 * expected shape becomes empty. Returns `undefined` when this is not a marker at all.
 */
export function paradisParseRunMarker(text: string): IParadisRunMarker | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw.version !== 1 || typeof raw.beatAt !== 'number' || !Number.isFinite(raw.beatAt) || typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) {
		return undefined;
	}
	const processes = isRecord(raw.processes) ? raw.processes : {};
	const group = (kind: ParadisRunProcessKind): IParadisRunProcessGroup => {
		const value = processes[kind];
		return isRecord(value) ? { count: count(value.count), mb: count(value.mb) } : { count: 0, mb: 0 };
	};
	return {
		version: 1,
		pid: count(raw.pid),
		startedAt: raw.startedAt,
		beatAt: raw.beatAt,
		beats: count(raw.beats),
		phase: raw.phase === 'quitting' ? 'quitting' : 'running',
		appVersion: word(raw.appVersion, /^[0-9A-Za-z.+-]{1,40}$/),
		commit: word(raw.commit, /^[0-9a-f]{1,40}$/),
		sentry: typeof raw.sentry === 'string' && SENTRY_STATES.includes(raw.sentry) ? raw.sentry : 'unknown',
		sentryError: word(raw.sentryError, /^[A-Za-z][A-Za-z0-9_]{0,60}$/),
		osBootAt: count(raw.osBootAt),
		suspended: raw.suspended === true,
		osShutdown: raw.osShutdown === true,
		rssMb: count(raw.rssMb),
		heapUsedMb: count(raw.heapUsedMb),
		heapTotalMb: count(raw.heapTotalMb),
		windowCount: count(raw.windowCount),
		freeMemMb: count(raw.freeMemMb),
		load1: count(raw.load1),
		processes: {
			browser: group('browser'),
			renderer: group('renderer'),
			gpu: group('gpu'),
			utility: group('utility'),
			other: group('other'),
		},
	};
}

/**
 * How the previous run ended, as far as a leftover marker can tell.
 *
 * - `os-shutdown`: the OS announced a shutdown or restart before the last heartbeat.
 * - `os-restart`: the OS booted again after the last heartbeat without announcing it (power loss,
 *   kernel panic, forced restart).
 * - `quitting`: the application had begun its own shutdown and did not finish it.
 * - `suspended`: the machine was asleep at the last heartbeat.
 * - `running`: none of the above. A crash, a forced quit or a kill from outside (SIGKILL).
 */
export type ParadisRunEndKind = 'os-shutdown' | 'os-restart' | 'quitting' | 'suspended' | 'running';

/** What the startup that found the marker knows about itself. */
export interface IParadisRunMarkerReader {
	readonly now: number;
	readonly osUptimeSeconds: number;
	readonly appVersion: string;
	readonly commit: string | undefined;
}

function osRestarted(previous: IParadisRunMarker, reader: Pick<IParadisRunMarkerReader, 'now' | 'osUptimeSeconds'>): boolean {
	return previous.osBootAt > 0 && paradisOsBootTime(reader.now, reader.osUptimeSeconds) - previous.osBootAt > OS_BOOT_TIME_SLACK_MS;
}

export function paradisClassifyRunEnd(previous: IParadisRunMarker, reader: Pick<IParadisRunMarkerReader, 'now' | 'osUptimeSeconds'>): ParadisRunEndKind {
	if (previous.osShutdown) {
		return 'os-shutdown';
	}
	if (osRestarted(previous, reader)) {
		return 'os-restart';
	}
	if (previous.phase === 'quitting') {
		return 'quitting';
	}
	if (previous.suspended) {
		return 'suspended';
	}
	return 'running';
}

/**
 * The report of a run that did not end normally: the last heartbeat plus what tells the ways to
 * end apart. Every key is `safe_` and avoids the words the Sentry project scrubs by key
 * (`session`, `terminal`, `token`, `path`, `env`, ...); every value is a number, a boolean or one
 * of a fixed set of words.
 */
export function paradisRunEndExtra(previous: IParadisRunMarker, reader: IParadisRunMarkerReader): Record<`safe_${string}`, number | string | boolean> {
	const total = PROCESS_KINDS.reduce((sum, kind) => sum + previous.processes[kind].mb, 0);
	const totalCount = PROCESS_KINDS.reduce((sum, kind) => sum + previous.processes[kind].count, 0);
	return {
		safe_end_kind: paradisClassifyRunEnd(previous, reader),
		safe_uptime_min: Math.max(0, Math.round((previous.beatAt - previous.startedAt) / 60_000)),
		// How long after the last heartbeat this startup came. A run that was killed is restarted
		// by hand, so this is an upper bound of when it ended, not the time it ended.
		safe_restart_gap_s: Math.max(0, Math.round((reader.now - previous.beatAt) / 1_000)),
		safe_beats: previous.beats,
		safe_rss_mb: previous.rssMb,
		safe_heap_used_mb: previous.heapUsedMb,
		safe_heap_total_mb: previous.heapTotalMb,
		safe_app_total_mb: total,
		safe_app_process_count: totalCount,
		safe_browser_mb: previous.processes.browser.mb,
		safe_renderer_mb: previous.processes.renderer.mb,
		safe_renderer_count: previous.processes.renderer.count,
		safe_gpu_mb: previous.processes.gpu.mb,
		safe_utility_mb: previous.processes.utility.mb,
		safe_utility_count: previous.processes.utility.count,
		safe_other_mb: previous.processes.other.mb,
		safe_other_count: previous.processes.other.count,
		safe_window_count: previous.windowCount,
		safe_free_mem_mb: previous.freeMemMb,
		safe_load1: previous.load1,
		safe_was_quitting: previous.phase === 'quitting',
		safe_was_suspended: previous.suspended,
		safe_os_shutdown_announced: previous.osShutdown,
		safe_os_restarted: osRestarted(previous, reader),
		safe_ended_version: previous.appVersion,
		safe_ended_commit: previous.commit.slice(0, 10),
		safe_same_build: previous.appVersion === reader.appVersion && previous.commit === (reader.commit ?? ''),
		// Whether Sentry ran in the run that ended, or why not: a run without it leaves no minidump.
		safe_ended_sentry: previous.sentry,
		safe_ended_sentry_error: previous.sentryError,
	};
}

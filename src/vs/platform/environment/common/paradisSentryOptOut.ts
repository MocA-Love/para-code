/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * The upstream crash-reporter inputs that decide whether Para Code may send anything to Sentry.
 *
 * `telemetry.telemetryLevel` is not an input of its own: settings are not read yet when the main
 * process starts. Upstream mirrors it into argv.json instead (`updateCrashReporterEnablement` in
 * `vs/code/electron-main/app.ts` writes `enable-crash-reporter: telemetryLevel >= crash` once per
 * startup), and its Electron crash reporter follows argv.json from the next startup on. Sentry
 * follows the same argv.json value, with the same delay.
 */
export interface IParadisCrashReportingInputs {
	/** `enable-crash-reporter` from argv.json. */
	readonly enableCrashReporter?: unknown;
	/** `--disable-crash-reporter` on the command line. */
	readonly disableCrashReporter?: boolean;
}

/**
 * Whether the user turned crash reporting off, so no process may initialize Sentry.
 *
 * Unlike upstream's gate (`argvConfig['enable-crash-reporter'] && ...`), a missing argv.json value
 * does not opt out: it is missing only on the user's first startup (argv.json lives in the data
 * folder under the home directory, not per profile), before upstream has written the mirrored
 * telemetry level, and reporting the first run is wanted. Only an explicit `false` opts out.
 *
 * `--crash-reporter-directory` is not an opt-out here: the smoke tests (`test/automation`) pass it,
 * and their packaged-build runs are meant to keep reporting under the `local` environment.
 */
export function isParadisSentryOptedOut(inputs: IParadisCrashReportingInputs): boolean {
	return inputs.enableCrashReporter === false || !!inputs.disableCrashReporter;
}

/**
 * Carries the main process's decision to the processes it spawns afterwards (the shared process
 * reads it from its environment, windows from their configuration). Main rewrites it on every
 * startup, so a value inherited from another instance never decides.
 */
const PARADIS_SENTRY_DISABLED_ENV = 'PARA_CODE_SENTRY_DISABLED';

/** Records the main process's decision in `env` (set when opted out, removed otherwise). */
export function setParadisSentryDisabledEnv(env: Record<string, string | undefined>, disabled: boolean): void {
	if (disabled) {
		env[PARADIS_SENTRY_DISABLED_ENV] = '1';
	} else {
		delete env[PARADIS_SENTRY_DISABLED_ENV];
	}
}

/** Whether the main process that spawned this process decided not to report. */
export function isParadisSentryDisabledByEnv(env: Record<string, string | undefined>): boolean {
	return env[PARADIS_SENTRY_DISABLED_ENV] === '1';
}

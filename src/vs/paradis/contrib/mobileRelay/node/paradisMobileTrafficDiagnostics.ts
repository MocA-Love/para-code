/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisMobileFrameTrafficSample } from '../common/paradisMobileMux.js';
import { ChannelId, MOBILE_ID_LENGTH } from '../common/paradisMobileProtocol.js';

const PC_RELAY_FRAME_PREFIX_BYTES = 1 + MOBILE_ID_LENGTH;
const MOBILE_TRAFFIC_DIAGNOSTICS_INTERVAL_MS = 60_000;

export interface IParadisMobileTrafficTotals {
	readonly frames: number;
	readonly messages: number;
	readonly payloadBytes: number;
	readonly sealedBytes: number;
	readonly relayPayloadBytes: number;
}

export interface IParadisMobileChannelTraffic {
	readonly sent?: IParadisMobileTrafficTotals;
	readonly received?: IParadisMobileTrafficTotals;
}

export interface IParadisMobileTrafficSnapshot {
	readonly channels: Partial<Record<ChannelId, IParadisMobileChannelTraffic>>;
}

interface MutableTrafficTotals {
	frames: number;
	messages: number;
	payloadBytes: number;
	sealedBytes: number;
	relayPayloadBytes: number;
}

interface MutableChannelTraffic {
	sent?: MutableTrafficTotals;
	received?: MutableTrafficTotals;
}

function emptyTotals(): MutableTrafficTotals {
	return { frames: 0, messages: 0, payloadBytes: 0, sealedBytes: 0, relayPayloadBytes: 0 };
}

function saturatingAdd(current: number, value: number): number {
	return current >= Number.MAX_SAFE_INTEGER - value ? Number.MAX_SAFE_INTEGER : current + value;
}

/** Enables local traffic diagnostics only for an explicit opt-in value. */
export function isParadisMobileTrafficDiagnosticsEnabled(environmentValue: string | undefined): boolean {
	return environmentValue === '1';
}

/** Serializes a non-empty anonymous interval for the existing local log service. */
export function formatParadisMobileTrafficSnapshot(snapshot: IParadisMobileTrafficSnapshot): string | undefined {
	return Object.keys(snapshot.channels).length > 0 ? JSON.stringify(snapshot) : undefined;
}

export class ParadisMobileTrafficDiagnostics {
	private channels: Partial<Record<ChannelId, MutableChannelTraffic>> = {};

	record(sample: IParadisMobileFrameTrafficSample): void {
		const channel = this.channels[sample.channel] ?? {};
		this.channels[sample.channel] = channel;
		const totals = channel[sample.direction] ?? emptyTotals();
		channel[sample.direction] = totals;
		totals.frames = saturatingAdd(totals.frames, 1);
		totals.messages = saturatingAdd(totals.messages, sample.more ? 0 : 1);
		totals.payloadBytes = saturatingAdd(totals.payloadBytes, sample.payloadBytes);
		totals.sealedBytes = saturatingAdd(totals.sealedBytes, sample.sealedBytes);
		totals.relayPayloadBytes = saturatingAdd(totals.relayPayloadBytes, sample.sealedBytes + PC_RELAY_FRAME_PREFIX_BYTES);
	}

	takeSnapshot(): IParadisMobileTrafficSnapshot {
		const channels = this.channels;
		this.channels = {};
		return { channels };
	}
}

/** Creates the aggregator only for an explicitly opted-in local process. */
export function createParadisMobileTrafficDiagnostics(environmentValue: string | undefined): ParadisMobileTrafficDiagnostics | undefined {
	return isParadisMobileTrafficDiagnosticsEnabled(environmentValue) ? new ParadisMobileTrafficDiagnostics() : undefined;
}

/** Flushes one non-empty interval without allowing local logging failures to escape. */
export function reportParadisMobileTrafficDiagnostics(diagnostics: ParadisMobileTrafficDiagnostics, log: (line: string) => void): boolean {
	try {
		const line = formatParadisMobileTrafficSnapshot(diagnostics.takeSnapshot());
		if (line === undefined) {
			return false;
		}
		log(line);
		return true;
	} catch {
		// Local diagnostics are best-effort and must not affect the relay service.
		return false;
	}
}

export interface IParadisMobileTrafficDiagnosticsDisposable {
	dispose(): void;
}

export type ParadisMobileTrafficDiagnosticsScheduler = (callback: () => void, intervalMs: number) => IParadisMobileTrafficDiagnosticsDisposable;

export interface IParadisMobileTrafficDiagnosticsSession extends IParadisMobileTrafficDiagnosticsDisposable {
	readonly diagnostics: ParadisMobileTrafficDiagnostics;
}

function scheduleTrafficDiagnostics(callback: () => void, intervalMs: number): IParadisMobileTrafficDiagnosticsDisposable {
	const timer = setInterval(callback, intervalMs);
	return { dispose: () => clearInterval(timer) };
}

/** Owns the opt-in aggregator and its local periodic logger as one disposable unit. */
export function startParadisMobileTrafficDiagnostics(
	environmentValue: string | undefined,
	log: (line: string) => void,
	schedule: ParadisMobileTrafficDiagnosticsScheduler = scheduleTrafficDiagnostics,
): IParadisMobileTrafficDiagnosticsSession | undefined {
	const diagnostics = createParadisMobileTrafficDiagnostics(environmentValue);
	if (diagnostics === undefined) {
		return undefined;
	}
	const timer = schedule(() => reportParadisMobileTrafficDiagnostics(diagnostics, log), MOBILE_TRAFFIC_DIAGNOSTICS_INTERVAL_MS);
	return {
		diagnostics,
		dispose: () => timer.dispose(),
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisPortEntry, IParadisPortKillBatchResult, IParadisPortKillRequest } from './paradisPortList.js';

function isParadisPortKillRequest(value: unknown): value is IParadisPortKillRequest {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const request = value as Record<string, unknown>;
	const { pid, port, processName } = request;
	return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
		&& typeof port === 'number' && Number.isSafeInteger(port) && port > 0
		&& typeof processName === 'string';
}

export async function executeParadisPortKillBatch(
	requests: readonly unknown[],
	collect: () => Promise<readonly IParadisPortEntry[]>,
	protectedPids: ReadonlySet<number>,
	kill: (pid: number) => void,
): Promise<IParadisPortKillBatchResult> {
	const entries = await collect();
	const byPid = new Map<number, IParadisPortKillRequest[]>();
	let failed = 0;
	for (const value of requests) {
		if (!isParadisPortKillRequest(value)) {
			failed++;
			continue;
		}
		const request = value;
		const isCurrentEntry = entries.some(entry => entry.pid === request.pid && entry.port === request.port && entry.processName === request.processName);
		if (!isCurrentEntry || protectedPids.has(request.pid)) {
			failed++;
			continue;
		}
		const group = byPid.get(request.pid) ?? [];
		group.push(request);
		byPid.set(request.pid, group);
	}
	for (const [pid, group] of byPid) {
		try {
			kill(pid);
		} catch {
			failed += group.length;
		}
	}
	return { failed };
}

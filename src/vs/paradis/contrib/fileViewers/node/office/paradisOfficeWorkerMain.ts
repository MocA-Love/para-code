/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { parentPort } from 'worker_threads';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import type { ParadisOfficeBudgetProfile } from '../../common/paradisOfficeProtocol.js';
import { createParadisOfficeNodeArchive } from './paradisOfficeNodeArchive.js';
import { inspectOfficePackage } from '../../common/office/paradisOfficePackageCore.js';
import { projectOfficeWorkerResult } from './paradisOfficeWorkerHost.js';

type WorkerOperation = 'inspect' | 'parse' | 'diff';

interface WorkerRunMessage {
	readonly kind: 'run';
	readonly requestId: string;
	readonly operation: WorkerOperation;
	readonly source: { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly revision: string };
	readonly budget: ParadisOfficeBudgetProfile;
}

interface WorkerCancelMessage {
	readonly kind: 'cancel';
	readonly requestId: string;
}

interface ActiveRequest {
	readonly requestId: string;
	readonly cancellation: CancellationTokenSource;
}

let active: ActiveRequest | undefined;

function dataField(value: unknown, name: string): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) { return undefined; }
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function validRun(value: unknown): value is WorkerRunMessage {
	const kind = dataField(value, 'kind');
	const requestId = dataField(value, 'requestId');
	const operation = dataField(value, 'operation');
	const source = dataField(value, 'source');
	const budget = dataField(value, 'budget');
	return kind === 'run' && typeof requestId === 'string' && /^[1-9]\d{0,15}$/.test(requestId)
		&& (operation === 'inspect' || operation === 'parse' || operation === 'diff')
		&& !!source && typeof source === 'object' && dataField(source, 'kind') === 'bytes' && dataField(source, 'bytes') instanceof Uint8Array && typeof dataField(source, 'revision') === 'string'
		&& !!budget && typeof budget === 'object';
}

function validCancel(value: unknown): value is WorkerCancelMessage {
	return dataField(value, 'kind') === 'cancel' && typeof dataField(value, 'requestId') === 'string';
}

async function run(message: WorkerRunMessage): Promise<void> {
	if (active) {
		parentPort?.postMessage({ kind: 'failure', requestId: message.requestId });
		return;
	}
	const cancellation = new CancellationTokenSource();
	active = { requestId: message.requestId, cancellation };
	try {
		// Parsing is deliberately available only for transferred bytes. This worker never opens paths,
		// follows external relationships, executes macros, or invokes document-provided code.
		const archive = await createParadisOfficeNodeArchive(message.source.bytes);
		const inventory = await inspectOfficePackage(archive, message.budget, cancellation.token);
		if (cancellation.token.isCancellationRequested) {
			parentPort?.postMessage({ kind: 'cancelled', requestId: message.requestId });
			return;
		}
		// The core may intentionally reuse immutable hash objects. The bounded descriptor
		// projector clones that trusted graph directly; do not allocate a JSON wire copy first.
		const value = projectOfficeWorkerResult('inspect', { inventory }, true);
		if (!value) {
			parentPort?.postMessage({ kind: 'failure', requestId: message.requestId });
			return;
		}
		parentPort?.postMessage({ kind: 'result', requestId: message.requestId, value });
	} catch {
		parentPort?.postMessage(cancellation.token.isCancellationRequested
			? { kind: 'cancelled', requestId: message.requestId }
			: { kind: 'failure', requestId: message.requestId });
	} finally {
		cancellation.dispose();
		if (active?.requestId === message.requestId) { active = undefined; }
	}
}

const port = parentPort;
if (port) {
	port.postMessage({ kind: 'ready' });
	port.on('message', message => {
		if (validCancel(message) && active?.requestId === message.requestId) {
			active.cancellation.cancel();
			return;
		}
		if (validRun(message)) {
			void run(message);
		}
	});
}

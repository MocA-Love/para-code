/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_OFFICE_BUDGET_PROFILES } from '../../common/paradisOfficeProtocol.js';
import { buildOpcFixture } from '../common/paradisOfficeFixture.js';
import { OfficeHandleStore, OfficeHandleStoreError } from '../../node/office/paradisOfficeHandleStore.js';
import { OfficeMemoryAccountant, OfficeWorkerHost, projectOfficeWorkerResult, type IOfficeWorker } from '../../node/office/paradisOfficeWorkerHost.js';

class FakeClock {
	private now = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { readonly at: number; readonly runner: () => void }>();

	read = () => this.now;

	setTimeout = (runner: () => void, delay: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.now + delay, runner });
		return id;
	};

	clearTimeout = (id: unknown): void => { if (typeof id === 'number') { this.timers.delete(id); } };

	advance(milliseconds: number): void {
		this.now += milliseconds;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.now) {
				this.timers.delete(id);
				timer.runner();
			}
		}
	}

	jump(milliseconds: number): void { this.now += milliseconds; }
}

class FakeWorker implements IOfficeWorker {
	readonly messages: unknown[] = [];
	terminated = false;
	emitExitOnTerminate = true;
	terminateResult: Promise<number> = Promise.resolve(1);
	private readonly messageEmitter = new Emitter<unknown>();
	private readonly errorEmitter = new Emitter<unknown>();
	private readonly exitEmitter = new Emitter<number>();

	postMessage(message: unknown): void { this.messages.push(message); }
	terminate(): Promise<number> { this.terminated = true; if (this.emitExitOnTerminate) { this.exitEmitter.fire(1); } return this.terminateResult; }
	onMessage(listener: (message: unknown) => void): IDisposable { return this.messageEmitter.event(listener); }
	onError(listener: (error: unknown) => void): IDisposable { return this.errorEmitter.event(listener); }
	onExit(listener: (code: number) => void): IDisposable { return this.exitEmitter.event(listener); }
	emit(message: unknown): void { this.messageEmitter.fire(message); }
	fail(error: unknown): void { this.errorEmitter.fire(error); }
	exit(code: number): void { this.exitEmitter.fire(code); }
}

class ObservedWorker implements IOfficeWorker {
	readonly messages: unknown[] = [];
	readonly listenerDisposals = { message: 0, error: 0, exit: 0 };
	terminateCalls = 0;
	emitExitOnTerminate = true;
	terminateResult: Promise<number> = Promise.resolve(1);
	private messageListener: ((message: unknown) => void) | undefined;
	private exitListener: ((code: number) => void) | undefined;

	postMessage(message: unknown): void { this.messages.push(message); }
	terminate(): Promise<number> { this.terminateCalls++; if (this.emitExitOnTerminate) { this.exitListener?.(1); } return this.terminateResult; }
	onMessage(listener: (message: unknown) => void): IDisposable { this.messageListener = listener; return toDisposable(() => { this.listenerDisposals.message++; }); }
	onError(_listener: (error: unknown) => void): IDisposable { return toDisposable(() => { this.listenerDisposals.error++; }); }
	onExit(listener: (code: number) => void): IDisposable { this.exitListener = listener; return toDisposable(() => { this.listenerDisposals.exit++; }); }
	emit(message: unknown): void { this.messageListener?.(message); }
	exit(code: number): void { this.exitListener?.(code); }
}

class CountingMemoryAccountant extends OfficeMemoryAccountant {
	releaseWorkerCalls = 0;
	override releaseWorker(bytes: number): void { this.releaseWorkerCalls++; super.releaseWorker(bytes); }
}

function source() {
	return { kind: 'bytes' as const, bytes: new Uint8Array([80, 75, 3, 4]), revision: 'safe-revision' };
}

function parseSummary() {
	return { operation: 'parse', handle: { kind: 'document', id: 'handle-1' }, outcome: 'complete', completeness: completeness(), capabilities: [], changes: [] };
}

function diffSummary() {
	return {
		operation: 'diff', handle: { kind: 'comparison', id: 'comparison-1' }, outcome: 'complete', completeness: completeness(), capabilities: ['changeNavigation'],
		changes: [{
			id: 'change-1', category: 'content', subject: { kind: 'paragraph', locator: 'word:p:1' },
			before: { kind: 'none' }, after: { kind: 'scalar', valueType: 'text', value: 'after' },
			certainty: 'exact', sourceParts: ['/word/document.xml'], navigableAnchor: 'paragraph-1',
		}],
	};
}

function completeness() {
	return { expectedParts: 0, visitedParts: 0, parsedParts: 0, opaqueParts: 0, failedParts: 0, omittedParts: 0, expectedSemanticUnits: 0, visitedSemanticUnits: 0, terminal: true };
}

function inspectInventory() {
	return {
		format: 'docx', container: 'opc', parts: [], relationships: [], features: [],
		security: { encrypted: false, hasMacros: false, hasExternalRelationships: false, hasEmbeddedObjects: false, hasProtection: false, hasSignatures: false },
		budgetProfile: 'desktopLocal',
		budgetUsage: { compressedInputBytes: 0, expandedBytes: 0, entryCount: 0, largestPartBytes: 0, totalMediaBytes: 0, elapsedMilliseconds: 0 },
		outcome: 'complete', completeness: completeness(),
		warnings: [],
	};
}

const workerProjectionBytes = 2 * 1024 * 1024;

function jsonByteLength(value: unknown): number {
	return VSBuffer.fromString(JSON.stringify(value)).byteLength;
}

function exactSizeInspectResult(targetBytes: number) {
	const specialCharacters = 'quote:" backslash:\\ controls:\b\t\n\f\r\u0000 BMP:é中 astral:😀 lone:\ud800x\udc00';
	const warnings = Array.from({ length: 512 }, (_, index) => ({ code: `code-${index}`, message: index === 0 ? specialCharacters : '' }));
	const value = { inventory: { ...inspectInventory(), warnings } };
	let remaining = targetBytes - jsonByteLength(value);
	for (const warning of warnings) {
		const addedCharacters = Math.min(4096 - warning.message.length, remaining);
		warning.message += 'x'.repeat(addedCharacters);
		remaining -= addedCharacters;
	}
	assert.strictEqual(remaining, 0, 'fixture must have enough bounded warning capacity');
	assert.strictEqual(jsonByteLength(value), targetBytes, 'independent JSON/UTF-8 oracle must hit the requested boundary');
	return value;
}

function wrapChangeValue(value: object, listCount: number, recordCount: number): object {
	let result = value;
	for (let index = 0; index < listCount; index++) { result = { kind: 'list', items: [result] }; }
	for (let index = 0; index < recordCount; index++) { result = { kind: 'record', fields: [{ name: `field-${index}`, value: result }] }; }
	return result;
}

function assertFreshData(input: unknown, output: unknown): void {
	if (!input || typeof input !== 'object') { assert.strictEqual(output, input); return; }
	assert.notStrictEqual(output, input);
	assert.strictEqual(Array.isArray(output), Array.isArray(input));
	for (const key of Object.keys(input)) {
		assertFreshData((input as Record<string, unknown>)[key], (output as Record<string, unknown>)[key]);
	}
}

function withoutField(value: Record<string, unknown>, field: string): Record<string, unknown> {
	const result = { ...value };
	delete result[field];
	return result;
}

const uncancelledToken = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };

suite('ParadisOfficeWorkerHost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('rejects descriptors at the worker bytes boundary', async () => {
		const host = new OfficeWorkerHost({ createWorker: () => new FakeWorker() });
		const result = host.run('inspect', 'client-a', { kind: 'file', displayName: 'must-not-cross.xlsx' } as never, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('cancels cooperatively without publishing a later worker result', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({
			createWorker: () => worker,
			now: clock.read,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
		});
		const cancellation = new CancellationTokenSource();
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		worker.emit({ kind: 'cancelled', requestId: '1' });
		worker.emit({ kind: 'result', requestId: '1', value: { inventory: 'late' } });
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		assert.strictEqual(worker.terminated, true);
	});

	test('terminates an unresponsive cancelled worker after 250ms', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const cancellation = new CancellationTokenSource();
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		clock.advance(249);
		assert.strictEqual(worker.terminated, false);
		clock.advance(1);
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		assert.strictEqual(worker.terminated, true);
	});

	test('retains an orphaned worker slot until a late exit after termination rejection', async () => {
		const worker = new FakeWorker();
		worker.emitExitOnTerminate = false;
		worker.terminateResult = Promise.reject(new Error('terminate rejected'));
		const host = new OfficeWorkerHost({ createWorker: () => worker, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		const cancellation = new CancellationTokenSource();
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		worker.emit({ kind: 'cancelled', requestId: '1' });
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		assert.strictEqual(host.activeWorkerCount, 1);
		worker.exit(1);
		assert.strictEqual(host.activeWorkerCount, 0);
	});

	test('starts the Node worker and receives its cooperative cancellation acknowledgement', async () => {
		// The Electron renderer test host cannot launch worker_threads. The node unit runner is the
		// production execution boundary and runs this smoke test below.
		if (process.type === 'renderer') { return; }
		const host = new OfficeWorkerHost();
		const cancellation = new CancellationTokenSource();
		const result = host.run('inspect', 'node-worker', { kind: 'bytes', bytes: new Uint8Array(), revision: 'node-cancel' }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		assert.deepStrictEqual(await result, { outcome: 'cancelled' });
		host.dispose();
	});

	test('inspects a real minimal OPC package and reaps the worker', async () => {
		if (process.type === 'renderer') { return; }
		const bytes = await buildOpcFixture({
			parts: [
				['/word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'],
				['/word/vbaProject.bin', new Uint8Array([1])],
				['/media/orphan.bin', new Uint8Array([2])],
			],
			relationships: [
				{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' },
				{ source: '/word/document.xml', id: 'rId2', type: 'https://example.test/external', target: 'https://example.test/', targetMode: 'External' },
			],
		});
		const accountant = new OfficeMemoryAccountant(1024 * 1024 * 1024);
		const host = new OfficeWorkerHost({ accountant, memory: { workerReservationBytes: 1 } });
		const result = await host.run('inspect', 'node-inspect', { kind: 'bytes', bytes, revision: 'fixture-1' }, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		assert.strictEqual(result.outcome, 'complete', JSON.stringify(result));
		if (result.outcome === 'complete') {
			const inventory = (result.value as { inventory: { readonly features: readonly { readonly kind: string }[]; readonly security: { readonly hasMacros: boolean; readonly hasExternalRelationships: boolean } } }).inventory;
			assert.deepStrictEqual(inventory.features.map(feature => feature.kind).sort(), ['externalRelationship', 'macro', 'orphanPart']);
			assert.strictEqual(inventory.security.hasMacros, true);
			assert.strictEqual(inventory.security.hasExternalRelationships, true);
		}
		assert.strictEqual(host.activeWorkerCount, 0);
		assert.strictEqual(accountant.snapshot().workerBytes, 0);
	});

	test('maps an inspect deadline and worker crash to safe outcomes', async () => {
		const clock = new FakeClock();
		const created: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); created.push(worker); return worker; }, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const deadline = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(30_001);
		assert.deepStrictEqual(await deadline, { outcome: 'blocked', error: 'limitExceeded' });
		const crash = host.run('diff', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		created[1].fail(new Error('/private/path and stack must not escape'));
		assert.deepStrictEqual(await crash, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('maps a parse deadline to the processing limit outcome', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(60_001);
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('maps a diff deadline to the processing limit outcome', async () => {
		const worker = new FakeWorker();
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const result = host.run('diff', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(90_001);
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('maps a worker resource limit report to blocked without retaining its diagnostics', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		worker.emit({ kind: 'limitExceeded', requestId: '1', path: '/secret/document.xlsx', stack: 'private' });
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('rejects an invalid inspect result instead of publishing partial worker data', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		worker.emit({ kind: 'result', requestId: '1', value: { inventory: { format: 'xlsx', container: 'opc', parts: [], relationships: [], features: [] }, stack: '/private' } });
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('requires every inspect descriptor field and never returns a nested worker identity', async () => {
		for (const inventory of [
			(() => { const value = inspectInventory(); delete (value as Partial<typeof value>).budgetProfile; return value; })(),
			(() => { const value = inspectInventory(); delete (value as Partial<typeof value>).warnings; return value; })(),
		]) {
			const worker = new FakeWorker();
			const host = new OfficeWorkerHost({ createWorker: () => worker });
			const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
			worker.emit({ kind: 'result', requestId: '1', value: { inventory } });
			assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		}

		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const original = { inventory: inspectInventory() };
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		worker.emit({ kind: 'result', requestId: '1', value: original });
		const outcome = await result;
		assert.strictEqual(outcome.outcome, 'complete');
		if (outcome.outcome === 'complete') {
			assert.notStrictEqual(outcome.value, original);
			assert.notStrictEqual((outcome.value as { inventory: object }).inventory, original.inventory);
		}
	});

	test('bounds projected worker output before publishing a deep or oversized payload', async () => {
		for (const inventory of [
			(() => { let value: unknown = inspectInventory(); for (let index = 0; index < 33; index++) { value = { inventory: value }; } return value; })(),
			{ ...inspectInventory(), warnings: [{ code: 'x', message: '😀'.repeat(524_289) }] },
		]) {
			const worker = new FakeWorker();
			const host = new OfficeWorkerHost({ createWorker: () => worker });
			const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
			worker.emit({ kind: 'result', requestId: '1', value: { inventory } });
			assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		}
	});

	test('enforces the exact JSON UTF-8 worker projection byte boundary', () => {
		const exact = exactSizeInspectResult(workerProjectionBytes);
		const over = exactSizeInspectResult(workerProjectionBytes + 1);
		assert.notStrictEqual(projectOfficeWorkerResult('inspect', exact), undefined);
		assert.strictEqual(projectOfficeWorkerResult('inspect', over), undefined);
	});

	test('rejects hash coverage and operation-handle inversions at the projector seam', () => {
		const fingerprint = { algorithm: 'sha256', value: 'a'.repeat(64), byteLength: 1 };
		const base = { id: '/a', canonicalUri: '/a', contentType: 'x', compressedBytes: 1, expandedBytes: 1, required: false };
		const opaque = { ...inspectInventory(), parts: [{ ...base, coverage: 'completeOpaque', hashCompleteness: 'allBytes', fingerprint }] };
		opaque.completeness = { ...completeness(), expectedParts: 1, visitedParts: 1, opaqueParts: 1, expectedSemanticUnits: 1, visitedSemanticUnits: 1 };
		const projectedOpaque = projectOfficeWorkerResult('inspect', { inventory: opaque }) as { inventory: { parts: readonly { fingerprint: object }[] } };
		assert.deepStrictEqual(projectedOpaque.inventory.parts[0].fingerprint, fingerprint);
		assert.notStrictEqual(projectedOpaque.inventory.parts[0], opaque.parts[0]);
		assert.notStrictEqual(projectedOpaque.inventory.parts[0].fingerprint, opaque.parts[0].fingerprint);
		for (const invalidPart of [
			withoutField(opaque.parts[0], 'fingerprint'),
			withoutField(opaque.parts[0], 'hashCompleteness'),
			{ ...opaque.parts[0], hashCompleteness: 'incomplete' },
		]) {
			assert.strictEqual(projectOfficeWorkerResult('inspect', { inventory: { ...opaque, parts: [invalidPart] } }), undefined);
		}
		assert.strictEqual(projectOfficeWorkerResult('inspect', { inventory: { ...opaque, parts: [{ ...opaque.parts[0], rawHash: { ...fingerprint } }] } }), undefined);
		const parsed = { ...inspectInventory(), parts: [{ ...base, coverage: 'parsed', hashCompleteness: 'allBytes', rawHash: fingerprint }] };
		parsed.completeness = { ...completeness(), expectedParts: 1, visitedParts: 1, parsedParts: 1, expectedSemanticUnits: 1, visitedSemanticUnits: 1 };
		const projectedParsed = projectOfficeWorkerResult('inspect', { inventory: parsed }) as { inventory: { parts: readonly { rawHash: object }[] } };
		assert.deepStrictEqual(projectedParsed.inventory.parts[0].rawHash, fingerprint);
		assert.notStrictEqual(projectedParsed.inventory.parts[0], parsed.parts[0]);
		assert.notStrictEqual(projectedParsed.inventory.parts[0].rawHash, parsed.parts[0].rawHash);
		for (const invalidPart of [
			withoutField(parsed.parts[0], 'rawHash'),
			withoutField(parsed.parts[0], 'hashCompleteness'),
			{ ...parsed.parts[0], hashCompleteness: 'incomplete' },
		]) {
			assert.strictEqual(projectOfficeWorkerResult('inspect', { inventory: { ...parsed, parts: [invalidPart] } }), undefined);
		}
		assert.strictEqual(projectOfficeWorkerResult('inspect', { inventory: { ...parsed, parts: [{ ...parsed.parts[0], fingerprint: { ...fingerprint } }] } }), undefined);
		const parse = parseSummary();
		assert.deepStrictEqual(projectOfficeWorkerResult('parse', parse), parse);
		assert.strictEqual(projectOfficeWorkerResult('parse', { ...parse, handle: { kind: 'comparison', id: 'x' } }), undefined);
		const diff = diffSummary();
		assert.deepStrictEqual(projectOfficeWorkerResult('diff', diff), diff);
		assert.strictEqual(projectOfficeWorkerResult('diff', { ...diff, handle: { kind: 'document', id: 'x' } }), undefined);
	});

	test('enforces projector depth 32 before touching depth 33', () => {
		let atLimitReads = 0;
		const atLimitLeaf = new Proxy({ kind: 'none' }, {
			getPrototypeOf: target => { atLimitReads++; return Reflect.getPrototypeOf(target); },
		});
		const atLimit = diffSummary();
		atLimit.changes[0].before = wrapChangeValue(atLimitLeaf, 14, 0) as typeof atLimit.changes[0]['before'];
		assert.strictEqual(projectOfficeWorkerResult('diff', atLimit), undefined);
		assert.ok(atLimitReads > 0, 'a node at projector depth 32 must be inspected');

		let overLimitReads = 0;
		const overLimitLeaf = new Proxy({ kind: 'none' }, {
			getPrototypeOf: target => { overLimitReads++; return Reflect.getPrototypeOf(target); },
		});
		const overLimit = diffSummary();
		overLimit.changes[0].before = wrapChangeValue(overLimitLeaf, 13, 1) as typeof overLimit.changes[0]['before'];
		assert.strictEqual(projectOfficeWorkerResult('diff', overLimit), undefined);
		assert.strictEqual(overLimitReads, 0, 'a node at projector depth 33 must remain untouched');
	});

	test('enforces projector node 65,536 before touching node 65,537', () => {
		const exact = { ...parseSummary(), capabilities: Array.from({ length: 65_518 }, () => '') };
		assert.notStrictEqual(projectOfficeWorkerResult('parse', exact), undefined);

		let sentinelTouched = false;
		const overCapabilities = new Proxy(Array.from({ length: 65_519 }, () => ''), {
			getOwnPropertyDescriptor(target, key) {
				if (key === '65518') { sentinelTouched = true; }
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		assert.strictEqual(projectOfficeWorkerResult('parse', { ...parseSummary(), capabilities: overCapabilities }), undefined);
		assert.strictEqual(sentinelTouched, false);
	});

	test('stops projecting a shared DAG before reading later pending work', () => {
		const shared = diffSummary().changes[0];
		let sentinelTouched = false;
		const changes = new Proxy([shared, shared, diffSummary().changes[0]], {
			getOwnPropertyDescriptor(target, key) {
				if (key === '2') { sentinelTouched = true; }
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		const value = { ...diffSummary(), changes };
		assert.strictEqual(projectOfficeWorkerResult('diff', value), undefined);
		assert.strictEqual(sentinelTouched, false);
	});

	test('rejects nested path and stack fields and returns a fully fresh valid diff tree', () => {
		const pathBearing = diffSummary();
		pathBearing.changes[0].subject = { ...pathBearing.changes[0].subject, path: '/private/document.docx' } as typeof pathBearing.changes[0]['subject'];
		assert.strictEqual(projectOfficeWorkerResult('diff', pathBearing), undefined);
		const stackBearing = diffSummary();
		stackBearing.changes[0].after = { ...stackBearing.changes[0].after, stack: 'private stack' } as typeof stackBearing.changes[0]['after'];
		assert.strictEqual(projectOfficeWorkerResult('diff', stackBearing), undefined);

		const input = diffSummary();
		input.changes[0].before = {
			kind: 'record',
			fields: [{ name: 'nested', value: { kind: 'list', items: [{ kind: 'scalar', valueType: 'text', value: 'before' }] } }],
		} as typeof input.changes[0]['before'];
		const output = projectOfficeWorkerResult('diff', input);
		assert.notStrictEqual(output, undefined);
		assertFreshData(input, output);
	});

	test('rejects extra, path-bearing, and Proxy worker summaries', async () => {
		for (const value of [{ ...parseSummary(), path: '/private/document.xlsx', stack: 'secret' }]) {
			const worker = new FakeWorker();
			const host = new OfficeWorkerHost({ createWorker: () => worker });
			const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
			worker.emit({ kind: 'result', requestId: '1', value });
			assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		}
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		const proxy = new Proxy(parseSummary(), { getOwnPropertyDescriptor: () => { throw new Error('getter'); } });
		worker.emit({ kind: 'result', requestId: '1', value: proxy });
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('snapshots a valid inventory and rejects getters, post-validation mutation, and path keys', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const original = { inventory: inspectInventory() };
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		worker.emit({ kind: 'result', requestId: '1', value: original });
		const complete = await result;
		assert.strictEqual(complete.outcome, 'complete');
		if (complete.outcome === 'complete') { assert.notStrictEqual(complete.value, original); }

		for (const value of [
			{ inventory: inspectInventory(), path: '/private/document.docx' },
			{ inventory: inspectInventory(), stack: 'private stack' },
			Object.defineProperty({ inventory: inspectInventory() }, 'path', { enumerable: true, get: () => '/private' }),
		]) {
			const invalidWorker = new FakeWorker();
			const invalidHost = new OfficeWorkerHost({ createWorker: () => invalidWorker });
			const invalid = invalidHost.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
			invalidWorker.emit({ kind: 'result', requestId: '1', value });
			assert.deepStrictEqual(await invalid, { outcome: 'failed', error: 'engineCrashed' });
		}

		const changingInventory = inspectInventory();
		let inventoryDescriptorReads = 0;
		const mutating = new Proxy({ inventory: changingInventory }, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'inventory' && ++inventoryDescriptorReads === 2) { changingInventory.security.hasMacros = 'not-a-boolean' as never; }
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		const mutatingWorker = new FakeWorker();
		const mutatingHost = new OfficeWorkerHost({ createWorker: () => mutatingWorker });
		const invalid = mutatingHost.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		mutatingWorker.emit({ kind: 'result', requestId: '1', value: mutating });
		assert.deepStrictEqual(await invalid, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('rejects a valid-to-valid descriptor mutation between fresh projection passes', async () => {
		const inventory = inspectInventory();
		let reads = 0;
		const value = new Proxy({ inventory }, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'inventory' && ++reads === 2) { inventory.budgetProfile = 'browser'; }
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('inspect', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		worker.emit({ kind: 'result', requestId: '1', value });
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('rejects parse and diff summaries with incomplete nested payloads', async () => {
		for (const value of [
			{ ...parseSummary(), completeness: {} },
			{ operation: 'diff', handle: { kind: 'comparison', id: 'handle-2' }, outcome: 'complete', completeness: completeness(), changes: [{ path: '/private' }] },
		]) {
			const worker = new FakeWorker();
			const host = new OfficeWorkerHost({ createWorker: () => worker });
			const operation = value.operation as 'parse' | 'diff';
			const result = host.run(operation, 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
			worker.emit({ kind: 'result', requestId: '1', value });
			assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		}
	});

	test('maps an abnormal worker exit to engineCrashed', async () => {
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		worker.exit(23);
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
	});

	test('invalidates only the crashed worker handle owner', async () => {
		let randomSeed = 5;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const crashed = store.create('client-a', 'document', 'revision-a', 1, 'worker-a');
		const retained = store.create('client-b', 'document', 'revision-b', 1, 'worker-b');
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, onWorkerCrashed: workerId => store.invalidateWorker(workerId) });
		const result = host.run('parse', 'client-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) }, { workerId: 'worker-a' });
		worker.fail(new Error('untrusted stack'));
		assert.deepStrictEqual(await result, { outcome: 'failed', error: 'engineCrashed' });
		assert.strictEqual(store.get(crashed), undefined);
		assert.notStrictEqual(store.get(retained), undefined);
	});

	test('queues fairly and rejects an admission which cannot reserve memory', async () => {
		const workers: FakeWorker[] = [];
		const clock = new FakeClock();
		const host = new OfficeWorkerHost({
			createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
			now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
			memory: { limitBytes: 256, workerReservationBytes: 128 },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const a = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const b = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const c = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		assert.strictEqual(workers.length, 2);
		workers[0].emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.strictEqual(workers.length, 3);
		workers[1].emit({ kind: 'result', requestId: '2', value: parseSummary() });
		workers[2].emit({ kind: 'result', requestId: '3', value: parseSummary() });
		assert.deepStrictEqual(await Promise.all([a, b, c]), [{ outcome: 'complete', value: parseSummary() }, { outcome: 'complete', value: parseSummary() }, { outcome: 'complete', value: parseSummary() }]);
		const blocked = await host.run('parse', 'c', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token, { reservationBytes: 385 });
		assert.deepStrictEqual(blocked, { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('enforces two workers per client and four globally before admitting the next FIFO request', async () => {
		const workers: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, memory: { limitBytes: 4096, workerReservationBytes: 1 } });
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const requests = [
			host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
			host.run('parse', 'c', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token),
		];
		assert.strictEqual(host.activeWorkerCount, 4);
		assert.strictEqual(host.queuedWorkerCount, 1);
		workers[0].emit({ kind: 'result', requestId: '1', value: {} });
		assert.strictEqual(host.activeWorkerCount, 4);
		for (let index = 1; index < workers.length; index++) { workers[index].emit({ kind: 'result', requestId: String(index + 1), value: {} }); }
		await Promise.all(requests);
	});

	test('cancels a queued request without creating a worker', async () => {
		const first = new FakeWorker();
		let created = 0;
		const host = new OfficeWorkerHost({ createWorker: () => { created++; return first; }, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		const running = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		const cancellation = new CancellationTokenSource();
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		cancellation.cancel();
		assert.deepStrictEqual(await queued, { outcome: 'cancelled' });
		assert.strictEqual(created, 1);
		first.emit({ kind: 'result', requestId: '1', value: {} });
		await running;
	});

	test('does not release another active worker reservation when a queued job is cancelled', async () => {
		const accountant = new OfficeMemoryAccountant(100);
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, accountant, memory: { limitBytes: 100, workerReservationBytes: 100 } });
		const running = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		const cancellation = new CancellationTokenSource();
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, cancellation.token);
		assert.strictEqual(accountant.snapshot().workerBytes, 100);
		cancellation.cancel();
		assert.deepStrictEqual(await queued, { outcome: 'cancelled' });
		assert.strictEqual(accountant.snapshot().workerBytes, 100);
		worker.emit({ kind: 'result', requestId: '1', value: parseSummary() });
		await running;
		assert.strictEqual(accountant.snapshot().workerBytes, 0);
	});

	test('times out a queued admission at 30 seconds', async () => {
		const clock = new FakeClock();
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		void host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(30_000);
		assert.deepStrictEqual(await queued, { outcome: 'blocked', error: 'limitExceeded' });
		host.dispose();
	});

	test('starts an operation deadline only after a 29-second queue wait', async () => {
		const clock = new FakeClock();
		const workers: FakeWorker[] = [];
		const host = new OfficeWorkerHost({ createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, memory: { limitBytes: 1, workerReservationBytes: 1 } });
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const first = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		const queued = host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		clock.advance(29_000);
		workers[0].emit({ kind: 'result', requestId: '1', value: parseSummary() });
		clock.advance(59_999);
		workers[1].emit({ kind: 'result', requestId: '2', value: parseSummary() });
		assert.strictEqual((await queued).outcome, 'complete');
		await first;
	});

	test('blocks a result at its exact operation deadline and idle get cannot revive after a delayed timer', async () => {
		const clock = new FakeClock();
		const worker = new FakeWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
		const result = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) });
		clock.advance(60_000);
		worker.emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.deepStrictEqual(await result, { outcome: 'blocked', error: 'limitExceeded' });
		let randomSeed = 90;
		const store = new OfficeHandleStore({ now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const handle = store.create('owner', 'document', 'revision', 1);
		clock.jump(10 * 60 * 1000);
		assert.strictEqual(store.get(handle), undefined);
	});

	test('evicts inactive cache before a reservation and releases it once after completion', async () => {
		const workers: FakeWorker[] = [];
		let cache = 128;
		const host = new OfficeWorkerHost({
			createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
			memory: { limitBytes: 256, workerReservationBytes: 128, cacheBytes: () => cache, spoolBytes: () => 16, derivedAssetBytes: () => 16, evictInactiveCache: required => { cache = Math.max(0, cache - required); return required; } },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { }) };
		const first = host.run('parse', 'a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		assert.strictEqual(cache, 96);
		workers[0].emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.deepStrictEqual(await first, { outcome: 'complete', value: parseSummary() });
		assert.strictEqual(host.activeWorkerCount, 0);
		assert.deepStrictEqual(await host.run('parse', 'b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token, { reservationBytes: Number.MAX_SAFE_INTEGER + 1 }), { outcome: 'blocked', error: 'limitExceeded' });
	});

	test('uses the shared accountant eviction deficit and never leaves a failed reservation', async () => {
		const accountant = new OfficeMemoryAccountant(150);
		accountant.setCache(100);
		const workers: FakeWorker[] = [];
		const host = new OfficeWorkerHost({
			createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
			accountant,
			memory: { limitBytes: 150, workerReservationBytes: 100, evictInactiveCache: required => { assert.strictEqual(required, 50); accountant.setCache(50); return required; } },
		});
		const result = host.run('parse', 'owner-a', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		assert.strictEqual(workers.length, 1);
		assert.strictEqual(accountant.snapshot().workerBytes, 100);
		workers[0].emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.strictEqual((await result).outcome, 'complete');
		assert.strictEqual(accountant.snapshot().workerBytes, 0);

		const clock = new FakeClock();
		const rejectedAccountant = new OfficeMemoryAccountant(100);
		rejectedAccountant.setCache(100);
		const rejected = new OfficeWorkerHost({
			createWorker: () => { throw new Error('must not create'); }, now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
			accountant: rejectedAccountant,
			memory: { limitBytes: 100, workerReservationBytes: 1, evictInactiveCache: () => { throw new Error('eviction failed'); } },
		});
		const queued = rejected.run('parse', 'owner-b', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		clock.advance(30_000);
		assert.deepStrictEqual(await queued, { outcome: 'blocked', error: 'limitExceeded' });
		assert.strictEqual(rejectedAccountant.snapshot().workerBytes, 0);
	});

	test('keeps every accountant category and cache map unchanged when a global admission is denied', () => {
		const accountant = new OfficeMemoryAccountant(10);
		assert.strictEqual(accountant.trySetCache(6), true);
		assert.strictEqual(accountant.trySetSpool(5), false);
		assert.deepStrictEqual(accountant.snapshot(), { limitBytes: 10, workerBytes: 0, cacheBytes: 6, handleBytes: 0, spoolBytes: 0, derivedAssetBytes: 0, totalBytes: 6 });
		assert.strictEqual(accountant.trySetCache(0), true);
		assert.strictEqual(accountant.trySetSpool(6), true);
		const store = new OfficeHandleStore({ accountant, semanticCacheLimitBytes: 10, randomBytes: length => new Uint8Array(length).fill(1) });
		assert.strictEqual(store.putSemanticCache('active', 6, true), false);
		assert.strictEqual(store.semanticCacheBytes, 0);
		assert.deepStrictEqual(accountant.snapshot(), { limitBytes: 10, workerBytes: 0, cacheBytes: 0, handleBytes: 0, spoolBytes: 6, derivedAssetBytes: 0, totalBytes: 6 });
	});

	test('keeps spool, derived assets, and retained handles atomic on global over-limit updates', () => {
		const accountant = new OfficeMemoryAccountant(15);
		accountant.setSpool(4);
		accountant.setDerivedAssets(4);
		let randomSequence = 0;
		const store = new OfficeHandleStore({ accountant, randomBytes: length => new Uint8Array(length).fill(++randomSequence) });
		const retained = store.create('owner-a', 'document', 'revision-a', 4);
		const before = { accountant: accountant.snapshot(), size: store.size, semanticCacheBytes: store.semanticCacheBytes, record: store.get(retained), randomSequence };

		assert.throws(() => accountant.setSpool(8), RangeError);
		assert.strictEqual(accountant.trySetDerivedAssets(8), false);
		assert.throws(
			() => store.create('owner-b', 'comparison', 'revision-b', 4),
			error => error instanceof OfficeHandleStoreError && error.code === 'memoryExceeded',
		);

		assert.deepStrictEqual({ accountant: accountant.snapshot(), size: store.size, semanticCacheBytes: store.semanticCacheBytes, record: store.get(retained), randomSequence }, before);
	});

	test('does not post or schedule after a synchronous listener terminal transition', async () => {
		class SynchronousResultWorker extends FakeWorker {
			override onMessage(listener: (message: unknown) => void): IDisposable {
				const disposable = super.onMessage(listener);
				listener({ kind: 'result', requestId: '1', value: parseSummary() });
				return disposable;
			}
		}
		const worker = new SynchronousResultWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		const result = await host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		assert.deepStrictEqual(result, { outcome: 'complete', value: parseSummary() });
		assert.deepStrictEqual(worker.messages, []);
		assert.strictEqual(host.activeWorkerCount, 0);
	});

	test('disposes cancellation exactly once when registration fires synchronously', async () => {
		let listenerDisposals = 0;
		let workerCreations = 0;
		const host = new OfficeWorkerHost({ createWorker: () => { workerCreations++; return new FakeWorker(); } });
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				listener();
				return toDisposable(() => { listenerDisposals++; });
			},
		};
		assert.deepStrictEqual(await host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token), { outcome: 'cancelled' });
		assert.deepStrictEqual({ listenerDisposals, workerCreations }, { listenerDisposals: 1, workerCreations: 0 });
	});

	test('cleans up when the queue timer fires synchronously', async () => {
		let listenerDisposals = 0;
		let workerCreations = 0;
		const cleared: unknown[] = [];
		const host = new OfficeWorkerHost({
			createWorker: () => { workerCreations++; return new FakeWorker(); },
			setTimeout: runner => { runner(); return 'queue-timer'; },
			clearTimeout: handle => { cleared.push(handle); },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { listenerDisposals++; }) };
		assert.deepStrictEqual(await host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token), { outcome: 'blocked', error: 'limitExceeded' });
		assert.deepStrictEqual({ listenerDisposals, workerCreations, cleared }, { listenerDisposals: 1, workerCreations: 0, cleared: ['queue-timer'] });
	});

	test('terminates and disposes listeners when the deadline timer fires synchronously', async () => {
		const worker = new ObservedWorker();
		let timerSequence = 0;
		let cancellationDisposals = 0;
		const host = new OfficeWorkerHost({
			createWorker: () => worker,
			setTimeout: (runner, delay) => {
				const handle = `timer-${++timerSequence}`;
				if (delay === PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.semanticParseMilliseconds) { runner(); }
				return handle;
			},
			clearTimeout: () => { },
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { cancellationDisposals++; }) };
		assert.deepStrictEqual(await host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token), { outcome: 'blocked', error: 'limitExceeded' });
		assert.deepStrictEqual({ terminateCalls: worker.terminateCalls, listenerDisposals: worker.listenerDisposals, cancellationDisposals, messages: worker.messages }, {
			terminateCalls: 1, listenerDisposals: { message: 1, error: 1, exit: 1 }, cancellationDisposals: 1, messages: [],
		});
	});

	test('terminates and disposes listeners when the cancel timer fires synchronously', async () => {
		const worker = new ObservedWorker();
		let cancellationListener: (() => void) | undefined;
		let cancellationDisposals = 0;
		const host = new OfficeWorkerHost({
			createWorker: () => worker,
			setTimeout: (runner, delay) => {
				const handle = Symbol(`timer-${delay}`);
				if (delay === 250) { runner(); }
				return handle;
			},
			clearTimeout: () => { },
		});
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => { cancellationListener = listener; return toDisposable(() => { cancellationDisposals++; }); },
		};
		const result = host.run('parse', 'owner-cancel', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		cancellationListener?.();
		assert.strictEqual((await result).outcome, 'cancelled');
		assert.deepStrictEqual({ terminateCalls: worker.terminateCalls, listenerDisposals: worker.listenerDisposals, cancellationDisposals }, {
			terminateCalls: 1, listenerDisposals: { message: 1, error: 1, exit: 1 }, cancellationDisposals: 1,
		});
	});

	test('settles only through a synchronously fired reap timer and releases on late exit', async () => {
		const events: string[] = [];
		class PendingTerminationWorker extends ObservedWorker {
			override terminate(): Promise<number> {
				this.terminateCalls++;
				events.push('terminate');
				return new Promise(() => { });
			}
		}
		const accountant = new CountingMemoryAccountant(100);
		const worker = new PendingTerminationWorker();
		let timerSequence = 0;
		let cancellationDisposals = 0;
		const timerKinds = new Map<object, string>();
		const host = new OfficeWorkerHost({
			createWorker: () => worker,
			accountant,
			memory: { workerReservationBytes: 100 },
			setTimeout: (runner, delay) => {
				const kind = delay === 30_000 ? 'queue' : delay === 60_000 ? 'deadline' : 'reap';
				const handle = { id: ++timerSequence, kind };
				timerKinds.set(handle, kind);
				events.push(`register:${kind}:${handle.id}`);
				if (kind === 'reap') { events.push(`fire:${kind}:${handle.id}`); runner(); }
				return handle;
			},
			clearTimeout: handle => {
				const timer = handle as { readonly id: number };
				events.push(`clear:${timerKinds.get(handle as object)}:${timer.id}`);
			},
		});
		const token = { isCancellationRequested: false, onCancellationRequested: () => toDisposable(() => { cancellationDisposals++; }) };
		const result = host.run('parse', 'owner-reap', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, token);
		worker.emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.deepStrictEqual(await result, { outcome: 'complete', value: parseSummary() });
		assert.deepStrictEqual(events, [
			'register:queue:1', 'clear:queue:1', 'register:deadline:2', 'clear:deadline:2',
			'register:reap:3', 'fire:reap:3', 'clear:reap:3', 'terminate',
		]);
		assert.deepStrictEqual({ active: host.activeWorkerCount, workerBytes: accountant.snapshot().workerBytes, listenerDisposals: worker.listenerDisposals, cancellationDisposals }, {
			active: 1, workerBytes: 100, listenerDisposals: { message: 0, error: 0, exit: 0 }, cancellationDisposals: 1,
		});

		worker.exit(1);
		worker.exit(1);
		assert.deepStrictEqual({ active: host.activeWorkerCount, releaseWorkerCalls: accountant.releaseWorkerCalls, workerBytes: accountant.snapshot().workerBytes, listenerDisposals: worker.listenerDisposals }, {
			active: 0, releaseWorkerCalls: 1, workerBytes: 0, listenerDisposals: { message: 1, error: 1, exit: 1 },
		});
	});

	test('retains and releases a reaped worker reservation exactly once on late exit', async () => {
		const accountant = new CountingMemoryAccountant(100);
		const worker = new ObservedWorker();
		worker.emitExitOnTerminate = false;
		worker.terminateResult = Promise.reject(new Error('termination rejected'));
		const host = new OfficeWorkerHost({ createWorker: () => worker, accountant, memory: { workerReservationBytes: 100 } });
		const result = host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken);
		worker.emit({ kind: 'result', requestId: '1', value: parseSummary() });
		assert.deepStrictEqual(await result, { outcome: 'complete', value: parseSummary() });
		assert.deepStrictEqual(accountant.snapshot(), { limitBytes: 100, workerBytes: 100, cacheBytes: 0, handleBytes: 0, spoolBytes: 0, derivedAssetBytes: 0, totalBytes: 100 });
		worker.exit(1);
		worker.exit(1);
		assert.deepStrictEqual({ releaseWorkerCalls: accountant.releaseWorkerCalls, snapshot: accountant.snapshot() }, {
			releaseWorkerCalls: 1,
			snapshot: { limitBytes: 100, workerBytes: 0, cacheBytes: 0, handleBytes: 0, spoolBytes: 0, derivedAssetBytes: 0, totalBytes: 0 },
		});
	});

	test('disposes listeners and does not post after a synchronous exit registration', async () => {
		class SynchronousExitWorker extends FakeWorker {
			override onExit(listener: (code: number) => void): IDisposable {
				const disposable = super.onExit(listener);
				listener(1);
				return disposable;
			}
		}
		const worker = new SynchronousExitWorker();
		const host = new OfficeWorkerHost({ createWorker: () => worker });
		assert.deepStrictEqual(await host.run('parse', 'owner', source(), PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal, uncancelledToken), { outcome: 'failed', error: 'engineCrashed' });
		assert.deepStrictEqual(worker.messages, []);
	});

	test('rejects oversized or overflowing handles before retaining an owner entry and rolls back failed creation', () => {
		const accountant = new OfficeMemoryAccountant(1024 * 1024 * 1024);
		let randomCalls = 0;
		const store = new OfficeHandleStore({
			accountant, randomBytes: length => {
				randomCalls++;
				if (randomCalls === 2) { throw new Error('randomness failure'); }
				return new Uint8Array(length).fill(randomCalls);
			}
		});
		assert.throws(() => store.create('owner-a', 'document', 'large', 512 * 1024 * 1024 + 1));
		assert.throws(() => store.create('owner-b', 'document', 'overflow', Number.MAX_SAFE_INTEGER));
		assert.strictEqual(store.size, 0);
		assert.strictEqual(accountant.snapshot().handleBytes, 0);
		assert.throws(() => store.create('owner-c', 'document', 'random-failure', 1));
		assert.strictEqual(store.size, 0);
		assert.strictEqual(accountant.snapshot().handleBytes, 0);
	});

	test('releases a reserved handle when idle timer setup fails', () => {
		const accountant = new OfficeMemoryAccountant(100);
		const store = new OfficeHandleStore({
			accountant,
			randomBytes: length => new Uint8Array(length).fill(1),
			createIdleTimer: () => ({ schedule: () => { throw new Error('timer failed'); }, dispose: () => { throw new Error('dispose failed'); } }),
		});
		assert.throws(() => store.create('owner', 'document', 'revision', 1));
		assert.strictEqual(store.size, 0);
		assert.strictEqual(accountant.snapshot().handleBytes, 0);
	});

	test('makes owner capabilities unforgeable, expires idle handles, and invalidates a worker crash only for its handles', () => {
		const clock = new FakeClock();
		let randomSeed = 0;
		const store = new OfficeHandleStore({ now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const first = store.create('client-a', 'document', 'revision-1', 8, 'worker-a');
		const second = store.create('client-b', 'comparison', 'revision-2', 8, 'worker-b');
		assert.strictEqual(store.get({ ...first, nonce: '0'.repeat(64) }), undefined);
		assert.strictEqual(store.get({ ...first, ownerId: 'client-b' }), undefined);
		store.invalidateWorker('worker-a');
		assert.strictEqual(store.get(first), undefined);
		assert.notStrictEqual(store.get(second), undefined);
		clock.advance(10 * 60 * 1000);
		assert.strictEqual(store.get(second), undefined);
		assert.strictEqual(store.close(second), false);
	});

	test('enforces four combined document and comparison handles per owner', () => {
		let randomSeed = 10;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		for (let index = 0; index < 4; index++) { store.create('client-a', index % 2 === 0 ? 'document' : 'comparison', `revision-${index}`, 1); }
		assert.throws(() => store.create('client-a', 'document', 'revision-5', 1), error => error instanceof Error && error.name === 'OfficeHandleStoreError');
	});

	test('shares cache and handle accounting across the host and handle store', () => {
		const accountant = new OfficeMemoryAccountant(100);
		let randomSeed = 60;
		const store = new OfficeHandleStore({ accountant, semanticCacheLimitBytes: 100, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		assert.strictEqual(store.putSemanticCache('cache', 20), true);
		const handle = store.create('client-a', 'document', 'revision', 30);
		assert.deepStrictEqual(accountant.snapshot(), { limitBytes: 100, workerBytes: 0, cacheBytes: 20, handleBytes: 30, spoolBytes: 0, derivedAssetBytes: 0, totalBytes: 50 });
		assert.strictEqual(store.close(handle), true);
		assert.strictEqual(accountant.snapshot().handleBytes, 0);
		assert.throws(() => accountant.setSpool(-1));
	});

	test('preserves active cache and handle entries while evicting inactive LRU entries', () => {
		const clock = new FakeClock();
		let randomSeed = 20;
		const store = new OfficeHandleStore({ now: clock.read, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, semanticCacheLimitBytes: 10, randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		assert.strictEqual(store.putSemanticCache('old', 6), true);
		clock.advance(1);
		assert.strictEqual(store.putSemanticCache('pinned', 4, true), true);
		assert.strictEqual(store.putSemanticCache('next', 6), true);
		assert.strictEqual(store.semanticCacheBytes, 10);
		const inactive = store.create('client-a', 'document', 'old-revision', 4);
		const active = store.create('client-a', 'comparison', 'new-revision', 4);
		store.setActive(active, true);
		assert.strictEqual(store.evictInactiveHandles(4), 4);
		assert.strictEqual(store.get(inactive), undefined);
		assert.notStrictEqual(store.get(active), undefined);
	});

	test('closes all owner handles on renderer crash and invalidates revision handles idempotently', () => {
		let randomSeed = 40;
		const store = new OfficeHandleStore({ randomBytes: length => new Uint8Array(length).fill(++randomSeed) });
		const revision = store.create('client-a', 'document', 'revision-shared', 1);
		const other = store.create('client-a', 'comparison', 'revision-other', 1);
		store.invalidateRevision('revision-shared');
		assert.strictEqual(store.get(revision), undefined);
		store.onRendererCrash('client-a');
		assert.strictEqual(store.get(other), undefined);
		assert.strictEqual(store.close(other), false);
	});
});

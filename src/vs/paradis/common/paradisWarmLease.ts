/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Emitter, Event } from '../../base/common/event.js';
import { IDisposable } from '../../base/common/lifecycle.js';

export const PARADIS_WARM_LEASE_DURATION_MS = 900_000;
export const PARADIS_WARM_LEASE_RENEW_INTERVAL_MS = 300_000;

export interface IParadisWarmLeaseScheduler extends IDisposable {
	schedule(delay: number): void;
	cancel(): void;
}

export type ParadisWarmLeaseTargetValue = undefined
	| null
	| boolean
	| number
	| string
	| readonly ParadisWarmLeaseTargetValue[]
	| { readonly [key: string]: ParadisWarmLeaseTargetValue };

export interface IParadisWarmLeaseTargetSnapshot<TTarget extends ParadisWarmLeaseTargetValue> {
	readonly key: string;
	readonly target: TTarget;
	readonly generation: number;
}

export interface IParadisWarmLeaseLimits {
	readonly maxOwners: number;
	readonly maxTargetsPerOwner: number;
	readonly maxDistinctTargets: number;
	readonly maxTotalMemberships: number;
	readonly maxTotalCost: number;
}

interface IParadisWarmLeaseOwner<TTarget extends ParadisWarmLeaseTargetValue> {
	readonly expiresAt: number;
	readonly renewSequence: number;
	readonly targets: ReadonlyMap<string, TTarget>;
	readonly cost: number;
}

type SchedulerFactory = (runner: () => void) => IParadisWarmLeaseScheduler;

const cloneRejected = Symbol('cloneRejected');

function cloneAndFreezeTarget<TTarget extends ParadisWarmLeaseTargetValue>(target: TTarget): TTarget | typeof cloneRejected {
	try {
		const clone = cloneTargetValue(target, new Set<object>());
		return clone === cloneRejected ? cloneRejected : clone as TTarget;
	} catch {
		return cloneRejected;
	}
}

function cloneTargetValue(value: unknown, ancestors: Set<object>): unknown | typeof cloneRejected {
	if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value !== 'object') {
		return cloneRejected;
	}
	if (ancestors.has(value)) {
		return cloneRejected;
	}

	ancestors.add(value);
	const clone = Array.isArray(value)
		? cloneTargetArray(value, ancestors)
		: cloneTargetObject(value, ancestors);
	ancestors.delete(value);
	return clone === cloneRejected ? cloneRejected : Object.freeze(clone);
}

function cloneTargetArray(value: readonly unknown[], ancestors: Set<object>): unknown | typeof cloneRejected {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			return cloneRejected;
		}
		if (key === 'length') {
			continue;
		}
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
			return cloneRejected;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return cloneRejected;
		}
	}

	const clone: unknown[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return cloneRejected;
		}
		const item = cloneTargetValue(descriptor.value, ancestors);
		if (item === cloneRejected) {
			return cloneRejected;
		}
		clone.push(item);
	}
	return clone;
}

function cloneTargetObject(value: object, ancestors: Set<object>): unknown | typeof cloneRejected {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		return cloneRejected;
	}

	const clone = Object.create(prototype) as Record<string, unknown>;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string') {
			return cloneRejected;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
			return cloneRejected;
		}
		const property = cloneTargetValue(descriptor.value, ancestors);
		if (property === cloneRejected) {
			return cloneRejected;
		}
		Object.defineProperty(clone, key, { value: property, enumerable: true, writable: true, configurable: true });
	}
	return clone;
}

/**
 * 複数の owner が保持する warm 対象を合成し、最新の renewal を有効値として公開する。
 */
export class ParadisWarmLeaseTracker<TTarget extends ParadisWarmLeaseTargetValue> implements IDisposable {
	private readonly owners = new Map<string, IParadisWarmLeaseOwner<TTarget>>();
	private readonly ownersByTarget = new Map<string, Map<string, TTarget>>();
	private readonly snapshots = new Map<string, IParadisWarmLeaseTargetSnapshot<TTarget>>();
	private readonly onDidChangeEmitter = new Emitter<void>();
	private readonly scheduler: IParadisWarmLeaseScheduler;
	private nextRenewSequence = 0;
	private nextGeneration = 0;
	private disposed = false;

	readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

	constructor(
		private readonly keyOf: (target: TTarget) => string,
		private readonly equals: (left: TTarget, right: TTarget) => boolean,
		private readonly costOf: (target: TTarget) => number,
		private readonly now: () => number,
		schedulerFactory: SchedulerFactory,
		private readonly limits: IParadisWarmLeaseLimits,
	) {
		this.scheduler = schedulerFactory(() => {
			if (this.disposed) {
				return;
			}
			this.purgeExpiredLeases(false);
			if (this.disposed) {
				return;
			}
			this.syncExpiryScheduler();
		});
	}

	setLease(ownerId: string, targets: readonly TTarget[]): void {
		if (this.disposed) {
			return;
		}
		this.purgeExpiredLeases();
		if (this.disposed) {
			return;
		}
		if (targets.length === 0) {
			this.removeOwner(ownerId);
			return;
		}

		const ownerTargets = new Map<string, TTarget>();
		for (const target of targets) {
			const clonedTarget = cloneAndFreezeTarget(target);
			if (clonedTarget === cloneRejected) {
				return;
			}
			ownerTargets.set(this.keyOf(clonedTarget), clonedTarget);
		}
		const cost = this.costOfTargets(ownerTargets.values());
		if (cost === undefined || !this.isWithinLimits(ownerId, ownerTargets, cost)) {
			return;
		}

		const previous = this.owners.get(ownerId);
		const affectedKeys = new Set<string>(previous?.targets.keys());
		for (const key of ownerTargets.keys()) {
			affectedKeys.add(key);
		}
		if (previous) {
			this.removeOwnerTargets(ownerId, previous.targets);
		}

		this.owners.set(ownerId, {
			expiresAt: this.now() + PARADIS_WARM_LEASE_DURATION_MS,
			renewSequence: ++this.nextRenewSequence,
			targets: ownerTargets,
			cost,
		});
		for (const [key, target] of ownerTargets) {
			let owners = this.ownersByTarget.get(key);
			if (!owners) {
				owners = new Map();
				this.ownersByTarget.set(key, owners);
			}
			owners.set(ownerId, target);
		}

		this.recomputeSnapshots(affectedKeys);
		this.syncExpiryScheduler();
	}

	release(ownerId: string): void {
		if (this.disposed) {
			return;
		}
		this.purgeExpiredLeases();
		if (this.disposed) {
			return;
		}
		this.removeOwner(ownerId);
	}

	activeTargets(): readonly IParadisWarmLeaseTargetSnapshot<TTarget>[] {
		if (this.disposed) {
			return Object.freeze([]);
		}
		this.purgeExpiredLeases();
		if (this.disposed) {
			return Object.freeze([]);
		}
		return Object.freeze([...this.snapshots.values()].map(snapshot => Object.freeze({ ...snapshot })));
	}

	isCurrent(targetKey: string, generation: number): boolean {
		if (this.disposed) {
			return false;
		}
		this.purgeExpiredLeases();
		if (this.disposed) {
			return false;
		}
		return this.snapshots.get(targetKey)?.generation === generation;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.scheduler.cancel();
		this.scheduler.dispose();
		this.owners.clear();
		this.ownersByTarget.clear();
		this.snapshots.clear();
		this.onDidChangeEmitter.dispose();
	}

	private isWithinLimits(ownerId: string, targets: ReadonlyMap<string, TTarget>, cost: number): boolean {
		const previous = this.owners.get(ownerId);
		if (!previous && this.owners.size >= this.limits.maxOwners) {
			return false;
		}
		if (targets.size > this.limits.maxTargetsPerOwner) {
			return false;
		}

		let membershipCount = targets.size;
		let totalCost = cost;
		const distinctKeys = new Set<string>();
		for (const [id, owner] of this.owners) {
			if (id === ownerId) {
				continue;
			}
			membershipCount += owner.targets.size;
			totalCost += owner.cost;
			for (const key of owner.targets.keys()) {
				distinctKeys.add(key);
			}
		}
		for (const key of targets.keys()) {
			distinctKeys.add(key);
		}

		return membershipCount <= this.limits.maxTotalMemberships
			&& distinctKeys.size <= this.limits.maxDistinctTargets
			&& totalCost <= this.limits.maxTotalCost;
	}

	private costOfTargets(targets: Iterable<TTarget>): number | undefined {
		let totalCost = 0;
		for (const target of targets) {
			const cost = this.costOf(target);
			if (!Number.isFinite(cost) || cost < 0) {
				return undefined;
			}
			totalCost += cost;
		}
		return totalCost;
	}

	private purgeExpiredLeases(syncScheduler = true): boolean {
		const now = this.now();
		const expiredOwnerIds: string[] = [];
		for (const [ownerId, owner] of this.owners) {
			if (owner.expiresAt <= now) {
				expiredOwnerIds.push(ownerId);
			}
		}
		if (expiredOwnerIds.length === 0) {
			return false;
		}

		const affectedKeys = new Set<string>();
		for (const ownerId of expiredOwnerIds) {
			const owner = this.owners.get(ownerId);
			if (!owner) {
				continue;
			}
			this.owners.delete(ownerId);
			this.removeOwnerTargets(ownerId, owner.targets);
			for (const key of owner.targets.keys()) {
				affectedKeys.add(key);
			}
		}
		this.recomputeSnapshots(affectedKeys);
		if (syncScheduler) {
			this.syncExpiryScheduler();
		}
		return true;
	}

	private removeOwner(ownerId: string): void {
		const owner = this.owners.get(ownerId);
		if (!owner) {
			return;
		}
		this.owners.delete(ownerId);
		this.removeOwnerTargets(ownerId, owner.targets);
		this.recomputeSnapshots(owner.targets.keys());
		this.syncExpiryScheduler();
	}

	private removeOwnerTargets(ownerId: string, targets: ReadonlyMap<string, TTarget>): void {
		for (const key of targets.keys()) {
			const owners = this.ownersByTarget.get(key);
			if (!owners) {
				continue;
			}
			owners.delete(ownerId);
			if (owners.size === 0) {
				this.ownersByTarget.delete(key);
			}
		}
	}

	private recomputeSnapshots(keys: Iterable<string>): void {
		let changed = false;
		for (const key of keys) {
			const previous = this.snapshots.get(key);
			const next = this.findLatestTarget(key);
			if (!next) {
				if (previous) {
					this.snapshots.delete(key);
					changed = true;
				}
				continue;
			}
			if (!previous || !this.equals(previous.target, next)) {
				this.snapshots.set(key, Object.freeze({ key, target: next, generation: ++this.nextGeneration }));
				changed = true;
			}
		}
		if (changed) {
			this.onDidChangeEmitter.fire();
		}
	}

	private findLatestTarget(key: string): TTarget | undefined {
		let latestSequence = -1;
		let latestTarget: TTarget | undefined;
		for (const [ownerId, target] of this.ownersByTarget.get(key) ?? []) {
			const owner = this.owners.get(ownerId);
			if (owner && owner.renewSequence > latestSequence) {
				latestSequence = owner.renewSequence;
				latestTarget = target;
			}
		}
		return latestTarget;
	}

	private syncExpiryScheduler(): void {
		if (this.disposed) {
			return;
		}
		this.scheduler.cancel();
		let earliestExpiry = Number.POSITIVE_INFINITY;
		for (const owner of this.owners.values()) {
			earliestExpiry = Math.min(earliestExpiry, owner.expiresAt);
		}
		if (earliestExpiry !== Number.POSITIVE_INFINITY) {
			this.scheduler.schedule(Math.max(0, earliestExpiry - this.now()));
		}
	}
}

export type ParadisWarmLeaseOperation = (ownerId: string) => Promise<void> | void;

/**
 * 1 owner の acquire、renew、release を直列化する heartbeat controller。
 */
export class ParadisWarmLeaseController implements IDisposable {
	private readonly scheduler: IParadisWarmLeaseScheduler;
	private desiredOwnerId: string | undefined;
	private acquiredOwnerId: string | undefined;
	private refreshRequested = false;
	private reconciling = false;
	private disposed = false;

	constructor(
		private readonly acquire: ParadisWarmLeaseOperation,
		private readonly renew: ParadisWarmLeaseOperation,
		private readonly release: ParadisWarmLeaseOperation,
		schedulerFactory: SchedulerFactory,
		private readonly ownerIdFactory: () => string,
	) {
		this.scheduler = schedulerFactory(() => this.refresh());
	}

	setEnabled(enabled: boolean): void {
		if (this.disposed) {
			return;
		}
		if (enabled) {
			if (this.desiredOwnerId) {
				return;
			}
			this.desiredOwnerId = this.ownerIdFactory();
			this.startReconcile();
			return;
		}
		if (!this.desiredOwnerId && !this.acquiredOwnerId) {
			return;
		}
		this.desiredOwnerId = undefined;
		this.refreshRequested = false;
		this.scheduler.cancel();
		this.startReconcile();
	}

	refresh(): void {
		if (this.disposed || !this.desiredOwnerId) {
			return;
		}
		this.refreshRequested = true;
		this.scheduler.cancel();
		this.startReconcile();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.desiredOwnerId = undefined;
		this.refreshRequested = false;
		this.scheduler.cancel();
		this.scheduler.dispose();
		this.startReconcile();
	}

	private startReconcile(): void {
		if (this.reconciling) {
			return;
		}
		this.reconciling = true;
		void this.reconcile();
	}

	private async reconcile(): Promise<void> {
		try {
			while (true) {
				const desiredOwnerId = this.desiredOwnerId;
				const acquiredOwnerId = this.acquiredOwnerId;
				if (acquiredOwnerId) {
					if (acquiredOwnerId !== desiredOwnerId) {
						this.acquiredOwnerId = undefined;
						await this.invoke(this.release, acquiredOwnerId);
						continue;
					}
					if (!this.refreshRequested) {
						return;
					}
					this.refreshRequested = false;
					await this.invoke(this.renew, acquiredOwnerId);
					if (this.acquiredOwnerId === acquiredOwnerId && this.desiredOwnerId === acquiredOwnerId && !this.refreshRequested) {
						this.scheduler.schedule(PARADIS_WARM_LEASE_RENEW_INTERVAL_MS);
						return;
					}
					continue;
				}

				if (!desiredOwnerId) {
					return;
				}
				const acquired = await this.invoke(this.acquire, desiredOwnerId);
				if (!acquired) {
					if (this.desiredOwnerId === desiredOwnerId) {
						this.desiredOwnerId = undefined;
						this.refreshRequested = false;
					}
					continue;
				}
				this.acquiredOwnerId = desiredOwnerId;
				if (this.desiredOwnerId === desiredOwnerId && !this.refreshRequested) {
					this.scheduler.schedule(PARADIS_WARM_LEASE_RENEW_INTERVAL_MS);
					return;
				}
			}
		} finally {
			this.reconciling = false;
		}
	}

	private async invoke(operation: ParadisWarmLeaseOperation, ownerId: string): Promise<boolean> {
		try {
			await operation(ownerId);
			return true;
		} catch {
			return false;
		}
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ターミナルの所属の判定（`paradisTerminalScope.contribution.ts`）が instanceId ごとに持つ台帳を、
 * 1 つの Map にまとめたもの。
 *
 * 前は台帳ごとに別々の Map / Set を持ち、端末が閉じたときに 1 つずつ消していた。新しい台帳を
 * 足して消し忘れると、開け閉めのたびに 1 件ずつ残る。ここでは 1 端末 1 件の記録にまとめ、
 * 閉じたときは {@link ParadisTerminalInstanceRecords.retire} の 1 回で全部消える。
 *
 * 呼び出し側は台帳ごとの見え方（{@link IParadisInstanceMap} / {@link IParadisInstanceSet}）を
 * 今までの Map / Set と同じ書き方で使う。
 */

/** 値を持つ台帳。キーは instanceId。 */
export interface IParadisInstanceMapValues {
	readonly persistentProcessId: number;
	readonly activeScopeCandidate: string | undefined;
	readonly restoreScopeCandidate: string;
	readonly initialCwd: string;
	readonly restartedShellScope: string;
}

/** 印だけの台帳。キーは instanceId。 */
export type ParadisInstanceFlag =
	| 'candidateCaptured'
	| 'initialCwdResolved'
	| 'activeFallback'
	| 'inheritedGroupScope'
	| 'restored'
	| 'sharedPanel'
	| 'sharedPanelMigrated'
	| 'seenOutsideSharedPanel';

type ParadisInstanceRecord = { -readonly [K in keyof IParadisInstanceMapValues]?: IParadisInstanceMapValues[K] } & { [K in ParadisInstanceFlag]?: true };

/** 1 つの台帳の、Map と同じ書き方の見え方。 */
export interface IParadisInstanceMap<V> {
	get(instanceId: number): V | undefined;
	has(instanceId: number): boolean;
	set(instanceId: number, value: V): void;
	delete(instanceId: number): boolean;
}

/** 1 つの印の、Set と同じ書き方の見え方。並びは記録を作った順。 */
export interface IParadisInstanceSet extends Iterable<number> {
	has(instanceId: number): boolean;
	add(instanceId: number): void;
	delete(instanceId: number): boolean;
}

export class ParadisTerminalInstanceRecords {
	private readonly _records = new Map<number, ParadisInstanceRecord>();

	/** 記録のある端末の数（テストと漏れの確認用）。 */
	get size(): number {
		return this._records.size;
	}

	/** 端末が閉じた。すべての台帳から消す。 */
	retire(instanceId: number): void {
		this._records.delete(instanceId);
	}

	map<K extends keyof IParadisInstanceMapValues>(field: K): IParadisInstanceMap<IParadisInstanceMapValues[K]> {
		return {
			get: instanceId => this._records.get(instanceId)?.[field] as IParadisInstanceMapValues[K] | undefined,
			has: instanceId => {
				const record = this._records.get(instanceId);
				return record !== undefined && Object.prototype.hasOwnProperty.call(record, field);
			},
			set: (instanceId, value) => {
				this.recordOf(instanceId)[field] = value;
			},
			delete: instanceId => this.deleteField(instanceId, field),
		};
	}

	flag(field: ParadisInstanceFlag): IParadisInstanceSet {
		const records = this._records;
		return {
			has: instanceId => records.get(instanceId)?.[field] === true,
			add: instanceId => {
				this.recordOf(instanceId)[field] = true;
			},
			delete: instanceId => this.deleteField(instanceId, field),
			*[Symbol.iterator]() {
				for (const [instanceId, record] of records) {
					if (record[field] === true) {
						yield instanceId;
					}
				}
			},
		};
	}

	private recordOf(instanceId: number): ParadisInstanceRecord {
		let record = this._records.get(instanceId);
		if (record === undefined) {
			record = {};
			this._records.set(instanceId, record);
		}
		return record;
	}

	private deleteField(instanceId: number, field: keyof ParadisInstanceRecord): boolean {
		const record = this._records.get(instanceId);
		if (record === undefined || !Object.prototype.hasOwnProperty.call(record, field)) {
			return false;
		}
		delete record[field];
		// 空になった記録は残さない（中身の無い記録が開け閉めのたびに溜まらないように）。
		if (Object.keys(record).length === 0) {
			this._records.delete(instanceId);
		}
		return true;
	}
}

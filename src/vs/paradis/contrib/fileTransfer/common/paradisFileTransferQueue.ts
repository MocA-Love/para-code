/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 2 画面のファイル転送の待ち行列。
//
// `IFileService.copy` はプロバイダーをまたぐとストリームで流すが、バイト単位の進み具合も取り消しも
// 受け取らない。そこで 1 ファイルずつ `IParadisTransferFileSystem.copyFile` を呼び、フォルダーは再帰で
// 展開する。並行は既定 2 本で、残りは待つ。
//
// データを守るための約束（2026-10-02 のレビューで決めた）:
// - 書き込みは読み書きの口の側で「一時名に書いて rename」する。待ち行列は送り先を消さない
//   （種類の違う同名を、確認を取ったうえで置き換えるときだけ `removeForReplace` を呼ぶ）
// - 取り消しは、実行が本当に終わるまで同時に流れる数に数える。再試行は前の実行が終わるのを待つ
// - `overwrite: false` の項目は、実行の直前にも送り先の有無を確かめる（待っている間にできた同名や、
//   同時に積んだ別の転送が同じ送り先を選んだ場合を、黙って上書きしないため）
//
// 同じ名前の確認は、Para ホストのビュー（paradisRemoteHostsTransfer.ts）と同じく**積む前に**まとめて聞く。
// 一覧は送り先のフォルダーを 1 回だけ読み、項目ごとに stat しない（SSH では往復が項目数ぶんになる）。

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, extUri, isEqualOrParent, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { paradisNumberedName } from './paradisFileTransferListing.js';
import {
	IParadisConflictDecision,
	IParadisTransferError,
	IParadisTransferFileSystem,
	IParadisTransferItem,
	IParadisTransferRequest,
	IParadisTransferSource,
	IParadisTransferStat,
	IParadisTransferSummary,
	paradisClassifyTransferError,
	paradisDescribeTransferError,
	paradisIsSkippableInsideFolder,
	ParadisConflictResolver,
	ParadisTransferConflictError,
	ParadisTransferErrorKind,
	ParadisTransferSpecialFileError,
} from './paradisFileTransferQueueTypes.js';

export * from './paradisFileTransferQueueTypes.js';

export interface IParadisTransferQueueOptions {
	readonly fileSystem: IParadisTransferFileSystem;
	/** 同時に流す項目の数。 */
	readonly concurrency?: number;
	/** 時計（テストで差し替える）。 */
	readonly now?: () => number;
	/** 接続が切れているか。切れているときの失敗は「接続が切れた」として出す。 */
	readonly isDisconnected?: (item: IParadisTransferItem) => boolean;
}

/** 速度を計る窓。これより古い標本は捨てる。 */
const SPEED_WINDOW_MS = 5000;
/** 速度を出し始めるまでの最短の経過時間。 */
const SPEED_MIN_SPAN_MS = 500;
/** 進み具合の通知の最短の間隔（大量の小さな塊で描き直しが詰まらないように）。 */
const PROGRESS_EVENT_INTERVAL_MS = 100;
/** 「名前を変える」で探す番号の上限。 */
const MAX_RENAME_ATTEMPTS = 9999;

type MutableItem = {
	-readonly [K in keyof IParadisTransferItem]: IParadisTransferItem[K];
};

interface IEntry {
	readonly item: MutableItem;
	/** 送り先の同名を置き換えてよいか（利用者が「上書き」を選んだ）。 */
	overwrite: boolean;
	/** 種類の違う同名（ファイル ⇔ フォルダー）を、取り除いてから置き換えてよいか（専用の確認を経た）。 */
	replaceKind: boolean;
	/** 実行の直前に同名ができていたときに聞く先。自動の流し直しでは無い（黙って失敗にする）。 */
	resolveConflict: ParadisConflictResolver | undefined;
	cancellation: CancellationTokenSource | undefined;
	/** 実行中の約束。取り消した後も、本当に終わるまで残る。 */
	run: Promise<void> | undefined;
	/** 実行の直前の衝突のダイアログを待っている（同時に流れる数に数えない）。 */
	awaitingDecision: boolean;
	runCount: number;
	samples: Array<{ readonly at: number; readonly bytes: number }>;
}

interface IPlannedItem {
	readonly source: IParadisTransferSource;
	readonly target: URI;
	readonly overwrite: boolean;
	readonly replaceKind: boolean;
	readonly error?: IParadisTransferError;
}

interface IScanPlan {
	readonly directories: URI[];
	readonly files: Array<{ readonly source: URI; readonly target: URI; readonly size: number }>;
	readonly skipped: number;
}

/** 置き換えると送り先が丸ごと替わる組み合わせか（ファイル ⇔ フォルダー、または送り先がリンク）。 */
export function paradisIsKindMismatch(sourceIsDirectory: boolean, target: IParadisTransferStat): boolean {
	return target.isDirectory !== sourceIsDirectory || !!target.isSymbolicLink;
}

/** 同じフォルダーで使われている名前を避けて、番号つきの名前を選ぶ（stat しない）。 */
export function paradisFreeName(name: string, taken: ReadonlySet<string>): string {
	for (let index = 1; index <= MAX_RENAME_ATTEMPTS; index++) {
		const candidate = paradisNumberedName(name, index);
		if (!taken.has(candidate)) {
			return candidate;
		}
	}
	return paradisNumberedName(name, Date.now());
}

export class ParadisTransferQueue extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** 項目の追加・状態の変化・進み具合（間引いて）で発火する。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly fileSystem: IParadisTransferFileSystem;
	private readonly concurrency: number;
	private readonly now: () => number;
	private readonly isDisconnected: (item: IParadisTransferItem) => boolean;

	private readonly entries: IEntry[] = [];
	private nextId = 1;
	private preparing = 0;
	private lastProgressEventAt = 0;

	constructor(options: IParadisTransferQueueOptions) {
		super();
		this.fileSystem = options.fileSystem;
		this.concurrency = Math.max(1, options.concurrency ?? 2);
		this.now = options.now ?? Date.now;
		this.isDisconnected = options.isDisconnected ?? (() => false);
	}

	get items(): readonly IParadisTransferItem[] {
		return this.entries.map(entry => entry.item);
	}

	getSummary(): IParadisTransferSummary {
		let active = 0;
		let running = 0;
		let failed = 0;
		let total = 0;
		let done = 0;
		let known = true;
		let speed = 0;
		for (const { item } of this.entries) {
			if (item.state === 'error') {
				failed++;
			}
			if (item.state !== 'waiting' && item.state !== 'running') {
				continue;
			}
			active++;
			if (item.state === 'running') {
				running++;
				speed += item.bytesPerSecond ?? 0;
			}
			if (item.totalBytes === undefined) {
				known = false;
			} else {
				total += item.totalBytes;
				done += item.doneBytes;
			}
		}
		const percent = active === 0 ? undefined : total > 0 ? Math.min(100, Math.floor(done / total * 100)) : (known ? 0 : undefined);
		const remainingSeconds = active > 0 && known && speed > 0 ? (total - done) / speed : undefined;
		return { active, running, failed, preparing: this.preparing, percent, remainingSeconds };
	}

	/**
	 * 実行中のものがすべて本当に終わるのを待つ（取り消したものの片付けも含む）。
	 * `ignoreAwaitingDecision` なら、衝突のダイアログを待っているものは待たない（閉じるときに使う）。
	 */
	async whenIdle(options?: { readonly ignoreAwaitingDecision?: boolean }): Promise<void> {
		const pending = () => this.entries.filter(entry => entry.run && !(options?.ignoreAwaitingDecision && entry.awaitingDecision));
		while (pending().length) {
			await Promise.all(pending().map(entry => entry.run));
		}
	}

	/**
	 * 転送を待ち行列へ積む。同じ名前があれば `resolveConflict` で 1 件ずつ聞く（「以後すべてに適用」なら
	 * 残りは聞かない。ただし種類の違う衝突は毎回聞く）。`cancel` が返ったら何も積まない。積んだ件数を返す。
	 */
	async enqueue(request: IParadisTransferRequest, resolveConflict: ParadisConflictResolver): Promise<number> {
		this.preparing++;
		this._onDidChange.fire();
		try {
			const planned = await this.plan(request, resolveConflict);
			if (!planned) {
				return 0;
			}
			this.push(planned, request, resolveConflict);
			return planned.length;
		} finally {
			this.preparing--;
			this._onDidChange.fire();
		}
	}

	/** 1 件をやめる。表示はすぐ「取り消し」にし、実行は書きかけの一時ファイルを片付けてから終わる。 */
	cancel(id: number): void {
		const entry = this.find(id);
		if (!entry || (entry.item.state !== 'waiting' && entry.item.state !== 'running')) {
			return;
		}
		entry.cancellation?.cancel();
		this.finish(entry, 'cancelled', undefined);
	}

	cancelAll(): void {
		for (const entry of [...this.entries]) {
			this.cancel(entry.item.id);
		}
	}

	/**
	 * 失敗・取り消しの 1 件をやり直す。前の実行が本当に終わるのを待ってから始める（前の実行の片付けと
	 * 新しい実行が重ならないように）。上書きの可否は最初に決めたものを使い、実行の直前に送り先を確かめる。
	 * `resolveConflict` を渡すと、その間に同名ができていたら聞く（渡さなければ失敗にする）。
	 */
	async retry(id: number, resolveConflict?: ParadisConflictResolver): Promise<void> {
		const entry = this.find(id);
		if (!entry || (entry.item.state !== 'error' && entry.item.state !== 'cancelled')) {
			return;
		}
		if (entry.run) {
			await entry.run;
		}
		if (!this.entries.includes(entry) || (entry.item.state !== 'error' && entry.item.state !== 'cancelled')) {
			return;
		}
		Object.assign(entry.item, {
			state: 'waiting', totalBytes: undefined, doneBytes: 0, totalFiles: undefined, doneFiles: 0, skipped: 0, writesInPlace: false,
			bytesPerSecond: undefined, remainingSeconds: undefined, error: undefined,
		} satisfies Partial<MutableItem>);
		entry.resolveConflict = resolveConflict;
		entry.samples = [];
		this._onDidChange.fire();
		this.pump();
	}

	/** 条件に合う失敗をまとめてやり直す（接続が戻ったときなど。利用者に聞けないので衝突は失敗にする）。 */
	retryWhere(predicate: (item: IParadisTransferItem) => boolean): void {
		for (const entry of [...this.entries]) {
			if (entry.item.state === 'error' && predicate(entry.item)) {
				void this.retry(entry.item.id);
			}
		}
	}

	/** 完了・取り消しの行を消す（失敗は再試行できるよう残す。片付け中のものも残す）。 */
	clearFinished(): void {
		const before = this.entries.length;
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if ((entry.item.state === 'done' || entry.item.state === 'cancelled') && !entry.run) {
				this.entries.splice(index, 1);
			}
		}
		if (this.entries.length !== before) {
			this._onDidChange.fire();
		}
	}

	/** 終わった 1 行を消す。 */
	dismiss(id: number): void {
		const entry = this.find(id);
		if (entry && !entry.run && entry.item.state !== 'running' && entry.item.state !== 'waiting') {
			this.entries.splice(this.entries.indexOf(entry), 1);
			this._onDidChange.fire();
		}
	}

	override dispose(): void {
		for (const entry of this.entries) {
			entry.cancellation?.cancel();
		}
		super.dispose();
	}

	private find(id: number): IEntry | undefined {
		return this.entries.find(candidate => candidate.item.id === id);
	}

	// --- 積む --------------------------------------------------------------------------------------

	private async plan(request: IParadisTransferRequest, resolveConflict: ParadisConflictResolver): Promise<IPlannedItem[] | undefined> {
		const existing = await this.listNames(request.targetDirectory);
		// 「名前を変える」で付ける名前は、送り先に今ある名前・この転送で作る名前・待ち行列の他の項目が
		// 作る名前のどれとも重ならないようにする
		const taken = new Set(existing.keys());
		for (const entry of this.entries) {
			if (extUri.isEqual(dirname(entry.item.target), request.targetDirectory)) {
				taken.add(extUri.basename(entry.item.target));
			}
		}
		const planned: IPlannedItem[] = [];
		const conflicts: Array<{ source: IParadisTransferSource; target: URI; targetStat: IParadisTransferStat }> = [];
		for (const source of request.sources) {
			const target = joinPath(request.targetDirectory, source.name);
			if (isEqualOrParent(target, source.resource)) {
				planned.push({
					source, target, overwrite: false, replaceKind: false,
					error: { kind: 'other', message: localize('paradis.fileTransfer.error.intoItself', "同じ場所、またはそれ自身の中へはコピーできません") },
				});
				continue;
			}
			const targetStat = existing.get(source.name);
			if (targetStat) {
				conflicts.push({ source, target, targetStat });
			} else {
				taken.add(source.name);
				planned.push({ source, target, overwrite: false, replaceKind: false });
			}
		}
		return this.resolveConflicts(request.targetDirectory, conflicts, taken, planned, resolveConflict);
	}

	private async resolveConflicts(
		directory: URI,
		conflicts: ReadonlyArray<{ source: IParadisTransferSource; target: URI; targetStat: IParadisTransferStat }>,
		taken: Set<string>,
		planned: IPlannedItem[],
		resolveConflict: ParadisConflictResolver,
	): Promise<IPlannedItem[] | undefined> {
		let remembered: IParadisConflictDecision | undefined;
		for (let index = 0; index < conflicts.length; index++) {
			const { source, target, targetStat } = conflicts[index];
			// 種類の違う衝突は「以後すべて」の対象にしない（フォルダーごと置き換わるので毎回確かめる）
			const kindMismatch = paradisIsKindMismatch(source.isDirectory, targetStat);
			let decision = kindMismatch ? undefined : remembered;
			if (!decision) {
				decision = await resolveConflict({
					name: source.name,
					source: source.resource,
					target,
					sourceStat: { isDirectory: source.isDirectory, size: source.size ?? 0, mtime: source.mtime },
					targetStat,
					renamedName: paradisFreeName(source.name, taken),
					kindMismatch,
					allowApplyToAll: !kindMismatch,
					index: index + 1,
					total: conflicts.length,
				});
				if (!kindMismatch && decision.applyToAll) {
					remembered = decision;
				}
			}
			if (decision.action === 'cancel') {
				return undefined;
			}
			if (decision.action === 'rename') {
				const name = paradisFreeName(source.name, taken);
				taken.add(name);
				planned.push({ source, target: joinPath(directory, name), overwrite: false, replaceKind: false });
			} else if (decision.action === 'overwrite') {
				planned.push({ source, target, overwrite: true, replaceKind: kindMismatch });
			}
		}
		return planned;
	}

	private async listNames(directory: URI): Promise<Map<string, IParadisTransferStat>> {
		const names = new Map<string, IParadisTransferStat>();
		for (const child of await this.fileSystem.readDirectory(directory)) {
			names.set(child.name, child);
		}
		return names;
	}

	private push(planned: readonly IPlannedItem[], request: IParadisTransferRequest, resolveConflict: ParadisConflictResolver): void {
		for (const plan of planned) {
			this.entries.push({
				item: {
					id: this.nextId++,
					name: plan.source.name,
					isDirectory: plan.source.isDirectory,
					source: plan.source.resource,
					target: plan.target,
					targetLabel: request.targetLabel,
					direction: request.direction,
					state: plan.error ? 'error' : 'waiting',
					totalBytes: undefined,
					doneBytes: 0,
					totalFiles: undefined,
					doneFiles: 0,
					skipped: 0,
					writesInPlace: false,
					bytesPerSecond: undefined,
					remainingSeconds: undefined,
					error: plan.error,
				},
				overwrite: plan.overwrite,
				replaceKind: plan.replaceKind,
				resolveConflict,
				cancellation: undefined,
				run: undefined,
				awaitingDecision: false,
				runCount: 0,
				samples: [],
			});
		}
		if (planned.length) {
			this._onDidChange.fire();
			this.pump();
		}
	}

	// --- 流す --------------------------------------------------------------------------------------

	private pump(): void {
		if (this._store.isDisposed) {
			return;
		}
		// 取り消した後に片付けている実行も、終わるまでは 1 本に数える。衝突のダイアログを待っている実行は数えない
		let busy = this.entries.filter(entry => entry.run && !entry.awaitingDecision).length;
		for (const entry of this.entries) {
			if (busy >= this.concurrency) {
				break;
			}
			if (entry.item.state === 'waiting' && !entry.run) {
				busy++;
				this.start(entry);
			}
		}
	}

	private start(entry: IEntry): void {
		const cancellation = new CancellationTokenSource();
		entry.cancellation = cancellation;
		entry.runCount++;
		entry.item.state = 'running';
		entry.samples = [{ at: this.now(), bytes: 0 }];
		this._onDidChange.fire();
		// 一時名に使う印。別のウィンドウの実行と重ならないよう、時刻と乱数も混ぜる
		const runId = `${entry.item.id}-${entry.runCount}-${Math.floor(this.now()).toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
		entry.run = this.execute(entry, cancellation.token, runId).finally(() => {
			cancellation.dispose();
			if (entry.cancellation === cancellation) {
				entry.cancellation = undefined;
			}
			entry.run = undefined;
			this._onDidChange.fire();
			this.pump();
		});
	}

	private async execute(entry: IEntry, token: CancellationToken, runId: string): Promise<void> {
		try {
			if (!await this.prepareTarget(entry, token)) {
				return;
			}
			const plan = await this.scan(entry.item, token);
			if (token.isCancellationRequested) {
				return;
			}
			entry.item.totalBytes = plan.files.reduce((sum, file) => sum + file.size, 0);
			entry.item.totalFiles = plan.files.length;
			entry.item.skipped = plan.skipped;
			this._onDidChange.fire();
			const completed = await this.copyAll(entry, plan, token, runId);
			// 置き換えの途中で取り消しても、置き換えが済んでいれば「完了」と出す
			if (completed) {
				this.finish(entry, 'done', undefined, true);
			}
		} catch (error) {
			if (token.isCancellationRequested || isCancellationError(error)) {
				return;
			}
			this.finish(entry, 'error', this.describe(entry.item, error));
		}
	}

	private describe(item: IParadisTransferItem, error: unknown): IParadisTransferError {
		let kind: ParadisTransferErrorKind = paradisClassifyTransferError(error);
		if (kind !== 'conflict' && kind !== 'special' && kind !== 'sameFile' && this.isDisconnected(item)) {
			kind = 'disconnected';
		}
		return { kind, message: paradisDescribeTransferError(kind, error instanceof Error ? error.message : String(error)) };
	}

	/**
	 * 実行の直前に送り先を確かめる。進めてよければ true。
	 * - 上書きしない項目で同名があれば、聞ける先があれば聞き、無ければ衝突として失敗にする
	 * - 種類の違う同名は、専用の確認を経たときだけ取り除く（手元はゴミ箱へ）
	 */
	private async prepareTarget(entry: IEntry, token: CancellationToken): Promise<boolean> {
		const existing = await this.fileSystem.stat(entry.item.target);
		if (!existing || token.isCancellationRequested) {
			return !token.isCancellationRequested;
		}
		const kindMismatch = paradisIsKindMismatch(entry.item.isDirectory, existing);
		if (!entry.overwrite) {
			const decision = await this.askAtRun(entry, existing, kindMismatch);
			if (token.isCancellationRequested) {
				return false;
			}
			if (decision.action === 'cancel' || decision.action === 'skip') {
				this.finish(entry, 'cancelled', undefined);
				return false;
			}
			if (decision.action === 'rename') {
				const taken = await this.takenNames(entry);
				entry.item.target = joinPath(dirname(entry.item.target), paradisFreeName(entry.item.name, taken));
				return true;
			}
			entry.overwrite = true;
			entry.replaceKind = kindMismatch;
		}
		if (kindMismatch) {
			if (!entry.replaceKind) {
				throw new ParadisTransferConflictError(entry.item.target);
			}
			if (token.isCancellationRequested) {
				return false;
			}
			await this.fileSystem.removeForReplace(entry.item.target);
		}
		return !token.isCancellationRequested;
	}

	/** 送り先のフォルダーで使われている名前と、待ち行列の他の項目が作る予定の名前。 */
	private async takenNames(self: IEntry): Promise<Set<string>> {
		const directory = dirname(self.item.target);
		const taken = new Set((await this.fileSystem.readDirectory(directory)).map(child => child.name));
		for (const entry of this.entries) {
			if (entry !== self && extUri.isEqual(dirname(entry.item.target), directory)) {
				taken.add(extUri.basename(entry.item.target));
			}
		}
		return taken;
	}

	private async askAtRun(entry: IEntry, existing: IParadisTransferStat, kindMismatch: boolean): Promise<IParadisConflictDecision> {
		const resolveConflict = entry.resolveConflict;
		if (!resolveConflict) {
			throw new ParadisTransferConflictError(entry.item.target);
		}
		const taken = await this.takenNames(entry);
		// ダイアログを待つ間は同時に流れる数に数えず、他の項目を先に流す
		entry.awaitingDecision = true;
		this.pump();
		try {
			return await this.askAtRunWith(resolveConflict, entry, existing, kindMismatch, taken);
		} finally {
			entry.awaitingDecision = false;
		}
	}

	private async askAtRunWith(resolveConflict: ParadisConflictResolver, entry: IEntry, existing: IParadisTransferStat, kindMismatch: boolean, taken: ReadonlySet<string>): Promise<IParadisConflictDecision> {
		return resolveConflict({
			name: entry.item.name,
			source: entry.item.source,
			target: entry.item.target,
			sourceStat: (await this.fileSystem.stat(entry.item.source)) ?? { isDirectory: entry.item.isDirectory, size: 0, mtime: undefined },
			targetStat: existing,
			renamedName: paradisFreeName(entry.item.name, taken),
			kindMismatch,
			allowApplyToAll: false,
			index: 1,
			total: 1,
		});
	}

	/** 写すものを洗い出す。フォルダーは 1 階層ごとに 1 回だけ一覧を読む（大きさも一緒に取る）。 */
	private async scan(item: IParadisTransferItem, token: CancellationToken): Promise<IScanPlan> {
		const directories: URI[] = [];
		const files: Array<{ source: URI; target: URI; size: number }> = [];
		let skipped = 0;
		if (!item.isDirectory) {
			const stat = await this.fileSystem.stat(item.source);
			if (!stat) {
				throw new FileOperationError(localize('paradis.fileTransfer.error.sourceMissing', "{0} が見つかりません", item.name), FileOperationResult.FILE_NOT_FOUND);
			}
			if (stat.special || stat.isDirectory) {
				throw new ParadisTransferSpecialFileError();
			}
			files.push({ source: item.source, target: item.target, size: stat.size });
			return { directories, files, skipped };
		}
		const pending: Array<{ source: URI; target: URI }> = [{ source: item.source, target: item.target }];
		while (pending.length && !token.isCancellationRequested) {
			const { source, target } = pending.shift()!;
			let children;
			try {
				children = await this.fileSystem.readDirectory(source);
			} catch (error) {
				// 中の読めないフォルダーは飛ばす（一番上が読めなければ全体の失敗にする）
				if (source !== item.source && paradisIsSkippableInsideFolder(paradisClassifyTransferError(error))) {
					skipped++;
					continue;
				}
				throw error;
			}
			// 読めたフォルダーだけを送り先に作る
			directories.push(target);
			for (const child of children) {
				const childTarget = joinPath(target, child.name);
				if (child.directoryLink || child.special) {
					// フォルダーを指すリンクは辿らず、ソケット・FIFO・壊れたリンクは読まない（読むと止まりうる）
					skipped++;
				} else if (child.isDirectory) {
					pending.push({ source: child.resource, target: childTarget });
				} else {
					files.push({ source: child.resource, target: childTarget, size: child.size });
				}
			}
		}
		return { directories, files, skipped };
	}

	/** 写す。最後まで済んだら true（最後の 1 件の置き換えの途中で取り消されても、置き換えが済んでいれば true）。 */
	private async copyAll(entry: IEntry, plan: IScanPlan, token: CancellationToken, runId: string): Promise<boolean> {
		for (const directory of plan.directories) {
			if (token.isCancellationRequested) {
				return false;
			}
			await this.fileSystem.createDirectory(directory);
		}
		for (const file of plan.files) {
			if (token.isCancellationRequested) {
				return false;
			}
			try {
				await this.fileSystem.copyFile(file.source, file.target, {
					overwrite: entry.overwrite,
					runId,
					onBytes: bytes => this.addBytes(entry, bytes),
					onWriteInPlace: () => {
						entry.item.writesInPlace = true;
						this._onDidChange.fire();
					},
					token,
				});
				entry.item.doneFiles++;
			} catch (error) {
				if (token.isCancellationRequested || isCancellationError(error)) {
					throw error;
				}
				// フォルダーの中の読めないファイルは飛ばして続ける（数は行に出す）
				if (!entry.item.isDirectory || !paradisIsSkippableInsideFolder(paradisClassifyTransferError(error))) {
					throw error;
				}
				entry.item.skipped++;
			}
			this.updateSpeed(entry, true);
		}
		return true;
	}

	private addBytes(entry: IEntry, bytes: number): void {
		if (entry.item.state !== 'running') {
			return;
		}
		entry.item.doneBytes += bytes;
		this.updateSpeed(entry, false);
	}

	private updateSpeed(entry: IEntry, force: boolean): void {
		const now = this.now();
		entry.samples.push({ at: now, bytes: entry.item.doneBytes });
		while (entry.samples.length > 2 && now - entry.samples[0].at > SPEED_WINDOW_MS) {
			entry.samples.shift();
		}
		const first = entry.samples[0];
		const span = now - first.at;
		if (span >= SPEED_MIN_SPAN_MS) {
			const speed = (entry.item.doneBytes - first.bytes) / (span / 1000);
			entry.item.bytesPerSecond = speed;
			entry.item.remainingSeconds = speed > 0 && entry.item.totalBytes !== undefined
				? Math.max(0, entry.item.totalBytes - entry.item.doneBytes) / speed
				: undefined;
		}
		if (force || now - this.lastProgressEventAt >= PROGRESS_EVENT_INTERVAL_MS) {
			this.lastProgressEventAt = now;
			this._onDidChange.fire();
		}
	}

	private finish(entry: IEntry, state: 'done' | 'error' | 'cancelled', error: IParadisTransferError | undefined, overrideCancelled = false): void {
		const open = entry.item.state === 'waiting' || entry.item.state === 'running';
		if (!open && !(overrideCancelled && entry.item.state === 'cancelled')) {
			return;
		}
		entry.item.state = state;
		entry.item.error = error;
		entry.item.remainingSeconds = undefined;
		if (state !== 'done') {
			entry.item.bytesPerSecond = undefined;
		}
		this._onDidChange.fire();
	}
}

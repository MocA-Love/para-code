/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	IParadisSpaceNote,
	IParadisSpaceNotesService,
	IParadisSpaceNoteSummary,
	PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH,
	PARADIS_SPACE_NOTES_MAX_COUNT,
	PARADIS_SPACE_NOTES_STORAGE_KEY,
	paradisNormalizeSpaceNoteText,
	paradisParseSpaceNotes,
	paradisRemoveSpaceNoteTask,
	paradisReplaceSpaceNoteTaskText,
	paradisSerializeSpaceNotes,
	paradisSpaceNoteSummary,
	paradisToggleSpaceNoteTask
} from '../common/paradisSpaceNotes.js';
import { IParadisWorkspaceSwitchService } from '../common/paradisWorkspaceSwitch.js';

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 1_000;
const MAX_SAVE_RETRIES = 3;

const EMPTY_SUMMARY: IParadisSpaceNoteSummary = { open: 0, done: 0 };

/**
 * スペースごとのメモを WORKSPACE ストレージに保持する。リポジトリの色・並び順・折りたたみ状態と
 * 同じ置き場所で、worktree を削除するとライフサイクル側から remove() されて一緒に消える。
 * 別ウィンドウ (同じ workspace を開いた他ウィンドウ) からの更新は storage の変更通知で取り込む。
 */
export class ParadisSpaceNotesService extends Disposable implements IParadisSpaceNotesService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeNotes = this._register(new Emitter<readonly string[]>());
	readonly onDidChangeNotes: Event<readonly string[]> = this._onDidChangeNotes.event;

	private notes: Map<string, IParadisSpaceNote>;
	private readonly scheduler: RunOnceScheduler;
	private dirty = false;
	/** まだ保存できていない編集のスペース。他ウィンドウの更新を取り込むときに、この分だけ守る。 */
	private readonly dirtyKeys = new Set<string>();
	private saveFailures = 0;
	/** 自分が書いた値。storage 変更通知が自分の書き込みだったときに再読込を省くために持つ。 */
	private lastWritten: string | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
	) {
		super();

		this.notes = this.load();
		this.scheduler = this._register(new RunOnceScheduler(() => this.persist(), SAVE_DELAY_MS));

		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, PARADIS_SPACE_NOTES_STORAGE_KEY, this._store)(() => this.onExternalChange()));
		// ウィンドウ終了時など、デバウンス待ちの編集を取りこぼさずに書き出す
		this._register(this.storageService.onWillSaveState(() => this.persist()));
		// worktree 削除などでスペースが失われたら、そのメモも一緒に捨てる
		this._register(workspaceSwitchService.onDidRetireScope(stateKey => this.remove(stateKey)));
	}

	read(stateKey: string): string {
		return this.notes.get(stateKey)?.text ?? '';
	}

	summary(stateKey: string): IParadisSpaceNoteSummary {
		const text = this.notes.get(stateKey)?.text;
		return text ? paradisSpaceNoteSummary(text) : EMPTY_SUMMARY;
	}

	write(stateKey: string, text: string): void {
		const normalized = paradisNormalizeSpaceNoteText(text);
		const previous = this.notes.get(stateKey);
		if ((previous?.text ?? '') === normalized) {
			return;
		}
		if (normalized.trim().length === 0) {
			if (!this.notes.delete(stateKey)) {
				return;
			}
			this.markDirty([stateKey]);
			return;
		}
		// 上限を満たさないエントリを持ち込むと serialize がスナップショット全体を拒否し、
		// 他のスペースのメモまで保存されなくなる。受け付ける時点で弾いておく
		if (!this.canAccept(stateKey)) {
			return;
		}
		this.notes.set(stateKey, { text: normalized, updatedAt: Date.now() });
		this.markDirty([stateKey]);
	}

	/** 新しいスペースのメモを受け付けられるか (キー長・件数の上限)。既存キーの更新は常に許可する。 */
	private canAccept(stateKey: string): boolean {
		if (stateKey.length === 0 || stateKey.length > PARADIS_SPACE_NOTE_MAX_STATE_KEY_LENGTH) {
			this.warn('Rejected a space note with an unusable state key');
			return false;
		}
		if (!this.notes.has(stateKey) && this.notes.size >= PARADIS_SPACE_NOTES_MAX_COUNT) {
			this.warn('Rejected a space note beyond the per-workspace limit');
			return false;
		}
		return true;
	}

	toggleTask(stateKey: string, lineIndex: number): void {
		const current = this.notes.get(stateKey)?.text;
		if (current === undefined) {
			return;
		}
		const toggled = paradisToggleSpaceNoteTask(current, lineIndex);
		if (toggled === undefined) {
			return;
		}
		this.notes.set(stateKey, { text: toggled, updatedAt: Date.now() });
		this.markDirty([stateKey]);
	}

	removeTask(stateKey: string, lineIndex: number): void {
		const current = this.notes.get(stateKey)?.text;
		if (current === undefined) {
			return;
		}
		const removed = paradisRemoveSpaceNoteTask(current, lineIndex);
		if (removed === undefined) {
			return;
		}
		// 最後の1件を消して空になったらエントリごと片付けたいので write() を通す
		this.write(stateKey, removed);
	}

	updateTaskText(stateKey: string, lineIndex: number, taskText: string): void {
		const current = this.notes.get(stateKey)?.text;
		if (current === undefined) {
			return;
		}
		const replaced = paradisReplaceSpaceNoteTaskText(current, lineIndex, taskText);
		if (replaced === undefined) {
			return;
		}
		this.write(stateKey, replaced);
	}

	remove(stateKey: string): void {
		if (this.notes.delete(stateKey)) {
			this.markDirty([stateKey]);
		}
	}

	private load(): Map<string, IParadisSpaceNote> {
		try {
			return paradisParseSpaceNotes(this.storageService.get(PARADIS_SPACE_NOTES_STORAGE_KEY, StorageScope.WORKSPACE));
		} catch {
			this.warn('Failed to load space notes');
			return new Map();
		}
	}

	/** 他ウィンドウが同じ workspace のメモを書き換えたときに取り込む。 */
	private onExternalChange(): void {
		let raw: string | undefined;
		try {
			raw = this.storageService.get(PARADIS_SPACE_NOTES_STORAGE_KEY, StorageScope.WORKSPACE);
		} catch {
			this.warn('Failed to read space notes after external change');
			return;
		}
		if (raw === this.lastWritten) {
			return;
		}
		// 未保存の編集はスペース単位で守る。丸ごと捨てると、こちらが編集していない他スペースへの
		// 更新まで巻き戻り、次の persist でそれが相手側にも書き戻ってしまう
		const incoming = paradisParseSpaceNotes(raw);
		const merged = new Map(incoming);
		for (const stateKey of this.dirtyKeys) {
			const local = this.notes.get(stateKey);
			if (local === undefined) {
				merged.delete(stateKey);
			} else {
				merged.set(stateKey, local);
			}
		}
		const changed = this.diffKeys(this.notes, merged);
		this.notes = merged;
		if (changed.length > 0) {
			this._onDidChangeNotes.fire(changed);
		}
	}

	private diffKeys(before: ReadonlyMap<string, IParadisSpaceNote>, after: ReadonlyMap<string, IParadisSpaceNote>): string[] {
		const changed: string[] = [];
		for (const [stateKey, note] of after) {
			if (before.get(stateKey)?.text !== note.text) {
				changed.push(stateKey);
			}
		}
		for (const stateKey of before.keys()) {
			if (!after.has(stateKey)) {
				changed.push(stateKey);
			}
		}
		return changed;
	}

	private markDirty(changed: readonly string[]): void {
		this.dirty = true;
		for (const stateKey of changed) {
			this.dirtyKeys.add(stateKey);
		}
		this.scheduler.schedule(SAVE_DELAY_MS);
		this._onDidChangeNotes.fire(changed);
	}

	private persist(): void {
		if (!this.dirty) {
			return;
		}
		const serialized = paradisSerializeSpaceNotes(this.notes);
		if (serialized === undefined) {
			// 上限を超えた snapshot は書かない (既存のメモを壊さないことを優先する)。
			// write() 側で受け入れ時に弾いているため、ここへ来るのは storage 上の既存データが
			// 上限を超えていた場合だけ
			this.warn('Refused to persist oversized space notes');
			this.dirty = false;
			this.dirtyKeys.clear();
			return;
		}
		try {
			this.storageService.store(PARADIS_SPACE_NOTES_STORAGE_KEY, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			this.lastWritten = serialized;
			this.dirty = false;
			this.dirtyKeys.clear();
			this.saveFailures = 0;
		} catch {
			this.warn('Failed to persist space notes');
			if (this.saveFailures++ < MAX_SAVE_RETRIES) {
				this.scheduler.schedule(RETRY_DELAY_MS);
			} else {
				this.dirty = false;
			}
		}
	}

	private warn(message: string): void {
		try {
			this.logService.warn(`[ParadisSpaceNotes] ${message}`);
		} catch {
			// Diagnostics must not interrupt editing or view disposal.
		}
	}

	override dispose(): void {
		this.scheduler.cancel();
		this.persist();
		super.dispose();
	}
}

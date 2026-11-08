/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 差分の行へのメモ（G-01）をスペースごとに持つ。保存は WORKSPACE の自前のキー。今のスペースの未送信の件数を
// コンテキストキーに出す（エディタの見出しとソース管理の見出しの「AI メモを送る」の出し分け）。

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisDiffReviewNote, PARADIS_DIFF_REVIEW_MAX_NOTES, PARADIS_DIFF_REVIEW_NOTE_BODY_MAX, PARADIS_DIFF_REVIEW_NOTE_LINE_TEXT_MAX, PARADIS_DIFF_REVIEW_NOTES_STORAGE_KEY, paradisMarkDiffReviewNotesSent, paradisParseDiffReviewNotes, paradisSerializeDiffReviewNotes } from '../common/paradisDiffReviewNotes.js';

/** 今のスペースの未送信のメモの数。 */
export const ParadisDiffReviewUnsentCountContext = new RawContextKey<number>('paradisDiffReviewUnsentCount', 0, localize('paradis.diffReviewNotes.unsentCount', "今のスペースで、まだエージェントへ送っていない差分のメモの数"));

export const IParadisDiffReviewNotesService = createDecorator<IParadisDiffReviewNotesService>('paradisDiffReviewNotesService');

export interface IParadisDiffReviewNotesService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	getNotes(stateKey: string): readonly IParadisDiffReviewNote[];
	/** 足したメモ。上限に達していれば undefined。 */
	add(stateKey: string, note: { readonly path: string; readonly line: number; readonly lineText: string; readonly body: string }): IParadisDiffReviewNote | undefined;
	remove(stateKey: string, ids: ReadonlySet<string>): void;
	/** 送った後に呼ぶ。`readVersions` は送る文を組み立てたときの `updatedAt`。 */
	markSent(stateKey: string, readVersions: ReadonlyMap<string, number>): void;
}

class ParadisDiffReviewNotesService extends Disposable implements IParadisDiffReviewNotesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly store: Map<string, IParadisDiffReviewNote[]>;
	private readonly unsentCount: IContextKey<number>;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IParadisWorkspaceSwitchService private readonly switchService: IParadisWorkspaceSwitchService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.store = paradisParseDiffReviewNotes(this.storageService.get(PARADIS_DIFF_REVIEW_NOTES_STORAGE_KEY, StorageScope.WORKSPACE));
		this.unsentCount = ParadisDiffReviewUnsentCountContext.bindTo(contextKeyService);
		this._register(this.switchService.onDidSwitchScope(() => this.updateContext()));
		this.updateContext();
	}

	getNotes(stateKey: string): readonly IParadisDiffReviewNote[] {
		return this.store.get(stateKey) ?? [];
	}

	add(stateKey: string, input: { readonly path: string; readonly line: number; readonly lineText: string; readonly body: string }): IParadisDiffReviewNote | undefined {
		const notes = this.store.get(stateKey) ?? [];
		const body = input.body.trim();
		if (notes.length >= PARADIS_DIFF_REVIEW_MAX_NOTES || body.length === 0) {
			return undefined;
		}
		const now = Date.now();
		const note: IParadisDiffReviewNote = {
			id: generateUuid(),
			path: input.path,
			line: input.line,
			lineText: input.lineText.slice(0, PARADIS_DIFF_REVIEW_NOTE_LINE_TEXT_MAX),
			body: body.slice(0, PARADIS_DIFF_REVIEW_NOTE_BODY_MAX),
			createdAt: now,
			updatedAt: now,
		};
		this.commit(stateKey, [...notes, note]);
		return note;
	}

	remove(stateKey: string, ids: ReadonlySet<string>): void {
		const notes = this.store.get(stateKey) ?? [];
		this.commit(stateKey, notes.filter(note => !ids.has(note.id)));
	}

	markSent(stateKey: string, readVersions: ReadonlyMap<string, number>): void {
		this.commit(stateKey, paradisMarkDiffReviewNotesSent(this.store.get(stateKey) ?? [], readVersions, Date.now()));
	}

	private commit(stateKey: string, notes: IParadisDiffReviewNote[]): void {
		if (notes.length > 0) {
			this.store.set(stateKey, notes);
		} else {
			this.store.delete(stateKey);
		}
		this.storageService.store(PARADIS_DIFF_REVIEW_NOTES_STORAGE_KEY, paradisSerializeDiffReviewNotes(this.store), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.updateContext();
		this._onDidChange.fire();
	}

	private updateContext(): void {
		const stateKey = this.switchService.activeStateKey;
		this.unsentCount.set(stateKey === undefined ? 0 : this.getNotes(stateKey).filter(note => note.sentAt === undefined).length);
	}
}

registerSingleton(IParadisDiffReviewNotesService, ParadisDiffReviewNotesService, InstantiationType.Delayed);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// MCPの「スペースのメモ」ツール群（list_space_notes / read_space_note / write_space_note /
// add_space_note_task / check_space_note_task / delete_space_note_task）の受け口。
// shared process の ParadisAgentBrowserService が「呼び出し元ペインを所有するウィンドウ」だけへ
// ctxフィルタでルーティングして呼ぶため、ここではメモの読み書きに徹する
// （ウィンドウ取り違えの防止は shared process 側のルーティングで保証済み）。
//
// メモ本体は Workspaces ビューの下部と同じ IParadisSpaceNotesService で、書き込みは
// そのままビューとモバイルへ反映される（保存・上限・他ウィンドウとの併合はサービス側の責務）。
//
// 信頼境界はウィンドウ単位。ペインが属するスペースを既定にしつつ、`space` を明示すれば
// 同じウィンドウの他スペースのメモも読み書きできる（横断で確認したいという要件のため）。
// したがって一覧にはウィンドウ内の全スペースのキー（worktree は絶対パスを含む）が載る。
// 別ウィンドウのメモへは到達できない（shared process 側がペイン→所有ウィンドウへ限定する）。

import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import {
	IParadisAgentNoteRequest,
	IParadisAgentNoteResult,
	IParadisAgentNoteSpace,
	IParadisAgentNoteView,
	PARADIS_AGENT_NOTES_CHANNEL,
	PARADIS_AGENT_NOTES_METHOD,
	paradisAgentNoteLines,
} from '../common/paradisAgentNotes.js';
import { IParadisPaneTokenService } from '../browser/paradisPaneTokenService.js';
import {
	IParadisSpaceNotesService,
	PARADIS_SPACE_NOTE_MAX_LENGTH,
	paradisAppendSpaceNoteTask,
	paradisSpaceNoteSummary,
} from '../../workspaceSwitch/common/paradisSpaceNotes.js';
import {
	IParadisSpaceEntry,
	IParadisTerminalScopeService,
	IParadisWorkspaceSwitchService,
	IParadisWorktreeService,
	paradisListSpaces,
} from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

const UNKNOWN_SPACE_HINT = 'Call list_space_notes to see the available spaces and their keys.';
const NO_DEFAULT_SPACE_MESSAGE = `Para Code could not tell which space this terminal pane belongs to. ${UNKNOWN_SPACE_HINT}`;
const NOT_A_TASK_MESSAGE = 'is not a checklist item ("- [ ] ..." / "- [x] ...") in this space note. Call read_space_note to see the current lines.';
const SAVE_REFUSED_MESSAGE = 'Para Code refused to save the note (it may have hit the per-workspace note limit). The note was left unchanged.';

export class ParadisAgentNotesChannel implements IServerChannel {

	constructor(
		private readonly spaceNotesService: IParadisSpaceNotesService,
		private readonly workspaceSwitchService: IParadisWorkspaceSwitchService,
		private readonly worktreeService: IParadisWorktreeService,
		private readonly terminalScopeService: IParadisTerminalScopeService,
		private readonly paneTokenService: IParadisPaneTokenService,
	) { }

	listen<T>(_ctx: unknown, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown): Promise<T> {
		if (command === PARADIS_AGENT_NOTES_METHOD) {
			const args = Array.isArray(arg) ? arg : [];
			const token = typeof args[0] === 'string' ? args[0] : undefined;
			const request = args[1];
			if (typeof request !== 'object' || request === null) {
				const malformed: IParadisAgentNoteResult = { ok: false, error: 'Malformed space note request.' };
				return malformed as T;
			}
			return this._spaceNote(token, request as IParadisAgentNoteRequest) as T;
		}
		throw new Error(`Method not found: ${command}`);
	}

	private _spaceNote(token: string | undefined, request: IParadisAgentNoteRequest): IParadisAgentNoteResult {
		const entries = this._spaces();
		const current = this._resolveCurrentSpace(token, entries);
		if (request.op === 'list') {
			return { ok: true, kind: 'spaces', spaces: entries.map(entry => this._toSpace(entry, current)) };
		}

		const entry = request.space === undefined
			? entries.find(candidate => candidate.space === current)
			: entries.find(candidate => candidate.space === request.space);
		if (!entry) {
			return {
				ok: false,
				error: request.space === undefined ? NO_DEFAULT_SPACE_MESSAGE : `Unknown space: ${request.space}. ${UNKNOWN_SPACE_HINT}`,
			};
		}

		switch (request.op) {
			case 'read':
				return { ok: true, kind: 'note', note: this._toView(entry) };
			case 'write':
				return this._write(entry, request.text ?? '', true);
			case 'addTask':
				return this._addTask(entry, request.task ?? '');
			case 'checkTask':
				return this._checkTask(entry, request.line, request.done);
			case 'deleteTask':
				return this._deleteTask(entry, request.line);
			default:
				return { ok: false, error: `Unsupported space note operation: ${String((request as { op?: unknown }).op)}` };
		}
	}

	/** メモを持てるスペース（登録リポジトリと、その実在 worktree）を Workspaces ビューと同じ順で並べる。 */
	private _spaces(): IParadisSpaceEntry[] {
		return paradisListSpaces(this.workspaceSwitchService.repositories, this.worktreeService);
	}

	/**
	 * 呼び出し元ペインが属するスペース。台帳に記録があればそれを使い、無ければ確定した
	 * スコープだけを見る。`pending`（スペース切り替え中・端末の再接続中など、所属が未確定）を
	 * アクティブスペースで埋めると、切り替え中の write が無関係なスペースのメモを
	 * 全文上書きしうるため、既定スペース無しとして扱う（モバイルリレーと同じ判断）。
	 */
	private _resolveCurrentSpace(token: string | undefined, entries: readonly IParadisSpaceEntry[]): string | undefined {
		const instanceId = token !== undefined ? this.paneTokenService.getInstanceForToken(token) : undefined;
		const candidate = instanceId === undefined ? undefined : this._resolveInstanceSpace(instanceId);
		return candidate !== undefined && entries.some(entry => entry.space === candidate) ? candidate : undefined;
	}

	private _resolveInstanceSpace(instanceId: number): string | undefined {
		const recorded = this.terminalScopeService.getStateKeyForInstance(instanceId);
		if (recorded !== undefined) {
			return recorded;
		}
		const scope = this.terminalScopeService.resolveScope(instanceId);
		return scope.kind === 'managed'
			? scope.stateKey
			: scope.kind === 'unscoped'
				? this.workspaceSwitchService.activeStateKey
				: undefined;
	}

	private _toSpace(entry: IParadisSpaceEntry, current: string | undefined): IParadisAgentNoteSpace {
		const summary = this.spaceNotesService.summary(entry.space);
		return {
			space: entry.space,
			name: entry.name,
			kind: entry.kind,
			...(entry.space === current ? { current: true } : {}),
			open: summary.open,
			done: summary.done,
		};
	}

	private _toView(entry: IParadisSpaceEntry): IParadisAgentNoteView {
		const text = this.spaceNotesService.read(entry.space);
		const summary = paradisSpaceNoteSummary(text);
		return {
			space: entry.space,
			name: entry.name,
			text,
			lines: paradisAgentNoteLines(text),
			open: summary.open,
			done: summary.done,
		};
	}

	/**
	 * 本文を差し替えて結果を返す。サービスは件数・キー長の上限に触れる更新を黙って捨てるため、
	 * 受け付けられたかどうかを読み直して確かめる（確認できるのはサービスが保持する値までで、
	 * ストレージへの永続化はデバウンス後に行われる）。
	 * `reportReplaced` は全文置換のときだけ真にする（消えた本文を呼び出し元へ返すため）。
	 */
	private _write(entry: IParadisSpaceEntry, text: string, reportReplaced: boolean = false): IParadisAgentNoteResult {
		if (text.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			return { ok: false, error: `The note text is too long (limit: ${PARADIS_SPACE_NOTE_MAX_LENGTH} characters, got: ${text.length}).` };
		}
		const previous = this.spaceNotesService.read(entry.space);
		this.spaceNotesService.write(entry.space, text);
		const expected = text.trim().length === 0 ? '' : text;
		if (this.spaceNotesService.read(entry.space) !== expected) {
			return { ok: false, error: SAVE_REFUSED_MESSAGE };
		}
		const replaced = reportReplaced && previous.length > 0 && previous !== expected ? { replaced: previous } : {};
		return { ok: true, kind: 'note', note: this._toView(entry), ...replaced };
	}

	private _addTask(entry: IParadisSpaceEntry, task: string): IParadisAgentNoteResult {
		const appended = paradisAppendSpaceNoteTask(this.spaceNotesService.read(entry.space), task);
		if (appended === undefined) {
			return { ok: false, error: 'The checklist item is empty after trimming, so nothing was added.' };
		}
		if (appended.length > PARADIS_SPACE_NOTE_MAX_LENGTH) {
			return { ok: false, error: `Adding this item would exceed the note limit of ${PARADIS_SPACE_NOTE_MAX_LENGTH} characters. Delete some items first.` };
		}
		return this._write(entry, appended);
	}

	private _checkTask(entry: IParadisSpaceEntry, line: number | undefined, done: boolean | undefined): IParadisAgentNoteResult {
		const task = this._taskAt(entry, line);
		if (!task.ok) {
			return { ok: false, error: task.error };
		}
		if (done !== undefined && task.done === done) {
			// 既に望みの状態なら書かない（同じ指示を繰り返しても updatedAt を動かさない）
			return { ok: true, kind: 'note', note: this._toView(entry) };
		}
		this.spaceNotesService.toggleTask(entry.space, task.line);
		return { ok: true, kind: 'note', note: this._toView(entry) };
	}

	private _deleteTask(entry: IParadisSpaceEntry, line: number | undefined): IParadisAgentNoteResult {
		const task = this._taskAt(entry, line);
		if (!task.ok) {
			return { ok: false, error: task.error };
		}
		this.spaceNotesService.removeTask(entry.space, task.line);
		return { ok: true, kind: 'note', note: this._toView(entry) };
	}

	/** 対象行がチェックリストであることを確かめる（範囲外・見出し・本文行は明示エラーにする）。 */
	private _taskAt(entry: IParadisSpaceEntry, line: number | undefined): { readonly ok: true; readonly line: number; readonly done: boolean } | { readonly ok: false; readonly error: string } {
		if (line === undefined) {
			return { ok: false, error: 'The "line" argument is required (use the 0-based line number from read_space_note).' };
		}
		const target = paradisAgentNoteLines(this.spaceNotesService.read(entry.space)).find(candidate => candidate.line === line);
		if (!target) {
			return { ok: false, error: `Line ${line} is out of range for this space note. Call read_space_note to see the current lines.` };
		}
		if (target.kind !== 'task') {
			return { ok: false, error: `Line ${line} ${NOT_A_TASK_MESSAGE}` };
		}
		return { ok: true, line, done: target.done === true };
	}
}

/**
 * shared process の IPCServer へ、このウィンドウ宛の {@link PARADIS_AGENT_NOTES_CHANNEL}
 * を登録する。登録はウィンドウの生存期間ずっと有効（接続断で自動的に消える）。
 */
class ParadisAgentNotesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentNotes';

	constructor(
		@ISharedProcessService sharedProcessService: ISharedProcessService,
		@IParadisSpaceNotesService spaceNotesService: IParadisSpaceNotesService,
		@IParadisWorkspaceSwitchService workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService worktreeService: IParadisWorktreeService,
		@IParadisTerminalScopeService terminalScopeService: IParadisTerminalScopeService,
		@IParadisPaneTokenService paneTokenService: IParadisPaneTokenService,
	) {
		super();
		sharedProcessService.registerChannel(PARADIS_AGENT_NOTES_CHANNEL, new ParadisAgentNotesChannel(
			spaceNotesService,
			workspaceSwitchService,
			worktreeService,
			terminalScopeService,
			paneTokenService,
		));
	}
}

registerWorkbenchContribution2(ParadisAgentNotesContribution.ID, ParadisAgentNotesContribution, WorkbenchPhase.AfterRestored);

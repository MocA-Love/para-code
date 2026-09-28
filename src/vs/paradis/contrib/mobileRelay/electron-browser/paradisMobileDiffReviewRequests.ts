/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { paradisStripTerminalControlCharacters } from '../../../common/paradisTerminalControlCharacters.js';
import { paradisCanPasteMultiline } from '../../agentIde/browser/paradisAgentIdeTerminalInput.js';
import { paradisScreenShowsAgentPrompt, paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisAgentPromptQuotingError } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisLaunchAgentInWorkspace } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { IParadisTerminalIdentityService } from '../browser/paradisTerminalIdentityService.js';
import { paradisSendAgentMessageToTui } from '../common/paradisAgentMessageSender.js';
import {
	IParadisMobileReviewNote,
	IParadisMobileReviewNoteToSend,
	IParadisMobileStatusFile,
	paradisBuildReviewNotesPrompt,
	paradisLocateReviewNoteLine,
	paradisMobileDiffIdentity,
	paradisIsUntrackedFile,
	paradisMobileReviewState,
	paradisParseMobilePorcelainStatus,
	paradisStagedConsistently,
	paradisWithMobileLineCounts,
	paradisWithUntrackedFileStats,
} from '../common/paradisMobileDiffReview.js';
import { paradisResolveMobileTerminalStateKey } from '../common/paradisMobileRelay.js';
import {
	IParadisMobileReviewSpace,
	PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST,
	PARADIS_MOBILE_REVIEW_MAX_NOTES,
	PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX,
	PARADIS_MOBILE_REVIEW_STORAGE_KEY,
	paradisAddMobileReviewNote,
	paradisApplyMobileReviewMarkChanges,
	paradisDeleteMobileReviewNotes,
	paradisEditMobileReviewNote,
	paradisIsReviewNoteBody,
	paradisIsReviewNoteId,
	paradisIsReviewNoteLine,
	paradisIsReviewPath,
	paradisMarkMobileReviewNotesSent,
	paradisMobileReviewSpace,
	paradisParseMobileReviewMarkChanges,
	paradisParseMobileReviewNoteIds,
	paradisParseMobileReviewStore,
	paradisPruneMobileReviewSpace,
	paradisRemapMobileReviewMarks,
	paradisSerializeMobileReviewStore,
} from '../common/paradisMobileReviewStore.js';
import { IParadisMobileRequest, IParadisMobileRequestContext, registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';

/**
 * モバイルの差分レビューの記録を PC に保存し、行へのメモをエージェントへ送り、確認済みだけをステージする
 * （Orca W2-14 `review.store.v1` / W2-28 `review.notes.v1` `review.stage.v1`）。置き場所はスペースのメモと同じ
 * ウィンドウの WORKSPACE ストレージ。iPhone と iPad で同じ記録を見る。
 *
 * どの要求も応答に `{ t: 'review', ws, marks, notes }`（そのスペースの記録の全体）を含める。
 * - `reviewGet { ws }`: コミット・破棄されて変更の一覧から消えたファイルの印は外す
 * - `reviewSet { ws, marks: [{ path, identity | null }] }`: 印を1件ずつ付ける・外す（全体を送らないので、
 *   別の端末が同時に別のファイルへ付けた印を消さない）
 * - `reviewNoteAdd { ws, path, line, lineText, body }` / `reviewNoteEdit { ws, noteId, body }` / `reviewNoteDelete { ws, ids }`
 * - `reviewNotesClear { ws }`: 送信済みと、行が見つからなくなった（直された）メモをまとめて消す
 * - `reviewNotesSend { ws, ids, target: { terminalKey } | { agent } }`: 保存済みのメモから依頼文を組み立てて
 *   送る（スマホから届いた文章は打ち込まない）。送れたら「送信済み」にして残す（Q120 A）
 * - `reviewStage { ws, entries: [{ path, identity }] }`: いまの中身の識別がスマホの見たものと同じファイルだけ
 *   `git add` し、印をステージ後の識別へ付け替える
 *
 * 記録を読んでから書くまでは await を挟まない（レンダラーは1本のスレッドなので、要求どうしが混ざらない）。
 */

export function paradisReadMobileReviewStore(storage: IStorageService): Map<string, IParadisMobileReviewSpace> {
	return paradisParseMobileReviewStore(storage.get(PARADIS_MOBILE_REVIEW_STORAGE_KEY, StorageScope.WORKSPACE));
}

export function paradisWriteMobileReviewStore(storage: IStorageService, store: ReadonlyMap<string, IParadisMobileReviewSpace>): void {
	storage.store(PARADIS_MOBILE_REVIEW_STORAGE_KEY, paradisSerializeMobileReviewStore(store), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/** 応答の本文（どの要求でも共通の部分）。 */
export function paradisMobileReviewReply(ws: string, space: IParadisMobileReviewSpace): { readonly t: 'review'; readonly ws: string; readonly marks: IParadisMobileReviewSpace['marks']; readonly notes: IParadisMobileReviewSpace['notes'] } {
	return { t: 'review', ws, marks: space.marks, notes: space.notes };
}

/** `ws` が解決できるスペースか確かめる。できなければ応答して undefined。 */
function requireWorkspace(request: IParadisMobileRequest, context: IParadisMobileRequestContext): string | undefined {
	if (typeof request.ws !== 'string' || request.ws.length === 0 || context.root === undefined) {
		context.reply({ error: `unknown workspace: ${request.ws ?? ''}` });
		return undefined;
	}
	return request.ws;
}

/** そのスペースの記録を変えて保存し、応答する（同期で読んでから書く）。`update` が undefined を返したら `error` で応答。 */
function updateSpace(storage: IStorageService, ws: string, context: IParadisMobileRequestContext, update: (space: IParadisMobileReviewSpace) => IParadisMobileReviewSpace | undefined, error: string, extra: object = {}): void {
	const store = paradisReadMobileReviewStore(storage);
	const space = update(paradisMobileReviewSpace(store, ws));
	if (space === undefined) {
		context.reply({ error });
		return;
	}
	store.set(ws, space);
	paradisWriteMobileReviewStore(storage, store);
	context.reply({ ...paradisMobileReviewReply(ws, space), ...extra });
}

/** スペースの中のファイルの大きさと最終更新時刻（フォルダ・読めないものは undefined）。 */
async function statWorkspaceFile(context: IParadisMobileRequestContext, fileService: IFileService, path: string): Promise<{ size: number; mtime: number } | undefined> {
	const uri = await context.resolvePath(path);
	if (uri === undefined) {
		return undefined;
	}
	const stat = await fileService.stat(uri);
	return stat.isDirectory ? undefined : { size: stat.size, mtime: stat.mtime };
}

/** status と両側の行数、未追跡のファイルの大きさと時刻を読む（scm `status` 応答と同じ材料）。 */
async function readStatusWithCounts(context: IParadisMobileRequestContext, fileService: IFileService): Promise<IParadisMobileStatusFile[] | undefined> {
	const [status, unstaged, staged] = await Promise.all([
		context.runGit(['status', '--porcelain=v1']),
		context.runGit(['diff', '--numstat', '-z']).catch(() => undefined),
		context.runGit(['diff', '--cached', '--numstat', '-z']).catch(() => undefined),
	]);
	if (status.code !== 0) {
		return undefined;
	}
	const files = paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status.stdout), unstaged?.code === 0 ? unstaged.stdout : undefined, staged?.code === 0 ? staged.stdout : undefined);
	return paradisWithUntrackedFileStats(files, path => statWorkspaceFile(context, fileService, path));
}

/** 行を追いかけるために読むファイルの上限。これより大きいファイルのメモは「古い」と判定しない。 */
const LOCATE_FILE_SIZE_LIMIT = 2 * 1024 * 1024;

/**
 * メモの行がいま作業ツリーのファイルのどこにあるか。`'unknown'` は読めなかった（大きすぎるなど）ので判定しない。
 * ファイルが無い（削除された）ときは undefined（古いメモ）。
 */
async function locateNotes(notes: readonly IParadisMobileReviewNote[], context: IParadisMobileRequestContext, fileService: IFileService): Promise<Map<string, number | undefined | 'unknown'>> {
	const linesByPath = new Map<string, readonly string[] | undefined | 'unknown'>();
	for (const path of new Set(notes.map(note => note.path))) {
		const uri = await context.resolvePath(path);
		if (uri === undefined) {
			linesByPath.set(path, undefined);
			continue;
		}
		try {
			const stat = await fileService.stat(uri);
			if (stat.isDirectory || stat.size > LOCATE_FILE_SIZE_LIMIT) {
				linesByPath.set(path, 'unknown');
				continue;
			}
			const content = await fileService.readFile(uri, { limits: { size: LOCATE_FILE_SIZE_LIMIT } });
			linesByPath.set(path, content.value.toString().split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line));
		} catch {
			linesByPath.set(path, undefined);
		}
	}
	const located = new Map<string, number | undefined | 'unknown'>();
	for (const note of notes) {
		const lines = linesByPath.get(note.path);
		located.set(note.id, lines === 'unknown' ? 'unknown' : lines === undefined ? undefined
			: paradisLocateReviewNoteLine(line => lines[line - 1]?.slice(0, PARADIS_MOBILE_REVIEW_NOTE_LINE_TEXT_MAX), note.line, note.lineText));
	}
	return located;
}

/** エージェントのターミナルへ送ってよいか。 */
export type ParadisReviewNotesTargetVerdict = 'ready' | 'not-agent' | 'busy' | 'parked' | 'not-running';

/**
 * 既にあるターミナルへ依頼文を貼り付けてよいかの判定。**貼り付けた後に Enter を送る**ので、エージェントが
 * 抜けてシェル（や ssh・python など別のプログラム）に戻っていると、依頼文がそのプログラムへの入力として
 * 実行される。複数行の貼り付けの判定はエージェント向けの IDE 操作ツールと同じ `paradisCanPasteMultiline`
 * （貼り付けの囲みが有効で、シェル統合で前面のコマンドが Claude Code / Codex と確かめられたときだけ）を使う。
 * 確かめられないターミナルには送らない（新しいエージェントを起動してもらう）。
 */
export function paradisReviewNotesTargetVerdict(input: {
	/** そのスペースのターミナルで、エージェントが動いた実績がある。 */
	readonly isAgent: boolean;
	readonly status: ParadisAgentStatus | undefined;
	/** PC の画面から外れていて（park 中）、画面の中身を読めない。 */
	readonly parked: boolean;
	/** 複数行を貼り付けてよい（`paradisCanPasteMultiline`）。 */
	readonly canPasteMultiline: boolean;
	/** 画面に許可の確認や質問の選択肢が出ている（Enter が選択肢を確定してしまう）。 */
	readonly screenShowsPrompt: boolean;
}): ParadisReviewNotesTargetVerdict {
	if (!input.isAgent) {
		return 'not-agent';
	}
	if (input.parked) {
		return 'parked';
	}
	if (input.status === 'working' || input.status === 'permission' || input.status === 'question' || input.screenShowsPrompt) {
		return 'busy';
	}
	return input.canPasteMultiline ? 'ready' : 'not-running';
}

const TARGET_ERRORS: Record<Exclude<ParadisReviewNotesTargetVerdict, 'ready'>, string> = {
	'not-agent': 'このターミナルではエージェントが動いていません。',
	'busy': 'エージェントが作業中か、確認を待っています。終わってから送ってください。',
	'parked': 'このターミナルは PC の画面に出ていないため、エージェントの状態を確かめられません。新しいエージェントで送ってください。',
	'not-running': 'このターミナルでエージェントが入力を待っていることを確かめられません。新しいエージェントで送ってください。',
};

/** 送信中のスペース（同じスペースへの二重送信を防ぐ）。 */
const sendingSpaces = new Set<string>();

/** 依頼文の上限（文字）。これを超えるなら何回かに分けて送ってもらう。 */
const MAX_PROMPT_LENGTH = 16_000;

registerParadisMobileRequestHandler('scm', 'reviewGet', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const status = await context.runGit(['status', '--porcelain=v1']);
		const store = paradisReadMobileReviewStore(storage);
		let space = paradisMobileReviewSpace(store, ws);
		if (status.code === 0) {
			const pruned = paradisPruneMobileReviewSpace(space, new Set(paradisParseMobilePorcelainStatus(status.stdout).map(file => file.path)));
			if (pruned !== space) {
				space = pruned;
				store.set(ws, space);
				paradisWriteMobileReviewStore(storage, store);
			}
		}
		context.reply(paradisMobileReviewReply(ws, space));
	},
});

registerParadisMobileRequestHandler('scm', 'reviewSet', {
	handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const changes = paradisParseMobileReviewMarkChanges(request.marks);
		if (changes === undefined) {
			context.reply({ error: 'invalid marks' });
			return;
		}
		updateSpace(storage, ws, context, space => paradisApplyMobileReviewMarkChanges(space, changes, Date.now()), 'invalid marks');
	},
});

registerParadisMobileRequestHandler('scm', 'reviewNoteAdd', {
	handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const { path, line, lineText, body } = request;
		if (!paradisIsReviewPath(path) || !paradisIsReviewNoteLine(line) || typeof lineText !== 'string' || lineText.length > 10_000 || !paradisIsReviewNoteBody(body)) {
			context.reply({ error: 'invalid note' });
			return;
		}
		const id = generateUuid();
		updateSpace(storage, ws, context, space => paradisAddMobileReviewNote(space, { id, path, line, lineText, body }, Date.now()), `メモが上限（${PARADIS_MOBILE_REVIEW_MAX_NOTES} 件）に達しています。送信済みや古いメモを消してから書いてください。`, { added: id });
	},
});

registerParadisMobileRequestHandler('scm', 'reviewNoteEdit', {
	handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		// `id` は応答の宛先なので、メモの id は `noteId` で受ける
		const { noteId, body } = request;
		if (!paradisIsReviewNoteId(noteId) || !paradisIsReviewNoteBody(body)) {
			context.reply({ error: 'invalid note' });
			return;
		}
		updateSpace(storage, ws, context, space => paradisEditMobileReviewNote(space, noteId, body, Date.now()), 'unknown note');
	},
});

registerParadisMobileRequestHandler('scm', 'reviewNoteDelete', {
	handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const ids = paradisParseMobileReviewNoteIds(request.ids);
		if (ids === undefined) {
			context.reply({ error: 'invalid ids' });
			return;
		}
		updateSpace(storage, ws, context, space => paradisDeleteMobileReviewNotes(space, ids, Date.now()), 'invalid ids');
	},
});

registerParadisMobileRequestHandler('scm', 'reviewNotesClear', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const fileService = accessor.get(IFileService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		// コミット・破棄されて変更の一覧から消えたファイルのメモも片付ける（ファイルに行が残っていても、もう差分には出ない）
		const status = await context.runGit(['status', '--porcelain=v1']);
		const changedPaths = status.code === 0 ? new Set(paradisParseMobilePorcelainStatus(status.stdout).map(file => file.path)) : undefined;
		const unsent = paradisMobileReviewSpace(paradisReadMobileReviewStore(storage), ws).notes.filter(note => note.sentAt === undefined);
		const committed = new Set(changedPaths === undefined ? [] : unsent.filter(note => !changedPaths.has(note.path)).map(note => note.id));
		const located = await locateNotes(unsent.filter(note => !committed.has(note.id)), context, fileService);
		const stale = new Set([...committed, ...unsent.filter(note => !committed.has(note.id) && located.get(note.id) === undefined).map(note => note.id)]);
		// 行を探している間に書き足されたメモは消さない（送信済みか、探して古いと分かったものだけ）
		const store = paradisReadMobileReviewStore(storage);
		const current = paradisMobileReviewSpace(store, ws);
		const ids = new Set(current.notes.filter(note => note.sentAt !== undefined || stale.has(note.id)).map(note => note.id));
		const space = paradisDeleteMobileReviewNotes(current, ids, Date.now());
		store.set(ws, space);
		paradisWriteMobileReviewStore(storage, store);
		context.reply({ ...paradisMobileReviewReply(ws, space), removed: ids.size });
	},
});

/** 送信に使うサービス（要求の処理の同期的な先頭で accessor から取り出す）。 */
interface IReviewNotesSendServices {
	readonly storage: IStorageService;
	readonly fileService: IFileService;
	readonly terminalService: ITerminalService;
	readonly terminalGroupService: ITerminalGroupService;
	readonly identityService: IParadisTerminalIdentityService;
	readonly scopeService: IParadisTerminalScopeService;
	readonly switchService: IParadisWorkspaceSwitchService;
	readonly agentStatusStore: IParadisAgentStatusStore;
	readonly instantiationService: IInstantiationService;
}

type ReviewNotesSendTarget = { readonly kind: 'terminal'; readonly terminalKey: string } | { readonly kind: 'launch'; readonly agent: string };

/** 送信の本体。呼び出し側がスペースごとの送信中の印を持つ。 */
async function sendReviewNotes(services: IReviewNotesSendServices, context: IParadisMobileRequestContext, ws: string, root: URI, ids: ReadonlySet<string>, target: ReviewNotesSendTarget): Promise<void> {
	const notes = paradisMobileReviewSpace(paradisReadMobileReviewStore(services.storage), ws).notes.filter(note => ids.has(note.id));
	if (notes.length === 0) {
		context.reply({ error: 'メモが見つかりません。一覧を読み直してください。', code: 'gone' });
		return;
	}
	// 送る間（ファイルを読む・貼り付けを待つ・エージェントを起動する）に書き直されたメモは、送った内容と違うので
	// 送信済みにしない。読んだときの版を控える
	const readVersions = new Map(notes.map(note => [note.id, note.updatedAt]));
	const located = await locateNotes(notes, context, services.fileService);
	const toSend: IParadisMobileReviewNoteToSend[] = notes.map(note => {
		const line = located.get(note.id);
		return { note, currentLine: line === 'unknown' ? note.line : line };
	});
	// メモの本文と控えた行の中身はリポジトリや利用者から来る。ESC を通すと貼り付けの終わりの印（`ESC [201~`）を
	// 偽造でき、その後ろが打鍵として流れるので、改行以外の制御文字を落とす（起動コマンドのプロンプトと同じ規則）
	const prompt = paradisStripTerminalControlCharacters(paradisBuildReviewNotesPrompt(toSend));
	if (prompt.length > MAX_PROMPT_LENGTH) {
		context.reply({ error: 'メモが長すぎます。何回かに分けて送ってください。', code: 'too-long' });
		return;
	}

	if (target.kind === 'terminal') {
		const findInstance = (): ITerminalInstance | undefined => {
			const instanceId = services.identityService.getInstanceId(target.terminalKey);
			return instanceId === undefined ? undefined : paradisCollectAllTerminalInstances(services.terminalService, services.terminalGroupService).find(candidate => candidate.instanceId === instanceId);
		};
		const verdictOf = (instance: ITerminalInstance | undefined): ParadisReviewNotesTargetVerdict => {
			if (instance === undefined || instance.isDisposed) {
				return 'not-agent';
			}
			const stateKey = paradisResolveMobileTerminalStateKey(services.scopeService.getStateKeyForInstance(instance.instanceId), services.scopeService.resolveScope(instance.instanceId), services.switchService.activeStateKey);
			return paradisReviewNotesTargetVerdict({
				isAgent: stateKey === ws && services.agentStatusStore.isAgentInstance(instance.instanceId),
				status: services.agentStatusStore.getInstanceStatus(instance.instanceId),
				parked: instance.xterm === undefined,
				canPasteMultiline: paradisCanPasteMultiline(instance),
				screenShowsPrompt: paradisScreenShowsAgentPrompt(paradisVisibleTerminalText(instance)),
			});
		};
		const instance = findInstance();
		const verdict = verdictOf(instance);
		if (instance === undefined || verdict !== 'ready') {
			// アプリは `error` の文をそのまま出す（`code` は判定用）
			context.reply({ error: TARGET_ERRORS[verdict === 'ready' ? 'not-agent' : verdict], code: verdict });
			return;
		}
		// 貼り付けの前と Enter の前に、同じ判定で同じターミナルがまだ受け取れる状態かを確かめ直す
		const outcome = await paradisSendAgentMessageToTui(
			prompt,
			(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
			async () => findInstance() === instance && verdictOf(instance) === 'ready',
		);
		if (!outcome.executed) {
			context.reply({ error: outcome.consumed ? '貼り付けた後にエージェントの状態が変わったため、送信の確定をしませんでした。PC で確かめてください。' : '送る直前にエージェントの状態が変わりました。', code: 'changed', consumed: outcome.consumed });
			return;
		}
	} else {
		try {
			// 利用者が PC で作業している最中に前へ出さない（エージェントの IDE 操作や定期実行と同じ扱い）
			await services.instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, { rootUri: root, stateKey: ws, agentId: target.agent, prompt, preserveFocus: true });
		} catch (error) {
			if (error instanceof ParadisAgentPromptQuotingError) {
				context.reply({ error: 'メモにバックスラッシュ（\\）が含まれていて、PC のシェルの種類が分からないため、新しいエージェントへは安全に渡せません。動いているエージェントへ送るか、PC で起動してください。', code: 'quoting' });
				return;
			}
			throw error;
		}
		// 新しいターミナルをすぐスマホの送り先・一覧に出す
		context.pushState();
	}

	updateSpace(services.storage, ws, context, space => paradisMarkMobileReviewNotesSent(space, new Set(space.notes.filter(note => readVersions.get(note.id) === note.updatedAt).map(note => note.id)), Date.now()), 'unreachable', { sent: notes.map(note => note.id) });
}

registerParadisMobileRequestHandler('scm', 'reviewNotesSend', {
	async handle(accessor, request, context) {
		const services: IReviewNotesSendServices = {
			storage: accessor.get(IStorageService),
			fileService: accessor.get(IFileService),
			terminalService: accessor.get(ITerminalService),
			terminalGroupService: accessor.get(ITerminalGroupService),
			identityService: accessor.get(IParadisTerminalIdentityService),
			scopeService: accessor.get(IParadisTerminalScopeService),
			switchService: accessor.get(IParadisWorkspaceSwitchService),
			agentStatusStore: accessor.get(IParadisAgentStatusStore),
			instantiationService: accessor.get(IInstantiationService),
		};
		const ws = requireWorkspace(request, context);
		if (ws === undefined || context.root === undefined) {
			return;
		}
		const ids = paradisParseMobileReviewNoteIds(request.ids);
		const raw = request.target as { readonly terminalKey?: unknown; readonly agent?: unknown } | undefined;
		const terminalKey = typeof raw?.terminalKey === 'string' && raw.terminalKey.length > 0 && raw.terminalKey.length <= 200 ? raw.terminalKey : undefined;
		const agent = typeof raw?.agent === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw.agent) ? raw.agent : undefined;
		const target: ReviewNotesSendTarget | undefined = terminalKey !== undefined && agent === undefined ? { kind: 'terminal', terminalKey }
			: agent !== undefined && terminalKey === undefined ? { kind: 'launch', agent }
				: undefined;
		if (ids === undefined || target === undefined) {
			context.reply({ error: 'invalid request' });
			return;
		}
		// iPhone と iPad から同時に（または連打で）送ると、同じメモを二度貼り付けることになる
		if (sendingSpaces.has(ws)) {
			context.reply({ error: 'このスペースのメモを送っている最中です。終わってからもう一度送ってください。', code: 'sending' });
			return;
		}
		sendingSpaces.add(ws);
		try {
			await sendReviewNotes(services, context, ws, context.root, ids, target);
		} finally {
			sendingSpaces.delete(ws);
		}
	},
});

/** ステージしなかった理由。 */
type ReviewStageSkip = 'gone' | 'changed' | 'not-reviewed' | 'staged' | 'conflict' | 'unsupported';

registerParadisMobileRequestHandler('scm', 'reviewStage', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined) {
			return;
		}
		const entries = Array.isArray(request.entries) && request.entries.length > 0 && request.entries.length <= PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST
			? request.entries.filter((entry): entry is { path: string; identity: string } => typeof entry === 'object' && entry !== null && paradisIsReviewPath((entry as { path?: unknown }).path) && typeof (entry as { identity?: unknown }).identity === 'string')
			: [];
		if (entries.length === 0) {
			context.reply({ error: 'invalid entries' });
			return;
		}
		const fileService = accessor.get(IFileService);
		const before = await readStatusWithCounts(context, fileService);
		if (before === undefined) {
			context.reply({ error: 'git status failed' });
			return;
		}
		const byPath = new Map(before.map(file => [file.path, file]));
		const toStage: string[] = [];
		const skipped: { path: string; reason: ReviewStageSkip }[] = [];
		const identities = new Map<string, string>();
		// 足してよいのは PC に保存した「確認済み」の印が今の中身と一致するものだけ（スマホが送ってきた識別だけを
		// 信じない。別の端末で外された印や、確認していないファイルを足さない）
		const marks = paradisMobileReviewSpace(paradisReadMobileReviewStore(storage), ws).marks;
		for (const entry of entries) {
			const file = byPath.get(entry.path);
			const identity = file !== undefined ? paradisMobileDiffIdentity(file) : undefined;
			const reason: ReviewStageSkip | undefined = file === undefined ? 'gone'
				: identity !== entry.identity ? 'changed'
					: paradisMobileReviewState(identity, marks[entry.path]) !== 'reviewed' ? 'not-reviewed'
						: file.x === 'U' || file.y === 'U' || (file.x === 'A' && file.y === 'A') || (file.x === 'D' && file.y === 'D') ? 'conflict'
							: file.y === ' ' ? 'staged'
								// 引用付きのパス（特殊な文字）は status の表記と実際の名前が違う。未追跡のフォルダ（`dir/`）は、
								// 確認した後に中に足されたファイルまで入るので扱わない
								: entry.path.startsWith('"') || (file.x === '?' && !paradisIsUntrackedFile(file)) ? 'unsupported'
									: undefined;
			if (reason !== undefined) {
				skipped.push({ path: entry.path, reason });
			} else if (identity !== undefined && !toStage.includes(entry.path)) {
				toStage.push(entry.path);
				identities.set(entry.path, identity);
			}
		}
		if (toStage.length > 0) {
			// `:(literal)` でパスの記法（`*` や先頭の `:` など）を読ませず、書いたとおりの名前だけを足す
			const added = await context.runGit(['add', '--', ...toStage.map(path => `:(literal)${path}`)]);
			if (added.code !== 0) {
				context.reply({ error: added.stderr.trim() || 'git add failed' });
				return;
			}
		}
		const after = await readStatusWithCounts(context, fileService);
		const restaged = new Map<string, { before: string; after: string }>();
		for (const file of after ?? []) {
			const previous = identities.get(file.path);
			const original = byPath.get(file.path);
			// 足した中身がスマホの見たものと同じだと行数（未追跡は大きさと時刻）で確かめられたものだけ付け替える
			if (previous !== undefined && original !== undefined && paradisStagedConsistently(original, file)) {
				restaged.set(file.path, { before: previous, after: paradisMobileDiffIdentity(file) });
			}
		}
		updateSpace(storage, ws, context, space => paradisRemapMobileReviewMarks(space, restaged), 'unreachable', { staged: toStage, skipped });
	},
});

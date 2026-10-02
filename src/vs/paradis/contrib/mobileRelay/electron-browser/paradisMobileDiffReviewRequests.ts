/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { paradisStripTerminalControlCharacters } from '../../../common/paradisTerminalControlCharacters.js';
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
	paradisStagedContentDiffers,
} from '../common/paradisMobileDiffReview.js';
import { paradisStatMobileWorkspaceFiles } from '../common/paradisMobileWorkspaceFileStats.js';
import { paradisIsMobileHostNoResponse, paradisWithHostDeadline } from '../common/paradisMobileHostDeadline.js';
import { paradisReadMobileStatusFiles } from '../common/paradisMobileScmStatusRead.js';
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
	paradisNextMobileReviewRevision,
	paradisParseMobileReviewMarkChanges,
	paradisParseMobileReviewNoteIds,
	paradisParseMobileReviewStore,
	paradisPruneMobileReviewSpace,
	paradisRemapMobileReviewMarks,
	paradisSerializeMobileReviewStore,
} from '../common/paradisMobileReviewStore.js';
import { IParadisAgentPromptServices, ParadisAgentPromptTarget, ParadisMobileSendGate, paradisAgentPromptServices, paradisDeliverAgentPrompt, paradisParseAgentPromptTarget } from './paradisMobileAgentPromptDelivery.js';
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
export function paradisMobileReviewReply(ws: string, space: IParadisMobileReviewSpace): { readonly t: 'review'; readonly ws: string; readonly revision: number; readonly marks: IParadisMobileReviewSpace['marks']; readonly notes: IParadisMobileReviewSpace['notes'] } {
	return { t: 'review', ws, revision: space.revision, marks: space.marks, notes: space.notes };
}

/** 変えた記録を次の版にして保存し、保存したものを返す（同期で読んでから書く呼び出し側の中で使う）。 */
function saveSpace(storage: IStorageService, store: Map<string, IParadisMobileReviewSpace>, ws: string, next: IParadisMobileReviewSpace): IParadisMobileReviewSpace {
	const saved = paradisNextMobileReviewRevision(paradisMobileReviewSpace(store, ws), next);
	store.set(ws, saved);
	paradisWriteMobileReviewStore(storage, store);
	return saved;
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
	context.reply({ ...paradisMobileReviewReply(ws, saveSpace(storage, store, ws, space)), ...extra });
}

/** status と両側の行数、未追跡のファイルの大きさと時刻を読む（scm `status` 応答と同じ材料）。 */
async function readStatusWithCounts(context: IParadisMobileRequestContext, fileService: IFileService, root: URI): Promise<IParadisMobileStatusFile[] | undefined> {
	// ステージの判定は行数と大きさまで揃った一覧で行う（省くと識別が変わる）ので、全部を上限つきで待ち、
	// 接続先が返さなければ「接続先が応答しません」で失敗させる
	return paradisReadMobileStatusFiles({
		runGit: args => context.runGit(args),
		statFiles: paths => paradisStatMobileWorkspaceFiles(fileService, root, paths),
	});
}

/** `git add` の後に、未追跡だったファイルの大きさを調べ直す上限（アプリは reviewStage を 90 秒待つ）。 */
const AFTER_STAT_DEADLINE_MS = 10_000;

/** `git add` の後に確かめられなかった（接続先が返さなかった）ときの応答。 */
const STAGED_UNVERIFIED = { error: 'ステージしましたが、確かめられませんでした。PC でステージを確かめてください。', code: 'staged-unverified' };

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

/** 送信中のスペース（同じスペースへの二重送信を防ぐ）。 */
const sendGate = new ParadisMobileSendGate();

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
				space = saveSpace(storage, store, ws, pruned);
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
		// コミット・破棄されて変更の一覧から消えたファイルのメモも片付ける（ファイルに行が残っていても、もう差分には出ない）。
		// 未追跡のフォルダの中のファイルのメモを「一覧に無い」と誤らないよう、フォルダの中まで1件ずつ出す（-uall）
		const status = await context.runGit(['status', '--porcelain=v1', '-uall']);
		const changedPaths = status.code === 0 ? new Set(paradisParseMobilePorcelainStatus(status.stdout).map(file => file.path)) : undefined;
		const unsent = paradisMobileReviewSpace(paradisReadMobileReviewStore(storage), ws).notes.filter(note => note.sentAt === undefined);
		const committed = new Set(changedPaths === undefined ? [] : unsent.filter(note => !changedPaths.has(note.path)).map(note => note.id));
		const located = await locateNotes(unsent.filter(note => !committed.has(note.id)), context, fileService);
		const stale = new Set([...committed, ...unsent.filter(note => !committed.has(note.id) && located.get(note.id) === undefined).map(note => note.id)]);
		// 行を探している間に書き足されたメモは消さない（送信済みか、探して古いと分かったものだけ）
		const store = paradisReadMobileReviewStore(storage);
		const current = paradisMobileReviewSpace(store, ws);
		const ids = new Set(current.notes.filter(note => note.sentAt !== undefined || stale.has(note.id)).map(note => note.id));
		const space = saveSpace(storage, store, ws, paradisDeleteMobileReviewNotes(current, ids, Date.now()));
		context.reply({ ...paradisMobileReviewReply(ws, space), removed: ids.size });
	},
});

/** 送信に使うサービス（要求の処理の同期的な先頭で accessor から取り出す）。 */
interface IReviewNotesSendServices extends IParadisAgentPromptServices {
	readonly storage: IStorageService;
	readonly fileService: IFileService;
}

/** 送信の本体。呼び出し側がスペースごとの送信中の印を持つ。 */
async function sendReviewNotes(services: IReviewNotesSendServices, context: IParadisMobileRequestContext, ws: string, root: URI, ids: ReadonlySet<string>, target: ParadisAgentPromptTarget): Promise<void> {
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
	// 既にあるターミナルへの貼り付けと新しいエージェントの起動（paradisMobileAgentPromptDelivery.ts）
	const outcome = await paradisDeliverAgentPrompt(services, ws, root, prompt, target, () => context.pushState());
	if (!outcome.ok) {
		// アプリは `error` の文をそのまま出す（`code` は判定用）
		context.reply({ error: outcome.error, code: outcome.code, ...(outcome.consumed !== undefined ? { consumed: outcome.consumed } : {}) });
		return;
	}

	updateSpace(services.storage, ws, context, space => paradisMarkMobileReviewNotesSent(space, new Set(space.notes.filter(note => readVersions.get(note.id) === note.updatedAt).map(note => note.id)), Date.now()), 'unreachable', { sent: notes.map(note => note.id) });
}

registerParadisMobileRequestHandler('scm', 'reviewNotesSend', {
	async handle(accessor, request, context) {
		const services: IReviewNotesSendServices = {
			...paradisAgentPromptServices(accessor),
			storage: accessor.get(IStorageService),
			fileService: accessor.get(IFileService),
		};
		const ws = requireWorkspace(request, context);
		if (ws === undefined || context.root === undefined) {
			return;
		}
		const ids = paradisParseMobileReviewNoteIds(request.ids);
		// メモの送り先は、選んだターミナルか、選んだエージェントの起動（W2-28 の形）
		const target = paradisParseAgentPromptTarget(request.target);
		if (ids === undefined || target === undefined || target.kind === 'auto' || target.kind === 'new') {
			context.reply({ error: 'invalid request' });
			return;
		}
		const root = context.root;
		// iPhone と iPad から同時に（または連打で）送ると、同じメモを二度貼り付けることになる
		const done = await sendGate.run(ws, async () => {
			await sendReviewNotes(services, context, ws, root, ids, target);
			return true;
		});
		if (done === undefined) {
			context.reply({ error: 'このスペースのメモを送っている最中です。終わってからもう一度送ってください。', code: 'sending' });
		}
	},
});

/** ステージしなかった理由。 */
type ReviewStageSkip = 'gone' | 'changed' | 'not-reviewed' | 'staged' | 'conflict' | 'unsupported';

registerParadisMobileRequestHandler('scm', 'reviewStage', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const ws = requireWorkspace(request, context);
		const root = context.root;
		if (ws === undefined || root === undefined) {
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
		const before = await readStatusWithCounts(context, fileService, root);
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
								// 大きさの無い未追跡のファイル（調べる上限より後ろ・読めなかった）は、足した中身を確かめられない
								: entry.path.startsWith('"') || (file.x === '?' && (!paradisIsUntrackedFile(file) || file.size === undefined)) ? 'unsupported'
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
		// 未追跡だったファイルは足した後の status に大きさが載らない（追跡中になる）ので、調べ直して渡す
		const wasUntracked = toStage.filter(path => byPath.get(path)?.x === '?');
		let after: IParadisMobileStatusFile[] | undefined;
		let afterStats: ReadonlyMap<string, { readonly size: number; readonly mtime: number }>;
		try {
			after = await readStatusWithCounts(context, fileService, root);
			afterStats = await paradisWithHostDeadline(paradisStatMobileWorkspaceFiles(fileService, root, wasUntracked), AFTER_STAT_DEADLINE_MS);
		} catch (error) {
			// 足した後を読めないと、確かめていない中身を戻すことも印を付け替えることもできない。
			// ステージしたことは伝え、PC で確かめてもらう（印は付け替えない）
			if (paradisIsMobileHostNoResponse(error) && toStage.length > 0) {
				context.reply(STAGED_UNVERIFIED);
				return;
			}
			throw error;
		}
		// 確かめてから足すまでの間に書き換えられて、確認していない中身を足したと分かったものは、足す前へ戻す
		// （足す前はステージ側に変更が無かったものだけが対象なので、`restore --staged` で元どおりになる）
		const differed = (after ?? []).filter(file => {
			const original = byPath.get(file.path);
			return identities.has(file.path) && original !== undefined && paradisStagedContentDiffers(original, file, afterStats.get(file.path));
		}).map(file => file.path);
		let staged = toStage;
		if (differed.length > 0) {
			const restored = await context.runGit(['restore', '--staged', '--', ...differed.map(path => `:(literal)${path}`)]).catch(() => undefined);
			if (restored?.code !== 0) {
				// 戻せなかった（まだコミットの無いリポジトリでは HEAD が無く `restore --staged` が失敗する）。確かめていない
				// 中身がステージに残っているので、ステージできたとは返さない
				context.reply({ error: '確認した後に書き換えられたファイルをステージしてしまい、元に戻せませんでした。PC でステージを確かめてください。', code: 'restore-failed' });
				return;
			}
			staged = toStage.filter(path => !differed.includes(path));
			skipped.push(...differed.map(path => ({ path, reason: 'changed' as const })));
		}
		const restaged = new Map<string, { before: string; after: string }>();
		for (const file of after ?? []) {
			const previous = staged.includes(file.path) ? identities.get(file.path) : undefined;
			const original = byPath.get(file.path);
			// 足した中身がスマホの見たものと同じだと行数（未追跡は大きさと時刻）で確かめられたものだけ付け替える
			if (previous !== undefined && original !== undefined && paradisStagedConsistently(original, file, afterStats.get(file.path))) {
				restaged.set(file.path, { before: previous, after: paradisMobileDiffIdentity(file) });
			}
		}
		updateSpace(storage, ws, context, space => paradisRemapMobileReviewMarks(space, restaged), 'unreachable', { staged, skipped });
	},
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisCollectAllTerminalInstances } from '../../agentBrowser/browser/paradisLivePaneInstances.js';
import { paradisScreenShowsAgentPrompt, paradisVisibleTerminalText } from '../../agentChat/browser/paradisAgentTuiInput.js';
import { IParadisAgentStatusStore, IParadisTerminalScopeService, IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
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
	paradisParseMobilePorcelainStatus,
	paradisWithMobileLineCounts,
} from '../common/paradisMobileDiffReview.js';
import { paradisResolveMobileTerminalStateKey } from '../common/paradisMobileRelay.js';
import {
	IParadisMobileReviewSpace,
	PARADIS_MOBILE_REVIEW_MAX_MARKS_PER_REQUEST,
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

/** status と両側の行数を読む（scm `status` 応答と同じ材料）。 */
async function readStatusWithCounts(context: IParadisMobileRequestContext): Promise<IParadisMobileStatusFile[] | undefined> {
	const [status, unstaged, staged] = await Promise.all([
		context.runGit(['status', '--porcelain=v1']),
		context.runGit(['diff', '--numstat', '-z']).catch(() => undefined),
		context.runGit(['diff', '--cached', '--numstat', '-z']).catch(() => undefined),
	]);
	if (status.code !== 0) {
		return undefined;
	}
	return paradisWithMobileLineCounts(paradisParseMobilePorcelainStatus(status.stdout), unstaged?.code === 0 ? unstaged.stdout : undefined, staged?.code === 0 ? staged.stdout : undefined);
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
export type ParadisReviewNotesTargetVerdict = 'ready' | 'not-agent' | 'busy' | 'not-running' | 'unknown-foreground';

/**
 * 既にあるターミナルへ依頼文を貼り付けてよいかの判定。**貼り付けた後に Enter を送る**ので、エージェントが
 * 抜けてシェルに戻っていると、依頼文がシェルのコマンドとして実行される。前面でコマンド（エージェント）が
 * 動いていることをシェル統合で確かめられないターミナルには送らない（新しいエージェントを起動してもらう）。
 */
export function paradisReviewNotesTargetVerdict(input: {
	readonly isAgent: boolean;
	readonly status: ParadisAgentStatus | undefined;
	/** シェル統合のコマンド検出があるか。無ければ前面のプロセスを確かめられない。 */
	readonly hasCommandDetection: boolean;
	/** 前面で動いているコマンド（シェルのプロンプトに戻っていれば undefined）。 */
	readonly executingCommand: string | undefined;
	/** 画面に許可の確認や質問の選択肢が出ている（Enter が選択肢を確定してしまう）。 */
	readonly screenShowsPrompt: boolean;
}): ParadisReviewNotesTargetVerdict {
	if (!input.isAgent) {
		return 'not-agent';
	}
	if (input.status === 'working' || input.status === 'permission' || input.status === 'question' || input.screenShowsPrompt) {
		return 'busy';
	}
	if (!input.hasCommandDetection) {
		return 'unknown-foreground';
	}
	return input.executingCommand !== undefined ? 'ready' : 'not-running';
}

const TARGET_ERRORS: Record<Exclude<ParadisReviewNotesTargetVerdict, 'ready'>, string> = {
	'not-agent': 'このターミナルではエージェントが動いていません。',
	'busy': 'エージェントが作業中か、確認を待っています。終わってから送ってください。',
	'not-running': 'エージェントが終了しています。新しいエージェントで送ってください。',
	'unknown-foreground': 'このターミナルではエージェントが動いているか確かめられません。新しいエージェントで送ってください。',
};

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
		updateSpace(storage, ws, context, space => paradisAddMobileReviewNote(space, { id, path, line, lineText, body }, Date.now()), 'too many notes', { added: id });
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
		const unsent = paradisMobileReviewSpace(paradisReadMobileReviewStore(storage), ws).notes.filter(note => note.sentAt === undefined);
		const located = await locateNotes(unsent, context, fileService);
		const stale = new Set(unsent.filter(note => located.get(note.id) === undefined).map(note => note.id));
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

registerParadisMobileRequestHandler('scm', 'reviewNotesSend', {
	async handle(accessor, request, context) {
		const storage = accessor.get(IStorageService);
		const fileService = accessor.get(IFileService);
		const terminalService = accessor.get(ITerminalService);
		const terminalGroupService = accessor.get(ITerminalGroupService);
		const identityService = accessor.get(IParadisTerminalIdentityService);
		const scopeService = accessor.get(IParadisTerminalScopeService);
		const switchService = accessor.get(IParadisWorkspaceSwitchService);
		const agentStatusStore = accessor.get(IParadisAgentStatusStore);
		const instantiationService = accessor.get(IInstantiationService);
		const ws = requireWorkspace(request, context);
		if (ws === undefined || context.root === undefined) {
			return;
		}
		const root = context.root;
		const ids = paradisParseMobileReviewNoteIds(request.ids);
		const target = request.target as { readonly terminalKey?: unknown; readonly agent?: unknown } | undefined;
		const terminalKey = typeof target?.terminalKey === 'string' && target.terminalKey.length > 0 && target.terminalKey.length <= 200 ? target.terminalKey : undefined;
		const agent = typeof target?.agent === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(target.agent) ? target.agent : undefined;
		if (ids === undefined || (terminalKey === undefined) === (agent === undefined)) {
			context.reply({ error: 'invalid request' });
			return;
		}
		const notes = paradisMobileReviewSpace(paradisReadMobileReviewStore(storage), ws).notes.filter(note => ids.has(note.id));
		if (notes.length === 0) {
			context.reply({ error: 'メモが見つかりません。一覧を読み直してください。', code: 'gone' });
			return;
		}
		const located = await locateNotes(notes, context, fileService);
		const toSend: IParadisMobileReviewNoteToSend[] = notes.map(note => {
			const line = located.get(note.id);
			return { note, currentLine: line === 'unknown' ? note.line : line };
		});
		const prompt = paradisBuildReviewNotesPrompt(toSend);
		if (prompt.length > MAX_PROMPT_LENGTH) {
			context.reply({ error: 'メモが長すぎます。何回かに分けて送ってください。', code: 'too-long' });
			return;
		}

		if (terminalKey !== undefined) {
			const findInstance = (): ITerminalInstance | undefined => {
				const instanceId = identityService.getInstanceId(terminalKey);
				return instanceId === undefined ? undefined : paradisCollectAllTerminalInstances(terminalService, terminalGroupService).find(candidate => candidate.instanceId === instanceId);
			};
			const verdictOf = (instance: ITerminalInstance | undefined): ParadisReviewNotesTargetVerdict => {
				if (instance === undefined || instance.isDisposed) {
					return 'not-agent';
				}
				const stateKey = paradisResolveMobileTerminalStateKey(scopeService.getStateKeyForInstance(instance.instanceId), scopeService.resolveScope(instance.instanceId), switchService.activeStateKey);
				const detection = instance.capabilities.get(TerminalCapability.CommandDetection);
				return paradisReviewNotesTargetVerdict({
					isAgent: stateKey === ws && agentStatusStore.isAgentInstance(instance.instanceId),
					status: agentStatusStore.getInstanceStatus(instance.instanceId),
					hasCommandDetection: detection !== undefined,
					executingCommand: detection?.executingCommand,
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
			// 貼り付けの前と Enter の前に、同じターミナルがまだ受け取れる状態かを確かめ直す
			const outcome = await paradisSendAgentMessageToTui(
				prompt,
				(text, execute, bracketedPasteMode) => instance.sendText(text, execute ?? false, bracketedPasteMode),
				async () => findInstance() === instance && verdictOf(instance) === 'ready',
			);
			if (!outcome.executed) {
				context.reply({ error: outcome.consumed ? '貼り付けた後にエージェントの状態が変わったため、送信の確定をしませんでした。PC で確かめてください。' : '送る直前にエージェントの状態が変わりました。', code: 'changed', consumed: outcome.consumed });
				return;
			}
		} else if (agent !== undefined) {
			await instantiationService.invokeFunction(paradisLaunchAgentInWorkspace, { rootUri: root, stateKey: ws, agentId: agent, prompt });
		}

		updateSpace(storage, ws, context, space => paradisMarkMobileReviewNotesSent(space, new Set(notes.map(note => note.id)), Date.now()), 'unreachable', { sent: notes.map(note => note.id) });
	},
});

/** ステージしなかった理由。 */
type ReviewStageSkip = 'gone' | 'changed' | 'staged' | 'conflict' | 'unsupported';

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
		const before = await readStatusWithCounts(context);
		if (before === undefined) {
			context.reply({ error: 'git status failed' });
			return;
		}
		const byPath = new Map(before.map(file => [file.path, file]));
		const toStage: string[] = [];
		const skipped: { path: string; reason: ReviewStageSkip }[] = [];
		const identities = new Map<string, string>();
		for (const entry of entries) {
			const file = byPath.get(entry.path);
			const identity = file !== undefined ? paradisMobileDiffIdentity(file) : undefined;
			const reason: ReviewStageSkip | undefined = file === undefined ? 'gone'
				: identity !== entry.identity ? 'changed'
					: file.x === 'U' || file.y === 'U' || (file.x === 'A' && file.y === 'A') || (file.x === 'D' && file.y === 'D') ? 'conflict'
						: file.y === ' ' ? 'staged'
							// 引用付きのパス（特殊な文字）と、git のパス指定の記法に読まれる先頭 `:` は、狙ったファイル以外を
							// 足しうるので扱わない
							: entry.path.startsWith('"') || entry.path.startsWith(':') ? 'unsupported'
								: undefined;
			if (reason !== undefined) {
				skipped.push({ path: entry.path, reason });
			} else if (identity !== undefined && !toStage.includes(entry.path)) {
				toStage.push(entry.path);
				identities.set(entry.path, identity);
			}
		}
		if (toStage.length > 0) {
			const added = await context.runGit(['add', '--', ...toStage]);
			if (added.code !== 0) {
				context.reply({ error: added.stderr.trim() || 'git add failed' });
				return;
			}
		}
		const after = await readStatusWithCounts(context);
		const restaged = new Map<string, { before: string; after: string }>();
		for (const file of after ?? []) {
			const previous = identities.get(file.path);
			if (previous !== undefined) {
				restaged.set(file.path, { before: previous, after: paradisMobileDiffIdentity(file) });
			}
		}
		updateSpace(storage, ws, context, space => paradisRemapMobileReviewMarks(space, restaged), 'unreachable', { staged: toStage, skipped });
	},
});

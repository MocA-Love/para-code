/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペース切り替えのたびに `.code-workspace` を IPC で確かめて読み直す往復を省く。
 *
 * upstream の `JSONEditingService` は書き込みのたびに「存在確認 → テキストモデルの作成（読み込み）→
 * 書き込み（etag の stat・書き込み・書き込み後の stat）」を行い、`WorkspaceConfiguration.setFolders` は
 * その後でもう一度ファイルを読む。Para Code のウィンドウは切り替えのたびにこれを通るので、ファイルの
 * IPC が詰まっている Mac や SSH の接続先では、存在確認と読み込みだけで数十秒かかっていた
 * （Sentry の `safe_update_folders_resolve_ms`）。
 *
 * ここでは最後に書いた（または読んだ）中身と etag（mtime・size）をメモリに覚え、次の書き込みでは
 * 覚えた中身に `folders` の変更を当てて、**覚えた etag を付けて**直接書く。
 *
 * - 外部での変更（別のエディタ・git の切り替え・別のウィンドウ）は、ファイルの変更の通知
 *   (`IFileService.onDidFilesChange`。監視は upstream の `FileServiceBasedWorkspaceConfiguration` が
 *   同じファイルに張っているものを使う）を受けた時点で stat を 1 回取り、etag が覚えたものと違えば
 *   覚えた中身を捨てる。自分の書き込みの通知（etag が同じ）では捨てない
 * - 監視が通知を取りこぼしても、書き込みの etag の衝突検出（`FILE_MODIFIED_SINCE`）が残る。衝突したら
 *   覚えた中身を捨て、upstream の経路（読み直して書く）で書き直す。ユーザーの設定
 *   `files.saveConflictResolution` によらず、こちらの経路では常に etag を確かめる
 * - テキストモデルが開いているとき（ユーザーがエディタで開いている）は使わない。開いたモデルを
 *   素通りしてディスクに書くと、未保存の編集と食い違うため
 *
 * 書いた直後の読み直し (`FileServiceBasedWorkspaceConfiguration.resolveContent`) には、書いた中身を
 * **1 回だけ・書いてから 10 秒以内・監視の通知を確かめ終えているときだけ** 返す。
 */

import { IDisposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { applyEdit, setProperty } from '../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStatWithMetadata } from '../../../../platform/files/common/files.js';
import { hasWorkspaceFileExtension } from '../../../../platform/workspace/common/workspace.js';
import { IJSONValue } from '../../../../workbench/services/configuration/common/jsonEditing.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../workbench/services/textfile/common/textfiles.js';
import { paradisMarkFolderUpdate, paradisNoteFolderUpdateShortcut } from './paradisFolderUpdateTrace.js';
import { isParadisManagedWorkspaceWindow } from './paradisWorkspaceSwitch.js';

/** 書いた中身を読み直しに渡してよい時間。書いた直後の `setFolders` の読み直しだけを狙う。 */
const RELOAD_OFFER_MS = 10_000;

/** 覚えておく `.code-workspace` の中身。 */
export interface IParadisWorkspaceFileSnapshot {
	readonly content: string;
	readonly etag: string;
	readonly mtime: number;
	readonly encoding: string | undefined;
	readonly formatting: FormattingOptions;
}

interface IEntry extends IParadisWorkspaceFileSnapshot {
	readonly resource: URI;
	/** 読み直しに中身を渡してよい期限（渡したら undefined）。 */
	reloadOfferUntil: number | undefined;
}

/** ウィンドウ（renderer）の中の、今使っているもの。読み直しの側 (`configuration.ts`) から引く。 */
let current: ParadisWorkspaceFileWriteCache | undefined;

/**
 * 書いた直後の読み直しの PARA-PATCH から呼ぶ。渡せる中身が無ければ undefined（読み直す）。
 */
export function paradisTakeWrittenWorkspaceContent(resource: URI): string | undefined {
	return current?.takeWrittenContent(resource);
}

/**
 * `JSONEditingService` が 1 つ持つ。Para Code のウィンドウの `.code-workspace` でだけ働く。
 * upstream のサービスは破棄されないので Disposable を継承しない（購読は覚え始めてから作り、
 * ウィンドウと同じ寿命として singleton の印を付ける）。
 */
export class ParadisWorkspaceFileWriteCache implements IDisposable {

	private entry: IEntry | undefined;

	/** 変更の通知の購読。Para Code のウィンドウで覚え始めてから作る。 */
	private listener: IDisposable | undefined;
	/** 監視の通知を確かめている stat。終わるまで覚えた中身を使わない。 */
	private verifying: Promise<void> | undefined;
	/** 確かめている間に次の通知が来た。 */
	private verifyAgain = false;
	/** 自分の書き込みの最中に通知が来た。書き終えてから確かめる。 */
	private writing = false;
	private verifyAfterWrite = false;

	constructor(
		private readonly fileService: IFileService,
		private readonly textFileService: ITextFileService,
		private readonly now: () => number = () => Date.now(),
		private readonly applies: (resource: URI) => boolean = resource => isParadisManagedWorkspaceWindow() && hasWorkspaceFileExtension(resource),
	) { }

	/**
	 * 覚えた中身で書く。書けたら true。false なら呼び出し元が upstream の経路で書く（覚えた中身は
	 * 捨ててある）。
	 */
	async tryWrite(resource: URI, values: IJSONValue[]): Promise<boolean> {
		if (!this.applies(resource) || !this.entry || !isEqual(this.entry.resource, resource)) {
			return false;
		}
		// エディタで開いているモデルがあれば、その中身（未保存の編集を含む）が正しい。upstream に任せる。
		if (this.textFileService.files.get(resource)) {
			this.forget();
			return false;
		}
		let verified = false;
		while (this.verifying) {
			verified = true;
			await this.verifying;
		}
		const entry = this.entry;
		if (!entry || !isEqual(entry.resource, resource)) {
			return false;
		}
		const content = applyValues(entry.content, values, entry.formatting);
		if (content === undefined) {
			this.forget();
			return false;
		}
		paradisNoteFolderUpdateShortcut(verified ? 'resolve_verified' : 'resolve_cached');
		paradisMarkFolderUpdate('model_resolved');
		if (content === entry.content) {
			paradisMarkFolderUpdate('saved');
			return true;
		}
		this.writing = true;
		try {
			const stat = await this.textFileService.write(resource, content, { etag: entry.etag, mtime: entry.mtime, encoding: entry.encoding });
			if (this.entry !== entry) {
				// 書いている間に別の経路が覚え直した・捨てた。書けたことだけを返す。
				return true;
			}
			paradisMarkFolderUpdate('saved');
			this.setEntry(resource, { ...entry, content, etag: stat.etag, mtime: stat.mtime });
			return true;
		} catch {
			// 衝突 (FILE_MODIFIED_SINCE) でも、それ以外の失敗でも、覚えた中身を捨てて upstream の経路
			// （読み直して書く）で書き直す。失敗の知らせ（保存エラーの通知など）は upstream の経路が出す。
			paradisNoteFolderUpdateShortcut('resolve_conflict');
			this.forget();
			return false;
		} finally {
			this.writing = false;
			if (this.verifyAfterWrite) {
				this.verifyAfterWrite = false;
				this.verify();
			}
		}
	}

	/**
	 * upstream の経路で書いた直後（テキストモデルの参照を手放す前）に呼ぶ。モデルの中身とディスクが
	 * 一致しているときだけ覚える。
	 */
	rememberModel(resource: URI): void {
		if (!this.applies(resource)) {
			return;
		}
		const model = this.textFileService.files.get(resource);
		// `TextFileEditorModel.lastResolvedFileStat`（公開のフィールド）。具象クラスを import すると
		// `configuration.ts` からの読み込みが重くなるので形で読む。
		const stat = (model as { readonly lastResolvedFileStat?: IFileStatWithMetadata } | undefined)?.lastResolvedFileStat;
		if (!model || !stat || !model.isResolved() || !model.hasState(TextFileEditorModelState.SAVED)) {
			this.forget();
			return;
		}
		const textModel = model.textEditorModel;
		const { tabSize, insertSpaces } = textModel.getOptions();
		this.remember(resource, stat, {
			content: textModel.getValue(),
			etag: stat.etag,
			mtime: stat.mtime,
			encoding: model.getEncoding(),
			formatting: { tabSize, insertSpaces, eol: textModel.getEOL() },
		});
	}

	/** テストと `rememberModel` から。`stat` は覚える中身を書いた・読んだときのもの。 */
	remember(resource: URI, stat: Pick<IFileStatWithMetadata, 'etag' | 'mtime'>, snapshot: IParadisWorkspaceFileSnapshot): void {
		if (!this.applies(resource)) {
			return;
		}
		this.setEntry(resource, { ...snapshot, etag: stat.etag, mtime: stat.mtime });
	}

	/** 書いた直後の読み直しに、書いた中身を 1 回だけ渡す。 */
	takeWrittenContent(resource: URI): string | undefined {
		const entry = this.entry;
		if (!entry || !isEqual(entry.resource, resource) || entry.reloadOfferUntil === undefined || this.verifying || this.writing || this.verifyAfterWrite) {
			return undefined;
		}
		const until = entry.reloadOfferUntil;
		entry.reloadOfferUntil = undefined;
		if (this.now() > until) {
			return undefined;
		}
		paradisNoteFolderUpdateShortcut('reload_cached');
		return entry.content;
	}

	/** 覚えた中身を捨てる。通知の購読は残す（次に覚えたとき作り直さない）。 */
	forget(): void {
		this.entry = undefined;
	}

	dispose(): void {
		this.forget();
		this.listener?.dispose();
		this.listener = undefined;
		if (current === this) {
			current = undefined;
		}
	}

	private setEntry(resource: URI, snapshot: IParadisWorkspaceFileSnapshot): void {
		this.entry = { ...snapshot, resource, reloadOfferUntil: this.now() + RELOAD_OFFER_MS };
		current = this;
		this.ensureListener();
	}

	private ensureListener(): void {
		if (this.listener) {
			return;
		}
		// 監視は足さない。覚えるのはこのウィンドウの `.code-workspace` だけで、upstream の
		// `FileServiceBasedWorkspaceConfiguration` が同じファイルを常に監視している（その通知で読み直す）。
		// 同じ通知を受けるので、読み直しより先に覚えた中身を捨てられる。監視を自分でも持つと、
		// 破棄されない upstream のサービスから接続先へ 2 本目の監視を張ったままになる。
		// 取りこぼしても、書き込みの etag の衝突検出が残る（tryWrite）。
		this.listener = markAsSingleton(this.fileService.onDidFilesChange(e => {
			const entry = this.entry;
			if (entry && e.contains(entry.resource)) {
				this.onDidChangeOnDisk();
			}
		}));
	}

	private onDidChangeOnDisk(): void {
		if (!this.entry) {
			return;
		}
		// 通知を受けたら、確かめ終えても読み直しには渡さない（読み直しは upstream が自分で読む）。
		this.entry.reloadOfferUntil = undefined;
		if (this.writing) {
			this.verifyAfterWrite = true;
			return;
		}
		this.verify();
	}

	/** ディスクの etag を 1 回確かめ、覚えたものと違えば捨てる。自分の書き込みの通知なら残す。 */
	private verify(): void {
		if (this.verifying) {
			this.verifyAgain = true;
			return;
		}
		const run = async () => {
			do {
				this.verifyAgain = false;
				const entry = this.entry;
				if (!entry) {
					return;
				}
				let etag: string | undefined;
				try {
					etag = (await this.fileService.stat(entry.resource)).etag;
				} catch {
					etag = undefined; // 消された・読めない
				}
				if (this.entry === entry && etag !== entry.etag) {
					this.forget();
				}
			} while (this.verifyAgain);
		};
		const verifying: Promise<void> = run().finally(() => {
			if (this.verifying === verifying) {
				this.verifying = undefined;
			}
		});
		this.verifying = verifying;
	}
}

/** `JSONEditingService.getEdits` と同じ当て方（1 つ目の edit だけ）。中身が JSON として壊れていれば undefined。 */
function applyValues(content: string, values: IJSONValue[], formatting: FormattingOptions): string | undefined {
	const errors: ParseError[] = [];
	parse(content, errors, { allowTrailingComma: true, allowEmptyContent: true });
	if (errors.length > 0) {
		return undefined;
	}
	let result = content;
	for (const { path, value } of values) {
		if (!path.length) {
			return undefined; // ファイル全体の置き換えは upstream に任せる（Para Code は使わない）
		}
		const edit = setProperty(result, path, value, formatting)[0];
		if (edit) {
			result = applyEdit(result, edit);
		}
	}
	return result;
}

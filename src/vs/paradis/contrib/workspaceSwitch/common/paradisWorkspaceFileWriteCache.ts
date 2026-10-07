/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペース切り替えのたびに `.code-workspace` を IPC で確かめて読み直す往復を省く。
 *
 * upstream の `JSONEditingService` は書き込みのたびに「存在確認 → テキストモデルの作成（バックアップの
 * 確認・読み込み）→ 書き込み（etag の stat・書き込み・書き込み後の stat）」を行い、
 * `WorkspaceConfiguration.setFolders` はその後でもう一度ファイルを読む。Para Code のウィンドウは切り替えの
 * たびにこれを通るので、ファイルの IPC が詰まっている Mac や SSH の接続先では、存在確認と読み込みだけで
 * 数十秒かかっていた（Sentry の `safe_update_folders_resolve_ms`）。
 *
 * ここでは最後に書いた（または読んだ）中身と etag（mtime・size）をメモリに覚え、次の書き込みでは
 * **stat を 1 回だけ取って etag が覚えたものと同じことを確かめてから**、覚えた中身に `folders` の変更を
 * 当てて直接書く。
 *
 * - 外部での変更（別のエディタ・git の切り替え・別のウィンドウ・削除）は、この stat で etag が違う
 *   （または stat が失敗する）ので、覚えた中身を捨てて upstream の経路（読み直して書く）に任せる。
 *   通知に頼らないのは、通知が遅れる・取りこぼされることがあり、書き込みの etag の衝突検出
 *   （`FileService.validateWriteFile`）はサイズの変わらない変更を見逃すため
 * - 書き込みにも覚えた etag を付ける（stat と書き込みの間の変更）。衝突・失敗したら覚えた中身を捨てて
 *   upstream の経路で書き直す。`files.saveConflictResolution` によらず、こちらの経路では常に確かめる
 * - 書き込みは atomic（一時ファイルに書いて置き換える）。ディスクが一杯で途中で失敗しても元の
 *   ファイルを切り詰めない（upstream の経路はモデルに正しい中身が残り、`paradisWorkspaceFileRecovery.ts`
 *   が後で直せるが、こちらはモデルを作らないため）。atomic に書けない provider では使わない
 * - テキストモデルが開いているとき（ユーザーがエディタで開いている）は使わない。開いたモデルを
 *   素通りしてディスクに書くと、未保存の編集と食い違うため
 * - 覚えるのはこのウィンドウのワークスペースのファイルだけ（`resolveContent` が読むもの）
 *
 * 書いた直後の読み直し (`FileServiceBasedWorkspaceConfiguration.resolveContent`) には、書いた中身を
 * **1 回だけ・書いてから 10 秒以内・その後にファイルの変更の通知が来ていないときだけ** 返す。通知が来たら
 * 渡さない（upstream の 50ms の読み直しが自分で読む）。
 */

import { IDisposable, markAsSingleton } from '../../../../base/common/lifecycle.js';
import { applyEdit, setProperty } from '../../../../base/common/jsonEdit.js';
import { FormattingOptions } from '../../../../base/common/jsonFormatter.js';
import { parse, ParseError } from '../../../../base/common/json.js';
import { isEqual } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService, IFileStatWithMetadata } from '../../../../platform/files/common/files.js';
import { hasWorkspaceFileExtension } from '../../../../platform/workspace/common/workspace.js';
import { IJSONValue } from '../../../../workbench/services/configuration/common/jsonEditing.js';
import { ITextFileService, TextFileEditorModelState } from '../../../../workbench/services/textfile/common/textfiles.js';
import { paradisMarkFolderUpdate, paradisNoteFolderUpdateShortcut } from './paradisFolderUpdateTrace.js';
import { isParadisManagedWorkspaceWindow } from './paradisWorkspaceSwitch.js';

/** 書いた中身を読み直しに渡してよい時間。書いた直後の `setFolders` の読み直しだけを狙う。 */
const RELOAD_OFFER_MS = 10_000;

const ATOMIC_WRITE = { postfix: '.vsctmp' } as const;

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

/** このウィンドウのワークスペースのファイル（`resolveContent` が最後に読んだもの）。 */
let windowWorkspaceFile: URI | undefined;

/**
 * `FileServiceBasedWorkspaceConfiguration.resolveContent` の PARA-PATCH から呼ぶ。渡せる中身が無ければ
 * undefined（読み直す）。
 */
export function paradisTakeWrittenWorkspaceContent(resource: URI): string | undefined {
	windowWorkspaceFile = resource;
	return current?.takeWrittenContent(resource);
}

function isWindowWorkspaceFile(resource: URI): boolean {
	return isParadisManagedWorkspaceWindow() && hasWorkspaceFileExtension(resource) && windowWorkspaceFile !== undefined && isEqual(windowWorkspaceFile, resource);
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

	constructor(
		private readonly fileService: IFileService,
		private readonly textFileService: ITextFileService,
		private readonly now: () => number = () => Date.now(),
		private readonly applies: (resource: URI) => boolean = isWindowWorkspaceFile,
	) { }

	/**
	 * 覚えた中身で書く。書けたら true。false なら呼び出し元が upstream の経路で書く（覚えた中身は
	 * 捨ててある）。
	 */
	async tryWrite(resource: URI, values: IJSONValue[]): Promise<boolean> {
		const entry = this.entry;
		if (!entry || !this.applies(resource) || !isEqual(entry.resource, resource)) {
			return false;
		}
		// エディタで開いているモデルがあれば、その中身（未保存の編集を含む）が正しい。upstream に任せる。
		if (this.textFileService.files.get(resource) || !this.fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite)) {
			this.forget();
			return false;
		}
		const content = applyValues(entry.content, values, entry.formatting);
		if (content === undefined) {
			this.forget();
			return false;
		}
		// 外部での変更を確かめる 1 往復（存在確認・バックアップの確認・読み込みの代わり）。
		let diskEtag: string | undefined;
		try {
			diskEtag = (await this.fileService.stat(resource)).etag;
		} catch {
			diskEtag = undefined; // 消された・読めない
		}
		if (this.entry !== entry || diskEtag !== entry.etag) {
			if (this.entry === entry) {
				this.forget();
			}
			return false;
		}
		paradisNoteFolderUpdateShortcut('resolve_cached');
		paradisMarkFolderUpdate('model_resolved');
		if (content === entry.content) {
			paradisMarkFolderUpdate('saved');
			return true;
		}
		try {
			const stat = await this.textFileService.write(resource, content, { etag: entry.etag, mtime: entry.mtime, encoding: entry.encoding, atomic: ATOMIC_WRITE });
			paradisMarkFolderUpdate('saved');
			if (this.entry === entry) {
				this.setEntry(resource, { ...entry, content, etag: stat.etag, mtime: stat.mtime });
			}
			return true;
		} catch {
			// 衝突 (FILE_MODIFIED_SINCE) でも、それ以外の失敗でも、覚えた中身を捨てて upstream の経路
			// （読み直して書く）で書き直す。失敗の知らせ（保存エラーの通知など）は upstream の経路が出す。
			paradisNoteFolderUpdateShortcut('resolve_conflict');
			if (this.entry === entry) {
				this.forget();
			}
			return false;
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
		if (!entry || !isEqual(entry.resource, resource) || entry.reloadOfferUntil === undefined) {
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
		// 監視は足さない。upstream の `FileServiceBasedWorkspaceConfiguration` が同じファイルを常に
		// 監視している（その通知で 50ms 後に読み直す）。同じ通知を受けて、その読み直しに書いた中身を
		// 渡さないようにするだけ。書き込みの正しさは通知に頼らず、tryWrite の stat で確かめる。
		this.listener = markAsSingleton(this.fileService.onDidFilesChange(e => {
			const entry = this.entry;
			if (entry && e.contains(entry.resource)) {
				entry.reloadOfferUntil = undefined;
			}
		}));
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

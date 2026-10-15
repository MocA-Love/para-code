/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * スペース切り替えのたびに `.code-workspace` を書き換える往復を、切り替えの待ちから外す。
 *
 * upstream の `JSONEditingService` は書き込みのたびに「存在確認 → テキストモデルの作成（バックアップの
 * 確認・読み込み）→ 書き込み（etag の stat・書き込み・書き込み後の stat）」を行い、
 * `WorkspaceConfiguration.setFolders` はその後でもう一度ファイルを読み、読んだ中身で folders を変える。
 * Para Code のウィンドウは切り替えのたびにこれを通るので、ファイルの IPC が詰まっている Mac や SSH の
 * 接続先では、切り替えがこの書き込みを数秒〜十数秒待っていた（paracode-165 の Sentry で save 最大
 * 12,550ms。接続先の書き込みが返らない回と、手元のディスクが詰まった回の両方）。
 *
 * ここでは最後に書いた（または読んだ）中身と etag（mtime・size）をメモリに覚え、次の書き込みでは
 * **覚えた中身に `folders` の変更を当てた中身を、すぐに「書いた」として返す**。直後の読み直し
 * (`FileServiceBasedWorkspaceConfiguration.resolveContent`) にはその中身を渡すので、folders はディスクを
 * 待たずに変わる。ディスクへの書き込みは後ろで 1 本ずつ続ける（flush）。
 *
 * - flush は書く前に stat を 1 回取り、etag が覚えたものと同じことを確かめてから、覚えた etag を付けて
 *   書く（atomic）。外部での変更（別のエディタ・git の切り替え・削除）で etag が違う・書き込みが衝突した・
 *   失敗したときは、覚えた中身を捨てて upstream の経路（ディスクを読み、folders だけを当てて保存する）で
 *   書き直す。外部での変更は消さない
 * - 後ろの書き込みが終わるまで、読み直しにはメモリの中身を渡し続ける（`mask`）。待っている間に届いた
 *   前の書き込みや外部での変更の通知で、古い folders を読み直して切り替えが戻らないようにするため。
 *   書き込みが失敗したまま終わったときも、次に書けるまで渡し続ける
 * - 後ろの書き込みが終わったか（失敗したか）は `paradisWhenWorkspaceFileFlushed` で引ける。切り替えは
 *   書き終わるまで中断の台帳を消さない（書き終わる前に落ちたら、ディスクの folders に合わせて戻す）
 * - upstream の経路へ回すとき（テキストモデルが開いている・atomic に書けない・覚えていない）は、
 *   後ろの書き込みが終わるのを待ってから回す。順番を入れ替えない
 * - テキストモデルが開いているとき（ユーザーがエディタで開いている）は使わない。開いたモデルを
 *   素通りしてディスクに書くと、未保存の編集と食い違うため
 * - 書き込みは atomic（一時ファイルに書いて置き換える）。ディスクが一杯で途中で失敗しても元の
 *   ファイルを切り詰めない。atomic に書けない provider では使わない
 * - 覚えるのはこのウィンドウのワークスペースのファイルだけ（`resolveContent` が読むもの）
 *
 * upstream の経路で書いた直後の読み直しには、書いた中身を **1 回だけ・書いてから 10 秒以内・その後に
 * ファイルの変更の通知が来ていないときだけ** 返す。通知が来たら渡さない（upstream の 50ms の読み直しが
 * 自分で読む）。
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

interface IEntry {
	readonly resource: URI;
	/** メモリの中身。後ろの書き込みが終わるまではディスクより新しい。 */
	content: string;
	/** ディスクにある中身（最後に書いた・読んだもの）。 */
	diskContent: string;
	/** `diskContent` の etag。 */
	etag: string;
	mtime: number;
	readonly encoding: string | undefined;
	readonly formatting: FormattingOptions;
	/** 読み直しに中身を渡してよい期限（渡したら undefined）。 */
	reloadOfferUntil: number | undefined;
}

/** 後ろの書き込みの結果。`paradisWhenWorkspaceFileFlushed` が返す。 */
export interface IParadisWorkspaceFileFlush {
	/** ディスクがメモリの中身に追いついたか。 */
	readonly ok: boolean;
	/** 書き始めてから終わるまで (ms)。 */
	readonly ms: number;
	/** 書いた回数（後ろで続いている間に次の切り替えが来たら、まとめて最後の中身だけを書く）。 */
	readonly writes: number;
	/** 外部での変更・衝突・失敗で upstream の経路へ回したか。 */
	readonly fallback: boolean;
}

/** upstream の経路で書く（`JSONEditingService` のテキストモデルを使う書き込み）。 */
export type ParadisWorkspaceFileModelWriter = (resource: URI, values: IJSONValue[]) => Promise<void>;

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

/**
 * 後ろで続いている `.code-workspace` の書き込み。書き終わっていて、失敗したまま残ってもいなければ
 * undefined（ディスクはメモリの中身と同じ）。
 */
export function paradisWhenWorkspaceFileFlushed(): Promise<IParadisWorkspaceFileFlush> | undefined {
	return flushedOverride !== undefined ? flushedOverride() : current?.whenFlushed();
}

let flushedOverride: (() => Promise<IParadisWorkspaceFileFlush> | undefined) | undefined;

/** テスト用: `paradisWhenWorkspaceFileFlushed` の答えを差し替える。戻り値で元に戻す。 */
export function paradisOverrideWorkspaceFileFlushedForTest(override: () => Promise<IParadisWorkspaceFileFlush> | undefined): IDisposable {
	const previous = flushedOverride;
	flushedOverride = override;
	return { dispose: () => { flushedOverride = previous; } };
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

	/** まだディスクに書いていない最後の書き込み。後ろの書き込みはこれだけを書く。 */
	private unflushed: { readonly resource: URI; readonly values: IJSONValue[] } | undefined;

	/** 後ろで続いている書き込み。 */
	private flushing: Promise<IParadisWorkspaceFileFlush> | undefined;

	/** 後ろの書き込みのファイル。 */
	private flushResource: URI | undefined;

	/** 読み直しに渡し続けるメモリの中身。ディスクに書けた (`setEntry`) ら下ろす。 */
	private mask: { readonly resource: URI; readonly content: string } | undefined;

	/** 最後の後ろの書き込みが失敗したまま、まだ書けていないときの結果。 */
	private failedFlush: IParadisWorkspaceFileFlush | undefined;

	constructor(
		private readonly fileService: IFileService,
		private readonly textFileService: ITextFileService,
		private readonly writeThroughModel: ParadisWorkspaceFileModelWriter | undefined = undefined,
		private readonly now: () => number = () => Date.now(),
		private readonly applies: (resource: URI) => boolean = isWindowWorkspaceFile,
	) { }

	/**
	 * 覚えた中身に `values` を当てて「書いた」ことにし、ディスクへの書き込みを後ろへ回す。済ませたら true。
	 * false なら呼び出し元が upstream の経路で書く（後ろの書き込みは終わっている）。
	 */
	async tryWrite(resource: URI, values: IJSONValue[]): Promise<boolean> {
		const entry = this.entry;
		const content = entry !== undefined && this.canWriteBehind(entry, resource) ? applyValues(entry.content, values, entry.formatting) : undefined;
		if (entry === undefined || content === undefined) {
			if (entry !== undefined && isEqual(entry.resource, resource)) {
				// エディタで開いているモデルがあれば、その中身（未保存の編集を含む）が正しい。upstream に任せる。
				this.forget();
			}
			// 同じファイルの後ろの書き込みを追い越さない（ほかのファイルの書き込みは待たせない）。
			if (this.flushing !== undefined && this.flushResource !== undefined && isEqual(this.flushResource, resource)) {
				paradisNoteFolderUpdateShortcut('flush_waited');
				await this.flushing;
			}
			return false;
		}
		paradisNoteFolderUpdateShortcut('write_behind');
		paradisMarkFolderUpdate('model_resolved');
		paradisMarkFolderUpdate('saved');
		if (content !== entry.content) {
			entry.content = content;
			this.mask = { resource, content };
			this.unflushed = { resource, values };
			this.flushResource = resource;
			this.flushing ??= this.flush();
		}
		return true;
	}

	/** 後ろで続いている書き込み。失敗したまま残っているときは、その結果。 */
	whenFlushed(): Promise<IParadisWorkspaceFileFlush> | undefined {
		if (this.flushing !== undefined) {
			return this.flushing;
		}
		return this.failedFlush !== undefined ? Promise.resolve(this.failedFlush) : undefined;
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

	/**
	 * 読み直しに渡す中身。後ろの書き込みが済んでいなければメモリの中身を毎回、済んでいれば upstream の
	 * 経路で書いた中身を 1 回だけ渡す。
	 */
	takeWrittenContent(resource: URI): string | undefined {
		if (this.mask !== undefined && isEqual(this.mask.resource, resource)) {
			paradisNoteFolderUpdateShortcut('reload_cached');
			return this.mask.content;
		}
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

	private canWriteBehind(entry: IEntry, resource: URI): boolean {
		return this.applies(resource)
			&& isEqual(entry.resource, resource)
			&& !this.textFileService.files.get(resource)
			&& this.fileService.hasCapability(resource, FileSystemProviderCapabilities.FileAtomicWrite);
	}

	/** まだ書いていない最後の中身を、無くなるまで 1 本ずつ書く。 */
	private async flush(): Promise<IParadisWorkspaceFileFlush> {
		const startedAt = this.now();
		let writes = 0;
		let fallback = false;
		let ok = true;
		try {
			while (this.unflushed !== undefined) {
				const { resource, values } = this.unflushed;
				this.unflushed = undefined;
				writes++;
				if (await this.writeRemembered(resource)) {
					ok = true;
					continue;
				}
				fallback = true;
				ok = await this.writeUpstream(resource, values);
			}
		} finally {
			this.flushing = undefined;
		}
		const result: IParadisWorkspaceFileFlush = { ok, ms: Math.max(0, this.now() - startedAt), writes, fallback };
		this.failedFlush = ok ? undefined : result;
		return result;
	}

	/** 覚えた中身を、外部での変更が無いことを確かめてから書く。書けたら true。 */
	private async writeRemembered(resource: URI): Promise<boolean> {
		const entry = this.entry;
		if (entry === undefined || !this.canWriteBehind(entry, resource)) {
			return false;
		}
		// 前の回の書き込みが、待っている間に来た分まで書いていれば書かない。
		if (entry.content === entry.diskContent) {
			this.lowerMaskIfFlushed(entry);
			return true;
		}
		// 外部での変更を確かめる 1 往復（書き込みの etag の確認はサイズの変わらない変更を見逃すため）。
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
		const content = entry.content;
		try {
			const stat = await this.textFileService.write(resource, content, { etag: entry.etag, mtime: entry.mtime, encoding: entry.encoding, atomic: ATOMIC_WRITE });
			if (this.entry === entry) {
				entry.diskContent = content;
				entry.etag = stat.etag;
				entry.mtime = stat.mtime;
				this.lowerMaskIfFlushed(entry);
			}
			return true;
		} catch {
			// 衝突 (FILE_MODIFIED_SINCE) でも、それ以外の失敗でも、覚えた中身を捨てて upstream の経路で書き直す。
			if (this.entry === entry) {
				this.forget();
			}
			return false;
		}
	}

	/** 書いている間に次の切り替えが来ていなければ、ディスクはメモリに追いついた。読み直しはディスクを読んでよい。 */
	private lowerMaskIfFlushed(entry: IEntry): void {
		if (this.unflushed === undefined && entry.content === entry.diskContent && this.mask?.content === entry.content) {
			this.mask = undefined;
		}
	}

	/**
	 * upstream の経路（ディスクを読み、folders だけを当てて保存する）で書く。外部での変更を残したまま
	 * folders をメモリの中身に揃える。保存できて覚え直せたら true。
	 */
	private async writeUpstream(resource: URI, values: IJSONValue[]): Promise<boolean> {
		if (this.writeThroughModel === undefined) {
			return false;
		}
		try {
			await this.writeThroughModel(resource, values);
		} catch {
			// 失敗の知らせ（保存エラーの通知など）は upstream の経路が出す。
			return false;
		}
		// 保存できたときだけ `rememberModel` が覚え直す（`setEntry` が mask を下ろす）。
		return this.entry !== undefined && isEqual(this.entry.resource, resource);
	}

	private setEntry(resource: URI, snapshot: IParadisWorkspaceFileSnapshot): void {
		this.entry = { ...snapshot, resource, diskContent: snapshot.content, reloadOfferUntil: this.now() + RELOAD_OFFER_MS };
		this.mask = undefined;
		this.failedFlush = undefined;
		current = this;
		this.ensureListener();
	}

	private ensureListener(): void {
		if (this.listener) {
			return;
		}
		// 監視は足さない。upstream の `FileServiceBasedWorkspaceConfiguration` が同じファイルを常に
		// 監視している（その通知で 50ms 後に読み直す）。同じ通知を受けて、その読み直しに書いた中身を
		// 渡さないようにするだけ。書き込みの正しさは通知に頼らず、flush の stat で確かめる。
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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { isString } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

/**
 * 貼り付けた画像を置くディレクトリ名。cwd 配下に作る（TUI が確認なしに読める範囲を保つため）。
 *
 * `.para-code/` 直下は `paradisAgentHooks.ts` の hooks スクリプトやリモートエージェントの
 * ソケットが `$HOME/.para-code/` として既に使っている名前空間なので、専用のサブディレクトリを切る。
 */
export const PASTED_IMAGE_DIR = '.para-code/pasted-images';
/** 置きっぱなしを掃除する閾値。TUI が読む前に消さない程度に長く取る。 */
const PASTED_IMAGE_TTL_MS = 60 * 60 * 1000;

/** SSH 接続中のターミナルへ画像を渡すために必要なもの。ローカルのときは省略してよい。 */
export interface IParadisTerminalImagePasteTarget {
	readonly fileService: IFileService;
	/** 接続先。undefined ならローカルのターミナル。 */
	readonly remoteAuthority: string | undefined;
	/** ターミナルの作業ディレクトリ。画像はここへ置く。 */
	readonly cwd: string | undefined;
	/**
	 * `cwd` が空のときの代わり（`ITerminalInstance.getSpeculativeCwd()`）。エディタ領域のターミナルは
	 * 復元直後に cwd が空になり、プロンプトが出て OSC 7 が届くまで空のまま（Claude Code を動かし
	 * 続けている間はずっと空）なので、起動時の cwd などで補う。
	 */
	readonly getSpeculativeCwd?: () => Promise<string>;
	/** 接続先へ画像を置けなかったことを知らせる。 */
	readonly notificationService?: INotificationService;
}

/**
 * クリップボードが「テキストなし・画像のみ」（macOSのスクリーンショット等）のときの処理。
 *
 * ローカルのターミナルでは、TUI（Claude Code / Codex / opencode 等）が画像添付のトリガーとして
 * 監視している Ctrl+V (0x16) を生バイトでPTYへ送る。`raw.input()` は bracketed paste のラップも
 * kitty CSI-u エンコードも通らず、onData 経由で 0x16 がそのまま PTY に書き込まれる。TUI側は
 * これを合図に自分でOSクリップボードから画像を読み取るため、画像データ自体は流さなくてよい。
 *
 * SSH 接続中はこの前提が崩れる。TUI は接続先で動いていて、こちらのクリップボードには手が届かない
 * （そもそも接続先にクリップボードが無い）。合図だけ送っても何も貼られないので、画像を接続先へ
 * 書き出し、そのパスを普通のテキストとして貼る。TUI 側はパスを見て画像を読み込む。
 *
 * 呼び出し元（terminal.clipboard.contribution.ts の paste()）でテキストとファイルパスの
 * 解決が両方空振りした場合のみ呼ぶこと。例外は SSH 接続中にテキストが手元の画像ファイルの
 * パスだけだった場合（`paradisIsLocalImagePathText`）。テキストペーストの既存挙動
 * （複数行警告・末尾改行剥がし・onWillPaste/onDidPaste）には一切影響させない。
 *
 * @returns
 *   `true`   … 0x16 を送信済み、または SSH 接続中に画像を接続先へ置けず通知済み。呼び出し元は
 *              何もしなくてよい（空の bracketed paste を送ると、TUI が「SSH では画像を貼れない」と誤解する）
 *   `string` … このテキスト（接続先に置いた画像のパス）を通常のペースト経路へ流すこと
 *   `false`  … クリップボードに画像が無い。既存のテキストペースト経路へフォールスルーする
 */
export async function paradisTryTerminalImagePaste(
	clipboardService: IClipboardService,
	xterm: { raw: RawXtermTerminal },
	target?: IParadisTerminalImagePasteTarget
): Promise<string | boolean> {
	let image: Uint8Array;
	try {
		image = await clipboardService.readImage();
	} catch {
		// クリップボードアクセス失敗時はテキストペーストの既存経路へフォールスルーさせる
		return false;
	}
	if (image.length === 0) {
		return false;
	}

	if (target?.remoteAuthority) {
		const written = await writeImageToRemote(image, target);
		if (isString(written)) {
			return written;
		}
		// 書き出せなかった場合でも 0x16 の経路へは落とさない。接続先の TUI は
		// こちらのクリップボードを読めないので、送っても何も起きずに紛らわしいだけ。
		// テキストの経路へも戻さない（空の貼り付けになるか、接続先に無い手元のパスを貼るだけ）。
		// 黙って何も起きないと分からないので、通知で知らせて貼り付けを終える。
		target.notificationService?.notify({
			severity: Severity.Warning,
			message: written === RemoteImageFailure.NoWorkingDirectory
				? localize('paradis.terminalImagePaste.remoteNoDirectory', "作業フォルダが分からないため、画像を接続先に置けませんでした。シェルのプロンプトを一度出すと直ることがあります。")
				: localize('paradis.terminalImagePaste.remoteWriteFailed', "画像を接続先に書き込めませんでした。画像のファイルを接続先へ送ってから、そのパスを貼り付けてください。"),
		});
		return true;
	}

	xterm.raw.input('\x16', true);
	return true;
}

/** Claude Code が貼られたパスを画像として扱う拡張子（`/\.(png|jpe?g|gif|webp)$/i`）に合わせる。 */
const LOCAL_IMAGE_PATH = /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)[^\r\n]*\.(?:png|jpe?g|gif|webp)$/i;

/**
 * SSH 接続中のターミナルで、クリップボードのテキストを画像の経路へ回すべきかを判定する。
 *
 * スクリーンショットツールの一部（DroppyCapture 等）は、画像と一緒に保存先ファイルの絶対パスを
 * テキストとしてクリップボードへ入れる。テキストが優先されるため、SSH 接続中は手元にしか無い
 * パスが接続先の TUI に渡って画像が付かない。テキストが手元の画像ファイルのパス 1 つだけの
 * ときに限り、画像の経路（接続先へ書き出してそのパスを貼る）を試させる。ローカルのターミナルでは
 * TUI が手元のパスを読めるので false を返し、既存の挙動のままにする。
 */
export function paradisIsLocalImagePathText(text: string, remoteAuthority: string | undefined): boolean {
	return !!remoteAuthority && LOCAL_IMAGE_PATH.test(text.trim());
}

/** 画像を接続先へ書き、そのパスを返す。書けなければその理由を返す。 */
/** 接続先へ画像を置けなかった理由。通知の文を分けるために使う。 */
const enum RemoteImageFailure {
	NoWorkingDirectory = 1,
	WriteFailed = 2,
}

async function writeImageToRemote(image: Uint8Array, target: IParadisTerminalImagePasteTarget): Promise<string | RemoteImageFailure> {
	const cwd = await resolveRemoteCwd(target);
	if (!cwd) {
		return RemoteImageFailure.NoWorkingDirectory;
	}
	const directory = URI.joinPath(cwd, PASTED_IMAGE_DIR);
	const file = URI.joinPath(directory, `${Date.now()}.png`);
	// .gitignore を画像より先に用意する。逆順だと、書き終えた直後の一瞬 .png だけが
	// git の変更一覧に見える窓ができてしまう。失敗しても貼り付け自体は成立するので無視してよい
	// （内部で例外を握りつぶす）。可視性に関わる処理なのでここは待つ。
	await ensurePastedImagesIgnored(directory, target.fileService);
	try {
		await target.fileService.writeFile(file, VSBuffer.wrap(image));
	} catch (error) {
		reportParadisDiagnosticError('owned', 'terminal-image-paste', 'remote-write-failed', error);
		return RemoteImageFailure.WriteFailed;
	}
	// 過去に置いたものの掃除はユーザーから見える効果が無いので、待たずに投げっぱなしにする。
	void cleanupOldImages(directory, target.fileService, file);
	return file.path;
}

/**
 * ターミナルの作業ディレクトリを SSH 接続先の URI として解決する。検出した cwd が空なら
 * `getSpeculativeCwd()` で補い、それも取れないときは Sentry に送って諦める。
 *
 * 注意: `target.cwd` は CwdDetection capability が OSC 7 / OSC 1337 のエスケープシーケンスから
 * 読み取った値で、ターミナルに出力できる側（実行中のコマンドやリモートのプロセス）なら誰でも
 * 書き換えられる。ここでは「クリップボードの画像を、ユーザーが今いるつもりの場所に置く」という
 * UX 上の前提として素直に信頼しているが、任意ディレクトリへの書き込みを許すことにはなるので、
 * 機密性の高い操作をこの値に追加で乗せないこと。
 */
async function resolveRemoteCwd(target: IParadisTerminalImagePasteTarget): Promise<URI | undefined> {
	if (!target.remoteAuthority) {
		return undefined;
	}
	let cwd = target.cwd;
	let speculativeFailed = false;
	if (!cwd && target.getSpeculativeCwd) {
		try {
			cwd = await target.getSpeculativeCwd();
		} catch {
			speculativeFailed = true;
		}
	}
	if (!cwd) {
		// パスは送らない。どちらの手段が空だったかだけを送る。属性名に cwd・path 等の
		// sensitiveFields の語を含めると Sentry のサーバー側で値ごと消されるので避ける
		reportParadisDiagnosticError('owned', 'terminal-image-paste', 'remote-cwd-missing', new Error('Terminal has no working directory'), {
			safe_has_fallback_dir: !!target.getSpeculativeCwd,
			safe_fallback_dir_failed: speculativeFailed,
		});
		return undefined;
	}
	return URI.from({ scheme: Schemas.vscodeRemote, authority: target.remoteAuthority, path: cwd });
}

async function cleanupOldImages(directory: URI, fileService: IFileService, keep: URI): Promise<void> {
	try {
		const entries = await fileService.resolve(directory);
		const now = Date.now();
		for (const child of entries.children ?? []) {
			if (child.isDirectory || !child.name.endsWith('.png') || child.resource.path === keep.path) {
				continue;
			}
			const base = child.name.slice(0, child.name.lastIndexOf('.'));
			if (!/^\d+$/.test(base)) {
				continue;
			}
			if (now - Number(base) > PASTED_IMAGE_TTL_MS) {
				await fileService.del(child.resource);
			}
		}
	} catch (error) {
		// 掃除できなくても実害はない
		reportParadisDiagnosticError('owned', 'terminal-image-paste', 'cleanup-failed', error, undefined, 'warning');
	}
}

/**
 * `.para-code/pasted-images/` を Git の untracked ファイルとして出さないよう、ディレクトリ内に
 * `.gitignore`（内容は `*` のみ）が無ければ作る。
 *
 * リポジトリルートの `.gitignore` を書き換える案は、tracked ファイルへの無断書き込みになり
 * `git commit -a` 等でユーザーの意図しない差分が紛れ込むほか、読み取り失敗時に既存の内容を
 * 破壊しかねないため採らない。自分専用のサブディレクトリの中に固定内容のファイルを置くだけなら、
 * 既存ファイルには一切触れず、内容が常に同じなので並行書き込みが起きても壊れない。
 */
async function ensurePastedImagesIgnored(directory: URI, fileService: IFileService): Promise<void> {
	try {
		const gitignore = URI.joinPath(directory, '.gitignore');
		if (await fileService.exists(gitignore)) {
			return;
		}
		await fileService.writeFile(gitignore, VSBuffer.fromString('*\n'));
	} catch (error) {
		// .gitignore を用意できなくても貼り付け自体は成立しているので無視してよい
		reportParadisDiagnosticError('owned', 'terminal-image-paste', 'gitignore-write-failed', error, undefined, 'warning');
	}
}

/**
 * 画像を `directory`（`.para-code/pasted-images/`）へ書き、書いたファイルの URI を返す。書けなければ undefined。
 * 手元のフォルダ（file:）でも SSH 先（vscode-remote:）でも同じに書ける。書く前に `.gitignore` を置く。
 *
 * 名前は呼び出し側が決め、古い画像の掃除は走らせない。「新しいスペース」の指示に添えた画像
 * （paradisWorktreeImageWrite.ts）が使う。その画像は掃除の対象から外れる名前で書き、スペースを消すまで残す。
 */
export async function paradisWritePastedImageFile(fileService: IFileService, directory: URI, fileName: string, image: VSBuffer): Promise<URI | undefined> {
	await ensurePastedImagesIgnored(directory, fileService);
	const file = URI.joinPath(directory, fileName);
	try {
		await fileService.writeFile(file, image);
	} catch (error) {
		reportParadisDiagnosticError('owned', 'terminal-image-paste', 'worktree-image-write-failed', error, undefined, 'warning');
		return undefined;
	}
	return file;
}

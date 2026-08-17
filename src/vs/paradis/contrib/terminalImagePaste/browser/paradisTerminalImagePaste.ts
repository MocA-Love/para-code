/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * 貼り付けた画像を置くディレクトリ名。cwd 配下に作る（TUI が確認なしに読める範囲を保つため）。
 *
 * `.para-code/` 直下は `paradisAgentHooks.ts` の hooks スクリプトやリモートエージェントの
 * ソケットが `$HOME/.para-code/` として既に使っている名前空間なので、専用のサブディレクトリを切る。
 */
const PASTED_IMAGE_DIR = '.para-code/pasted-images';
/** 置きっぱなしを掃除する閾値。TUI が読む前に消さない程度に長く取る。 */
const PASTED_IMAGE_TTL_MS = 60 * 60 * 1000;

/** SSH 接続中のターミナルへ画像を渡すために必要なもの。ローカルのときは省略してよい。 */
export interface IParadisTerminalImagePasteTarget {
	readonly fileService: IFileService;
	/** 接続先。undefined ならローカルのターミナル。 */
	readonly remoteAuthority: string | undefined;
	/** ターミナルの作業ディレクトリ。画像はここへ置く。 */
	readonly cwd: string | undefined;
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
 * 解決が両方空振りした場合のみ呼ぶこと。テキストペーストの既存挙動
 * （複数行警告・末尾改行剥がし・onWillPaste/onDidPaste）には一切影響させない。
 *
 * @returns
 *   `true`   … 0x16 を送信済み。呼び出し元は何もしなくてよい
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
		const path = await writeImageToRemote(image, target);
		if (path) {
			return path;
		}
		// 書き出せなかった場合でも 0x16 の経路へは落とさない。接続先の TUI は
		// こちらのクリップボードを読めないので、送っても何も起きずに紛らわしいだけ。
		return false;
	}

	xterm.raw.input('\x16', true);
	return true;
}

/** 画像を接続先へ書き、そのパスを返す。書けなければ undefined。 */
async function writeImageToRemote(image: Uint8Array, target: IParadisTerminalImagePasteTarget): Promise<string | undefined> {
	const cwd = resolveRemoteCwd(target);
	if (!cwd) {
		return undefined;
	}
	const directory = URI.joinPath(cwd, PASTED_IMAGE_DIR);
	const file = URI.joinPath(directory, `${Date.now()}.png`);
	// .gitignore を画像より先に用意する。逆順だと、書き終えた直後の一瞬 .png だけが
	// git の変更一覧に見える窓ができてしまう。失敗しても貼り付け自体は成立するので無視してよい
	// （内部で例外を握りつぶす）。可視性に関わる処理なのでここは待つ。
	await ensurePastedImagesIgnored(directory, target.fileService);
	try {
		await target.fileService.writeFile(file, VSBuffer.wrap(image));
	} catch {
		return undefined;
	}
	// 過去に置いたものの掃除はユーザーから見える効果が無いので、待たずに投げっぱなしにする。
	void cleanupOldImages(directory, target.fileService, file);
	return file.path;
}

/**
 * ターミナルの作業ディレクトリを SSH 接続先の URI として解決する。cwd が取れないときは諦める。
 *
 * 注意: `target.cwd` は CwdDetection capability が OSC 7 / OSC 1337 のエスケープシーケンスから
 * 読み取った値で、ターミナルに出力できる側（実行中のコマンドやリモートのプロセス）なら誰でも
 * 書き換えられる。ここでは「クリップボードの画像を、ユーザーが今いるつもりの場所に置く」という
 * UX 上の前提として素直に信頼しているが、任意ディレクトリへの書き込みを許すことにはなるので、
 * 機密性の高い操作をこの値に追加で乗せないこと。
 */
function resolveRemoteCwd(target: IParadisTerminalImagePasteTarget): URI | undefined {
	if (!target.cwd || !target.remoteAuthority) {
		return undefined;
	}
	return URI.from({ scheme: Schemas.vscodeRemote, authority: target.remoteAuthority, path: target.cwd });
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
	} catch {
		// 掃除できなくても実害はない
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
	} catch {
		// .gitignore を用意できなくても貼り付け自体は成立しているので無視してよい
	}
}

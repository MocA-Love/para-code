/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 着信音のカスタム音源の取り込み（ファイル・YouTube・Myinstants・切り出し）と、そのための yt-dlp の確かめ・入れ方。
// paradisNotificationsService.ts から分けた（中身は移しただけ）。

import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readdirSync, realpath, statSync, type Dirent } from 'fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { Sequencer } from '../../../../base/common/async.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, delimiter, dirname, extname, join } from '../../../../base/common/path.js';
import { Promises } from '../../../../base/node/pfs.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AivisError } from './paradisAudioScheduler.js';
import { paradisCollectBody } from './paradisStreamingBody.js';
import { CUSTOM_RINGTONE_ID, IParadisCustomRingtoneInfo, IParadisInstallLogLine, IParadisInstallLogResult, IParadisRenderClipRequest, IParadisRingtoneEditState, IParadisYouTubeDownloadResult, PARADIS_MAX_CLIP_DURATION_SECONDS, PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES, PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES } from '../common/paradisNotifications.js';
import { IParadisYtDlpCheckResult, IParadisYtDlpStatus, paradisAssessYtDlpVersion, paradisClassifyYtDlpError, paradisDetectYtDlpInstallMethod, paradisExtractYtDlpWarnings, paradisParseYtDlpVersion, paradisYtDlpUpdatePlan, ParadisYtDlpFailure } from '../common/paradisYtDlp.js';
import { IParadisMyinstantsDownloadResult, paradisCheckMyinstantsUrl, paradisIsMp3ContentType, paradisLooksLikeMp3, paradisMyinstantsDisplayName } from '../common/paradisMyinstants.js';

const YT_DLP_TIMEOUT_MS = 120_000;
const FULL_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FULL_DOWNLOAD_DURATION_SECONDS = 600;
/** 保持する yt-dlp インストール状態の上限。通常は1件しか走らない。 */
const PARADIS_MAX_INSTALL_STATES = 4;
const FETCH_AUDIO_TIMEOUT_MS = 15_000;
/** Myinstants の mp3 を取るときに追うリダイレクトの上限（追う先も同じ形の URL に限る）。 */
const MYINSTANTS_MAX_REDIRECTS = 3;
const REQUIRED_BINARIES = ['yt-dlp', 'ffmpeg', 'ffprobe'] as const;
/** yt-dlp が既定で使う JS ランタイム。無くても動くが、一部の形式が取れなくなる。Para Code は入れず案内だけする。 */
const OPTIONAL_BINARIES = ['deno'] as const;
/** `yt-dlp --version` の打ち切り。 */
const YT_DLP_VERSION_TIMEOUT_MS = 10_000;

export const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);
const OUTPUT_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);

export const CUSTOM_STEM = 'notification-custom';
const CUSTOM_SOURCE_STEM = 'notification-custom-source';

function mimeTypeFor(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case '.wav': return 'audio/wav';
		case '.ogg': return 'audio/ogg';
		case '.m4a': return 'audio/mp4';
		case '.aac': return 'audio/aac';
		case '.opus': return 'audio/opus';
		case '.webm': return 'audio/webm';
		default: return 'audio/mpeg';
	}
}

/** カスタム音源のメタ情報（`notification-custom.json`）。`sourceUrl` は後から足した項目で、無い JSON も読める。 */
interface IParadisCustomRingtoneMetadata {
	readonly name?: string;
	readonly importedAt?: number;
	readonly thumbnailUrl?: string;
	readonly editState?: IParadisRingtoneEditState;
	readonly sourceUrl?: string;
}

/** インストールログの購読用バッファ（yt-dlp/ffmpeg の `brew install` 進捗、UIはポーリングで取得）。 */
interface IInstallState {
	lines: IParadisInstallLogLine[];
	done: boolean;
	error?: string;
	nextSeq: number;
}

/** 子プロセスの失敗。メッセージは標準エラーの末尾、`stderr` には全文、`exitCode` には終了コードを持つ（失敗の理由と警告の見分けに使う）。 */
class ParadisProcessError extends Error {
	constructor(message: string, readonly stderr: string, readonly exitCode?: number) {
		super(message);
	}
}

export class ParadisRingtoneIngestService extends Disposable {

	/** 起動時 sweep の対象となる yt-dlp / ffmpeg 作業ディレクトリのプレフィックス。 */
	private static readonly TEMP_WORK_DIR_PREFIXES = ['paradis-ytfull-', 'paradis-ytclip-', 'paradis-myinstants-'];

	/**
	 * この年齢より新しい作業ディレクトリは sweep しない。フルダウンロードのタイムアウト(5分)より
	 * 十分長い時間を置くことで、同一マシンの別アプリインスタンスが実行中の取得と衝突しない
	 * ようにする(孤立した直後のものは次回起動以降で回収される)。
	 */
	private static readonly TEMP_WORK_DIR_MIN_AGE_MS = 30 * 60 * 1000;

	private readonly _metadataPath: string;
	/** カスタム音源のメタ情報の読み直し〜書き込み・削除を 1 本に並べる（{@link _updateMetadata}）。 */
	private readonly _metadataSequencer = new Sequencer();
	/**
	 * downloadYouTubeAudio / downloadMyinstantsAudio が発行した一時音源 (tempId → { path, dir })。
	 * Myinstants 由来のものだけ、取得した mp3 の URL（出典）を持つ。
	 */
	private readonly _tempAudio = new Map<string, { readonly path: string; readonly dir: string; readonly myinstantsSourceUrl?: string }>();
	private readonly _installStates = new Map<string, IInstallState>();

	constructor(
		private readonly logService: ILogService,
		/** 着信音のフォルダ（カスタム音源・メタ情報・再編集用のソースを置く）。 */
		private readonly _assetsDir: string,
	) {
		super();
		this._metadataPath = join(this._assetsDir, `${CUSTOM_STEM}.json`);
		void this._sweepOrphanTempWorkDirs();
	}

	override dispose(): void {
		// 取り込み成功/キャンセルどちらの経路でも掃除漏れがあり得るため、残った一時音源
		// ディレクトリ (paradis-ytfull-*) をプロセス終了前にまとめて削除する。
		for (const entry of this._tempAudio.values()) {
			void rm(entry.dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
		this._tempAudio.clear();
		this._installStates.clear();
		super.dispose();
	}

	/**
	 * 前回までのプロセスが残した YouTube 取込の一時ディレクトリ ($TMPDIR/paradis-ytfull-*,
	 * $TMPDIR/paradis-ytclip-*) を起動時に掃除する。
	 *
	 * ダウンロード完了前にダイアログが閉じられる（backdrop クリックやウィンドウリロード）と
	 * renderer 側の参照は消えるため、正常終了なら quit 時の dispose() で回収されるものの、
	 * shared process がクラッシュ・強制終了されると workDir は永久に残る。長時間セッションで
	 * の蓄積も同じ場所に溜まる。dispose 時の掃除は _tempAudio に載ったものしか対象にできず、
	 * この漏れを拾えない。
	 *
	 * 掃除はコンストラクタ（downloadYouTubeAudio をまだ受け付けていない時点）に1回だけ走り、
	 * 最終更新から一定年齢を超えたディレクトリだけを対象にする。同一マシンで別インスタンスが
	 * 実行中の取得を持っていても、その作業ディレクトリは更新され続けているため触られない。
	 */
	private async _sweepOrphanTempWorkDirs(): Promise<void> {
		const tmp = tmpdir();
		let entries: Dirent[];
		try {
			entries = await readdir(tmp, { withFileTypes: true });
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] failed to list ${tmp} for the temp work dir sweep: ${getErrorMessage(error)}`);
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !ParadisRingtoneIngestService.TEMP_WORK_DIR_PREFIXES.some(prefix => entry.name.startsWith(prefix))) {
				continue;
			}
			const dirPath = join(tmp, entry.name);
			try {
				if (Date.now() - (await stat(dirPath)).mtimeMs < ParadisRingtoneIngestService.TEMP_WORK_DIR_MIN_AGE_MS) {
					continue;
				}
			} catch {
				continue;
			}
			void rm(dirPath, { recursive: true, force: true })
				.catch(error => this.logService.warn(`[ParadisNotifications] failed to sweep the orphan temp dir ${entry.name}: ${getErrorMessage(error)}`));
		}
	}

	// === カスタム音源 ============================================================================

	private async _ensureAssetsDir(): Promise<void> {
		if (!await Promises.exists(this._assetsDir)) {
			await mkdir(this._assetsDir, { recursive: true, mode: 0o700 });
		}
	}

	/** 名前が `stem.` で始まる音源のうち最も新しいもの。{@link _resolveRingtonePath} 経由で着信音の前置きにも使うので同期のまま。 */
	findFileByStem(stem: string, extensions: ReadonlySet<string>): string | null {
		// eslint-disable-next-line local/code-no-sync-fs -- Also resolves the custom ringtone for _ringtonePrelude, which must answer in the same turn (see there).
		if (!existsSync(this._assetsDir)) {
			return null;
		}
		// eslint-disable-next-line local/code-no-sync-fs -- Also resolves the custom ringtone for _ringtonePrelude, which must answer in the same turn (see there).
		const candidates = readdirSync(this._assetsDir).filter(file => file.startsWith(`${stem}.`) && extensions.has(extname(file).toLowerCase()));
		if (candidates.length === 0) {
			return null;
		}
		// eslint-disable-next-line local/code-no-sync-fs -- Also resolves the custom ringtone for _ringtonePrelude, which must answer in the same turn (see there).
		candidates.sort((a, b) => statSync(join(this._assetsDir, b)).mtimeMs - statSync(join(this._assetsDir, a)).mtimeMs);
		return candidates[0] ?? null;
	}

	private async _removeFilesByStem(stem: string): Promise<void> {
		if (!await Promises.exists(this._assetsDir)) {
			return;
		}
		for (const file of await readdir(this._assetsDir)) {
			if (file.startsWith(`${stem}.`)) {
				try {
					await unlink(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	/**
	 * カスタム音源のメタ情報。`sourceUrl` は Myinstants から取り込んだ音の出典（後から足した項目。無い JSON は
	 * 今までどおり読める）。YouTube 由来の出典は `editState.sourceUrl` にある。
	 */
	private async _readMetadata(): Promise<IParadisCustomRingtoneMetadata> {
		if (!await Promises.exists(this._metadataPath)) {
			return {};
		}
		try {
			return JSON.parse(await readFile(this._metadataPath, 'utf8'));
		} catch {
			return {};
		}
	}

	/**
	 * メタ情報を読み直して書き換える。読んでから書くまでの間に別の更新（名前の変更と切り出しの保存が重なったときなど）が
	 * 入ると、後の書き込みが先の変更を消すので、更新は {@link _metadataSequencer} で 1 本ずつ行う。
	 */
	private _updateMetadata(update: (metadata: IParadisCustomRingtoneMetadata) => IParadisCustomRingtoneMetadata & { readonly name: string; readonly importedAt: number }): Promise<void> {
		return this._metadataSequencer.queue(async () => {
			const { name, importedAt, thumbnailUrl, editState, sourceUrl } = update(await this._readMetadata());
			await this._writeMetadata(name, importedAt, thumbnailUrl, editState, sourceUrl);
		});
	}

	private async _writeMetadata(name: string, importedAt: number, thumbnailUrl?: string, editState?: IParadisRingtoneEditState, sourceUrl?: string): Promise<void> {
		await this._ensureAssetsDir();
		await writeFile(this._metadataPath, JSON.stringify({ name, importedAt, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(editState ? { editState } : {}), ...(sourceUrl ? { sourceUrl } : {}) }), 'utf8');
		try {
			await chmod(this._metadataPath, 0o600);
		} catch {
			// best effort
		}
	}

	async getCustomRingtoneInfo(): Promise<IParadisCustomRingtoneInfo | null> {
		const filename = this.findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const metadata = await this._readMetadata();
		return {
			id: CUSTOM_RINGTONE_ID,
			name: metadata.name?.trim() || 'Custom Audio',
			description: 'Imported from your local machine',
			// allow-any-unicode-next-line
			emoji: '🔊',
			...(metadata.thumbnailUrl ? { thumbnailUrl: metadata.thumbnailUrl } : {}),
		};
	}

	async getCustomEditState(): Promise<IParadisRingtoneEditState | null> {
		return (await this._readMetadata()).editState ?? null;
	}

	async importCustomAudio(sourceFsPath: string): Promise<IParadisCustomRingtoneInfo> {
		const ext = extname(sourceFsPath).toLowerCase();
		if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
			// allow-any-unicode-next-line
			throw new Error('.mp3、.wav、.ogg のみサポートしています');
		}
		const sourceStat = await stat(sourceFsPath);
		if (!sourceStat.isFile()) {
			// allow-any-unicode-next-line
			throw new Error('指定されたパスはファイルではありません');
		}
		if (sourceStat.size > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
			// allow-any-unicode-next-line
			throw new Error(`音源ファイルが大きすぎます (${Math.round(sourceStat.size / 1024 / 1024)}MB)。最大20MBです。`);
		}

		await this._ensureAssetsDir();
		const destination = join(this._assetsDir, `${CUSTOM_STEM}${ext}`);
		const displayName = basename(sourceFsPath).replace(/\.[^/.]+$/, '').trim().slice(0, 80) || 'Custom Audio';

		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourceFsPath, tempPath);
			await this._removeFilesByStem(CUSTOM_STEM);
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			await chmod(destination, 0o600);
		} catch {
			// best effort
		}
		// 直接インポートはYouTube由来ではないため再編集用ソース・editStateは残さない。
		await this._removeSourceFiles();
		await this._updateMetadata(() => ({ name: displayName, importedAt: Date.now() }));

		// allow-any-unicode-next-line
		return { id: CUSTOM_RINGTONE_ID, name: displayName, description: 'Imported from your local machine', emoji: '🔊' };
	}

	async deleteCustomAudio(): Promise<void> {
		await this._removeFilesByStem(CUSTOM_STEM);
		await this._removeSourceFiles();
		await this._metadataSequencer.queue(async () => {
			if (await Promises.exists(this._metadataPath)) {
				try {
					await unlink(this._metadataPath);
				} catch {
					// best effort
				}
			}
		});
	}

	async renameCustomAudio(name: string): Promise<IParadisCustomRingtoneInfo> {
		const existing = await this.getCustomRingtoneInfo();
		if (!existing) {
			// allow-any-unicode-next-line
			throw new Error('カスタム音源が見つかりません');
		}
		const displayName = name.trim().slice(0, 80) || 'Custom Audio';
		await this._updateMetadata(metadata => ({ ...metadata, name: displayName, importedAt: metadata.importedAt ?? Date.now() }));
		return { ...existing, name: displayName };
	}

	async readCustomAudioFile(): Promise<{ base64: string; mimeType: string } | null> {
		const filename = this.findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const filePath = join(this._assetsDir, filename);
		const buffer = await readFile(filePath);
		return { base64: buffer.toString('base64'), mimeType: mimeTypeFor(filePath) };
	}

	// --- 再編集用ソース保存 ---------------------------------------------------------------------

	private async _removeSourceFiles(): Promise<void> {
		if (!await Promises.exists(this._assetsDir)) {
			return;
		}
		for (const file of await readdir(this._assetsDir)) {
			if (file.startsWith(`${CUSTOM_SOURCE_STEM}.`)) {
				try {
					await unlink(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	private _getCustomSourcePath(): string | null {
		const filename = this.findFileByStem(CUSTOM_SOURCE_STEM, ALLOWED_SOURCE_EXTENSIONS);
		return filename ? join(this._assetsDir, filename) : null;
	}

	private async _saveCustomSource(sourcePath: string): Promise<void> {
		await this._ensureAssetsDir();
		const ext = extname(sourcePath).toLowerCase();
		const destination = join(this._assetsDir, `${CUSTOM_SOURCE_STEM}${ext}`);
		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_SOURCE_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourcePath, tempPath);
			await this._removeSourceFiles();
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			await chmod(destination, 0o600);
		} catch {
			// best effort
		}
	}

	// === YouTube取込 =============================================================================

	private async _getShellPath(): Promise<string> {
		// macOS/Linux の GUI アプリはログインシェルのPATHを継承しないことがあるため、
		// ログインシェル経由でPATHを取得してフォールバックに使う（HomebrewやNVM等のPATH拡張対策）。
		if (process.platform === 'win32') {
			return process.env.PATH ?? '';
		}
		const shell = process.env.SHELL || '/bin/zsh';
		return new Promise<string>(resolve => {
			const timer = setTimeout(() => resolve(process.env.PATH ?? ''), 3000);
			execFile(shell, ['-ilc', 'echo -n "$PATH"'], { timeout: 3000 }, (error, stdout) => {
				clearTimeout(timer);
				resolve(!error && stdout.trim() ? stdout.trim() : (process.env.PATH ?? ''));
			});
		});
	}

	private async _resolveBinaryEnv(): Promise<NodeJS.ProcessEnv> {
		const shellPath = await this._getShellPath();
		// `~/.deno/bin` は deno の公式インストーラの既定の置き場所（yt-dlp が deno を見つけられるよう PATH にも足す）。
		const fallbackDirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin', join(homedir(), '.deno', 'bin')];
		const entries = new Set(shellPath.split(delimiter).filter(Boolean));
		for (const dir of fallbackDirs) {
			entries.add(dir);
		}
		return { ...process.env, PATH: [...entries].join(delimiter) };
	}

	private async _resolveBinaryPath(binary: string, env: NodeJS.ProcessEnv): Promise<string | null> {
		const pathValue = env.PATH ?? '';
		for (const dir of pathValue.split(delimiter)) {
			if (!dir) {
				continue;
			}
			const candidate = join(dir, process.platform === 'win32' ? `${binary}.exe` : binary);
			if (await Promises.exists(candidate) && (await stat(candidate)).isFile()) {
				return candidate;
			}
		}
		return null;
	}

	private async _resolveRequiredBinaries(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
		const missing = await this._checkRequiredBinaries(env);
		if (missing.missing.length > 0) {
			// allow-any-unicode-next-line
			throw new Error(`必要なツールが見つかりません: ${missing.missing.join(', ')}。\`brew install yt-dlp ffmpeg\`（macOS、ffprobeはffmpegに同梱）またはお使いのパッケージマネージャでインストールしてください。`);
		}
		const resolved: Record<string, string> = {};
		for (const binary of REQUIRED_BINARIES) {
			resolved[binary] = (await this._resolveBinaryPath(binary, env))!;
		}
		return resolved;
	}

	private async _checkRequiredBinaries(env: NodeJS.ProcessEnv): Promise<{ missing: string[] }> {
		const missing: string[] = [];
		for (const binary of REQUIRED_BINARIES) {
			if (!(await this._resolveBinaryPath(binary, env))) {
				missing.push(binary);
			}
		}
		return { missing };
	}

	/**
	 * 取り込みの前の確認。欠けている必須のツールに加え、無いと一部の動画が取れなくなる deno と、yt-dlp の版
	 * （既知の壊れた版か・古すぎるか、入れ方に応じた更新の手段）を返す。
	 */
	async checkYtDlp(): Promise<IParadisYtDlpCheckResult> {
		const env = await this._resolveBinaryEnv();
		const { missing } = await this._checkRequiredBinaries(env);
		const optionalMissing: string[] = [];
		for (const binary of OPTIONAL_BINARIES) {
			if (!(await this._resolveBinaryPath(binary, env))) {
				optionalMissing.push(binary);
			}
		}
		const ytDlp = await this._getYtDlpStatus(env);
		return { missing, optionalMissing, ...(ytDlp ? { ytDlp } : {}) };
	}

	private async _getYtDlpStatus(env: NodeJS.ProcessEnv): Promise<IParadisYtDlpStatus | undefined> {
		const binaryPath = await this._resolveBinaryPath('yt-dlp', env);
		if (!binaryPath) {
			return undefined;
		}
		let output: string;
		try {
			output = await this._runProcess(binaryPath, ['--version'], tmpdir(), env, YT_DLP_VERSION_TIMEOUT_MS);
		} catch (error) {
			this.logService.warn(`[ParadisNotifications] yt-dlp --version failed: ${getErrorMessage(error)}`);
			return undefined;
		}
		const version = paradisParseYtDlpVersion(output);
		if (!version) {
			this.logService.warn(`[ParadisNotifications] could not read the yt-dlp version from ${JSON.stringify(output.slice(0, 80))}`);
			return undefined;
		}
		const assessment = paradisAssessYtDlpVersion(version, Date.now());
		const [realPath, head] = await this._readBinaryIdentity(binaryPath);
		const installMethod = paradisDetectYtDlpInstallMethod(realPath, head);
		return { version: version.raw, status: assessment.status, ageDays: assessment.ageDays, installMethod, update: paradisYtDlpUpdatePlan(installMethod) };
	}

	/** 実行ファイルのシンボリックリンクを解いた実体のパスと、先頭 512 バイト（入れ方の見分けに使う）。 */
	private async _readBinaryIdentity(binaryPath: string): Promise<[string, string]> {
		let realPath = binaryPath;
		try {
			// realpathSync と同じ JS の実装（fs/promises の realpath は native で、Windows の subst などで結果が変わる）
			realPath = await promisify(realpath)(binaryPath);
		} catch {
			// 解けなければ見つけたパスのまま
		}
		let head = '';
		try {
			const handle = await open(realPath, 'r');
			try {
				const buffer = Buffer.alloc(512);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
				head = buffer.subarray(0, bytesRead).toString('latin1');
			} finally {
				await handle.close();
			}
		} catch {
			// 読めなければパスだけで見分ける
		}
		return [realPath, head];
	}

	private _appendInstallLog(installId: string, level: IParadisInstallLogLine['level'], message: string): void {
		const state = this._installStates.get(installId);
		if (!state) {
			return;
		}
		for (const line of message.split(/\r?\n/)) {
			const trimmed = line.trimEnd();
			if (!trimmed) {
				continue;
			}
			state.lines.push({ seq: state.nextSeq++, time: Date.now(), level, message: trimmed });
			if (state.lines.length > 1000) {
				state.lines.splice(0, state.lines.length - 1000);
			}
		}
	}

	private _beginInstallState(installId: string): void {
		// 通常は同時1件だが、ダイアログを閉じるとポーリングが止まり done 済みエントリが
		// 残り続ける（ログ最大1000行分）。少数上限に達したら done 済みのうち最も古いものを
		// 優先して破棄し、done が一つも無ければ最も古いもの（アクティブなものも含む）を
		// 破棄する（その installId のポーリングは unknown-id 契約に乗る）。
		while (this._installStates.size >= PARADIS_MAX_INSTALL_STATES) {
			let victim: string | undefined;
			for (const [key, value] of this._installStates) {
				if (value.done) {
					victim = key;
					break;
				}
			}
			victim ??= this._installStates.keys().next().value;
			if (victim === undefined) {
				break;
			}
			this._installStates.delete(victim);
		}
		this._installStates.set(installId, { lines: [], done: false, nextSeq: 1 });
	}

	private _finishInstallWithError(installId: string, message: string): void {
		this._appendInstallLog(installId, 'error', message);
		const state = this._installStates.get(installId);
		if (state) {
			state.done = true;
			state.error = message;
		}
	}

	async installYtDlp(installId: string): Promise<void> {
		this._beginInstallState(installId);

		if (process.platform !== 'darwin') {
			// allow-any-unicode-next-line
			const message = 'Homebrewによる自動インストールはmacOSのみ対応しています。yt-dlpとffmpegを手動でインストールしてください。';
			this._appendInstallLog(installId, 'error', message);
			const state = this._installStates.get(installId)!;
			state.done = true;
			state.error = message;
			return;
		}

		const env = await this._resolveBinaryEnv();
		const brewPath = await this._resolveBinaryPath('brew', env);
		if (!brewPath) {
			// allow-any-unicode-next-line
			const message = 'Homebrewがインストールされていません。https://brew.sh からインストールしてから、yt-dlpとffmpegをインストールしてください。';
			this._appendInstallLog(installId, 'error', message);
			const state = this._installStates.get(installId)!;
			state.done = true;
			state.error = message;
			return;
		}

		this._spawnLoggedCommand(installId, brewPath, ['install', 'yt-dlp', 'ffmpeg'], env, 'brew install',
			// allow-any-unicode-next-line
			'インストールが完了しました。');
	}

	/**
	 * yt-dlp を、入れ方に応じた手段で更新する（設定画面で利用者が「更新」を押したときだけ呼ばれる）。出力は
	 * インストールと同じく getInstallLog で読ませる。pip で入れたものと入れ方が分からないものは実行しない。
	 */
	async updateYtDlp(installId: string): Promise<void> {
		this._beginInstallState(installId);
		const env = await this._resolveBinaryEnv();
		const status = await this._getYtDlpStatus(env);
		if (!status || !status.update.runnable) {
			this._finishInstallWithError(installId, status?.installMethod === 'pip'
				// allow-any-unicode-next-line
				? `pip で入れた yt-dlp は Para Code から更新できません。yt-dlp を入れた Python の pip で更新してください（例: ${status.update.command}）。`
				// allow-any-unicode-next-line
				: 'yt-dlp の入れ方が分からないため更新できません。入れたときの方法で更新してください。');
			return;
		}
		const [program, ...args] = status.update.command.split(' ');
		const programPath = await this._resolveBinaryPath(program, env);
		if (!programPath) {
			// allow-any-unicode-next-line
			this._finishInstallWithError(installId, `${program} が見つかりません。ターミナルで「${status.update.command}」を実行してください。`);
			return;
		}
		this._spawnLoggedCommand(installId, programPath, args, env, status.update.command,
			// allow-any-unicode-next-line
			'更新が完了しました。');
	}

	private _spawnLoggedCommand(installId: string, programPath: string, args: string[], env: NodeJS.ProcessEnv, label: string, doneMessage: string): void {
		this._appendInstallLog(installId, 'info', `$ ${programPath} ${args.join(' ')}`);

		// fire-and-forget: 呼び出し元はgetInstallLogでポーリングする。
		const proc = spawn(programPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		const timer = setTimeout(() => proc.kill('SIGKILL'), 600_000);
		proc.stdout?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.stderr?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.on('error', error => {
			clearTimeout(timer);
			const state = this._installStates.get(installId);
			if (state) {
				state.done = true;
				// allow-any-unicode-next-line
				state.error = `${label} の起動に失敗しました: ${error.message}`;
				this._appendInstallLog(installId, 'error', state.error);
			}
		});
		proc.on('exit', code => {
			clearTimeout(timer);
			const state = this._installStates.get(installId);
			if (!state) {
				return;
			}
			state.done = true;
			if (code === 0) {
				this._appendInstallLog(installId, 'info', doneMessage);
			} else {
				// allow-any-unicode-next-line
				state.error = `${label} がコード ${code ?? '?'} で終了しました`;
				this._appendInstallLog(installId, 'error', state.error);
			}
		});
	}

	async getInstallLog(installId: string, afterSeq: number): Promise<IParadisInstallLogResult> {
		const state = this._installStates.get(installId);
		if (!state) {
			return { lines: [], done: true, error: 'unknown installId' };
		}
		const result: IParadisInstallLogResult = { lines: state.lines.filter(l => l.seq > afterSeq), done: state.done, error: state.error };
		if (state.done) {
			// 完了ログ（最大1000行）を返し切ったので、shared process に残さず破棄する。
			// UIは done を受け取るとポーリングを止めるため、これ以降 getInstallLog は呼ばれない。
			this._installStates.delete(installId);
		}
		return result;
	}

	private async _runProcess(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
		return (await this._runProcessWithStderr(binaryPath, args, cwd, env, timeoutMs)).stdout;
	}

	/** _runProcess と同じだが、標準エラーも返す。失敗したときは {@link ParadisProcessError} に標準エラーの全文を載せる。 */
	private _runProcessWithStderr(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const proc: ChildProcess = spawn(binaryPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
			proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
			const timer = setTimeout(() => {
				proc.kill('SIGKILL');
				// allow-any-unicode-next-line
				reject(new ParadisProcessError('処理がタイムアウトしました', stderr));
			}, timeoutMs);
			proc.on('error', error => {
				clearTimeout(timer);
				// allow-any-unicode-next-line
				reject(new Error(`プロセスの起動に失敗しました: ${error.message}`));
			});
			proc.on('exit', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					// allow-any-unicode-next-line
					reject(new ParadisProcessError(stderr.trim().split('\n').slice(-3).join('\n') || `プロセスがコード ${code ?? '?'} で終了しました`, stderr, code ?? undefined));
				}
			});
		});
	}

	private async _findProducedAudio(workDir: string): Promise<string | null> {
		if (!await Promises.exists(workDir)) {
			return null;
		}
		const candidates: { readonly path: string; readonly mtimeMs: number }[] = [];
		for (const name of await readdir(workDir)) {
			if (!OUTPUT_EXTENSIONS.has(extname(name).toLowerCase())) {
				continue;
			}
			const path = join(workDir, name);
			try {
				const fileStat = await stat(path);
				if (fileStat.isFile() && fileStat.size > 0) {
					candidates.push({ path, mtimeMs: fileStat.mtimeMs });
				}
			} catch {
				// 消えた・読めない
			}
		}
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return candidates[0]?.path ?? null;
	}

	async downloadYouTubeAudio(url: string): Promise<IParadisYouTubeDownloadResult> {
		const trimmed = url.trim();
		if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)[\w-]+|youtu\.be\/[\w-]+)/i.test(trimmed)) {
			// allow-any-unicode-next-line
			throw new Error('有効なYouTube URL (youtube.com または youtu.be) を入力してください。');
		}

		const env = await this._resolveBinaryEnv();
		const resolved = await this._resolveRequiredBinaries(env);
		const ffmpegDir = dirname(resolved.ffmpeg);
		const pathEntries = (env.PATH ?? '').split(delimiter).filter(Boolean);
		if (!pathEntries.includes(ffmpegDir)) {
			pathEntries.unshift(ffmpegDir);
		}
		const spawnEnv: NodeJS.ProcessEnv = { ...env, PATH: pathEntries.join(delimiter) };

		const workDir = await mkdtemp(join(tmpdir(), 'paradis-ytfull-'));
		const outputTemplate = join(workDir, 'audio.%(ext)s');

		const args = [
			// 警告は捨てずに拾う（古い版・JS ランタイムの欠け・署名の解読失敗などの壊れる前兆が出る）。
			'--no-playlist',
			// `--match-filter` だけだと、長すぎる動画は終了コード 0 で黙って飛ばされる（`--print-json` で理由の行も出ない）。
			// `--break-match-filters` なら終了コード 101 で止まるので、長さの超過と見分けられる。
			'--break-match-filters', `duration <= ${MAX_FULL_DOWNLOAD_DURATION_SECONDS}`,
			'-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
			'--concurrent-fragments', '5',
			'--ffmpeg-location', ffmpegDir,
			'--print-json', '--no-simulate',
			'-o', outputTemplate,
			trimmed,
		];

		let info: { title: string; thumbnailUrl: string; durationSeconds: number };
		let stderr = '';
		try {
			const output = await this._runProcessWithStderr(resolved['yt-dlp'], args, workDir, spawnEnv, FULL_DOWNLOAD_TIMEOUT_MS);
			const jsonOutput = output.stdout;
			stderr = output.stderr;
			const lastJsonLine = jsonOutput.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}')).pop();
			const data = lastJsonLine ? JSON.parse(lastJsonLine) as { title?: string; duration?: number; thumbnail?: string } : {};
			info = { title: data.title?.trim() || 'YouTube Video', thumbnailUrl: data.thumbnail || '', durationSeconds: data.duration ?? 0 };
		} catch (error) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			const message = error instanceof Error ? error.message : String(error);
			const fullStderr = error instanceof ParadisProcessError ? error.stderr : message;
			this._logYtDlpWarnings(fullStderr);
			const reason = paradisClassifyYtDlpError(fullStderr, error instanceof ParadisProcessError ? error.exitCode : undefined);
			if (reason === 'unknown') {
				throw error;
			}
			this.logService.warn(`[ParadisNotifications] yt-dlp failed (${reason}): ${message}`);
			const ytDlp = reason === 'forbidden' || reason === 'noFormats' ? await this._getYtDlpStatus(env).catch(() => undefined) : undefined;
			throw new Error(this._youTubeFailureMessage(reason, ytDlp));
		}

		const { precursors } = this._logYtDlpWarnings(stderr);
		const producedPath = await this._findProducedAudio(workDir);
		if (!producedPath) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			// 「非公開」と決めつけない。理由が分からないときは、まず yt-dlp の更新を勧める。
			// allow-any-unicode-next-line
			throw new Error('yt-dlpが音源を生成できませんでした。yt-dlp を更新してから、もう一度試してください。');
		}

		const tempId = randomUUID();
		this._tempAudio.set(tempId, { path: producedPath, dir: workDir });
		return { tempId, info, ...(precursors.length > 0 ? { precursors } : {}) };
	}

	/** yt-dlp の警告の行をログへ出し、壊れる前兆を返す。 */
	private _logYtDlpWarnings(stderr: string): ReturnType<typeof paradisExtractYtDlpWarnings> {
		const warnings = paradisExtractYtDlpWarnings(stderr);
		for (const line of warnings.lines.slice(0, 20)) {
			this.logService.warn(`[ParadisNotifications] yt-dlp: ${line}`);
		}
		return warnings;
	}

	/** yt-dlp の失敗の理由を、利用者に見せる文に変える。403 は非公開ではなく、版の古さを疑わせる。 */
	private _youTubeFailureMessage(reason: Exclude<ParadisYtDlpFailure, 'unknown'>, ytDlp?: IParadisYtDlpStatus): string {
		// 画面はこの文をそのまま文字として出すので、コマンドはバックティックではなく「」で囲む。
		const updateHint = !ytDlp?.update.command
			? ''
			: ytDlp.installMethod === 'pip'
				// allow-any-unicode-next-line
				? `（いまの版は ${ytDlp.version}。yt-dlp を入れた Python の pip で更新してください）`
				// allow-any-unicode-next-line
				: `（いまの版は ${ytDlp.version}。更新は「${ytDlp.update.command}」）`;
		switch (reason) {
			// allow-any-unicode-next-line
			case 'forbidden': return `YouTube が取得を拒みました (HTTP 403)。動画が非公開なのではなく、yt-dlp が YouTube の変更に追いついていないことがほとんどです。yt-dlp を更新してから、もう一度試してください${updateHint}。`;
			// allow-any-unicode-next-line
			case 'botCheck': return 'YouTube がロボットではない確認を求めたため取得できませんでした。時間をおいて試すか、yt-dlp を更新してください。';
			// allow-any-unicode-next-line
			case 'ageRestricted': return '年齢制限のある動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'membersOnly': return 'メンバー限定の動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'private': return '非公開の動画のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'unavailable': return 'この動画は削除されたか、見られない状態です。';
			// allow-any-unicode-next-line
			case 'liveNotStarted': return 'まだ始まっていないライブ配信・プレミア公開のため取得できませんでした。';
			// allow-any-unicode-next-line
			case 'tooLong': return `動画が長すぎます。最大 ${MAX_FULL_DOWNLOAD_DURATION_SECONDS / 60} 分までです。`;
			// allow-any-unicode-next-line
			case 'noFormats': return `取り込める音声の形式が見つかりませんでした。deno を入れていない場合は入れ、yt-dlp を更新してから、もう一度試してください${updateHint}。`;
			// allow-any-unicode-next-line
			case 'network': return 'YouTube に接続できませんでした。ネットワークの接続を確かめてください。';
		}
	}

	async readTempAudioFile(tempId: string): Promise<{ base64: string; mimeType: string } | null> {
		const entry = this._tempAudio.get(tempId);
		if (!entry) {
			return null;
		}
		const buffer = await readFile(entry.path);
		return { base64: buffer.toString('base64'), mimeType: mimeTypeFor(entry.path) };
	}

	async cleanupTempAudio(tempId: string): Promise<void> {
		const entry = this._tempAudio.get(tempId);
		this._tempAudio.delete(tempId);
		if (entry) {
			await rm(entry.dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	/**
	 * リモート音声（Aivisモデルのサンプル音声等）を取得してbase64で返す。renderer側の
	 * workbench CSP (`media-src`) は `<audio>` の再生元として https を許可していないため、
	 * shared process 側でバイト列を取得し、rendererはBlob URL化して再生する
	 * （カスタム音源のreadCustomAudioFileと同じパターン）。https以外・サイズ超過・タイムアウトは
	 * すべて null を返す（呼び出し元は再生をスキップする想定）。
	 */
	async fetchAudio(url: string): Promise<{ base64: string; mimeType: string } | null> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (parsed.protocol !== 'https:') {
			// allow-any-unicode-next-line
			this.logService.warn(`[ParadisNotifications] fetchAudio: https以外のURLは許可していません (${parsed.protocol})`);
			return null;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_AUDIO_TIMEOUT_MS);
		try {
			const response = await fetch(parsed, { signal: controller.signal });
			if (!response.ok) {
				this.logService.warn(`[ParadisNotifications] fetchAudio: HTTP ${response.status} (${url})`);
				return null;
			}
			const contentLength = Number(response.headers.get('content-length') ?? '0');
			if (contentLength > PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: レスポンスが大きすぎます (${contentLength} bytes)`);
				return null;
			}
			// content-length の無い応答も、上限を越えたところで読むのをやめる（全部読んでから確かめない）
			let buffer: Buffer;
			try {
				buffer = response.body ? await paradisCollectBody(response.body, PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES) : Buffer.alloc(0);
			} catch (error) {
				if (error instanceof AivisError) {
					// allow-any-unicode-next-line
					this.logService.warn(`[ParadisNotifications] fetchAudio: レスポンスが大きすぎます (over ${PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES} bytes)`);
					return null;
				}
				throw error;
			}
			const contentType = response.headers.get('content-type');
			const mimeType = contentType?.startsWith('audio/') ? contentType.split(';')[0].trim() : mimeTypeFor(parsed.pathname);
			return { base64: buffer.toString('base64'), mimeType };
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: タイムアウトしました (${url})`);
			} else {
				this.logService.warn(`[ParadisNotifications] fetchAudio failed (${url})`, error);
			}
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Myinstants の mp3 の直リンクを 1 回だけ取得し、一時音源として持つ（試聴は readTempAudioFile、保存は
	 * importMyinstantsAudio）。fetchAudio と違い、取りに行く先を `paradisCheckMyinstantsUrl` の形に絞る。
	 * リダイレクトは自分で追い、追う先も同じ形を満たすものに限る。Content-Type と先頭のバイト列で mp3 を確かめ、
	 * ファイルからの取り込みと同じ大きさの上限と、15 秒の打ち切りを掛ける。失敗は理由つきで返す（例外にしない）。
	 */
	async downloadMyinstantsAudio(url: string): Promise<IParadisMyinstantsDownloadResult> {
		const check = paradisCheckMyinstantsUrl(url);
		if (check.kind === 'page') {
			return { ok: false, reason: 'pageUrl' };
		}
		if (check.kind !== 'mp3') {
			return { ok: false, reason: 'invalidUrl' };
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_AUDIO_TIMEOUT_MS);
		let workDir: string | undefined;
		try {
			let current = check;
			let response: Response;
			for (let redirects = 0; ; redirects++) {
				response = await fetch(current.url, { signal: controller.signal, redirect: 'manual' });
				if (response.status < 300 || response.status >= 400) {
					break;
				}
				await response.body?.cancel().catch(() => { /* ignore */ });
				const location = response.headers.get('location');
				let next: string | undefined;
				try {
					next = location ? new URL(location, current.url).toString() : undefined;
				} catch {
					next = undefined;
				}
				const nextCheck = next !== undefined ? paradisCheckMyinstantsUrl(next) : undefined;
				if (redirects >= MYINSTANTS_MAX_REDIRECTS || nextCheck?.kind !== 'mp3') {
					this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: refused a redirect from ${current.url}`);
					return { ok: false, reason: 'redirect' };
				}
				current = nextCheck;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: HTTP ${response.status} (${current.url})`);
				if (response.status === 404 || response.status === 410) {
					return { ok: false, reason: 'notFound', status: response.status };
				}
				if (response.status === 403) {
					return { ok: false, reason: 'blocked', status: response.status };
				}
				return { ok: false, reason: 'http', status: response.status };
			}
			if (!paradisIsMp3ContentType(response.headers.get('content-type'))) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				return { ok: false, reason: 'notMp3' };
			}
			const contentLength = Number(response.headers.get('content-length') ?? '0');
			if (contentLength > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
				await response.body?.cancel().catch(() => { /* ignore */ });
				return { ok: false, reason: 'tooLarge' };
			}

			const chunks: Buffer[] = [];
			let size = 0;
			// 先頭のバイト列は、16 バイトそろった時点で確かめる（mp3 でなければ残りを読まずにやめる）。
			let headChecked = false;
			const reader = response.body?.getReader();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				size += value.byteLength;
				if (size > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
					await reader.cancel().catch(() => { /* ignore */ });
					return { ok: false, reason: 'tooLarge' };
				}
				chunks.push(Buffer.from(value));
				if (!headChecked && size >= 16) {
					headChecked = true;
					if (!paradisLooksLikeMp3(Buffer.concat(chunks, size).subarray(0, 16))) {
						await reader.cancel().catch(() => { /* ignore */ });
						return { ok: false, reason: 'notMp3' };
					}
				}
			}
			const buffer = Buffer.concat(chunks, size);
			if (!headChecked && !paradisLooksLikeMp3(buffer)) {
				return { ok: false, reason: 'notMp3' };
			}

			workDir = await mkdtemp(join(tmpdir(), 'paradis-myinstants-'));
			const audioPath = join(workDir, 'audio.mp3');
			await writeFile(audioPath, buffer, { mode: 0o600 });
			const tempId = randomUUID();
			this._tempAudio.set(tempId, { path: audioPath, dir: workDir, myinstantsSourceUrl: current.url });
			workDir = undefined;
			return {
				ok: true,
				tempId,
				sourceUrl: current.url,
				fileName: current.fileName,
				sizeBytes: buffer.byteLength,
				suggestedName: paradisMyinstantsDisplayName(current.fileName),
			};
		} catch (error) {
			if (controller.signal.aborted) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio: タイムアウトしました (${check.url})`);
				return { ok: false, reason: 'timeout' };
			}
			this.logService.warn(`[ParadisNotifications] downloadMyinstantsAudio failed (${check.url})`, error);
			return { ok: false, reason: 'network' };
		} finally {
			clearTimeout(timer);
			if (workDir) {
				await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			}
		}
	}

	/**
	 * downloadMyinstantsAudio が持った一時音源を、カスタム音源の 1 枠へ上書きで保存する（ファイルからの取り込みと
	 * 同じ importCustomAudio を通す）。出典は shared process が取得時に控えた URL を使い、renderer からは受け取らない。
	 */
	async importMyinstantsAudio(tempId: string, displayName: string): Promise<IParadisCustomRingtoneInfo> {
		const entry = this._tempAudio.get(tempId);
		if (!entry?.myinstantsSourceUrl) {
			// allow-any-unicode-next-line
			throw new Error('取り込む音源が見つかりません。もう一度読み込んでください。');
		}
		await this.importCustomAudio(entry.path);
		const name = displayName.trim().slice(0, 80) || paradisMyinstantsDisplayName(basename(new URL(entry.myinstantsSourceUrl).pathname));
		await this._updateMetadata(() => ({ name, importedAt: Date.now(), sourceUrl: entry.myinstantsSourceUrl }));
		await this.cleanupTempAudio(tempId);
		return (await this.getCustomRingtoneInfo())!;
	}

	async renderClip(request: IParadisRenderClipRequest): Promise<IParadisCustomRingtoneInfo> {
		const inputPath = request.tempId ? this._tempAudio.get(request.tempId)?.path : this._getCustomSourcePath() ?? undefined;
		if (!inputPath) {
			// allow-any-unicode-next-line
			throw new Error('編集元の音源が見つかりません。YouTubeから再度取り込んでください。');
		}

		const startSeconds = Math.max(0, request.startSeconds);
		const endSeconds = request.endSeconds;
		const playbackRate = Math.max(0.5, Math.min(2.0, request.playbackRate ?? 1.0));
		const rawDuration = endSeconds - startSeconds;
		const outputDuration = rawDuration / playbackRate;

		if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
			// allow-any-unicode-next-line
			throw new Error('終了時刻は開始時刻より後にしてください。');
		}
		if (outputDuration > PARADIS_MAX_CLIP_DURATION_SECONDS) {
			// allow-any-unicode-next-line
			throw new Error(`出力クリップの長さ (${outputDuration.toFixed(1)}秒) が上限の ${PARADIS_MAX_CLIP_DURATION_SECONDS}秒を超えています。`);
		}

		const env = await this._resolveBinaryEnv();
		const resolved = await this._resolveRequiredBinaries(env);
		const workDir = await mkdtemp(join(tmpdir(), 'paradis-ytclip-'));

		try {
			const filters: string[] = [];
			if (playbackRate !== 1.0) {
				filters.push(`atempo=${playbackRate.toFixed(3)}`);
			}
			const fadeIn = request.fadeInSeconds ?? 0;
			const fadeOut = request.fadeOutSeconds ?? 0;
			if (fadeIn > 0) {
				filters.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
			}
			if (fadeOut > 0) {
				filters.push(`afade=t=out:st=${Math.max(0, outputDuration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
			}

			const outputPath = join(workDir, `output_${randomUUID()}.mp3`);
			const ffmpegArgs = ['-ss', startSeconds.toFixed(3), '-i', inputPath, '-t', rawDuration.toFixed(3)];
			if (filters.length > 0) {
				ffmpegArgs.push('-af', filters.join(','));
			}
			ffmpegArgs.push('-acodec', 'libmp3lame', '-q:a', '5', '-y', outputPath);

			await this._runProcess(resolved.ffmpeg, ffmpegArgs, workDir, env, YT_DLP_TIMEOUT_MS);

			const result = await this.importCustomAudio(outputPath);
			const displayName = request.displayName?.trim().slice(0, 80);
			if (displayName) {
				await this.renameCustomAudio(displayName);
			}
			if (request.thumbnailUrl) {
				await this._updateMetadata(metadata => ({ name: metadata.name ?? result.name, importedAt: metadata.importedAt ?? Date.now(), thumbnailUrl: request.thumbnailUrl, editState: metadata.editState }));
			}

			// 再編集用にソース音源と編集パラメータを保存する。
			await this._saveCustomSource(inputPath);
			await this._updateMetadata(metadata => ({
				name: metadata.name ?? result.name, importedAt: metadata.importedAt ?? Date.now(), thumbnailUrl: metadata.thumbnailUrl, editState: {
					startSeconds, endSeconds, fadeInSeconds: request.fadeInSeconds, fadeOutSeconds: request.fadeOutSeconds,
					playbackRate, sourceTitle: request.sourceTitle, sourceUrl: request.sourceUrl,
				},
			}));

			return (await this.getCustomRingtoneInfo())!;
		} finally {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}
}

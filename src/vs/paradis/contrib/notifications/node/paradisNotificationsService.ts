/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process内で動く、通知サウンド機能のバックエンド本体（Superset apps/desktop の
// main/lib/custom-ringtones.ts, main/lib/youtube-ringtone.ts, main/lib/play-sound.ts,
// main/lib/aivis/client.ts, main/lib/notifications/aivis-tts.ts の移植・統合）。
// 呼び出し元（renderer）はAPIキー等の設定をIStorageServiceで持つため、Aivis関連の全メソッドは
// 引数でAPIキーを明示的に受け取るステートレス設計にしている（Supersetのようなmain側local-dbは無い）。

import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { copyFile, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, delimiter, dirname, extname, join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	CUSTOM_RINGTONE_ID,
	IParadisAivisDictionaryDetail,
	IParadisAivisDictionaryListItem,
	IParadisAivisDictionaryWord,
	IParadisAivisMeResult,
	IParadisAivisModelSummary,
	IParadisAivisUsageDayEntry,
	IParadisAivisUsageResult,
	IParadisCustomRingtoneInfo,
	IParadisInstallLogLine,
	IParadisInstallLogResult,
	IParadisPlayAivisRequest,
	IParadisRenderClipRequest,
	IParadisRingtoneEditState,
	IParadisYouTubeDownloadResult,
	PARADIS_MAX_CLIP_DURATION_SECONDS,
	PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES,
	PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES,
} from '../common/paradisNotifications.js';

const AIVIS_BASE_URL = 'https://api.aivis-project.com';
const AIVIS_SYNTHESIZE_TIMEOUT_MS = 30_000;
const YT_DLP_TIMEOUT_MS = 120_000;
const FULL_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FULL_DOWNLOAD_DURATION_SECONDS = 600;
const FETCH_AUDIO_TIMEOUT_MS = 15_000;
const REQUIRED_BINARIES = ['yt-dlp', 'ffmpeg', 'ffprobe'] as const;

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const ALLOWED_SOURCE_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);
const OUTPUT_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.webm']);

const CUSTOM_STEM = 'notification-custom';
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

/** インストールログの購読用バッファ（yt-dlp/ffmpeg の `brew install` 進捗、UIはポーリングで取得）。 */
interface IInstallState {
	lines: IParadisInstallLogLine[];
	done: boolean;
	error?: string;
	nextSeq: number;
}

class AivisApiError extends Error {
	constructor(readonly status: number, bodyText: string) {
		// allow-any-unicode-next-line
		super(`Aivis API エラー (HTTP ${status})${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
	}
}

/**
 * 通知サウンド機能のバックエンド本体。カスタム音源の保存 (`~/.para-code/assets/ringtones/`)、
 * YouTube取込 (yt-dlp/ffmpeg 呼び出し)、Aivis Cloud APIクライアント、TTS再生を担う。
 */
export class ParadisNotificationsService extends Disposable {

	private readonly _assetsDir = join(homedir(), '.para-code', 'assets', 'ringtones');
	private readonly _metadataPath = join(this._assetsDir, `${CUSTOM_STEM}.json`);

	/** downloadYouTubeAudio が発行した一時音源 (tempId → { path, dir }) */
	private readonly _tempAudio = new Map<string, { readonly path: string; readonly dir: string }>();
	private readonly _installStates = new Map<string, IInstallState>();

	constructor(private readonly logService: ILogService) {
		super();
	}

	// === カスタム音源 ============================================================================

	private _ensureAssetsDir(): void {
		if (!existsSync(this._assetsDir)) {
			mkdirSync(this._assetsDir, { recursive: true, mode: 0o700 });
		}
	}

	private _findFileByStem(stem: string, extensions: ReadonlySet<string>): string | null {
		if (!existsSync(this._assetsDir)) {
			return null;
		}
		const candidates = readdirSync(this._assetsDir).filter(file => file.startsWith(`${stem}.`) && extensions.has(extname(file).toLowerCase()));
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((a, b) => statSync(join(this._assetsDir, b)).mtimeMs - statSync(join(this._assetsDir, a)).mtimeMs);
		return candidates[0] ?? null;
	}

	private _removeFilesByStem(stem: string): void {
		if (!existsSync(this._assetsDir)) {
			return;
		}
		for (const file of readdirSync(this._assetsDir)) {
			if (file.startsWith(`${stem}.`)) {
				try {
					unlinkSync(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	private _readMetadata(): { name?: string; importedAt?: number; thumbnailUrl?: string; editState?: IParadisRingtoneEditState } {
		if (!existsSync(this._metadataPath)) {
			return {};
		}
		try {
			return JSON.parse(readFileSync(this._metadataPath, 'utf8'));
		} catch {
			return {};
		}
	}

	private _writeMetadata(name: string, importedAt: number, thumbnailUrl?: string, editState?: IParadisRingtoneEditState): void {
		this._ensureAssetsDir();
		writeFileSync(this._metadataPath, JSON.stringify({ name, importedAt, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(editState ? { editState } : {}) }), 'utf8');
		try {
			chmodSync(this._metadataPath, 0o600);
		} catch {
			// best effort
		}
	}

	async getCustomRingtoneInfo(): Promise<IParadisCustomRingtoneInfo | null> {
		const filename = this._findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const metadata = this._readMetadata();
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
		return this._readMetadata().editState ?? null;
	}

	async importCustomAudio(sourceFsPath: string): Promise<IParadisCustomRingtoneInfo> {
		const ext = extname(sourceFsPath).toLowerCase();
		if (!ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
			// allow-any-unicode-next-line
			throw new Error('.mp3、.wav、.ogg のみサポートしています');
		}
		const stat = statSync(sourceFsPath);
		if (!stat.isFile()) {
			// allow-any-unicode-next-line
			throw new Error('指定されたパスはファイルではありません');
		}
		if (stat.size > PARADIS_MAX_CUSTOM_AUDIO_SIZE_BYTES) {
			// allow-any-unicode-next-line
			throw new Error(`音源ファイルが大きすぎます (${Math.round(stat.size / 1024 / 1024)}MB)。最大20MBです。`);
		}

		this._ensureAssetsDir();
		const destination = join(this._assetsDir, `${CUSTOM_STEM}${ext}`);
		const displayName = basename(sourceFsPath).replace(/\.[^/.]+$/, '').trim().slice(0, 80) || 'Custom Audio';

		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourceFsPath, tempPath);
			this._removeFilesByStem(CUSTOM_STEM);
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			chmodSync(destination, 0o600);
		} catch {
			// best effort
		}
		// 直接インポートはYouTube由来ではないため再編集用ソース・editStateは残さない。
		this._removeSourceFiles();
		this._writeMetadata(displayName, Date.now());

		// allow-any-unicode-next-line
		return { id: CUSTOM_RINGTONE_ID, name: displayName, description: 'Imported from your local machine', emoji: '🔊' };
	}

	async deleteCustomAudio(): Promise<void> {
		this._removeFilesByStem(CUSTOM_STEM);
		this._removeSourceFiles();
		if (existsSync(this._metadataPath)) {
			try {
				unlinkSync(this._metadataPath);
			} catch {
				// best effort
			}
		}
	}

	async renameCustomAudio(name: string): Promise<IParadisCustomRingtoneInfo> {
		const existing = await this.getCustomRingtoneInfo();
		if (!existing) {
			// allow-any-unicode-next-line
			throw new Error('カスタム音源が見つかりません');
		}
		const displayName = name.trim().slice(0, 80) || 'Custom Audio';
		const metadata = this._readMetadata();
		this._writeMetadata(displayName, metadata.importedAt ?? Date.now(), metadata.thumbnailUrl, metadata.editState);
		return { ...existing, name: displayName };
	}

	async readCustomAudioFile(): Promise<{ base64: string; mimeType: string } | null> {
		const filename = this._findFileByStem(CUSTOM_STEM, ALLOWED_AUDIO_EXTENSIONS);
		if (!filename) {
			return null;
		}
		const filePath = join(this._assetsDir, filename);
		const buffer = await readFile(filePath);
		return { base64: buffer.toString('base64'), mimeType: mimeTypeFor(filePath) };
	}

	// --- 再編集用ソース保存 ---------------------------------------------------------------------

	private _removeSourceFiles(): void {
		if (!existsSync(this._assetsDir)) {
			return;
		}
		for (const file of readdirSync(this._assetsDir)) {
			if (file.startsWith(`${CUSTOM_SOURCE_STEM}.`)) {
				try {
					unlinkSync(join(this._assetsDir, file));
				} catch {
					// best effort
				}
			}
		}
	}

	private _getCustomSourcePath(): string | null {
		const filename = this._findFileByStem(CUSTOM_SOURCE_STEM, ALLOWED_SOURCE_EXTENSIONS);
		return filename ? join(this._assetsDir, filename) : null;
	}

	private async _saveCustomSource(sourcePath: string): Promise<void> {
		this._ensureAssetsDir();
		const ext = extname(sourcePath).toLowerCase();
		const destination = join(this._assetsDir, `${CUSTOM_SOURCE_STEM}${ext}`);
		const tempPath = join(this._assetsDir, `.tmp-${CUSTOM_SOURCE_STEM}-${randomUUID()}${ext}`);
		try {
			await copyFile(sourcePath, tempPath);
			this._removeSourceFiles();
			await rename(tempPath, destination);
		} catch (error) {
			await unlink(tempPath).catch(() => { /* ignore */ });
			throw error;
		}
		try {
			chmodSync(destination, 0o600);
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
		const fallbackDirs = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin'];
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
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return candidate;
			}
		}
		return null;
	}

	private async _resolveRequiredBinaries(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
		const missing = await this.checkYtDlp();
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

	async checkYtDlp(): Promise<{ missing: string[] }> {
		const env = await this._resolveBinaryEnv();
		const missing: string[] = [];
		for (const binary of REQUIRED_BINARIES) {
			if (!(await this._resolveBinaryPath(binary, env))) {
				missing.push(binary);
			}
		}
		return { missing };
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

	async installYtDlp(installId: string): Promise<void> {
		this._installStates.set(installId, { lines: [], done: false, nextSeq: 1 });

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

		this._appendInstallLog(installId, 'info', `$ ${brewPath} install yt-dlp ffmpeg`);

		// fire-and-forget: 呼び出し元はgetInstallLogでポーリングする。
		const proc = spawn(brewPath, ['install', 'yt-dlp', 'ffmpeg'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		const timer = setTimeout(() => proc.kill('SIGKILL'), 600_000);
		proc.stdout?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.stderr?.on('data', (chunk: Buffer) => this._appendInstallLog(installId, 'info', chunk.toString()));
		proc.on('error', error => {
			clearTimeout(timer);
			const state = this._installStates.get(installId);
			if (state) {
				state.done = true;
				// allow-any-unicode-next-line
				state.error = `brewの起動に失敗しました: ${error.message}`;
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
				// allow-any-unicode-next-line
				this._appendInstallLog(installId, 'info', 'インストールが完了しました。');
			} else {
				// allow-any-unicode-next-line
				state.error = `brew install がコード ${code ?? '?'} で終了しました`;
				this._appendInstallLog(installId, 'error', state.error);
			}
		});
	}

	async getInstallLog(installId: string, afterSeq: number): Promise<IParadisInstallLogResult> {
		const state = this._installStates.get(installId);
		if (!state) {
			return { lines: [], done: true, error: 'unknown installId' };
		}
		return { lines: state.lines.filter(l => l.seq > afterSeq), done: state.done, error: state.error };
	}

	private _runProcess(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const proc: ChildProcess = spawn(binaryPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
			proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
			const timer = setTimeout(() => {
				proc.kill('SIGKILL');
				// allow-any-unicode-next-line
				reject(new Error('処理がタイムアウトしました'));
			}, timeoutMs);
			proc.on('error', error => {
				clearTimeout(timer);
				// allow-any-unicode-next-line
				reject(new Error(`プロセスの起動に失敗しました: ${error.message}`));
			});
			proc.on('exit', code => {
				clearTimeout(timer);
				if (code === 0) {
					resolve(stdout);
				} else {
					// allow-any-unicode-next-line
					reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `プロセスがコード ${code ?? '?'} で終了しました`));
				}
			});
		});
	}

	private _findProducedAudio(workDir: string): string | null {
		if (!existsSync(workDir)) {
			return null;
		}
		const candidates = readdirSync(workDir)
			.filter(name => OUTPUT_EXTENSIONS.has(extname(name).toLowerCase()))
			.map(name => join(workDir, name))
			.filter(p => { try { return statSync(p).isFile() && statSync(p).size > 0; } catch { return false; } });
		if (candidates.length === 0) {
			return null;
		}
		candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
		return candidates[0] ?? null;
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
			'--no-playlist', '--no-warnings',
			'--match-filter', `duration <= ${MAX_FULL_DOWNLOAD_DURATION_SECONDS}`,
			'-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
			'--concurrent-fragments', '5',
			'--ffmpeg-location', ffmpegDir,
			'--print-json', '--no-simulate',
			'-o', outputTemplate,
			trimmed,
		];

		let info: { title: string; thumbnailUrl: string; durationSeconds: number };
		try {
			const jsonOutput = await this._runProcess(resolved['yt-dlp'], args, workDir, spawnEnv, FULL_DOWNLOAD_TIMEOUT_MS);
			const lastJsonLine = jsonOutput.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}')).pop();
			const data = lastJsonLine ? JSON.parse(lastJsonLine) as { title?: string; duration?: number; thumbnail?: string } : {};
			info = { title: data.title?.trim() || 'YouTube Video', thumbnailUrl: data.thumbnail || '', durationSeconds: data.duration ?? 0 };
		} catch (error) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			const message = error instanceof Error ? error.message : String(error);
			if (/does not pass filter|duration/i.test(message)) {
				// allow-any-unicode-next-line
				throw new Error(`動画が長すぎます。最大 ${MAX_FULL_DOWNLOAD_DURATION_SECONDS / 60} 分までです。`);
			}
			throw error;
		}

		const producedPath = this._findProducedAudio(workDir);
		if (!producedPath) {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
			// allow-any-unicode-next-line
			throw new Error('yt-dlpが音源を生成できませんでした。動画が非公開または制限されている可能性があります。');
		}

		const tempId = randomUUID();
		this._tempAudio.set(tempId, { path: producedPath, dir: workDir });
		return { tempId, info };
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
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.byteLength > PARADIS_MAX_FETCHED_AUDIO_SIZE_BYTES) {
				// allow-any-unicode-next-line
				this.logService.warn(`[ParadisNotifications] fetchAudio: レスポンスが大きすぎます (${buffer.byteLength} bytes)`);
				return null;
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
				const metadata = this._readMetadata();
				this._writeMetadata(metadata.name ?? result.name, metadata.importedAt ?? Date.now(), request.thumbnailUrl, metadata.editState);
			}

			// 再編集用にソース音源と編集パラメータを保存する。
			await this._saveCustomSource(inputPath);
			const metadata = this._readMetadata();
			this._writeMetadata(metadata.name ?? result.name, metadata.importedAt ?? Date.now(), metadata.thumbnailUrl, {
				startSeconds, endSeconds, fadeInSeconds: request.fadeInSeconds, fadeOutSeconds: request.fadeOutSeconds,
				playbackRate, sourceTitle: request.sourceTitle, sourceUrl: request.sourceUrl,
			});

			return (await this.getCustomRingtoneInfo())!;
		} finally {
			await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
		}
	}

	// === Aivis Cloud API =========================================================================

	private async _aivisFetch(path: string, apiKey: string, init: { method?: string; query?: Record<string, string | number | boolean | undefined>; json?: unknown; accept?: string } = {}): Promise<Response> {
		const url = new URL(path, AIVIS_BASE_URL);
		for (const [key, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
		const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' };
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
		let body: string | undefined;
		if (init.json !== undefined) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(init.json);
		}
		const response = await fetch(url, { method: init.method ?? 'GET', headers, body });
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new AivisApiError(response.status, text);
		}
		return response;
	}

	private async _aivisJson<T>(path: string, apiKey: string, init?: Parameters<ParadisNotificationsService['_aivisFetch']>[2]): Promise<T> {
		const response = await this._aivisFetch(path, apiKey, init);
		return response.json() as Promise<T>;
	}

	async getAivisModel(apiKey: string, uuid: string): Promise<IParadisAivisModelSummary | null> {
		interface AivmStyle { voice_samples?: { audio_url?: string | null }[] }
		interface AivmSpeaker { icon_url?: string | null; styles?: AivmStyle[] }
		interface AivmResponse { aivm_model_uuid: string; name: string; description?: string; user?: { name?: string; handle?: string; icon_url?: string | null }; speakers?: AivmSpeaker[] }
		try {
			const model = await this._aivisJson<AivmResponse>(`/v1/aivm-models/${uuid}`, apiKey);
			const speakerIcon = model.speakers?.[0]?.icon_url ?? null;
			const sampleUrl = model.speakers?.[0]?.styles?.[0]?.voice_samples?.[0]?.audio_url ?? null;
			return {
				uuid: model.aivm_model_uuid, name: model.name, description: model.description ?? '',
				iconUrl: speakerIcon ?? model.user?.icon_url ?? null, sampleUrl,
				authorName: model.user?.name ?? null, authorHandle: model.user?.handle ?? null,
			};
		} catch (error) {
			if (error instanceof AivisApiError && error.status === 404) {
				return null;
			}
			throw this._wrapAivisError(error);
		}
	}

	private _wrapAivisError(error: unknown): Error {
		if (error instanceof AivisApiError) {
			return new Error(error.message);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	async listAivisDictionaries(apiKey: string): Promise<IParadisAivisDictionaryListItem[]> {
		try {
			const json = await this._aivisJson<{ user_dictionaries: IParadisAivisDictionaryListItem[] }>('/v1/user-dictionaries', apiKey);
			return json.user_dictionaries;
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisDictionary(apiKey: string, uuid: string): Promise<IParadisAivisDictionaryDetail> {
		try {
			return await this._aivisJson<IParadisAivisDictionaryDetail>(`/v1/user-dictionaries/${uuid}`, apiKey);
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async createAivisDictionary(apiKey: string, name: string, description: string): Promise<{ uuid: string }> {
		const uuid = randomUUID();
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: [] } });
			return { uuid };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async updateAivisDictionary(apiKey: string, uuid: string, name: string, description: string, words: readonly IParadisAivisDictionaryWord[]): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'PUT', json: { name, description, word_properties: words } });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async deleteAivisDictionary(apiKey: string, uuid: string): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}`, apiKey, { method: 'DELETE' });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async exportAivisDictionary(apiKey: string, uuid: string): Promise<Record<string, unknown>> {
		try {
			return await this._aivisJson<Record<string, unknown>>(`/v1/user-dictionaries/${uuid}/export`, apiKey);
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async importAivisDictionary(apiKey: string, uuid: string, data: Record<string, unknown>, override: boolean): Promise<void> {
		try {
			await this._aivisFetch(`/v1/user-dictionaries/${uuid}/import`, apiKey, { method: 'POST', query: { override }, json: data });
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisUsageDaily(apiKey: string, startDate: string, endDate: string): Promise<IParadisAivisUsageResult> {
		interface UsageSummary { api_key_id: string; api_key_name: string; summary_date: string; request_count: number; character_count: number; credit_consumed: number }
		try {
			const json = await this._aivisJson<{ summaries: UsageSummary[] }>('/v1/payment/usage-summaries', apiKey, { query: { start_date: startDate, end_date: endDate } });
			const byDate = new Map<string, { date: string; requestCount: number; characterCount: number; creditConsumed: number; byApiKey: Record<string, { name: string; requestCount: number; characterCount: number; creditConsumed: number }> }>();
			for (const s of json.summaries) {
				const entry = byDate.get(s.summary_date) ?? { date: s.summary_date, requestCount: 0, characterCount: 0, creditConsumed: 0, byApiKey: {} };
				entry.requestCount += s.request_count;
				entry.characterCount += s.character_count;
				entry.creditConsumed += s.credit_consumed;
				const bucket = entry.byApiKey[s.api_key_id] ?? { name: s.api_key_name, requestCount: 0, characterCount: 0, creditConsumed: 0 };
				bucket.requestCount += s.request_count;
				bucket.characterCount += s.character_count;
				bucket.creditConsumed += s.credit_consumed;
				entry.byApiKey[s.api_key_id] = bucket;
				byDate.set(s.summary_date, entry);
			}
			const days: IParadisAivisUsageDayEntry[] = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
			const total = days.reduce((acc, d) => ({
				requestCount: acc.requestCount + d.requestCount,
				characterCount: acc.characterCount + d.characterCount,
				creditConsumed: acc.creditConsumed + d.creditConsumed,
			}), { requestCount: 0, characterCount: 0, creditConsumed: 0 });
			return { days, total };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	async getAivisMe(apiKey: string): Promise<IParadisAivisMeResult> {
		interface UserMeResponse { handle?: string; name?: string; credit_balance?: number }
		try {
			const me = await this._aivisJson<UserMeResponse>('/v1/users/me', apiKey);
			return { handle: me.handle ?? null, name: me.name ?? null, creditBalance: typeof me.credit_balance === 'number' ? me.credit_balance : null };
		} catch (error) {
			throw this._wrapAivisError(error);
		}
	}

	// --- TTS再生 -----------------------------------------------------------------------------

	async playAivis(request: IParadisPlayAivisRequest): Promise<void> {
		const text = request.text.trim();
		if (!text || !request.apiKey || !request.modelUuid) {
			return;
		}

		const body: Record<string, unknown> = { model_uuid: request.modelUuid, text, output_format: 'mp3' };
		if (request.userDictionaryUuid) {
			body.user_dictionary_uuid = request.userDictionaryUuid;
		}
		if (request.speakingRate !== undefined) {
			body.speaking_rate = request.speakingRate;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), AIVIS_SYNTHESIZE_TIMEOUT_MS);
		let audio: Buffer;
		try {
			const response = await fetch(new URL('/v1/tts/synthesize', AIVIS_BASE_URL), {
				method: 'POST',
				headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const bodyText = await response.text().catch(() => '');
				throw new AivisApiError(response.status, bodyText);
			}
			audio = Buffer.from(await response.arrayBuffer());
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				// allow-any-unicode-next-line
				throw new Error('Aivis APIのリクエストがタイムアウトしました');
			}
			throw this._wrapAivisError(error);
		} finally {
			clearTimeout(timer);
		}

		const tempPath = join(tmpdir(), `paradis-aivis-${Date.now()}-${randomUUID().slice(0, 8)}.mp3`);
		await writeFile(tempPath, audio);
		try {
			await this._playSoundFile(tempPath, request.volume ?? 100);
		} finally {
			unlink(tempPath).catch(() => { /* ignore */ });
		}
	}

	/**
	 * サウンドファイルをOSの標準ツールで再生し、完了を待つ（Superset main/lib/play-sound.ts 移植）。
	 * macOS: afplay -v、Linux: paplay --volume（失敗時aplayへフォールバック）、Windows: PowerShell。
	 */
	private _playSoundFile(soundPath: string, volume: number): Promise<void> {
		if (!existsSync(soundPath)) {
			this.logService.warn(`[ParadisNotifications] sound file not found: ${soundPath}`);
			return Promise.resolve();
		}
		const volumeDecimal = Math.max(0, Math.min(1, volume / 100));

		if (process.platform === 'darwin') {
			return new Promise(resolve => execFile('afplay', ['-v', volumeDecimal.toString(), soundPath], () => resolve()));
		}
		if (process.platform === 'win32') {
			if (volume === 0) {
				return Promise.resolve();
			}
			const escapedPath = soundPath.replace(/'/g, '\'\'');
			const isWav = /\.wav$/i.test(soundPath);
			const script = isWav
				? `$p = New-Object Media.SoundPlayer '${escapedPath}'; $p.PlaySync()`
				: `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([System.Uri]::new('${escapedPath}')); $p.Volume = ${volumeDecimal}; $p.Play(); Start-Sleep -Milliseconds 500; while ($p.NaturalDuration.HasTimeSpan -and $p.Position -lt $p.NaturalDuration.TimeSpan) { Start-Sleep -Milliseconds 200 }`;
			return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => resolve()));
		}
		// Linux
		const paVolume = Math.round(volumeDecimal * 65536);
		return new Promise(resolve => {
			execFile('paplay', ['--volume', paVolume.toString(), soundPath], error => {
				if (error) {
					execFile('aplay', [soundPath], () => resolve());
					return;
				}
				resolve();
			});
		});
	}
}

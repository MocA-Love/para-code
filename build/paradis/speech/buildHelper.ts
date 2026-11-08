/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 音声入力の補助プログラム（ParadisSpeech。macOS 26 の SpeechAnalyzer で書き起こす）をビルドして、Para Code.app に入れる。
//
//   node build/paradis/speech/buildHelper.ts [--out <dir>] [--arch universal|arm64|x86_64] [--if-stale]
//   node build/paradis/speech/buildHelper.ts --embed "<Para Code.app>" [--helper <ParadisSpeech>]
//
// Computer Use の補助（build/paradis/computerUse/buildHelper.ts）と同じく swiftc で arm64 と x86_64 を作って lipo で
// universal にし、ad-hoc 署名する。違いは .app にせず実行ファイル 1 つにすること。補助プログラムはマイクも画面も
// 自分では触らず（音声は Para Code の renderer が取り込んで標準入力へ渡す）、TCC の身元を分ける必要が無いため。
// 配布版は `Contents/Helpers/ParadisSpeech` に置き、build/darwin/sign.ts がアプリと一緒に署名し直す
// （別に公証はしない。アプリの公証にそのまま含まれる）。
//
// SpeechAnalyzer は macOS 26 の SDK（Xcode 26）が要る。既定の Xcode の SDK が古いときは、/Applications の
// Xcode 26 以上を探して DEVELOPER_DIR をこのビルドの間だけ差し替える（ほかのネイティブのビルドの Xcode は変えない）。
// 古い SDK で「使えない」だけを返す空の補助を作ることはしない（気付かずに使えない補助を配ることになるため）。
// 最低の版は macOS 14 のまま（古い Mac でも起動して「使えない」と答える）。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');

export const PARADIS_SPEECH_EXECUTABLE = 'ParadisSpeech';
export const PARADIS_SPEECH_SOURCE_ROOT = join(repositoryRoot, 'src', 'vs', 'paradis', 'contrib', 'dictation', 'native', 'macos');
export const PARADIS_SPEECH_DEFAULT_OUT = join(repositoryRoot, '.build', 'paradis', 'speech');

const MINIMUM_MACOS = '14.0';
/** SpeechAnalyzer（SpeechTranscriber）が入った SDK の版。 */
const MINIMUM_SDK_MAJOR = 26;
const ARCHITECTURES = ['arm64', 'x86_64'] as const;
type HelperArchitecture = typeof ARCHITECTURES[number];

export interface IParadisSpeechHelperBuildOptions {
	readonly outDir?: string;
	readonly architectures?: readonly HelperArchitecture[];
	/** 出来上がりがソースより新しければビルドしない。 */
	readonly ifStale?: boolean;
	readonly log?: (message: string) => void;
}

function sources(): string[] {
	const directory = join(PARADIS_SPEECH_SOURCE_ROOT, 'Sources', 'ParadisSpeech');
	return readdirSync(directory).filter(name => name.endsWith('.swift')).sort().map(name => join(directory, name));
}

/** SDK の版（`26.0` など）の先頭の数。読めなければ 0。 */
export function paradisSdkMajor(version: string): number {
	const major = Number.parseInt(version.trim().split('.')[0], 10);
	return Number.isFinite(major) ? major : 0;
}

function sdkVersion(env: NodeJS.ProcessEnv): string {
	try {
		return execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { env, encoding: 'utf8' }).trim();
	} catch {
		return '';
	}
}

/**
 * `/Applications` の Xcode を新しい順に並べる（`Xcode_26.3.app` → `Xcode_26.0.1.app` → `Xcode_16.4.app` → 版の無い `Xcode.app`）。
 * GitHub の macOS のランナーは `Xcode_<版>.app` で何本も入れている（既定は `Xcode.app` の symlink）。
 */
export function paradisXcodeCandidates(names: readonly string[]): string[] {
	const version = (name: string): number[] => /^Xcode[_-](?<version>[\d.]+)\.app$/.exec(name)?.groups?.version.split('.').map(Number) ?? [];
	const newer = (a: number[], b: number[]): number => {
		for (let index = 0; index < Math.max(a.length, b.length); index++) {
			const difference = (b[index] ?? 0) - (a[index] ?? 0);
			if (difference !== 0) {
				return difference;
			}
		}
		return 0;
	};
	return names.filter(name => /^Xcode.*\.app$/.test(name)).sort((a, b) => newer(version(a), version(b)) || a.localeCompare(b));
}

/** macOS 26 以上の SDK を持つ Xcode の環境変数。既定の Xcode で足りればそのまま、無ければ /Applications の Xcode を探す。 */
function sdkEnvironment(log: (message: string) => void): NodeJS.ProcessEnv {
	const current = sdkVersion(process.env);
	if (paradisSdkMajor(current) >= MINIMUM_SDK_MAJOR) {
		log(`macOS SDK ${current} (default Xcode)`);
		return process.env;
	}
	const candidates = existsSync('/Applications') ? paradisXcodeCandidates(readdirSync('/Applications')) : [];
	for (const name of candidates) {
		const developerDir = join('/Applications', name, 'Contents', 'Developer');
		const env = { ...process.env, DEVELOPER_DIR: developerDir };
		const version = sdkVersion(env);
		if (paradisSdkMajor(version) >= MINIMUM_SDK_MAJOR) {
			log(`macOS SDK ${version} (${developerDir})`);
			return env;
		}
	}
	throw new Error(`The speech helper needs the macOS ${MINIMUM_SDK_MAJOR} SDK (Xcode ${MINIMUM_SDK_MAJOR} or later); the default SDK is ${current || 'unknown'} and no newer Xcode was found in /Applications.`);
}

/** 補助プログラムをビルドして、実行ファイルの場所を返す。 */
export function buildParadisSpeechHelper(options: IParadisSpeechHelperBuildOptions = {}): string {
	if (process.platform !== 'darwin') {
		throw new Error('The speech helper can only be built on macOS.');
	}
	const log = options.log ?? (message => console.log(`[speech-helper] ${message}`));
	const outDir = resolve(options.outDir ?? PARADIS_SPEECH_DEFAULT_OUT);
	const executablePath = join(outDir, PARADIS_SPEECH_EXECUTABLE);
	const inputs = sources();
	if (options.ifStale && existsSync(executablePath)) {
		const newestInput = Math.max(...inputs.map(file => statSync(file).mtimeMs), statSync(import.meta.filename).mtimeMs);
		if (statSync(executablePath).mtimeMs >= newestInput) {
			log(`up to date: ${executablePath}`);
			return executablePath;
		}
	}
	const env = sdkEnvironment(log);
	const architectures = options.architectures ?? ARCHITECTURES;
	mkdirSync(outDir, { recursive: true });
	const staging = join(outDir, `.staging-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		const thin: string[] = [];
		for (const architecture of architectures) {
			const output = join(staging, `bin-${architecture}`);
			log(`compiling ${architecture}`);
			execFileSync('xcrun', [
				'swiftc',
				'-O',
				'-swift-version', '5',
				// @main を使うため（main.swift を置かない）
				'-parse-as-library',
				'-target', `${architecture}-apple-macos${MINIMUM_MACOS}`,
				'-module-name', 'ParadisSpeech',
				...inputs,
				'-o', output,
			], { stdio: 'inherit', env });
			thin.push(output);
		}
		const staged = join(staging, PARADIS_SPEECH_EXECUTABLE);
		if (thin.length === 1) {
			renameSync(thin[0], staged);
		} else {
			execFileSync('lipo', ['-create', ...thin, '-output', staged], { stdio: 'inherit', env });
		}
		// ad-hoc 署名。リリースは build/darwin/sign.ts がアプリと一緒に本番の identity で署名し直す
		execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', staged], { stdio: 'inherit' });
		rmSync(executablePath, { force: true });
		renameSync(staged, executablePath);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	log(`built ${executablePath}`);
	return executablePath;
}

/** 補助プログラムを `<Para Code.app>/Contents/Helpers/ParadisSpeech` に入れて、入れた先を返す。 */
export function paradisEmbedSpeechHelper(appBundlePath: string, helperPath: string = join(PARADIS_SPEECH_DEFAULT_OUT, PARADIS_SPEECH_EXECUTABLE)): string {
	const app = resolve(appBundlePath);
	const helper = resolve(helperPath);
	if (!existsSync(join(app, 'Contents', 'Info.plist'))) {
		throw new Error(`Not an app bundle: ${app}`);
	}
	if (!existsSync(helper) || !statSync(helper).isFile()) {
		throw new Error(`The speech helper was not found at ${helper}`);
	}
	const helpersDir = join(app, 'Contents', 'Helpers');
	const destination = join(helpersDir, PARADIS_SPEECH_EXECUTABLE);
	const staging = join(helpersDir, `.${PARADIS_SPEECH_EXECUTABLE}.partial`);
	mkdirSync(helpersDir, { recursive: true });
	rmSync(staging, { force: true });
	try {
		// 途中で失敗しても半端なものを署名に回さないよう、別名に写してから差し替える
		execFileSync('ditto', [helper, staging], { stdio: 'inherit' });
		rmSync(destination, { force: true });
		renameSync(staging, destination);
	} catch (error) {
		rmSync(staging, { force: true });
		rmSync(destination, { force: true });
		throw error;
	}
	return destination;
}

/**
 * gulp のパッケージの段から呼ぶ。macOS の手元のビルドでだけ、補助プログラムを（古ければ）ビルドして入れる。
 * CI（`CI` がある）と `PARADIS_SPEECH_HELPER=0` では何もしない（CI はワークフローの段で入れる）。
 * 失敗は警告にとどめ、パッケージは続ける（音声入力が「補助プログラムが入っていません」になるだけ）。
 */
export function paradisSpeechHelperPackageTask(platform: string, appBundlePath: string): () => Promise<void> {
	const embed = async () => {
		if (platform !== 'darwin' || process.platform !== 'darwin' || process.env['CI'] || process.env['PARADIS_SPEECH_HELPER'] === '0') {
			return;
		}
		try {
			const destination = paradisEmbedSpeechHelper(appBundlePath, buildParadisSpeechHelper({ ifStale: true }));
			console.log(`[speech-helper] embedded ${destination}`);
		} catch (error) {
			console.warn(`[speech-helper] skipped: the package ships without the speech helper (${error instanceof Error ? error.message : String(error)})`);
		}
	};
	return embed;
}

function parseArchitectures(value: string | undefined): readonly HelperArchitecture[] | undefined {
	if (value === undefined || value === 'universal') {
		return undefined;
	}
	if (value === 'arm64' || value === 'x86_64') {
		return [value];
	}
	throw new Error(`Unknown --arch ${value} (use universal, arm64 or x86_64)`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const valueOf = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const embedInto = valueOf('--embed');
	if (embedInto) {
		console.log(`[speech-helper] embedded ${paradisEmbedSpeechHelper(embedInto, valueOf('--helper'))}`);
	} else {
		const outDir = valueOf('--out');
		buildParadisSpeechHelper({
			outDir: outDir ? resolve(outDir) : undefined,
			architectures: parseArchitectures(valueOf('--arch')),
			ifStale: args.includes('--if-stale'),
		});
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Windows から WSL のファイルシステムを指す UNC パス（`\\wsl.localhost\<distro>\...`）を解析し、
// そのパスを対象とするコマンドをディストロの中で実行するための計画を組み立てる。
//
// 背景: リポジトリを `\\wsl.localhost\<distro>\...` として登録している場合、Windows 側のプロセスが
// `git` / `gh` をそのまま起動しても、Windows 側にそれらが入っていなければ何も動かない。実体は
// ディストロの中にあるので、対象パスが WSL 名前空間なら実行そのものを WSL へ移す。そのとき
// 引数の中のパスは、ディストロから見た絶対パス（`/home/u/repo`）へ書き換える必要がある。
//
// このファイルは文字列操作だけで完結させる（node の path/fs に依存しない）。Windows 以外でも
// 同じ結果になるので、ユニットテストがプラットフォームを問わず書ける。

/**
 * WSL のファイルシステムを指す UNC のホスト名。`wsl$` は古い綴りで、現在も有効。
 * 比較は大文字小文字を無視する（UNC のホスト名は case-insensitive）。
 */
const PARADIS_WSL_UNC_HOSTS: readonly string[] = ['wsl.localhost', 'wsl$'];

/**
 * ディストロ名として受け入れる形。`wsl.exe -d` へ渡す値なので、`-` で始まる名前を
 * オプションと誤読させないためにも絞る。判定は `validateDistroName`
 * (src/vs/platform/agentHost/node/wslRemoteAgentHostHelpers.ts) と同じ規則にしてある。
 * ここで弾いたものは「WSL ではない」として扱い、従来どおり Windows 側で実行させる。
 */
const PARADIS_WSL_DISTRO_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface IParadisWslLocation {
	/** UNC のホスト名（`wsl.localhost` か `wsl$`）。書かれていた綴りをそのまま保つ。 */
	readonly host: string;
	/** `wsl.exe -d` に渡すディストロ名。UNC に書かれていた綴りをそのまま保つ。 */
	readonly distro: string;
	/** ディストロの中から見た絶対パス。常に `/` 区切りで、共有のルートだけが `/` になる。 */
	readonly linuxPath: string;
}

/** UNC（`\\host\share\...` / `//host/share/...`）の形をしているか。WSL かどうかは問わない。 */
function paradisIsUncPath(rawPath: string): boolean {
	return /^[\\/]{2}[^\\/]/.test(rawPath);
}

/**
 * `\\wsl.localhost\<distro>\home\u\repo` のような UNC を、ディストロ名と Linux 側の絶対パスへ分解する。
 * WSL を指さないパス（ローカルのドライブパス、他ホストの共有、相対パス）では undefined を返す。
 *
 * `.` / `..` を含むものは、WSL を指していても解釈しない。Windows は UNC を解決してから 9p へ渡すので
 * `\\wsl.localhost\Ubuntu\..\Debian\x` は Debian を指すが、素朴に写すと Ubuntu の中の別の場所に
 * なってしまう。両者が食い違うくらいなら、WSL とみなさず従来どおり Windows 側で扱わせる。
 */
export function paradisParseWslUncPath(rawPath: string): IParadisWslLocation | undefined {
	if (typeof rawPath !== 'string' || !paradisIsUncPath(rawPath)) {
		return undefined;
	}
	const segments = rawPath.split(/[\\/]+/).filter(segment => segment.length > 0);
	const host = segments[0];
	const distro = segments[1];
	if (host === undefined || distro === undefined
		|| !PARADIS_WSL_UNC_HOSTS.includes(host.toLowerCase())
		|| !PARADIS_WSL_DISTRO_PATTERN.test(distro)) {
		return undefined;
	}
	const rest = segments.slice(2);
	if (rest.some(segment => segment === '.' || segment === '..')) {
		return undefined;
	}
	// 共有のルート（`\\wsl.localhost\<distro>`）はディストロのファイルシステムのルートそのもの。
	return { host, distro, linuxPath: `/${rest.join('/')}` };
}

/**
 * ディストロの中へ写す必要があるパス引数であることの目印。
 *
 * 「見た目がパスかどうか」で判定してはいけない。`git worktree lock --reason <任意の文字列>` の
 * ように値がユーザーの自由入力である引数が存在するため、そこに書かれた `C:\...` をパスとして
 * 扱うと、本来通るはずのコマンドが名前空間の不一致として弾かれてしまう。ロックの掛け直しが
 * そうやって失敗すると、削除できていないのにロックだけ消える。
 */
export interface IParadisWslPathArgument {
	readonly paradisPath: string;
}

/** 引数がパスであることを明示する。{@link paradisPlanWslCommand} はこれだけを写し替える。 */
export function paradisWslPathArg(value: string): IParadisWslPathArgument {
	return { paradisPath: value };
}

export type ParadisCommandArgument = string | IParadisWslPathArgument;

export type ParadisWslCommandPlan =
	/** WSL は関係しない。従来どおり Windows 側でそのまま実行する。 */
	| { readonly kind: 'local'; readonly args: readonly string[] }
	/** ディストロの中で実行する。args / cwd は Linux 側の絶対パスへ写し替え済み。 */
	| { readonly kind: 'wsl'; readonly distro: string; readonly args: readonly string[]; readonly cwd: string | undefined }
	/** 1回の実行に Windows 側と WSL 側のパスが混ざっている。どちらで実行しても壊れるので実行しない。 */
	| { readonly kind: 'conflict'; readonly detail: string };

/**
 * コマンドの引数と cwd を見て、ディストロの中で実行すべきかを判定する。
 *
 * 判定に使うのは「パスだと明示された引数」と cwd だけ。そのうち1つでも WSL を指していれば
 * WSL 実行に倒し、**残りのパス引数もすべて同じディストロを指していることを要求する**。
 * 満たさないものは `conflict` にする。ディストロの中では別の場所を指すか存在しないため、
 * 黙って進めると意図しない場所を読み書きしてしまう。パスでない引数は一切触らない。
 */
export function paradisPlanWslCommand(args: readonly ParadisCommandArgument[], cwd?: string): ParadisWslCommandPlan {
	const flatten = (): string[] => args.map(arg => typeof arg === 'string' ? arg : arg.paradisPath);
	const pathValues = args.filter((arg): arg is IParadisWslPathArgument => typeof arg !== 'string').map(arg => arg.paradisPath);

	let distro: string | undefined;
	for (const candidate of cwd === undefined ? pathValues : [...pathValues, cwd]) {
		distro = paradisParseWslUncPath(candidate)?.distro;
		if (distro !== undefined) {
			break;
		}
	}
	if (distro === undefined) {
		return { kind: 'local', args: flatten() };
	}

	/** そのディストロの中での絶対パスへ写す。別の名前空間を指していれば undefined。 */
	const translate = (value: string): string | undefined => {
		const location = paradisParseWslUncPath(value);
		return location !== undefined && location.distro.toLowerCase() === distro!.toLowerCase() ? location.linuxPath : undefined;
	};

	const translated: string[] = [];
	for (const arg of args) {
		if (typeof arg === 'string') {
			translated.push(arg);
			continue;
		}
		const value = translate(arg.paradisPath);
		if (value === undefined) {
			return { kind: 'conflict', detail: `path argument is outside the WSL distro ${distro}: ${arg.paradisPath}` };
		}
		translated.push(value);
	}
	if (cwd === undefined) {
		return { kind: 'wsl', distro, args: translated, cwd: undefined };
	}
	const translatedCwd = translate(cwd);
	return translatedCwd === undefined
		? { kind: 'conflict', detail: `cwd is outside the WSL distro ${distro}: ${cwd}` }
		: { kind: 'wsl', distro, args: translated, cwd: translatedCwd };
}

/**
 * ディストロの中でコマンドを起動する `wsl.exe` の引数列を組み立てる。
 *
 * `sh -c 'cd -- "$0" && exec "$@"'` を挟むのには2つ理由がある。
 * 1. 作業ディレクトリを `--cd` に頼らず指定できる。`--cd` は新しめの WSL にしか無く、
 *    古い綴りの `\\wsl$\` が使える環境では未対応のことがある。
 * 2. ログインシェルを通さないので、プロファイルが出力する挨拶やバナーが stdout に
 *    混ざらない。`git rev-parse` の結果や `gh --json` の JSON を読む側にとっては致命的なため。
 *
 * その代わりログインシェルの PATH が得られないので、必要なら `loginPath` を渡して
 * `env PATH=...` で被せる（{@link paradisWslLoginPathProbeArgs} で取得したもの）。
 * 引数はシェルの位置パラメータとして渡すので、空白や引用符を自前でエスケープする必要はない。
 */
export function paradisBuildWslInvocationArgs(
	plan: { readonly distro: string; readonly args: readonly string[]; readonly cwd: string | undefined },
	command: string,
	loginPath?: string,
): string[] {
	return [
		'-d', plan.distro,
		'-e',
		...(loginPath !== undefined && loginPath.length > 0 ? ['env', `PATH=${loginPath}`] : []),
		'sh', '-c', 'cd -- "$0" && exec "$@"', plan.cwd ?? '/',
		command, ...plan.args,
	];
}

/**
 * ログインシェルが組み立てる PATH を取り出すための `wsl.exe` 引数列。
 *
 * `~/.local/bin`・mise・Linuxbrew のように、プロファイルで PATH に足す場所へ `git` / `gh` を
 * 入れている構成は珍しくない。素の `-e` はプロファイルを読まないため、そのままでは
 * 「ターミナルでは動くのに Para Code からは見つからない」になる。
 */
const PARADIS_WSL_LOGIN_PATH_SENTINEL = '__paracode_wsl_path__=';

export function paradisWslLoginPathProbeArgs(distro: string): string[] {
	return ['-d', distro, '-e', 'bash', '-lc', `printf '\\n%s%s\\n' '${PARADIS_WSL_LOGIN_PATH_SENTINEL}' "$PATH"`];
}

/**
 * {@link paradisWslLoginPathProbeArgs} の出力から PATH を取り出す。
 * プロファイルが何か出力していても目印より後ろだけを見るので巻き込まれない。
 */
export function paradisParseWslLoginPath(stdout: string): string | undefined {
	const marker = stdout.lastIndexOf(PARADIS_WSL_LOGIN_PATH_SENTINEL);
	if (marker < 0) {
		return undefined;
	}
	const value = stdout.slice(marker + PARADIS_WSL_LOGIN_PATH_SENTINEL.length).split('\n', 1)[0].trim();
	// PATH として意味を成さないもの（空・NUL 混入）は使わない。
	return value.length > 0 && value.includes('/') && !value.includes('\0') ? value : undefined;
}

/**
 * `wsl.exe` の子プロセスへ引き渡したい環境変数名を `WSLENV` へ足す。
 *
 * WSL は `WSLENV` に列挙された変数だけを Windows から Linux へ渡すので、これを通さない限り
 * `GIT_TERMINAL_PROMPT` のような指定はディストロの中へ届かない。ユーザーが既に設定している
 * `WSLENV`（`NAME/p` のようなフラグ付き指定を含む）は保つ。
 */
export function paradisMergeWslEnvNames(existing: string | undefined, names: readonly string[]): string {
	const entries = (existing ?? '').split(':').map(entry => entry.trim()).filter(entry => entry.length > 0);
	const declared = new Set(entries.map(entry => entry.split('/', 1)[0]));
	for (const name of names) {
		if (!declared.has(name)) {
			declared.add(name);
			entries.push(name);
		}
	}
	return entries.join(':');
}

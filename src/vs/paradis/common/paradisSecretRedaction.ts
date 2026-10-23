/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 秘密らしい値（トークン・パスワード・URL の認証情報など）を伏せる規則。通知・受信箱・モバイルへの出力と、
// Sentry へ送る文（paradisSentryCommon.ts）が共用する。Sentry は main・utility の起動直後にも読み込むので、
// このファイルは何も import しない。

/** 伏せた部分の既定の印（通知・受信箱・モバイルの出力）。 */
const DEFAULT_MARKER = '***';

/**
 * 値として伏せる文字。ASCII の記号・英数字だけに限る（引用符・バッククオートと `&;|` は区切りとして除く）。
 * 日本語の文は空白で区切られないので、「次の空白まで」を値にすると文の残りまで消えてしまう。
 */
const VALUE = `[!#-%(-:<-_a-{}~]+`;
const QUOTED_OR_VALUE = `("[^"]*"|'[^']*'|${VALUE})`;
/**
 * 項目名の後の値。ただし3桁までの数字のすぐ後に日本語などが続くもの（`パスワード: 8文字以上`・`トークン=3件`）は
 * 数を書いた文なので伏せない。数字でない値は、後ろに日本語や句点が続いても（`password=hunter2で接続できました`）伏せる。
 * 省略記号（…）で切れた数字は、切り詰めた値の断片なので伏せる。
 * `undefined`・`null`・`true`・`false`・`none` と括弧だけの値（`Unexpected token: }`）は、エラーの文に出る語で秘密ではないので伏せない。
 */
const QUOTED_OR_STANDALONE_VALUE = `("[^"]*"|'[^']*'|(?!\\d{1,3}[^\\x00-\\x7F\\u2026])(?!(?:undefined|null|true|false|none)(?![!#-%(-:<-_a-{}~])|[{}()[\\]<>]+(?![!#-%(-:<-_a-{}~]))${VALUE})`;

/** 既知の形のトークンの接頭辞（切り詰めの境目で断片だけ残ったものを伏せるのにも使う）。 */
const KNOWN_TOKEN_PREFIXES = `(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|sk_|pk_|rk_|AKIA|ASIA|xox[abprs]-|AIza|npm_|glpat-|hf_|eyJ)`;

/**
 * 規則は長い文でも時間が文の長さに比例して収まるように書く。`.` や `-` を含む文字の並びを `*` で読むと、空白の無い
 * 長い文（`a.a.a.…`）で読み始めの位置ごとに末尾まで読み直して 2 乗の時間になるので、繰り返しには上限（`{0,64}` など）を付ける。
 */
function buildSecretPatterns(marker: string): readonly [RegExp, string][] {
	return [
		// URL に埋め込んだ認証情報（https://user:pass@host）と、キーだけのもの（Sentry の DSN など）
		[/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${marker}@`],
		[/\b(https?:\/\/)[0-9a-f]{16,}@/gi, `$1${marker}@`],
		// Webhook の URL（パスそのものが秘密）
		[/\b(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/g, `$1${marker}`],
		[/\b(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]+/g, `$1${marker}`],
		// PEM の秘密鍵（1行に畳まれて届くので、ヘッダーより後ろを全部伏せる）
		[/(-----BEGIN [A-Z ]*PRIVATE KEY-----).*/g, `$1 ${marker}`],
		// Authorization ヘッダー・Bearer / Basic の値（`Basic authentication failed` のような説明の語は値ではない）
		[/\b(Bearer|Basic)\s+(?!(?:authentication|authorization|auth|realm|scheme|tokens?|header|credentials?|access|login|is|was|failed|error|required)\b(?![-._~+/=]))[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${marker}`],
		// 大文字の環境変数（STRIPE_SECRET_KEY=... / OPENAI_KEY=... / SENTRY_DSN=...）
		[new RegExp(`\\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASS(?:WORD)?|PWD|DSN|CREDENTIALS?))(\\s*=\\s*)${QUOTED_OR_VALUE}`, 'g'), `$1$2${marker}`],
		// api_key: ... / password=... / secret_key_base: ... など（右辺だけ伏せる）。全角のコロン・等号（\uFF1A \uFF1D）も区切りとして読む
		// `max_tokens` などトークンの数（`tokens`）と `tokenizer`・`tokenIsValid` のような語は秘密ではないので除く
		[new RegExp(`\\b([A-Za-z0-9_.-]{0,64}(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token(?!s\\b|iz|is)|passw(?:or)?d|pwd|credentials?|authorization)[A-Za-z0-9_]{0,64})(["']?\\s*[:=\\uFF1A\\uFF1D]\\s*)${QUOTED_OR_STANDALONE_VALUE}`, 'gi'), `$1$2${marker}`],
		// 日本語の項目名（パスワード：hunter2 / トークン=abc123）。値は ASCII だけなので「パスワード：必須」のような文は伏せない
		// allow-any-unicode-next-line
		[new RegExp(`(パスワード|パスフレーズ|暗証番号|トークン|シークレット|秘密鍵|API\\s?キー|アクセスキー)(\\s*[:=\\uFF1A\\uFF1D]\\s*)${QUOTED_OR_STANDALONE_VALUE}`, 'gi'), `$1$2${marker}`],
		// 空白区切りで値を渡す設定（aws configure set aws_secret_access_key <値>）
		[new RegExp(`\\b([a-z0-9]+_(?:secret_access_key|session_token|secret_key|api_key|access_token))(\\s+)${QUOTED_OR_VALUE}`, 'gi'), `$1$2${marker}`],
		// --password xxx / --api-key=xxx などのコマンドライン引数（行頭か空白の直後のものだけ）
		[new RegExp(`(^|\\s)(--?(?:[a-z0-9-]*-)?(?:api-key|access-key|secret-key|secret|token|password|passwd|pass)(?:=|\\s+))${QUOTED_OR_VALUE}`, 'gi'), `$1$2${marker}`],
		// mysql -phunter2（値を空けずに付ける形）と docker login -p hunter2
		[new RegExp(`\\b((?:mysql|mysqldump|mariadb|mysqladmin)\\b[^|;&]{0,256}?\\s-p)${VALUE}`, 'g'), `$1${marker}`],
		[new RegExp(`\\b(login\\b[^|;&]{0,256}?\\s-p\\s+)${QUOTED_OR_VALUE}`, 'g'), `$1${marker}`],
		// curl -u user:pass
		[new RegExp(`(^|\\s)(-u|--user)(\\s+|=)([^\\s:"']+):${VALUE}`, 'g'), `$1$2$3$4:${marker}`],
		// よく知られた形のトークン
		[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, marker],
		[/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, marker],
		[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}/g, marker],
		[/\bgithub_pat_[A-Za-z0-9_]{12,}/g, marker],
		[/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, marker],
		[/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, marker],
		[/\bAIza[0-9A-Za-z_-]{20,}/g, marker],
		[/\bnpm_[A-Za-z0-9]{20,}/g, marker],
		[/\bglpat-[A-Za-z0-9_-]{16,}/g, marker],
		[/\bhf_[A-Za-z0-9]{20,}/g, marker],
		[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, marker],
		// 中継が長い文を切り詰めたとき（末尾が省略記号）、境目で既知の接頭辞の断片だけが残っていれば伏せる
		[new RegExp(`\\b${KNOWN_TOKEN_PREFIXES}[A-Za-z0-9_-]{0,256}(?=\\u2026$)`, 'g'), marker],
		[/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{0,256}(?=…$)/gi, `$1 ${marker}`],
	];
}

/** 印ごとに組み立てた規則。正規表現を呼ぶたびに作り直さない。 */
const secretPatternsByMarker = new Map<string, readonly [RegExp, string][]>();

function secretPatterns(marker: string): readonly [RegExp, string][] {
	let patterns = secretPatternsByMarker.get(marker);
	if (!patterns) {
		patterns = buildSecretPatterns(marker);
		secretPatternsByMarker.set(marker, patterns);
	}
	return patterns;
}

/**
 * 通知や受信箱に出す文から、秘密らしい値を伏せる。通知はロック画面・通知センターの履歴・
 * 画面共有に出るので、エージェントのコマンドに含まれるトークンやパスワードをそのまま載せない。
 * 見落としはありうる（形の決まっていない秘密は拾えない）ので、確実に隠したい人のために
 * 設定で本文そのものを切れるようにしてある。
 *
 * Sentry へ送る文も同じ規則を通す（`paradisSanitizeSentryText` が {@link paradisRedactSecretsWithMarker} で、印は `[Filtered]`）。ここに足すのは秘密の形だけにする。
 * メールアドレスやパスのような身元の情報はここに足さない。サイトのメモは「この関数が何かを伏せる文」を保存させないので
 * （`paradisBrowserSiteNotes.ts`）、足すとパスやメールに触れたメモが書けなくなり、モバイルの出力からもパスが消える。
 */
export function paradisRedactSecrets(text: string): string {
	return paradisRedactSecretsWithMarker(text, DEFAULT_MARKER);
}

/**
 * {@link paradisRedactSecrets} と同じ規則で、伏せた部分を `marker` にする（Sentry は `[Filtered]`）。
 * 印を `paradisRedactSecrets` の省略可能な引数にしないのは、`lines.map(paradisRedactSecrets)` が添え字を印として渡すため。
 */
export function paradisRedactSecretsWithMarker(text: string, marker: string): string {
	let result = text;
	for (const [pattern, replacement] of secretPatterns(marker)) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

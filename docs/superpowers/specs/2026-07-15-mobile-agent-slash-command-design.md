# Mobile Agent Slash Command Catalog Design

## Goal

ホームタブのエージェント詳細画面で、Claude CodeまたはCodexの入力欄の先頭に`/`を入力すると、本家CLIと同様のコマンド候補を表示する。`/a`のような追加入力では前方一致で候補を絞り込み、候補をタップすると入力欄へコマンドを挿入する。

## User Experience

- 候補はコンポーザー直上に表示し、ソフトウェアキーボードと入力フォーカスを維持する。
- 面にはモデルセレクターと同じ`GlassSurface`を使う。iOS 26以降は`expo-glass-effect`のLiquid Glass、それ以外は既存のBlurViewフォールバックになる。
- 入力全体が先頭のスラッシュトークンだけである間に表示する。空白、改行、通常文が入ったら閉じる。
- コマンド名は大文字小文字を区別せず前方一致で絞り込み、組み込み、ユーザー、プロジェクトの順序を保つ。
- 候補タップ時は入力欄全体を候補の`insertText`へ置換し、IMEフォーカスは維持する。自動送信はしない。
- 取得中、取得失敗、候補なしをパネル内で明示する。

## Catalog Semantics

- Claude Code: 共通の組み込みコマンドに加え、`~/.claude/skills`、`~/.claude/commands`、作業ディレクトリからリポジトリルートまでの`.claude/skills`と`.claude/commands`を読む。スキルは`/<name>`、旧式コマンドも`/<name>`として挿入する。
- Codex: 共通の組み込みコマンドと`~/.codex/prompts`直下の`/prompts:<name>`に加え、`~/.codex/skills`、`~/.agents/skills`、作業ディレクトリからリポジトリルートまでの`.agents/skills`を`/<name>`として表示する。Codex CLI本体は個別スキルを`$<name>`として解釈するため、モバイルでは表示・編集を`/<name>`に統一し、送信直前にカタログ上でCodexスキルと確認できた先頭トークンだけを`$<name>`へ変換する。
- 組み込み一覧はCLIの構造化一覧APIがないため、2026-07-15時点の公式コマンドリファレンスにあるコマンドをPara Code側で管理する。CLIのバージョン、契約、実験フラグ、セッション状態によって一部コマンドが実行時に利用できない場合がある。
- front matterの`description`、`argument-hint`、`user-invocable`を読み、`user-invocable: false`は一覧から除外する。説明がない場合は先頭の本文段落を短く表示する。
- 同名競合は組み込みを優先し、Claudeではユーザースキル、ユーザーコマンド、プロジェクトスキル、プロジェクトコマンドの順で一件だけ返す。

## Architecture And Data Flow

1. `AgentComposer`が先頭スラッシュトークンを検知すると、未取得の場合だけストアへカタログ取得を要求する。
2. モバイルストアは現在のターミナルID、ペイントークン、request IDを`command-catalog`フレームとしてPCへ送る。
3. shared processのmobile relayは購読中のペイン、確定済みセッション、現在の所有ウィンドウを検証する。
4. 独立したカタログモジュールがプロバイダーとPC側で既知のcwdから固定ルートだけを走査し、正規化済み候補を最大200件返す。
5. モバイルストアは一致するrequest IDの応答だけを受け入れ、正規化と文字数上限を再検証して`AgentChatState.commandCatalog`へ保存する。
6. 表示コンポーネントは純粋な検知・絞り込み関数の結果を`GlassSurface`内へ描画する。Codexスキルの送信時だけ、既知の候補に一致する`/<name>`を`$<name>`へ変換して既存の送信処理へ渡す。

## Security And Reliability

- モバイルからパスは受け取らない。cwdはPCが同期済みのペイン情報だけを使う。
- 読み取り対象は固定名の設定ディレクトリとMarkdown/SKILL.mdに限定し、1ファイル16 KiB、説明240文字、候補200件を上限にする。
- 個々のファイル読み取り失敗は候補を欠落させるだけで、カタログ全体を失敗させない。
- リレー応答前にセッション、所有者、購読状態を再検証し、切り替わったセッションの結果を送らない。
- モバイルは古いrequest IDの応答を無視し、15秒でエラー状態へ移行する。
- TextInputは既存どおりuncontrolledのままにし、日本語IMEへReactの`value`を書き戻さない。

## Testing

- モバイル純粋関数: `/`、`/a`、空白・改行・途中のスラッシュ、前方一致、挿入値、Codexスキルだけの送信時変換。
- PCカタログ: Claude/Codexの組み込み、ユーザー/プロジェクト走査、front matter、非表示、重複、件数上限。
- プロトコル: inbound shape検証、request IDの往復、古い応答と不正候補の拒否。
- 型検査: mobile packageとclient全体。

# 未保存エディターのスペーススコープ分離 設計

## 目的

Para Codeのスペースを作業コンテキストの境界として扱い、未保存のEditorInputとWorking Copyも作成・編集したstateKeyへ所属させる。スペース切替、ウィンドウのリロード、Hot Exit、スコープ退役のいずれでも、別スペースへの状態漏れと暗黙のデータ破棄を起こさない。

## 現状の問題

`ParadisWorkspaceSwitchService`は、切替元を`saveWorkingSet()`で保存し、切替先を`applyWorkingSet()`で適用する。upstreamのWorking Set適用は`closeAllEditors({ excludeConfirming: true })`を使うため、dirtyまたは独自close confirmationを持つ入力を閉じず、新レイアウトのactive groupへ持ち越す。この挙動は通常のWorking Setでは正しいが、Para Codeのスペース境界では未保存入力が別スペースへ漏れる。

また、Hot Exit復元はバックアップを現在のエディター領域へ一括復元する。ランタイム切替だけを直しても、リロード後にinactive scopeのバックアップがactive scopeへ開かれる。

## 採用アーキテクチャ

### 1. Opt-in Editor Working Set primitives

upstreamの既定挙動は変えず、`IEditorGroupsService`へPara Codeが明示的に利用する二つの汎用プリミティブを加える。

- `saveWorkingSet(name, { excludeEditors })`
  - 除外対象をグループレイアウト、MRU、preview、stickyのシリアライズ対象から外す。
  - live inputとシリアライズ入力が二重復元されることを防ぐ。
- `retainEditor(editor)`と`IEditorGroup.detachEditor(editor)`
  - retain中は、最後のグループ参照がなくなってもEditorInputをdisposeしない。
  - detachは確認を出さず、`EditorCloseContext.MOVE`としてグループから外す。
  - Side-by-side/Diffは親、primary、secondaryを再帰的にretainする。

既存の`saveWorkingSet()`と`applyWorkingSet()`を呼ぶ全機能は従来どおり動作する。

### 2. Scoped Live Working Set

`ParadisEditorScopeService`が、stateKeyごとにシリアライズ不能または未保存状態を持つEditorInputの実体と配置情報を保持する。

対象判定はトップレベル入力を単位とし、次のいずれかを自身またはSide-by-side/Diff配下が満たす場合にlive対象とする。

- `EditorInput.isModified()`
- `EditorInputCapabilities.Untitled`
- `EditorInputCapabilities.Scratchpad`
- `closeHandler.showConfirm()`
- 対応する`IWorkingCopy.isModified()`

保持する配置情報は、part/window、group id、index、active、preview/pinned、sticky、transient、multi-selection、active editorのview stateである。復元時は同じgroup idを優先し、レイアウト変更等で存在しなければ同じpartのactive group、最後にmain active groupへ安全にフォールバックする。

captureは次の順序で行う。

1. live対象と配置を列挙する。
2. 対応Working Copyの所有stateKeyを検証・記録する。
3. すべてのlive入力をretainする。
4. live対象を除外して通常Working Setを保存する。
5. 確認なしでグループからdetachする。

restoreは部分的なopenに失敗した場合、今回openした入力を再detachし、retainとlive stateを維持して失敗を返す。全openとselection復元が成功した後だけretain leaseを解放し、live stateを削除する。

### 3. Working Copy ownership ledger

`WorkingCopyIdentifier(resource + typeId) -> stateKey`をWORKSPACEスコープへバージョン付きで永続化する。キーは衝突を避けるためresourceとtypeIdのJSON tupleを用いる。

状態は次のとおり扱う。

- managed/stable: active stateKeyが確定し、直接対応する可視EditorInputがあるWorking Copyをactive stateKeyへ割り当てる。
- pending: スペース切替中、active stateKey不明、所有権不明、またはストレージ破損。推測割当しない。
- unscoped: Para Code管理外の通常ワークスペース。ルーターは復元を妨げない。

旧バージョンから初回移行するときだけ、所有権台帳が「未作成」でactive stateKeyが確定している場合、従来のHot Exitバックアップをactive stateKeyへ取り込む。台帳破損は未作成と区別し、安全なpendingとして扱う。

### 4. Working Copy Backup Restore Router

Working Copy共通層へopt-inの`IWorkingCopyBackupRestoreRouter`を追加する。

- provider未登録時は常にrestoreし、非Para Codeの挙動を変えない。
- providerはidentifierごとに`restore`または`defer`を返す。
- Backup Trackerはdeferされたidentifierを`unrestoredBackups`から削除しない。
- handlerとunrestored identifiersを保持し、route変更要求時に復元を再試行する。

Para Codeのproviderは`WorkbenchPhase.BlockRestore`で登録し、同期読み込み済みの所有権台帳とactive stateKeyを利用する。Backup Trackerの実復元は`LifecyclePhase.Restored`以降なので、最初の列挙より前にルーティング権限が確立する。

### 5. Switch transaction

切替は既存Sequencer内で次の順序に統一する。

1. owner serviceをpendingへ遷移し、既存`onWillSwitchScope`を発火。
2. 切替元のserialized Working Set、Scoped Live Working Set、panel、terminalを退避。
3. 切替先のserialized Working Setを適用。
4. foldersを切替。
5. active stateKeyをcommit。
6. 切替先のlive stateを復元。
7. 切替先に属する保留バックアップの復元を再試行。
8. panelを復元して`onDidSwitchScope`を発火。

いずれかが失敗した場合は、active identityを前stateKeyへrollbackし、元folders、元serialized Working Set、元live state、panelを復元する。復元自体の失敗は元live stateのretainを維持し、データを破棄せずエラーとして残す。

### 6. Scope retirement

退役は非同期preflightとcommitに分離する。

- inactiveなlive inputに加え、現在表示中でまだcaptureされていないactive scopeの未保存入力も既存close handlerまたはSave/Don't Save/Cancel相当の確認対象にする。
- Saveは削除元が存在するpreflight中に完了させる。Don't Saveは退役commitまで遅延し、teardownやスペース切替が失敗した場合は未保存内容を維持する。
- Save失敗、commit時のrevert後もmodified、Cancelは退役をvetoする。
- live inputがなくバックアップだけがある場合は、バックアップを破棄して退役する明示確認またはCancelを提示する。
- 外部のworktree削除はpreflight後に実施し、削除成功後だけcommitする。失敗時はpreflightをcancelする。
- 自動missing整理は確認が必要なスコープを勝手に退役させず、missingエントリとして残す。
- commit時にworking set、panel、live retain、owner entries、バックアップ、terminal/browser/SCMの既存retirement eventを順に整理する。
- activeな親リポジトリを退役する場合、別リポジトリがあれば先にそこへ切り替える。最後の1件なら管理スコープを解除し、退役済みstateKeyが再利用されないようにする。

## データフロー

### ランタイム切替

`Editor groups -> classify -> owner check -> save excluding live -> retain/detach -> apply target serialized -> update folders -> restore target live -> retry target backups`

### リロード復元

`BlockRestore: load identity + owner ledger + register route provider -> Restored: enumerate backups -> route(owner == active) -> create/open/resolve editor`

inactive scopeのbackupは列挙集合に残り、対象stateKeyへの切替commit後に再試行される。

## 既知の制約

- 同じ`resource + typeId`のWorking Copyをプロセス内で複数保持できないupstream制約は維持する。同一URI・同一typeIdへスペースごとに異なる内容を同時保持することは保証しない。
- active pane以外のエディターは汎用的なview state取得APIがないため、active editorはview stateまで、inactive editorはEditorInputとタブ配置までを保証する。
- バックアップhandlerが存在しないidentifierは従来どおりunrestoredとして残る。
- リロード後にバックアップから復元した入力は内容と所属を保証するが、プロセス内live stateの配置情報は残らないため、元の非active groupやselectionまで完全には復元できない場合がある。

## テスト境界

- pure state: owner ledgerのserialize/parse、legacy、corrupt、route、rekey、retire。
- EditorGroupModel/EditorParts: exclusionシリアライズ、retain/detach、Side-by-side、既定挙動非回帰。
- Backup Tracker: deferを開かない、集合に残す、route変更で再試行、providerなし非回帰。
- Paradis integration: A/B独立、dirty/Untitled/Scratchpad/compound、selection/preview/sticky、switch failure rollback、連打直列化、retirement veto。

## 自己レビュー結果

- serializedとliveの二重復元は、保存時除外を先に行うことで排除した。
- detach前に全入力をretainし、途中例外でもleaseを保持するためdispose穴を作らない。
- routerの既定値をrestoreにし、upstream利用者への影響をopt-inに限定した。
- 「台帳未作成」と「破損」を区別し、破損時の危険なlegacy移行を禁止した。
- 切替完了通知をfolders、identity、live restoreのcommit後に限定した。
- worktree外部削除はpreflight/commitに分け、確認前または削除失敗時の暗黙破棄を避けた。
- active scopeの画面上の入力も退役preflightへ含め、削除処理失敗時にはDon't Saveを実行しない。

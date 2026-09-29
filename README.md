# Real Dinosaur Game

Chrome のオフライン画面に出てくる「Dinosaur Game（T-Rex Runner）」を、実写風アセットで作り直したブラウザゲームです。
A photorealistic remake of Chrome's offline T-Rex Runner that runs in any modern browser.

![Real Dinosaur Game](docs/screenshots/hero.png)

| | | |
| --- | --- | --- |
| ![プテラノドン / pterodactyl](docs/screenshots/ptero.png) | ![夕暮れ / dusk](docs/screenshots/dusk.png) | ![夜 / night](docs/screenshots/night.png) |
| ![しゃがみ / duck](docs/screenshots/duck.png) | ![ゲームオーバー / game over](docs/screenshots/gameover.png) | ![デバッグ表示 / debug overlay](docs/screenshots/debug.png) |

---

## 日本語

### 遊び方
- 走り続ける T-rex でサボテンとプテラノドンをよけ、できるだけ遠くまで進みます。スコアは走った距離です。
- 速度は少しずつ上がります。一定の速さを超えるとプテラノドンが 3 つの高さで飛んできます。
  - 低い: ジャンプでよける
  - 中くらい: しゃがむかジャンプでよける
  - 高い: 立ったままくぐれる
- 走っている恐竜は、足で地面を蹴るたびに後ろへ砂ぼこりを立てます（着地やクラッシュのときにも舞い上がります）。
- 100 点ごとにスコアが点滅して効果音が鳴ります。700 点ごとに夕暮れを経て夜（月と星空）になり、しばらくすると夜が明けます。
- ハイスコアはブラウザに保存されます。Chrome と同じく、スコアは走り始めてから表示され、HI はハイスコアがあるときだけ表示されます。
- OS の「視差効果を減らす」（prefers-reduced-motion）がオンのときは、画面の揺れ、案内文の明滅、星のまたたきを止めます。

### 操作
| 操作 | キーボード | タッチ / マウス |
| --- | --- | --- |
| スタート / ジャンプ | Space・↑・W | 画面のどこでもタップ / クリック |
| 大ジャンプ / 小ジャンプ | 長押しで高く跳び、約 70〜110 ms で離すと低く跳びます。Chrome と同じく、それより短いタップでも長く押しても大ジャンプになります | 同左 |
| しゃがむ（地上） | ↓・S | 画面の左下（左半分の下 1/3）を長押し（プレイ中） |
| 急降下（空中） | ↓・S | 画面の左下をタップ（プレイ中） |
| リスタート | Space・↑・Enter（ゲームオーバーの 0.75 秒後から） | 画面のどこでもタップ（同じく 0.75 秒後から） |
| ミュート切替 | M | 左上のスピーカーボタン（スタート画面・一時停止中・ゲームオーバー画面） |
| 一時停止 | P・Esc（もう一度押すと再開。タブ切替やウィンドウが非アクティブになったときも自動で止まります） | — |
| デバッグ表示 | Shift + D | — |
| シェア | Tab でシェアボタンへ移動して Space・Enter（メニューは ↑↓ で選んで Enter、Esc で閉じる） | GAME OVER 画面のシェアボタン |

着地の 100 ms 前までに押したジャンプは、着地と同時に実行されます（着地前にキーを離しても大ジャンプになります）。キーを押しっぱなしにしても（オートリピート）連続ジャンプはしません。
タッチでは、画面の左下（左半分の下 1/3）だけがしゃがみ / 急降下で、それ以外はどこをタップしてもジャンプです。右手の親指はいつでもジャンプになり、地面の近くをタップしてもしゃがんでしまうことはありません。左下の範囲は、スタート画面、一時停止中、最初のプレイの始めの数秒、そしてまだタッチでしゃがんだことがなければゲームオーバー画面に、点線の枠で表示します。
左下でのしゃがみと急降下はプレイ中だけです。スタート画面とゲームオーバー画面では、左下をタップしてもほかの場所と同じようにスタート / リスタートします。キーボードの ↓・S ではスタートもリスタートもしません（Chrome と同じ）。
スピーカーボタンはタッチ操作の端末だけに表示し、プレイ中は出しません（左上の角をタップしてもジャンプが消えないようにするため）。

### 表示言語
- ブラウザの言語設定（`navigator.languages`）を上から見て、最初に出てくる日本語（`ja`・`ja-JP` など）か英語（`en`・`en-US` など）で表示します。どちらもないとき（例: フランス語だけ）は英語です。例: `fr, ja` なら日本語、`en-GB, ja` なら英語。
- 切り替わるもの: ページのタイトル（「リアル恐竜ゲーム」/「Real Dinosaur Game」）、ページの説明文、画面の案内文や一時停止などの表示、スクリーンリーダーの読み上げ、シェアボタンとシェアの文章。
- ゲームの途中でブラウザの言語設定を変えても、すぐに切り替わります。
- URL に `?lang=ja` / `?lang=en` を付けると、その言語に固定します（ブラウザの設定より優先）。

### スコアをシェア
GAME OVER 画面で、リスタートできるようになると（0.75 秒後）リスタートアイコンの近くに「シェア」ボタンが出ます。ボタンを押してもリスタートはしません。プレイ中・スタート画面・一時停止中は出ません。
- パソコンでは、ボタンを押すとシェア先のメニューが開きます。
  - X でポスト / Bluesky でポスト / LINE で送る: 投稿画面を新しいタブで開きます
  - Facebook でシェア: 公開 URL があるときだけ表示します（Facebook は URL しか共有できないため）
  - テキストをコピー: 投稿文をクリップボードにコピーして「コピーしました」と表示します
  - 画像を保存: GAME OVER 画面を PNG で保存します（`index.html` を直接開いたとき（file://）はブラウザの制限で画像を読み出せないので出ません）
  - その他…: OS の共有シート（メール、メッセージ、AirDrop など）を開きます。共有機能（Web Share API）に対応したブラウザ（macOS の Safari・Chrome、Windows の Edge・Chrome など）だけに表示します
- スマートフォンやタブレット（タッチ操作の端末）では、ボタンを押すと OS の共有シートが開きます（インストールしている X や LINE などのアプリを選べます）。対応していれば GAME OVER 画面のスクリーンショット（`real-dinosaur-game-score.png`）も添付します。共有シートを閉じただけのときは何もしません。共有シートがない端末や、共有に失敗したときは上のメニューが開きます。
- 添付・保存する画像では、スコアを遊ぶ範囲の右上に置き、「ゲームオーバー」の文字とリスタートアイコンをスコアに重ならない位置に描きます（縦長のスマートフォンでは、画面の表示よりも少し下になります）。
- 投稿文の例: 「リアル恐竜ゲームで 123 点を記録！🦖 #RealDinosaurGame」。ハイスコアを更新したときは「記録！」のあとに「自己ベスト更新！」が入ります（初めてのプレイは除く）。英語では "I scored 123 in Real Dinosaur Game! 🦖 #RealDinosaurGame"（更新時は " New personal best!" が入ります）。
- URL: `src/config.js` の `SHARE_URL` を設定するとその URL を付けます。空（既定）のときは、公開サーバー（http / https）で開いているページのアドレスを付けます。テスト用のパラメータ（`?` 以降）や `#` 以降は付けません。file://、localhost、127.0.0.1、`*.local`、社内 LAN のアドレス（10.x、172.16〜31.x、192.168.x、169.254.x など）のときは URL を付けません（友だちが開けないため）。
- キーボード: Tab でボタンに移動して Space か Enter。メニューは ↑↓・Home・End で選び、Enter で決定、Esc で閉じます。ボタンにフォーカスがあるときの Space・Enter はシェアになるので、リスタートしたいときは Esc（フォーカスをゲームに戻す）か画面のクリックです。

### 起動方法
- `index.html` をダブルクリックして開くだけで動きます（file:// 対応、ビルド不要、外部ライブラリなし）。
- ローカルサーバーで開くこともできます。この場合はオフラインキャッシュ（Service Worker）も有効になり、2 回目以降はネットワークなしで起動します。画像は内容のハッシュ（`tools/build_manifest.py` が付ける `?v=`）でキャッシュされるので、画像を差し替えても次の読み込みで新しい画像になります。
  ```sh
  python3 -m http.server 8000
  # http://localhost:8000/ を開く
  ```
- どんな形の画面でも、恐竜の前方が Chrome と同じくらい（約 1350 ワールド単位）見えるように描画します。反応できる時間が画面の形で変わらないようにするためです。幅の狭いスマートフォンでは、恐竜が約 44 CSS px より小さくならない範囲で見える距離を短くします。
  - 縦長の画面では、上に空（45%）、下に地面（55%）を広げて画面全体を埋めます。GAME OVER や案内の表示は遊ぶ範囲に付いたままです。スコアも同じですが、上に広げた空が 60 ワールド単位より高いとき（縦長のスマートフォンや 4:3 のタブレット）は、空の途中に浮かないように画面の上端（ノッチなどのセーフエリアの下）に固定します。
  - 3.2:1 より横長の画面だけ左右に帯が付きます。帯は地平線の高さで空の色と地面の色に分かれます。
- 画像は、空・地面・山・恐竜を先に、障害物・小石・雲を次に、夕暮れと夜の空と月を最後に読み込みます。5 秒（`LOAD_TIMEOUT_MS`）のあいだ 1 枚も届かないとき、または回線が遅くて読み込み開始から 15 秒（`LOAD_TIMEOUT_MAX_MS`）たったときは、残りを代わりの図形にしてゲームを始め、画像が届いたらその場で差し替えます。

### URL パラメータ（テスト・デバッグ用）
| パラメータ | 内容 |
| --- | --- |
| `seed=N` | 乱数シードを固定します（障害物の並びが毎回同じになります） |
| `bot=1` | オートパイロット（先読み探索で自動プレイ） |
| `sim=MS` | 最初の描画の前に、ゲーム内時間で MS ミリ秒ぶん早送りします（`bot=1` と組み合わせて使います） |
| `freeze=1` | 最初の 1 フレームを描いたらループを止めます（スクリーンショット用） |
| `state=idle` / `state=gameover` | 状態を強制します |
| `night=1` / `dusk=1` | 夜 / 夕暮れの照明を強制します |
| `debug=1` | 当たり判定、地面のライン、fps、速度を表示します |
| `lang=ja` / `lang=en` | 表示言語を固定します（既定はブラウザの言語設定。上の「表示言語」を参照） |
| `hi=N` | ハイスコア表示を N にします（表示だけで保存はしません。スクリーンショット用） |
| `touch=1` | タッチ端末向けの表示にします（案内文、しゃがみ範囲の枠、スピーカーボタン。スクリーンショット用） |
| `share=1` | `freeze=1` や `bot=1` のページでも GAME OVER のシェアボタンを表示します（ふだんはスクリーンショットに写らないように出しません） |

テスト用のパラメータ（`state`・`sim`・`bot`・`freeze`・`hi`）を 1 つでも付けたときは、ハイスコアを表示しますが localStorage には保存しません。

例: `index.html?seed=7&bot=1&sim=44500&freeze=1`（プテラノドンが飛んでくる場面）。
`window.__rdg` から `sim`・`state`・`step(ms)`・`config`・`metrics` などを参照できます。

スクリーンショットの撮り方（`docs/screenshots/` の画像はこの方法で作りました）:
```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1600,632 --screenshot=out.png \
  "file://$PWD/index.html?seed=3&bot=1&sim=25983&freeze=1&hi=812"
```

### テスト
```sh
node tools/sim_test.js
```
実際のアセットの当たり判定を使って、次の項目を確かめます。失敗すると 0 以外で終了します。
- 決定性（同じシードなら同じ展開になること）と、NaN が出ないこと
- 24 シードで bot が最高速度まで 4 分間生き残ること
- 障害物の間隔と連続出現のルール
- プテラノドンの出現速度と 3 つの高さ（翼の先が地面や恐竜の頭にめり込まないこと）
- スコア、ハイスコア、100 点ごとの点滅（ゲームオーバーの瞬間は必ず本当のスコアを表示）、700 点ごとの夜
- ジャンプ（短いタップでも大ジャンプ、着地前の先行入力、空中でぶつかったときにサボテンの上で止まること）
- タッチ入力（指ごとの長押しの管理、左下のしゃがみ範囲、スピーカーボタンを押してもジャンプしないこと）と、一時停止をはさんで押し続けた ↓ キーがしゃがみに戻ること
- シェアボタンなどの画面上の UI への操作がゲームの入力にならないこと（クリック、タップ、Space・Enter、メニューを閉じたタップ）
- 表示言語の決め方（`navigator.languages`、`?lang=`、言語設定の変更）、日英の文字列がそろっていること、シェアの文章、URL を付けるかどうかの判定、各 SNS の URL のエンコード
- シェアボタンを押したときに開くもの（タッチ端末は OS の共有シート、パソコンはメニュー）と、Shift などの修飾キーだけでは一時停止が解除されないこと
- シェア用の画像で「ゲームオーバー」の文字がスコアに重ならないこと（縦長のスマートフォンなど 16 通りの画面サイズ）

### アセットの作り方
- 画像はすべて **Codex の画像生成** で作りました。ゲームで使う画像のために全部で 58 回生成しています（恐竜 16 と画像編集 2、サボテン 12、プテラノドン 3、空 11、地形 14）。
  - 生成したままの画像は `assets/raw/` にあります（使わなかった候補も記録として残しています）。
  - ゲームで使う画像は `assets/dino/`・`assets/obstacles/`・`assets/scenery/` にあり、合計は約 1.2 MB（WebP）です。
  - 走るときの砂ぼこりは、砂ぼこりのスプライト（`assets/fx/`、`tools/assets/fx.py`、生成 10 回、約 0.3 MB）で描きます。Service Worker はこれらも先読みします。
- 生成のときは、毎回見本画像 `reference/screen.webp` を添付しました。さらに、先に作った画像も添付して「同じ個体」「同じ山並み」として描かせることで、見た目をそろえています。
  - 恐竜の走りの 4 コマは 1 枚のシートとしてまとめて生成しました。そのうち 1 コマ（`run_1`）は、手前の脚と奥の脚が交互に上がるように、あとから Codex の画像編集で描き直しました。
  - プテラノドンの羽ばたき 3 コマも 1 枚の画像として生成しました。
  - 背景はすべて透過（transparent background）で生成したので、クロマキー処理はしていません。
- 加工は再現可能なスクリプト `tools/assets/<group>.py`（dino / cactus / ptero / sky / terrain）で行います。スクリプトは次の処理をして、マニフェストの断片 `assets/manifest/<group>.json` を書き出します。
  - アルファのクリーンアップ
  - 見本写真に合わせた色調整
  - コマ同士の位置合わせ
  - 縮小と WebP 書き出し
  - アルファマスクから当たり判定を計算
  ```sh
  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
  .venv/bin/python tools/assets/dino.py      # 他のグループも同様
  python3 tools/build_manifest.py            # assets/manifest/*.json -> assets/manifest.js
  ```
- 作り直すときは、新しい生成画像を `assets/raw/` に置き、該当する `tools/assets/<group>.py` を実行してから `tools/build_manifest.py` を実行します。エンジンは次の値をマニフェストから自動で計算します。
  - 当たり判定と大きさ
  - プテラノドンの高度
  - 障害物の並びの公平性
- 画像が欠けていても、同じ当たり判定の形をした代わりの図形で遊べます。
- `tools/build_manifest.py` は画像のパスに内容のハッシュ（`?v=`）を付けます。`--check` を付けると、画像を変えたのにマニフェストを作り直していない場合も知らせます。

---

## English

### How to play
Keep the T-rex running: jump over cacti, and duck under or jump over pterodactyls. Your score is the distance run.
- The game speeds up over time. Past a speed threshold, pterodactyls arrive at three altitudes:
  - low: jump
  - mid: duck or jump
  - high: stay standing and let it pass overhead
- The running dino kicks up sand dust behind it with every stride (and on landing and crashing).
- The score blinks with a chime every 100 points.
- Every 700 points the desert fades through dusk into a moonlit, starry night, then back to day.
- The high score is kept in your browser. As in Chrome, the score appears once you start, and HI only once you have a high score.
- With `prefers-reduced-motion` set, there is no camera shake, hint pulse or star twinkle.

### Controls
| Action | Keyboard | Touch / mouse |
| --- | --- | --- |
| Start / jump | Space, ↑, W | tap anywhere / click |
| High / low jump | hold for a full jump; release after ~70–110 ms for a short hop (shorter taps and longer holds both give a full jump, as in Chrome) | same |
| Duck (on the ground) | ↓, S | hold the bottom-left of the screen (the bottom third of its left half; during a run) |
| Fast-fall (in the air) | ↓, S | tap the bottom-left (during a run) |
| Restart | Space, ↑, Enter (from 0.75 s after GAME OVER) | tap anywhere (from 0.75 s after GAME OVER) |
| Mute | M | the speaker button, top left (start, pause and GAME OVER screens) |
| Pause | P, Esc (press again to resume; also automatic when you switch tabs or the window loses focus) | — |
| Debug overlay | Shift + D | — |
| Share | Tab to the Share button, then Space / Enter (in the menu: ↑ ↓ to choose, Enter, Esc to close) | the Share button on GAME OVER |

A jump pressed up to 100 ms before landing fires on landing, as a full jump even if the key is released before touchdown. Holding a key down (auto-repeat) never jumps again.
On a touch screen only the bottom-left (the bottom third of the left half) ducks / fast-falls; a tap anywhere else jumps, so the right thumb always jumps and a tap near the ground never ducks by surprise. The zone is outlined with a dashed frame on the start screen, while paused, for the first seconds of the first run, and on GAME OVER until you have ducked by touch.
The bottom-left duck and fast-fall only apply during a run: on the start screen and on GAME OVER a tap there starts or restarts like a tap anywhere else. ↓ and S never start or restart (as in Chrome).
The speaker button appears on touch screens only, and never during a run (a tap in that corner must stay a jump).

### Language
- The UI is in Japanese or English: the first Japanese (`ja`, `ja-JP`, …) or English (`en`, `en-US`, …) entry in the browser's language list (`navigator.languages`) wins, and English is the fallback (e.g. French only). `fr, ja` gives Japanese; `en-GB, ja` gives English.
- This covers the page title ("Real Dinosaur Game" / 「リアル恐竜ゲーム」), the page description, the on-screen hints and pause text, the screen-reader label and announcements, and the share button and text.
- Changing the browser's language preferences switches the page live.
- `?lang=ja` / `?lang=en` pins a language over the browser's.

### Share your score
On GAME OVER, once a restart is possible (after 0.75 s), a Share button appears near the restart icon. Pressing it never restarts the game. It is never shown during a run, on the start screen or while paused.
- On a computer, the button opens a small menu:
  - Post on X / Post on Bluesky / Share on LINE: opens the post composer in a new tab
  - Share on Facebook: only when there is a public URL (Facebook shares links only)
  - Copy text: copies the post text and shows "Copied!"
  - Save image: saves the GAME OVER screen as a PNG (not offered from `file://`, where the browser does not let the page read its canvas)
  - More…: opens the OS share sheet (Mail, Messages, AirDrop, …); only in browsers with the Web Share API (Safari and Chrome on macOS, Edge and Chrome on Windows, …)
- On phones and tablets (touch screens), the button opens the OS share sheet (which lists your installed apps, such as X or LINE), with a screenshot of the GAME OVER screen (`real-dinosaur-game-score.png`) attached when the browser can share files. Closing the sheet does nothing. Without a share sheet, or if sharing fails, the menu above opens instead.
- In the shared / saved image the score sits at the top right of the playfield and GAME OVER and the restart icon are drawn clear of it (on tall phones a little lower than on screen).
- The text: "I scored 123 in Real Dinosaur Game! 🦖 #RealDinosaurGame", with " New personal best!" after "Game!" when the run beat your previous high score (not on your very first score). In Japanese: 「リアル恐竜ゲームで 123 点を記録！🦖 #RealDinosaurGame」 (plus 「自己ベスト更新！」).
- The URL: `SHARE_URL` in `src/config.js` when set. Otherwise the page's own address when it is served from a public http(s) host, without its query string (the test hooks) or hash. From `file://`, localhost, 127.0.0.1, `*.local` or a private LAN address (10.x, 172.16–31.x, 192.168.x, 169.254.x, …) no URL is added, since nobody else could open it.
- Keyboard: Tab to the button, then Space or Enter. In the menu, ↑ ↓ Home End move, Enter picks, Esc closes. While the button has focus, Space and Enter share instead of restarting: press Esc (hands the keyboard back to the game) or click the game to restart.

### Run it
- Double-click `index.html`. It works from `file://`, with no build step and no external libraries.
- Or serve the folder. This also enables the offline service worker, so later visits load without a network. Images are cached by content hash (the `?v=` that `tools/build_manifest.py` appends), so a changed image shows up on the next load:
  ```sh
  python3 -m http.server 8000   # then open http://localhost:8000/
  ```
- Any window shape shows at least Chrome's view ahead of the dino (about 1350 world units), so your reaction time does not depend on the window shape. On narrow phones the view is shortened just enough to keep the dino at least about 44 CSS px tall.
  - On taller screens the scene extends to fill the screen: extra sky above (45%) and more ground below (55%). GAME OVER and the hints stay with the playfield. So does the score, unless the extra sky is taller than 60 world units (portrait phones, 4:3 tablets): then it pins to the top of the screen, below any notch / safe-area inset, instead of floating mid-sky.
  - Only screens wider than 3.2:1 get side bands, which split into sky and ground colours at the horizon.
- Images load in priority order: the sky, ground, mountains and dino first, then the obstacles, decor and clouds, and the dusk / night skies and moon last. When no image has arrived for 5 s (`LOAD_TIMEOUT_MS`), or 15 s after loading started on a slow but moving connection (`LOAD_TIMEOUT_MAX_MS`), the rest get placeholders so the game can start, and each is swapped in as soon as it loads.

### URL parameters (testing / debugging)
| Parameter | Effect |
| --- | --- |
| `seed=N` | Deterministic run (the same obstacle sequence every time) |
| `bot=1` | Look-ahead autopilot |
| `sim=MS` | Fast-forward MS of game time before the first frame (use with `bot=1`) |
| `freeze=1` | Stop after the first frame (for screenshots) |
| `state=idle` / `state=gameover` | Force a state |
| `night=1` / `dusk=1` | Force the lighting |
| `debug=1` | Show hitboxes, ground lines, fps and speed |
| `lang=ja` / `lang=en` | Pin the UI language (default: the browser's language list; see Language above) |
| `hi=N` | Display a high score of N (display only, never saved; for screenshots) |
| `touch=1` | Show the touch UI (touch hints, duck-zone frame, speaker button; for screenshots) |
| `share=1` | Also show the GAME OVER Share button on `freeze=1` / `bot=1` pages (normally left out of screenshots) |

When any test hook (`state`, `sim`, `bot`, `freeze`, `hi`) is present, the high score is shown but never saved to localStorage.

Example: `index.html?seed=7&bot=1&sim=44500&freeze=1` (a pterodactyl approaching). `window.__rdg` exposes
`{ sim, state, step(ms), config, metrics, ... }`. The images in `docs/screenshots/` were made with headless Chrome:
`--headless=new --window-size=1600,632 --screenshot=out.png "file://…/index.html?seed=3&bot=1&sim=25983&freeze=1&hi=812"`.

### Tests
`node tools/sim_test.js` runs against the real asset hitboxes and exits non-zero on failure. It checks:
- determinism and the absence of NaNs
- bot survival up to MAX speed for 4 minutes on 24 seeds
- the obstacle gap and duplication rules
- the pterodactyl speed threshold and its three altitudes, including that the visible wingtips never sink into the ground or through the dino
- score and high-score maths, the 100-point milestones (GAME OVER always shows the real score) and the 700-point night cycle
- jump physics: a quick tap is a full jump, buffered presses, and a mid-air crash resting on the cactus
- touch input: per-finger holds, the bottom-left duck zone, speaker-button presses that never jump, and a ↓ key held across a pause that ducks again
- the on-screen UI (the Share button and its menu) never acting as game input: clicks, taps, Space / Enter, and the tap that closes the menu
- language negotiation (`navigator.languages`, `?lang=`, live changes), en / ja string parity, the share text, the public-URL rules and the encoding of every share link
- what the Share button opens (the OS share sheet on touch screens, the menu on computers), and that a modifier key such as Shift alone never resumes a pause
- that GAME OVER never overlaps the score in the share image (16 screen sizes, tall phones included)

### How the assets were made
- Every image was generated with **Codex image generation**: 58 generations for the game's images (dino 16 plus 2 image edits, cacti 12, pterodactyl 3, sky 11, terrain 14).
  - The untouched outputs are in `assets/raw/`, including rejected candidates, kept for provenance.
  - The game-ready WebPs in `assets/dino/`, `assets/obstacles/` and `assets/scenery/` total about 1.2 MB.
  - The running dust is drawn from a set of dust sprites (`assets/fx/`, built by `tools/assets/fx.py` from 10 generations, about 0.3 MB), which the service worker precaches too.
- Every prompt attached `reference/screen.webp`. Follow-up generations also attached an earlier "master" image, so every asset shows the same individual animal, the same mountain range and the same palette:
  - the 4-frame run cycle was generated as a single sheet; one frame (`run_1`) was later redone as a Codex image edit so the near and far legs alternate
  - the three wing-flap frames were generated as a single image
  - all sprites were generated with a native transparent background (no chroma keying)
- Reproducible post-processing scripts, `tools/assets/<group>.py` (dino, cactus, ptero, sky, terrain), take `assets/raw/` to game-ready files. Each one handles:
  - alpha clean-up
  - colour grading to the reference photo
  - frame alignment
  - downscaling and WebP export
  - hitbox extraction from the alpha mask
  - writing a manifest fragment, `assets/manifest/<group>.json`
- `tools/build_manifest.py` merges the fragments into `assets/manifest.js`. It is a classic script, so `file://` works.
  ```sh
  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
  .venv/bin/python tools/assets/terrain.py   # likewise dino / cactus / ptero / sky
  python3 tools/build_manifest.py
  ```
- To regenerate an asset, drop new generations into `assets/raw/`, rerun the group script, then rebuild the manifest. The engine derives the following from the manifest:
  - sprite sizes and hitboxes
  - the dino's length
  - pterodactyl altitudes
  - spawn fairness
- If an image is missing, the engine falls back to a placeholder with the same hitbox shape.
- `tools/build_manifest.py` adds a content hash (`?v=`) to every image path; `--check` also reports images that changed without a rebuild.

### Layout
- `index.html`, `style.css`
- `src/`
  - `config.js`: gameplay and loader tunables (the renderer keeps its own)
  - seeded RNG
  - `sim.js`: pure, deterministic simulation; also loads in Node
  - asset loader
  - WebAudio sound effects
  - input
  - canvas renderer
  - `i18n.js`: UI language (ja / en) and the DOM strings
  - `share.js`: the GAME OVER share button and menu
  - main loop
- `sw.js`: offline cache
- `tools/`: asset pipelines, manifest builder, tests
- `SPEC.md`: the design contract
- `docs/screenshots/`

---

## 動画の作り方 / Recording a video

X に投稿するプレイ動画 [`docs/video/real-dinosaur-game-x.mp4`](docs/video/real-dinosaur-game-x.mp4)（20.0 秒、1920×1080、60 fps、H.264 High + AAC-LC 48 kHz ステレオ、約 15 MB）と、ポスター画像 [`docs/video/poster.jpg`](docs/video/poster.jpg) は `tools/record/` のスクリプトで作りました。ゲーム本体は変えずに、ヘッドレス Chrome で `?freeze=1` のページを 1 フレーム（1/60 秒）ずつ進めて撮影します。効果音はゲームの `src/audio.js` で合成するので、何度実行しても同じ動画になります。

```sh
node tools/record/plan.js                            # (任意) シード 1〜2000 から展開を探して tools/record/plan.json を書く（約 80 秒）
node tools/record/verify_plan.js                     # (任意) plan.json が Chrome でも同じ展開になるか確かめる
FFMPEG=/path/to/ffmpeg node tools/record/record.js   # 撮影 → 効果音 → エンコード（約 3.5 分）
```

- 使ったもの: シード 909、`?hi=901`（ハイスコアの表示だけ）、`?lang=ja`。
- 流れ: スタート画面（「スペースキーでスタート」）→ 自動スタート → 0.4 秒のクロスフェード → 1 回のプレイ（`?sim=54800`、tick 3288〜4361）。
- 1 回のプレイの中身:
  - 昼（スコア 628）: プテラノドンをしゃがんでかわし、3 本並んだサボテンを跳ぶ
  - 700 点: スコアが点滅し、夕暮れを経て夜（月と天の川）になる
  - 夜: 低く飛ぶプテラノドンを跳び越える
  - tick 4206 で bot を止め、サボテンに衝突する（tick 4214、854 点）
  - ゲームオーバーとシェアボタンが出たあと 1.7 秒止める
- ポスター: 1 回のプレイの 794 フレーム目。

- 必要なもの: Node 22、Google Chrome、libx264 入りの ffmpeg。macOS では音声を AudioToolbox の AAC（CBR）で書き出します。作業用の PNG（約 2 GB）は `$RDG_VIDEO_WORK`（未設定なら一時フォルダ）に置きます。

`record.js` runs three scripts:
- `capture.js`
  - Serves the game with a throwaway `python3 -m http.server` on a random port from 9100 to 9999, and drives headless Chrome over CDP.
  - Each frame is one `__rdg.step(1000 / 60)` and one `Page.captureScreenshot`.
  - Every frame's state hash is checked against the Node replay of the plan. If Chrome does not reproduce the plan, the next planned candidate is tried.
  - The share button's CSS fade-in is replayed from the sim clock by recording-only CSS, so no wall-clock timing leaks into the frames.
- `audio.js` renders the game's own `RDG.Audio` on an `OfflineAudioContext`, at the recorded jump, landing, 100-point and crash events.
- `encode.js` builds the crossfade and writes the file:
  - BT.709 yuv420p video at CRF 18
  - AAC-LC audio at 48 kHz stereo, 160 kbit/s
  - `+faststart`
  - then probes the result and checks it against X's limits

Options: `--candidate N`, `--hold MS` (default 1700 after the share button appears), `--poster-frame N`.

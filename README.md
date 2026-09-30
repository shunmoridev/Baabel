# 🐑 Baabel

<img width="1792" height="610" alt="image" src="https://github.com/user-attachments/assets/e595fc3a-893b-44e1-9b4c-f8cd785b9c92" />

3 ペインのブラウザアプリです。

1. **JavaScript**（のサブセット）を書くと
2. **羊語**（= 命令文字を自由に決められる Brainfuck）にコンパイルされ
3. その羊語テキストが **WebAssembly のバイナリ**にコンパイルされて実行されます

中央の羊語は飾りではありません。実行されるのは常に中央のテキストで、手で書き換えればその通りに動きます。
命令セットを変えると字句解析器がその場で作り直され、中央のテキストも新しい言語に翻訳されます。

```
JS ──acorn──▶ AST ──frontend──▶ Brainfuck ──serialize(方言)──▶ 羊語テキスト（編集可能）

命令セット ──compiler generator──▶ 羊語コンパイラ.wasm
                                          │
羊語テキスト ─────────────────────────────┴──▶ program.wasm ──▶ Worker で実行
```

### 命令セット

プリセットは 羊語 / Brainfuck / Ook! / 猫語 / 絵文字 / BrainPower（掛け声風: `A-` `E-` `I-` `U-` `O-oooo` `E-eee` `JO-oooo` `AAAAE-`） / [Whitefuck](https://github.com/sevenc-nanashi/whitefuck) です。自分で作ることもできます。

Whitefuck は空白とタブだけで書く言語で、**1 行 1 命令**です（行全体が命令と一致したときだけ命令になり、それ以外の行はコメント扱い）。
これに合わせて、命令セットには「行単位モード」があります。JS 実装のコンパイラも生成される Wasm コンパイラも、このモードに対応しています。
中央ペインでは空白を `·`、タブを `→` で表示し、命令の種類ごとに色を付けます。
元の実装と違う点が 1 つあります。Windows の改行（CRLF）の `
` を無視します。

### コンパイラそのものも Wasm で生成

命令セットを決めるたびに、その言語専用のコンパイラ **`羊語コンパイラ.wasm`** がブラウザ内で生成されます（約 2KB、1ms 未満）。

- 命令文字列の Trie はテーブルではなく、UTF-8 バイトで分岐する**コード**（`$match` 関数）に変換されます
- `$compile` は中央のテキストを受け取り、`program.wasm` のバイト列をメモリに書き出します（Wasm が Wasm を生成）
- 「コンパイラ」タブで、生成されたコンパイラの逆アセンブル結果を見られます
- 上部の「Wasm化」で、最適化が強めの TypeScript 実装（`src/compiler/optimizer.ts` + `wasm.ts`）に切り替えられます。テストでは、両者が全サンプルで同じ出力になることを確認しています

## 起動

```bash
npm install
npm run dev
```

```bash
npm test
```

## 共有リンク

上部の「🔗 共有」を押すと、コード・命令セット・標準入力（中央を手で編集していれば中央のテキストも）を `deflate` で圧縮し、base64url にした URL を作ります（例：`https://…/#s=zTY4_Cs…`）。
リンクを開くとブラウザ内で展開され、同じ状態で表示・実行されます。開く前のコードは「自分のコードに戻す」で戻せます。

- データは URL の `#` より後ろに入っているので、サーバーには送信も保存もされません。静的ホスティングのままで動きます
- 長さはコードに比例します（サンプルの「羊を数える」で約 250 文字）。4000 文字を超えると警告します

## 多言語対応

UI・コンパイルエラー・サンプル・言語仕様は **日本語 / English / 简体中文** に対応しています（右上の 🌐）。
初回はブラウザの言語設定から自動で選びます。文言は `src/i18n/` にあり、`ja.ts` が原本です。`en.ts` / `zh.ts` にキーが欠けていると型チェックで失敗します。
言語を追加するには、`src/i18n/` にファイルを足して `LOCALES` に登録し、`src/examples.ts` のサンプル文言を追加します。

## 書ける JavaScript

アプリ内では、JS ペイン下部の「⚠ 制約」と「言語仕様」ダイアログで同じ内容を確認できます。
`test/pipeline.test.ts` の「language spec is honest」で、仕様に「未対応」と書いた構文が本当にエラーになること、「対応」と書いた構文が本当にコンパイルできることを検証しています。

| 対応 | 内容 |
|---|---|
| ✅値 | 8bit 符号なし整数（0〜255、はみ出すと一周）、`true`/`false` |
| ✅変数 | `let` / `const` / `var`（ブロックスコープ）、`const` の定数は畳み込み |
| ✅演算 | `+ - * / %`、比較、`&& \|\| !`、三項演算子、`+= -= *= /= %=`、`++ --`、定数シフト、`& (2^n-1)` |
| ✅制御 | `if/else`、`while`、`do-while`、`for`、`for...of`、`break`、`continue`、`return` |
| ✅関数 | `function` / アロー関数。呼び出し箇所にインライン展開（**再帰は不可**） |
| ✅配列 | `[1,2,3]`、`new Array(n).fill(v)`、`"文字列"`（UTF-8 のバイト配列）、実行時の添字でアクセス可 |
| ✅入出力 | `console.log(...)`、`print(...)`（改行なし）、`putchar(c)`、`getchar()`、`readInt()`、テンプレート文字列 |
| ✅その他 | `Math.min/max/floor/abs`、`String.fromCharCode`、`s.charCodeAt(i)` |
| ❌ | 再帰、関数を値として扱うこと、オブジェクト・クラス、`switch`、`try`、`async`・ジェネレータ、浮動小数点・負の数、256 以上の数、配列のメソッド |

`x / 0` と `x % 0` は 0 になります。入力が尽きたら `getchar()` は 0 を返します。

## 仕組み

- **フロントエンド**（`src/compiler/frontend.ts`）：コンパイル時にテープのヘッド位置を追跡し、セルを静的に割り当てます。`break`/`continue`/`return` はフラグセルで表現し、後続の文をガードします。配列は `[m, i, x, v]` の 4 セル単位のレイアウトで、実行時の添字に向かってヘッドが「歩いて」行って戻ってきます。
- **方言**（`src/compiler/dialect.ts`）：命令文字列から Trie を作り、最長一致で字句解析します。命令どうしがつなげると曖昧になる場合（例：「ふみ」と「ふみふみ」）は自動で検出し、空白区切りで出力します。
- **最適化**（`src/compiler/optimizer.ts`）：連続した `+`/`>` の畳み込み、オフセットアドレッシング、`[-]` → clear、`[->+<]` → 乗算、`[>]` → scan。
- **Wasm 生成**（`src/compiler/wasm.ts`）：ツールチェーンを使わず、バイト列を直接組み立てます。「Wasm (WAT)」タブは生成したバイト列を自前の逆アセンブラで戻したものです。
- **実行**：Web Worker 内で実行し、5 秒でタイムアウトします。テープは 65536 セル（1 ページ）です。

## ライセンス

このプロジェクトは [MIT License](LICENSE) です。

フォントは外部から読み込まず、アプリと一緒に配信しています（[Fontsource](https://fontsource.org/) の npm パッケージ経由）。

- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)：SIL Open Font License 1.1
- [M PLUS Rounded 1c](https://github.com/coz-m/MPLUS_FONTS)：SIL Open Font License 1.1

ビルドすると `dist/licenses/THIRD_PARTY_LICENSES.txt` が自動で作られます（`scripts/third-party-licenses.ts`）。
実際にバンドルされたパッケージ（JS・CSS・フォント）だけを集めて、それぞれのライセンス全文を載せます。
ライセンスファイルのないパッケージが紛れ込んだ場合は、ビルドが失敗します。

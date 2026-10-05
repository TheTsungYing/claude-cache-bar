# claude-cache-bar

[English](README.md)

Claude Code 的 mod，顯示 prompt cache 的狀態：還有多久過期、每次請求從快取讀了多少、何時失效以及可能的原因。快過期時會提醒，也能幫你延長快取。

快取命中的價格是一般輸入的十分之一；寫入快取則是 1.25 倍（5 分鐘 TTL）或 2 倍（1 小時 TTL）。離開稍微久一點，下一次請求就得重新寫入整段對話。cache-bar 讓這件事看得見。

## 安裝

```
/plugin marketplace add TheTsungYing/claude-cache-bar
/plugin install cache-bar@claude-cache-bar
```

需要 Claude Code 2.1.286 以上（function-hook plugin，搶先體驗的 API）。

## 功能

**Desktop（Code 分頁）**：輸入框上方一行高的精簡橫條。快取正常時保持安靜，只有需要你注意時才出現顏色。

- 小型 TTL 環形倒數與時間。正常時是灰色；剩 20% 變橘；剩 10% 變紅；過期後是灰色虛線環。不會閃爍。
- 滑鼠移到橫條上，會展開上次請求的命中率、上下文大小、命中率趨勢線（過期時另外顯示下次請求會重寫多少）。
- Claude 回覆中，環形停住不動，時間顯示 `…`：每次請求都會讓快取重新計時。
- 快過期時出現「延長」按鈕。
- 快取失效時出現紅色 ⚠，滑過可看可能原因。
- 「詳細資訊」開啟側邊面板。
- 不想看到橫條？在側邊面板把「輸入框上方橫條」設為「關閉」，仍會用 toast 提醒；輸入 `/cache` 可開啟面板，把橫條開回來。

**側邊面板**（`/cache` 或「詳細資訊」）：

- 倒數，下方一行顯示 TTL、上次命中率與上下文大小。
- 本次對話：平均命中率、請求數、失效次數、延長次數、最大上下文。
- 每次請求的圖表：以等效 token（讀取 ×0.1、寫入依 TTL ×1.25 或 ×2）畫出每次請求花了多少，寫入用橘色標出；命中率色帶只在下滑或失效時上色；閒置超過 5 分鐘與延長都有標記。遠高於其他的失效長條會被截斷，讓平常的長條看得清楚。
- 快取失效清單與可能原因、延長紀錄；都沒有時只顯示一行。
- 快捷設定：快過期時的處理方式、TTL 模式（附判定依據）、橫條、語言。

**Terminal 與 VS Code**：一行狀態列。

```
⚡ 3:42 · 94% · 48.2k
⚠ 0:28 /cache-extend · 94% · 48.2k
```

## 指令

| 指令 | 作用 |
|---|---|
| `/cache` | 開啟側邊面板 |
| `/cache lang [en\|zh-TW]` | 立即切換語言；不指定語言就切到另一種 |
| `/cache-extend` | 立即延長快取 |

## 延長快取

延長是透過 `$.model.fork` 在背景重送主對話的上一次請求，後面接一句極短的提示。這個請求會讀取整段快取前綴，讓 TTL 重新計時，不會出現在對話中。

成本約為上下文大小 × 快取讀取價格（0.1 倍），再加幾個輸出 token。50k 的上下文約等於 5k 一般輸入 token。讓它過期則要以 1.25 倍或 2 倍重寫，所以 5 分鐘快取延長約 12 次內、1 小時快取約 20 次內都划算。

`onExpiring` 設為 `auto` 時，到達提醒門檻會自動延長，但有三個上限：離開期間最多 `autoExtendMaxPerIdle` 次（預設 3）、上下文至少 `autoExtendMinContextK` 千 token（預設 20），以及可選的閒置超過 `autoExtendGiveUpMin` 分鐘就放棄。

## TTL 判定

Claude Code 不會告訴 plugin 快取是 5 分鐘還是 1 小時，所以倒數是估計值。`ttlMode` 為 `auto` 時暫定 5 分鐘（寧可早提醒）。若閒置超過 5 分鐘後送出的請求仍大多從快取讀取，TTL 必定是 1 小時，cache-bar 會記住，跨對話保留。之後若在一小時內的請求完全沒命中、又找不到其他原因，就改回 5 分鐘。

知道自己是哪一種的話，可以把 `ttlMode` 設為 `5m` 或 `1h`。

## 快取失效

上下文夠大、這次命中率低、上一次命中率高，三者同時成立就算失效。門檻依 `breakSensitivity` 而定：

| 靈敏度 | 上下文超過 | 本次低於 | 上一次高於 |
|---|---|---|---|
| `low` | 20k | 30% | 85% |
| `medium` | 10k | 50% | 80% |
| `high` | 5k | 70% | 70% |

可能原因：閒置超過 TTL、換模型、compact、system prompt 或 CLAUDE.md 變動、工具清單變動。

## 設定

每一項都是 `/config` 裡的一列。側邊面板的快捷設定也能改 `onExpiring`、`ttlMode`、`band` 與 `language`，`/cache lang` 也能改語言。

| 設定 | 選項 | 預設 | |
|---|---|---|---|
| `language` | `en`、`zh-TW` | `en` | 顯示語言 |
| `ttlMode` | `auto`、`5m`、`1h` | `auto` | 快取 TTL |
| `onExpiring` | `notify`、`button`、`auto` | `button` | 只通知；通知並提供延長按鈕；自動延長 |
| `band` | `compact`、`off` | `compact` | Desktop 輸入框上方的橫條；`off` 只保留 toast |
| `warnAtPercent` | 1–99 | 20 | TTL 剩這個百分比時變橘 |
| `alertAtPercent` | 1–99 | 10 | 剩這個百分比時通知（並提供延長） |
| `toast` | 開／關 | 開 | 快過期時顯示 toast |
| `autoExtendMaxPerIdle` | 0–100 | 3 | 離開期間最多自動延長幾次 |
| `autoExtendMinContextK` | 0–10000 | 20 | 上下文低於幾千 token 不自動延長 |
| `autoExtendGiveUpMin` | 0–1440 | 0 | 閒置超過幾分鐘就停止自動延長；0 = 不限 |
| `breakSensitivity` | `low`、`medium`、`high` | `medium` | 命中率下降多少才算失效 |

## 限制

- TTL 是推測的，不是讀到的；倒數是估計值。
- 只統計主對話，不含子代理。
- 通知只有 app 內 toast。不使用音效與語音：Windows 上無法使用。
- Plugin 無法把 TTL 改成 1 小時。
- 延長會花 token。

## 開發

直接從資料夾載入：

```
claude --plugin-dir ./plugins/cache-bar
```

Desktop app 不能加參數：在 `~/.claude/settings.json` 的 `env` 區塊把 `CLAUDE_CODE_PLUGIN_DIRS` 設為 `plugins/cache-bar` 的絕對路徑（並設 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`），再開新對話。存檔後模組會自動重新載入。

檢查與測試：

```
claude plugin validate ./plugins/cache-bar
claude plugin test ./plugins/cache-bar
```

要在編輯器做型別檢查，先在 Claude Code 裡執行 `/plugin-types plugins/cache-bar/.claude/types`，再用編輯器開啟 `plugins/cache-bar`。

```
.claude-plugin/marketplace.json   marketplace 清單
plugins/cache-bar/
  .claude-plugin/plugin.json      manifest 與 userConfig
  hooks/register.tsx              hooks 模組
  hooks/core.ts                   純邏輯：請求紀錄、TTL、失效判定、延長上限
  hooks/svg.ts                    橫條與面板的圖
  hooks/i18n.ts                   英文與繁體中文字串
  types/index.d.ts                $.state 契約
  tests/                          claude plugin test
```

## 授權

[MIT](LICENSE)

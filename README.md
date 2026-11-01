# dsh-plugin-qq

把 **QQ 私聊**接进 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）：你在手机上给一个 QQ 小号发消息，它变成 DSH 里某个会话的用户输入；agent 的回复再发回 QQ。

不需要公网、不需要服务器、不需要备案。QQ 和 DSH 都在你自己电脑上跑。

---

## 它是什么

```
手机 QQ  ──►  QQ 小号（NapCat）
                    │  OneBot v11 over WebSocket
                    ▼
              dsh-plugin-qq（本插件）
                    │
                    ▼
              DSH 会话  ──►  agent 干活（读写文件、跑命令、查资料）
                    │
                    ▼
              回复发回 QQ
```

用人话说：**让 DSH 变成你的 QQ 好友。** 你在外面发一句「帮我把那个表格的公式修一下」，电脑上的 agent 就动手，做完在 QQ 里告诉你。

选 QQ 而不是别的，是因为它自带文件传输——截图、PDF、代码包直接发过去，不用另想办法。

## 能做什么

- **一问一答**：发消息 → agent 处理 → 回复
- **连着发几条**会合并成一轮，不会答两遍
- **收文件**：QQ 里发的文件自动落到工作区 `inbox\`，agent 能直接读
- **发图片 / 发文件**：agent 能主动把结果发给你
- **引用回复**：agent 知道你这句话在回哪句
- **两种模式**：
  - **管家**（默认）：QQ 有自己的会话，用「QQ 管家」这个 agent preset 装配，工具精简、不读你的项目文件，
    不污染你网页端在聊的东西
  - **遥控**（`/bind` 到你已有的会话）：一个字节都不注入，只把那个会话的每一步输出（包括过程中的话）
    转到 QQ，让你在外面也能盯长任务
- **命令**：`/status` `/new` `/bind` `/help`
- **可调的东西分两处**：怎么干活（回复多短、怎么分条、什么时候说话）写在 agent preset
  「QQ 管家」里；怎么说人话（名字、称呼、语气）在设置页的「人设」里，改完下一条消息就生效。
  合并窗口、分片长度、Markdown 转换在设置页

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows | 目前只在 Windows 上验证过 |
| DSH | 桌面版或 CLI 版都行 |
| **一个小号** | 别用主号，见下方「风险」 |
| **NapCat** | 负责把 QQ 变成 OneBot 接口。**需要你自己下载，本插件不附带** |

### 关于 NapCat

本插件**不打包也不分发 NapCat**。它的许可证禁止再分发，而且它不含 QQ 本体、必须和特定 QQ 版本配套。

请自行到 NapCat 的官方发布页下载 Windows 版。

## 安装

```powershell
dsh plugin --profile <你的 profile 名> add dsh-plugin-qq
```

一条命令就够了。它会装进 `dependencies`，**并且自动把包名写进该 profile 的 `dsh.profile.bundles`**（因为这个包声明了 `dsh.bundle`）。重启 DSH 生效。

### 桌面版注意

`dsh plugin` 命令对 `desktop` profile 会拒绝执行——桌面版 profile 由 Electron 应用独占管理。桌面版用户可以：

- 用插件市场（如 `dshmarket`）安装，或
- 手动编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，两处都加：

```jsonc
{
  "dependencies": { "dsh-plugin-qq": "0.1.0" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-plugin-qq" ] } }
}
```

然后在该目录下 `pnpm install`。

### 升级 / 回退

```powershell
dsh plugin --profile <名> add dsh-plugin-qq@0.1.1   # 升级
dsh plugin --profile <名> add dsh-plugin-qq@0.1.0   # 回退
```

**配置不会丢**：代码在 `node_modules` 里，配置在 `%USERPROFILE%\.dsh\dsh-plugin-qq.json`，升级只换代码。

升级前先看 [CHANGELOG.md](CHANGELOG.md)。0.x 阶段：patch 是修 bug，minor 可能改行为。

## 配置

重启后打开 **设置 → QQ 桥接**。全程在这个页面里配，不用手改文件。

### 第一次配

1. **下载 NapCat**，解压到一个固定目录（以后别动）
2. **双击 `launcher-user.bat`** 启动它（`launcher.bat` 会弹 UAC 提权）
3. **拿到 WebUI 链接**，两条路任选：
   - 在它的控制台窗口里找打印出来的 `http://127.0.0.1:<端口>/webui?token=<令牌>`
   - 或者把启动脚本路径填进插件的「NapCat 安装位置」，点「读取配置并填入」，插件替你算出来
4. **打开那个链接**：扫码登录小号，然后在同一个页面里点「网络 → OneBot 配置 → 新建 WebSocket 服务端」
5. 回到设置页，填上「允许接收消息的 QQ 号」（你自己的主号），打开开关，保存

状态行显示 `已连接 · 机器人 <号>` 就好了。

> 就算第 3 步是你自己找的链接，连上之后点一下「自动检测」，插件也能把安装路径补回来。

### ⚠️ NapCat 必须你自己启动

不要让 DSH 或插件去拉它。DSH 启动的子进程会被一起清掉，导致 QQ 掉线。

## 风险，请先读

- **用小号，不要用主号。** 第三方 QQ 客户端有被封的可能，用小号损失最小。
- **白名单只放你自己的号。** 默认留空 = 谁发的都不理。放别人进来等于把这台电脑的操作权给他。
- **它能动你的文件、跑你的命令。** 这是 DSH 的能力，QQ 只是把入口开到了外面。请自己判断在什么场合用它。
- **遥控模式会动到你的会话。** 绑到已有会话时插件不改它的提示词和审批策略，只做两件事：
  隐藏提问工具、把它的输出转到 QQ。提问工具被拿掉之后，模型要跟你确认就只能开口问
  （问句会照常转到手机，你回一句就是下一轮）。切回「自动」即撤销。
- **需要人在电脑前的事，手机办不了。** 审批、以及计划模式提交方案后的评审，都只认网页：
  QQ 这边收不到、也答不了。所以在 QQ 场景里建议直接用**完全权限**——完全权限下没有「更宽的
  权限」可升，审批这条路径根本不会触发（请求在进入审批之前就因为不满足升权条件而报错）。
  一旦把会话设成只读或「工作区可写」，模型被拒绝后就会申请升权，然后卡在网页那边等你回来。
  这个插件明确不做审批与提问的转发。
- **管家模式会改工具集和审批。** QQ 自己的会话里没有提问、计划、目标这类工具，
  审批一律拒绝（QQ 上没人能点「同意」）。这条会话是插件的一次性产物，`/new` 就换掉。

## 常见问题

**连不上，状态行显示「连不上」**
NapCat 没启动、它的 WebSocket 服务端没开、或者还没扫码登录。三个都检查一下。

**「令牌不对」**
去 NapCat 的 WebUI 里看网络配置里的 token，原样填进来。

**「这个端口不是 OneBot」**
多半填成了 NapCat 的 WebUI 端口（比如 6099），不是 OneBot 的端口（比如 3001）。

**改人设没反应**
下一条 QQ 消息才会用新版本。人设是挂在会话上的，不是每轮重新读配置——但已经存在的会话也生效，
不用 `/new`。

**想改它怎么干活（回复多短、怎么分条、什么时候说话）**
这些写在 agent preset「QQ 管家」里，也就是 `cordis.patch.yml` 的那个 `prefix`。
设置页管不到它；改完要重启 DSH，再 `/new` 建新会话才生效（preset 是建会话时锁定的）。

**合并转发里看不到机器人自己说的话**
NapCat 的硬限制：登录账号自己发出的消息节点在合并转发里整个消失，发生在插件拿到数据之前，补不回来。用引用回复，或者直接粘文本。

## 卸载

```powershell
dsh plugin --profile <你的 profile 名> remove dsh-plugin-qq
```

再把 `dsh.profile.bundles` 里的包名删掉。

配置文件 `%USERPROFILE%\.dsh\dsh-plugin-qq.json` 不会被自动删除——想彻底清干净就手动删。

## 开发

```powershell
git clone <仓库地址>
cd dsh-plugin-qq
npm test
```

测试共 119 条断言，全部用临时目录造假数据，不碰真实 NapCat，换台机器跑也稳定：

```
test/mock-render.mjs    51   模拟宿主渲染设置页 + 纯函数单测
test/napcat-config.mjs  23   读取 NapCat 配置、挑候选
test/delivery.mjs       20   一段话该怎么送到 QQ（管家 / 遥控 × 有无工具调用 × 收尾）
test/napcat-detect.mjs  13   进程链反查、启动脚本挑选、命令注入防护
test/quote.mjs          12   引用消息拍平
```

### 目录结构

```
lib/index.js          插件主体：连接、会话、工具、提示词、事件回流
lib/delivery.js       「这段话该怎么送到 QQ」的纯决策（管家丢过程、遥控全转）
lib/settings-api.js   设置页的 HTTP 接口
lib/config.js         配置默认值与读写
lib/onebot.js         OneBot WebSocket 客户端
lib/rpc.js            DSH 内部 RPC
lib/md-to-plain.js    Markdown → 纯文本（QQ 不渲染 Markdown）
lib/napcat-config.js  读 NapCat 的 config/*.json
lib/napcat-detect.js  从端口反查 NapCat 装在哪
lib/quote.js          引用消息拍平
client/client.js      设置页（手写，无构建步骤）
```

### 为什么客户端没有构建步骤

DSH 的客户端插件是 `window.__ModuleLoader__.load({...})` 形式，`react` 和 UI 组件库从宿主的模块表里 `require`，不需要打包。所以 `client/client.js` 是直接能跑的原文件。

## 许可

MIT。**不包含也不分发 NapCat。**

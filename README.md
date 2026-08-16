# dsh-desktop-pet · 鲸鱼娘桌面宠物

![npm](https://img.shields.io/npm/v/@asahimoon/dsh-desktop-pet)
![license](https://img.shields.io/npm/l/@asahimoon/dsh-desktop-pet)
![build](https://img.shields.io/github/actions/workflow/status/AsahiMoon/dsh-desktop-pet/build.yml?branch=main)

一个住在桌面上的 **DSH 联动桌面宠物**：透明、置顶、无边框的 Electron 小窗，鲸鱼娘住在
桌面上陪你干活。它既是 **DSH（DeepSeek Harness）bundle 插件**（`dsh plugin` 一条命令
安装，Agent 状态实时驱动宠物反应），也能 **独立打包成 exe** 当普通桌宠用。

参考 [vlln/whale-girl](https://github.com/vlln/whale-girl)（网页版鲸鱼娘桌宠插件）制作，
角色素材与动画表来自该 MIT 项目（详见 [NOTICE.md](NOTICE.md)）。

![截图](docs/screenshot.png)

## ✨ 特性

- 🐋 **透明置顶桌宠**：不进任务栏、可拖拽、记住位置，坐下就来，起身就走
- 🔗 **DSH 状态联动**：任务完成 🎉 庆祝 → 💤 睡一小会儿 → 自动醒来；新任务立即起床工作；
  思考/等待/出错都有专属动画（详见下方联动表）
- 🎨 **多角色 / 多格式兼容**：内置鲸鱼娘，支持 Codex/petdex 生态（boba、aemeath 等），
  角色文件夹即插即用，全部接入同一套状态机
- ⚙️ **热配置**：尺寸/透明度/角色/游走/睡眠间隔即时生效（DSH 设置 UI 或 config.json）
- 🖱️ **原生交互**：左键拖拽、右键功能菜单（喂食/玩耍/庆祝/设置/穿透/退出）、点击有反应
- 🧊 **鼠标穿透 / 📌 桌面置底**：摸鱼时把宠物"关掉"也不碍事
- 🎮 **成长账本**：投喂/玩耍/陪伴时长 → XP → 等级 → 称号（零负反馈）
- 🚀 **两种分发形态**：npm 插件（DSH 联动） / 单文件 exe（独立桌宠）

## 📦 安装

### 形态一：DSH 插件（带 Agent 状态联动）

```sh
# 从 npm 安装（发布后）
dsh plugin --profile web add @asahimoon/dsh-desktop-pet

# 或本地路径安装（开发中）
dsh plugin --profile web add <本包路径>
```

安装后**重启 `dsh web`**：插件随 profile 加载，自动在桌面启动宠物窗口并开始监听 Agent
状态。卸载：`dsh plugin --profile web remove @asahimoon/dsh-desktop-pet`。

> **宠物窗口怎么启动**：插件优先用本机可解析到的 electron（开发环境 / 本地安装自带），
> 找不到时会自动复用已安装的独立版 exe（`%LOCALAPPDATA%\Programs\` 等位置）。
> 两者都没有时，插件只发信号、不启动窗口——可先按「形态二」装好独立版 exe，Agent 联动
> 照常工作。宠物意外崩溃（非主动退出）会自动重启，最多重试 5 次。

### 形态二：独立 exe

```sh
npm run dist            # Windows：dist/ 下安装器（nsis）与便携版（portable）
npm run dist:portable   # 只要便携版单文件 exe
npm run dist:mac        # macOS：dmg + zip
npm run dist:linux      # Linux：AppImage
```

双击即用。exe 版的 Agent 联动需要插件形态（Node half 在 DSH 进程内），其余本地行为
（打盹/游走/喂食/玩耍/成长）完整可用。

> 也可以从 GitHub Releases（CI 三平台自动构建产物）直接下载安装包。

### 跨平台

- **Windows**：原生优化——任务栏隐藏（WS_EX_TOOLWINDOW）、桌面置底（SetWindowPos）
  走 Win32；DPI 漂移处理针对透明窗口做了专门适配
- **macOS / Linux**：自动降级为 Electron 原生能力（`skipTaskbar` / `setAlwaysOnTop(false)`），
  无需额外配置即可运行
- 右键菜单坐标语义已按 Electron v33 三平台源码逐一验证（Windows/Linux 的
  `MenuViews::PopupAt`、macOS 的 `MenuMac::PopupAt`），均以窗口相对坐标传入，
  多屏/多 DPI 下位置一致
- 图标三平台齐备（ico / icns / png 图标集），由 `scripts/make-icon.cjs` 从鲸鱼娘
  素材自动生成

## 🔗 DSH 状态联动

| DSH 事件 | 宠物表现 |
|---|---|
| 工具调用中 | 🛠️ `working` 工作动画 + 气泡显示工具名 |
| 回合完成（`session/event` turn/end） | 🎉 `celebrate` 欢呼 → 💤 睡 25 秒 → 自动恢复待机 |
| 新任务到来（exec 心跳） | 立刻醒来进入工作 |
| 任务失败 / LLM 请求出错 | 😱 `error` 惊吓 → `disappointed` 失落 |
| 思考中（turn/start） | 💭 `think` 沉思漂浮 |
| 等待批准 / 阻塞 | 🕐 `wait` 期待扭动 |
| 新会话（`agent/session-start`） | 👋 `welcome` 挥手欢迎 |
| 心跳同步（5s） | 状态对齐，重启后也能跟上 |

**📋 任务进度黑框**：宠物下方一个宽扁的黑色信息框（类似原版 whale-girl 的消息框，
窗口右侧留了透明加宽区给文字空间）。两种形态：

- **悬停**：简略一瞥 —— `[23:30] 🛠️ 执行中 pwsh` + `📋 2/3 · 验收`
- **常驻**（右键菜单「📋 常驻任务进度」或设置勾选）：
  - 简略：与悬停同款
  - 详细（右键「📋 详细进度」或设置勾选）：当前工具 + **具体在做什么**
    （`📎 F:\AI_workspace\src\main.js` —— 正在读/写的文件路径、grep 的目录、
    pwsh 的命令等，取自工具调用参数）+ 已完成步骤（`📋 2/3 正在验收 ✅调研 ✅编码`），
    空闲时显示实际执行过的工具（`🛠️ 已执行：pwsh · read_file`）

`[HH:MM]` 时间戳与原版 whale-girl 记忆条目的格式一致，每 5 秒刷新；Agent 工作时
黑框优先于气泡显示。

信号经 `127.0.0.1:43991` 本地 HTTP POST 推送（仅本机回环，无网络暴露）。

## 💬 桌宠对话（不用打开网页）

桌宠窗口右键菜单或托盘菜单点「💬 对话」，会打开一个独立的聊天窗口：在输入框
里打字、Enter 发送，Agent 的回复会**实时流式**显示在窗口中——日常问答、简单任务
都不用切到浏览器。

- **单一端口**：整个插件只用 **`127.0.0.1:43991`**（桌宠窗口持有）。插件 Node half
  不监听任何端口——它向 `/signal` 推送状态与聊天信号，并**长轮询 `/poll`** 取走聊天
  窗口排队的用户输入，双向都走这一个端口
- **目标会话**：优先对话**最近活跃**的 Agent；没有活跃 Agent 时自动恢复**最近一次
  持久化会话**，因此全新启动、未打开网页也能直接对话
- **并行**：对话会唤醒该会话的 Agent 驱动回合，与网页 GUI 的会话是同一个，两边
  都能看到进展

## ⚙️ 配置

插件形态：配置注册进 DSH 设置（`dsh-desktop-pet:` 区段），改动即时热生效。

```yaml
dsh-desktop-pet:
  size: 110              # 窗口尺寸 px（64–256）
  opacity: 1             # 透明度（0.2–1）
  character: whale-girl  # 角色 id
  walk:
    enabled: true        # 游走开关
    intervalMs: 300000   # 游走间隔（ms）
    durationMs: 26000    # 单次游走时长（ms）
  sleepAfterMs: 60000    # 空闲多久打盹（ms）
  taskBarPersistent: false  # 任务进度黑框常驻显示
  taskBarDetailed: false    # 常驻时显示详细进度（已完成步骤 / 已执行工具）
  hideWhenIdle: false       # 长时间空闲入睡后隐藏宠物窗口（有活动自动出现）
```

exe 独立版直接编辑 `%APPDATA%/dsh-desktop-pet/config.json`，保存即热生效。

## 🎭 多角色 / 多格式兼容

宠物在 **两个角色目录** 中自动发现角色：

1. `%APPDATA%/dsh-desktop-pet/characters/<id>/` —— **统一管理目录**（运行时写入）：
   内置角色（鲸鱼娘）会在**首次启动时自动复制进来**，与 petdex 导入、手动放入的角色
   放在一起，打开文件夹就能看到、能改、能删
2. `assets/characters/<id>/` —— 随包内置（只读，用户目录里没有时才作为兜底）

> 内置角色是**复制即管理**：想改鲸鱼娘的素材，直接编辑
> `characters/whale-girl/` 里的文件即可（用户目录优先）。删掉文件夹会在下次启动时
> 还原（相当于"恢复默认"）；想彻底移除，在 `.ignore` 里写一行 `whale-girl`。

添加角色的方式：

```sh
npx petdex install <宠物名>        # ① petdex 生态：启动时自动导入
# 或 ② 把任意 codex/native 角色文件夹放进 %APPDATA%/dsh-desktop-pet/characters/
```

支持格式（全部接入同一套状态机 + DSH 联动，缺失状态自动用 idle 兜底，不会白屏）：

| 格式 | 识别文件 | 说明 |
|---|---|---|
| native | `manifest.json` + 各状态 PNG 条 | 本项目原生格式（whale-girl） |
| codex | `pet.json` + spritesheet | Codex / petdex 生态，支持自定义 `animations` 与官方默认表，状态自动映射 |

其他说明：

- 角色名读取自 manifest / pet.json；设置面板角色下拉会标注来源（`· Codex`）
- 不想自动导入/还原的角色：在 `characters/.ignore` 里每行写一个 id
- 删除角色：删掉 `characters/<id>/` 文件夹（内置角色会随下次启动还原，除非写进 `.ignore`）
- 角色素材版权归原作者，随包分发请自行确认许可（本项目内置 whale-girl 为 MIT）

## 🖱️ 交互

| 操作 | 行为 |
|---|---|
| 左键按住拖动 | 移动宠物 |
| 左键单击 | 开心反应（蹦跳 + 随机台词；睡觉时点击会醒来） |
| 右键 | 功能菜单：喂食 / 玩耍 / 庆祝 / 常驻任务进度开关 / 设置 / 桌面置底 / 鼠标穿透 / 退出 |
| 托盘 | 显示/隐藏、回右下角、置底、穿透（勾选状态实时同步）、退出 |

## 🛠️ 开发

```sh
npm install        # 安装依赖（electron + electron-builder + koffi + schemastery + vitest）
npm start          # 运行宠物窗口（独立模式）
npm run dev        # 开发模式（附带 DevTools）
npm run check      # 语法检查
npm test           # 单元测试（vitest：任务信号跟踪 / 状态机 / 黑框文案）
npm run dist       # 打包 Windows exe（nsis + portable）；另有 dist:mac / dist:linux
```

### 冒烟测试（scripts/smoke/）

冒烟测试用真实 Win32 输入 + CDP 驱动打包后的 exe，验证菜单定位 / 穿透 / 拖动 / 待机动画 /
DSH 打盹联动。需要先用 `--remote-debugging-port=9222` 启动打包产物：

```sh
npm run dist
"dist/DSH Desktop Pet 0.2.0.exe" --remote-debugging-port=9222
npm run smoke:menu     # 右键菜单位置
npm run smoke:pierce   # 穿透开关 + 拖动
npm run smoke:idle     # 待机动画 + 点击反应
npm run smoke:drag     # 拖动位移
npm run smoke:nap      # 任务完成 → 打盹 → 恢复（后台运行，避免 exec 心跳干扰）
```

## 🚀 发布到 GitHub 与 npm

### GitHub

```sh
git init
git add .
git commit -m "feat: dsh desktop pet"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-desktop-pet.git
git push -u origin main
git tag v0.2.0 && git push origin v0.2.0   # 触发 CI 构建 exe 产物（Actions → Artifacts）
```

CI（`.github/workflows/build.yml`）会在 main 分支与 `v*` tag 上自动跑单测 + 语法检查，
并在 **Windows / macOS / Linux 三平台**打包各自产物上传。

### npm

```sh
npm login
npm publish          # 发布前先改好 package.json 里的 author / repository 字段
```

发布后：

```sh
dsh plugin --profile web add @asahimoon/dsh-desktop-pet
```

> 发布前检查：`npm pack --dry-run` 可预览将要发布的内容（`files` 白名单已配置，
> node_modules / dist / 冒烟脚本不会进包）。

## 📁 项目结构

```
index.mjs          # DSH bundle Node half：Agent 事件 → HTTP 信号 → 启动宠物窗口
config.mjs         # 配置 schema（schemastery）+ 默认值（唯一权威）
main.js            # Electron 主进程：窗口/托盘/穿透/持久化/信号服务/角色扫描/热配置
preload.js         # 安全桥（contextIsolation）
renderer/          # 帧播放器 + 状态机 + 交互 + DSH 信号处理 + 角色适配
assets/characters/ # 内置角色（whale-girl，MIT）
scripts/smoke/     # 冒烟测试（真实输入 + CDP，见「开发」）
cordis.patch.yml   # bundle patch：挂载 Node half 行
docs/              # 文档截图
```

## 📄 许可与致谢

- 本项目 MIT（[LICENSE](LICENSE)）
- 鲸鱼娘角色 sprite 与动画表来自 [vlln/whale-girl](https://github.com/vlln/whale-girl)
  （MIT，角色形象 ZipZipPipe），详见 [NOTICE.md](NOTICE.md)
- 运行时使用 Electron（MIT）
- 其他角色素材版权归各自作者，请自行确认许可

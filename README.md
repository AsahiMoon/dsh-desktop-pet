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

### 形态二：独立 exe

```sh
npm run dist            # 生成 dist/ 下安装器（nsis）与便携版（portable）
npm run dist:portable   # 只要便携版单文件 exe
```

双击即用。exe 版的 Agent 联动需要插件形态（Node half 在 DSH 进程内），其余本地行为
（打盹/游走/喂食/玩耍/成长）完整可用。

> 也可以从 GitHub Releases（CI 自动构建产物）直接下载 exe。

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
  - 详细（右键「📋 详细进度」或设置勾选）：当前工具 + 进度 + 已完成步骤
    （`📋 2/3 正在验收 ✅调研 ✅编码`），空闲时显示实际执行过的工具
    （`🛠️ 已执行：pwsh · read_file`）

`[HH:MM]` 时间戳与原版 whale-girl 记忆条目的格式一致，每 5 秒刷新；Agent 工作时
黑框优先于气泡显示。

信号经 `127.0.0.1:43991` 本地 HTTP POST 推送（仅本机回环，无网络暴露）。

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

1. `assets/characters/<id>/` —— 随包内置（只读）
2. `%APPDATA%/dsh-desktop-pet/characters/<id>/` —— **运行时写入**，兼容一切新模型

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
- 不想自动导入的角色：在 `characters/.ignore` 里每行写一个 id
- 删除角色：删掉 `characters/<id>/` 文件夹
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
npm run dist       # 打包 exe（nsis + portable）
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

CI（`.github/workflows/build.yml`）会在 main 分支与 `v*` tag 上自动跑 `npm run dist`
并上传 exe 产物。

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

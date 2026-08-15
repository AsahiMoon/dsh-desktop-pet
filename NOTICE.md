NOTICE

dsh-desktop-pet 使用并复用了以下第三方作品：

- 宠物 sprite 素材（assets/characters/whale-girl/*.png）与动画表
  （assets/characters/whale-girl/manifest.json）来自
  https://github.com/vlln/whale-girl —— 该插件以 MIT License 发布。
  - 角色形象（鲸鱼娘 / whale-girl）由 ZipZipPipe 绘制。
  - whale-girl 项目 LICENSE 全文随素材保留于其原仓库。
- 桌面运行时使用 Electron（MIT License, https://electronjs.org）。
- Codex 宠物格式（pet.json + spritesheet）为本项目实现的格式适配器，不包含
  第三方代码；通过该适配器加载的角色（如 petdex 安装的宠物）版权归各自作者，
  分发时请自行确认许可。运行时新增的角色存放在用户目录
  `%APPDATA%/dsh-desktop-pet/characters/`，不属于本包内容。

本项目的其余代码（index.mjs / config.mjs / main.js / preload.js / renderer/*）
为原创，MIT License。

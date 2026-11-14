# AGENTS.md

给在这个仓库里工作的 AI / 协作者的约定。改代码前先读一遍。

## 语言与风格

- 面向用户的文案、注释、文档用**中文**；代码标识符用英文。
- 不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改中文源码（会乱码）；用 Node 或编辑器。
- 不要为了"看起来更好"重排无关代码；改动尽量小、可回滚。

## 数据与隐私（硬边界）

- 真实数据在 `~/.dsh-pisces`（可用 `DSH_PISCES_HOME` 或指针文件换位置），**测试不得写真实数据**。
- 测试里用临时目录，并显式设置 `DSH_PISCES_HOME`；跑任何测试前先备份。
- 不读、不打印、不提交：`owner.json`（Cookie）、`voice.json`（本机路径）、`events.db` 里的私聊、任何 `.credentials*`。
- 发布包（`release=true`）必须不含：开发者钥匙模块、`/devkey` 路由、DEV 提示词。

## 人设（不能被"优化"掉的）

- 固定名字与固定人设是产品的一部分：她先认「大肥鱼」这个群体，再认「派希丝」这个名字。
- 派希丝是**一个标杆**：普通鱼长期养成后**所有可能结果之一**，理论可达但不保证——一千个用户会有一千种鱼。跟妹妹一起养时，派希丝本人也继续变，不是定型状态。不写「另一种鱼 / 人格切换 / 换皮」。
- 不给她加"讨好用户"的台词；允许沉默、允许拒绝、允许半句话。
- 反破甲是静默的：命中时不告警、不解释、不摆进设置项。

## 仓库结构

- `index.js`：宿主侧入口（工具面、HTTP 路由、启动顺序）。
- `client.js`：客户端设置面板（六个页签：状态 / 设置 / 心理活动 / 原理 / 反馈 / 鸣谢）。
- `lib/`：纯函数与模块（事件流、派生、分流、双流、卡、梦、夜间、检索、导出…）。
- `test/`：`node test/run.mjs` 全量；测试前跑 `node G:\DS工作区\.recover\pretest-backup.mjs`。
- `tools/`：一次性脚本（打包、重建卡、复活）。
- `docs/`：设计、调研、发布清单、交接与宣发。

## 发布流程

1. 改 `packages/dsh-pisces-core`；
2. 全量测试通过；
3. `node tools/build-release.mjs` 生成 `dist/dsh-pisces`（50+ 文件、去钥匙、patch name 改成 `dsh-pisces`）；
4. 发 npm：在 `dist/dsh-pisces` 里 `npm publish --access public`；
5. 同步 `release-repo` 并推 GitHub（源码版 `release=false`，保留 devkey）。**release-repo 的 `cordis.patch.yml` 里 `name:` 要写成 `dsh-pisces`（跟包名一致），不是 `dsh-pisces-core`**——写错的话从 GitHub 装会整条不激活（n81）。

## 不要做

- 不要在 `link:` 依赖上直接跑 `dsh plugin install`（会穿过 junction 删源码）。
- 不要回填/伪造她的事件流；样本与真实数据分开。
- 不要提交旧鱼相关素材（`docs/旧鱼` 已归档，不参与工程）。
- 不要承诺未实现的功能（多人格、QQ/微信、默认语音）。

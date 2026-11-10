# 第三方来源与致谢

本文件从 `LICENSE` 中拆出。`LICENSE` 保持标准 MIT 全文，便于 GitHub 正确识别协议；
项目来源、思想引用与素材授权说明放在这里。

## 代码来源

本仓库**不含上游代码派生**：`lib/` 下全部实现（事件流、派生、分流、双流、人设卡八道闸、夜间流水线、
渐进揭开、好感推导、新手引导等）均在本项目中新写，插件没有任何运行时依赖。

## 思想引用

以下项目影响了本项目的设计，但**没有复制它们的代码或文本**，实现均为重新编写：

- **dsh-fish**（@ssamurias/dsh-fish，MIT）—— 事件流 + 纯函数派生 + 设置面板形态。
- **dsh-fish-memory** —— 记忆鲜活度与半衰期、中文双字组检索。
- **Character Card V2** —— 导出时兼容 CCv2 卡片格式。
- **dsh-companion** —— 好感分档与关系产品化的样本。
- **Generative Agents**（2023）—— memory stream + 定期 reflection 的启发。
- **DeepSeek Harness** —— 宿主、插件体系、slots / systemPrompt / tools 接口。
- **双鱼座性格的公开资料**（经 Exa 检索整理）—— 派希丝的性格起点。
- **所有养过鱼的人** —— 社区里"把 AI 当室友养"的尝试。

## 样本与素材

- `assets/adult-fish.soul.json`：本项目自造的成年鱼样本（96 条），随本仓库以同一许可（MIT）授权。
- `assets/qq-group.png`：交流群二维码，由作者提供，仅用于反馈页。
- 除此之外不含第三方美术资源；语音不捆绑任何 TTS，如需发声由用户自行配置（例如 edge-tts）。

## 语音

插件本身不包含、也不分发任何语音模型或声线；`voice.json` 由用户自行填写命令适配器。
文档里提到的 edge-tts / Xiaoxiao 只是示例配置，不是依赖。

---
name: openai-compatible-api
description: >-
  OpenAI 兼容接口（Node.js 官方 openai SDK）与多模态文档/附件智能分类重命名指导规范。
  涵盖 DeepSeek (https://api.deepseek.com, deepseek-flash / deepseek-v4-pro / deepseek-chat)、
  硅基流动 SiliconFlow、阿里云通义千问 DashScope、火山引擎豆包 Ark、OpenAI 官方及本地 Ollama 的
  baseURL 规范化、JSON Mode 结构化输出、多模态 Vision 图像识别与上传文件自动提取重命名流程。
---

# OpenAI 兼容接口与智能文件重命名指导规范 (QuickMemo)

本技能指导 `quick-memo` 项目中所有与 LLM 交互、OpenAI SDK 调用、多平台 `baseURL` 兼容以及上传文件自动重命名的实现。

## 1. 必须使用官方 `openai` Node.js SDK 并规范化 `baseURL`

各大模型厂商（DeepSeek、通义千问、硅基流动、火山方舟、Ollama）均提供与 OpenAI 兼容的接口，但不同厂商文档给出的 `base_url` 格式存在差异：

| 平台 | 官方文档推荐 `base_url` | 常用模型 (`model`) | API Key 格式特征 |
| --- | --- | --- | --- |
| **DeepSeek** | `https://api.deepseek.com` 或 `https://api.deepseek.com/v1` | `deepseek-flash` (DeepSeek-V4.1-Flash-1017)、`deepseek-v4-pro`、`deepseek-chat` | `sk-...` |
| **硅基流动 SiliconFlow** | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct`、`deepseek-ai/DeepSeek-V3` | `sk-...` |
| **阿里云·通义千问** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`、`qwen-max`、`qwen-vl-max` | `sk-...` |
| **火山引擎·豆包 Ark** | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-1-5-pro-32k-250115` 或接入点 `ep-...` | UUID (`xxxxxxxx-xxxx-...`) |
| **OpenAI 官方/中转** | `https://api.openai.com/v1` | `gpt-4o-mini`、`gpt-4o` | `sk-...` |
| **本地 Ollama** | `http://localhost:11434/v1` | `qwen2.5:7b`、`llama3.2` | 任意非空字符串（如 `'ollama'`） |

### `baseURL` 兼容处理规则
初始化 `new OpenAI({ baseURL, apiKey })` 时：
1. 若用户输入了完整的 `/chat/completions` 后缀，自动剥离末尾的 `/chat/completions`，交由 OpenAI SDK 统一拼接。
2. 若用户输入 `https://api.deepseek.com`（不带 `/v1`），DeepSeek 原生支持 `https://api.deepseek.com/chat/completions`；对于要求必须带 `/v1` 的第三方 OpenAI 中转站，若不带 `/v1` 请求返回 404，自动补齐 `/v1` 重试一次。
3. **UUID Key 智能识别**：若用户的 `apiKey` 为标准 UUID 格式（`^[0-9a-f]{8}-[0-9a-f]{4}-...`）且 `baseURL` 误填为 `api.deepseek.com` 返回 401，在错误提示中明确告知该 Key 为 UUID 格式（常见于火山引擎豆包 Ark 或 Key ID），引导用户切换正确的平台或填入 `sk-` 开头的 Key。

---

## 2. 结构化输出与 JSON 解析规范

1. 调用 `client.chat.completions.create` 时，优先尝试携带 `response_format: { type: 'json_object' }`（并在 System Prompt 中包含 `"JSON"` 字样，这是 OpenAI 与 DeepSeek JSON Mode 的强制要求）。
2. 若部分老旧或本地开源模型不支持 `response_format: { type: 'json_object' }` 抛出 400 错误，自动回退为不带 `response_format` 的普通请求，并通过正则提取首尾 `{...}` JSON 块。

---

## 3. 上传文件「即传即改名」双阶段工作流

用户将文件（如 `3D_138074619579219233.1eadc9e2f46f2f5.pdf`、`mmexport172977.png`）拖入或添加到输入框时，**不能只把原乱码文件名传给 LLM，也不能等到保存后才让用户去手动改名**：

1. **阶段一：文件拖入/选择瞬间（`/api/files/smart-rename`）**：
   - 前端在 `addFilesToDraft` 读取文件 Base64 后，立即将文件发送至后端 `/api/files/smart-rename`；
   - 后端先通过 `file-extractor.js` 提取文档内部前 3 页真实文本与首行大标题（支持 `.pdf`、`.docx`、`.txt`、`.md`、代码文件等）；
   - 再调用 OpenAI SDK（若为图片且模型支持多模态 Vision 如 `deepseek-flash` / `gpt-4o-mini`，则传入 `image_url`）生成清晰、可搜索的中文文件名（保留原扩展名）；
   - 若 LLM 未配置或鉴权失败，立即使用从文档内部提取出的真实标题自动重命名文件；
   - 前端附件卡片实时更新为重命名后的新文件名，并展示 `✨ 已根据内容自动重命名` 徽章。
2. **阶段二：点击归档保存时（`/api/memos/quick-save`）**：
   - 将文件内容、重命名后的附件名与用户补充备注一并交给分类器，生成最终分类文件夹、标题、摘要、标签，并以新文件名写入 `vault/<分类>/assets/`。

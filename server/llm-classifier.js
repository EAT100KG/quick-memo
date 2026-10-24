import path from 'node:path';
import { getConfig, sanitizeFileName } from './vault-manager.js';
import { extractFileContent, isMeaninglessFileName } from './file-extractor.js';

/**
 * 预处理附件：提取 PDF/Word/文本文件的内部正文和标题，供 AI 与本地规则引擎阅读和自动重命名
 */
export function enrichAttachmentsWithContent(attachments = []) {
  return attachments.map((att) => {
    if (att.extractedText !== undefined) {
      return att;
    }
    const { extractedText, detectedTitle } = extractFileContent(att);
    return {
      ...att,
      extractedText,
      detectedTitle
    };
  });
}

/**
 * 根据原文件名与新文件名生成带正确扩展名的安全文件名
 */
export function normalizeRenamedFile(originalName = '', suggestedName = '') {
  const origExt = path.extname(originalName || '');
  let clean = sanitizeFileName(String(suggestedName || '').trim());
  if (!clean) return originalName;
  if (origExt && !clean.toLowerCase().endsWith(origExt.toLowerCase())) {
    // 去掉可能多余的其他后缀再补原后缀
    clean = clean.replace(/\.[a-z0-9]{1,5}$/i, '') + origExt;
  }
  return clean;
}

/**
 * 本地启发式规则分类与文件自动重命名（当未配置 API Key 或接口异常时兜底，同样会读取 PDF/文档内部标题自动重命名！）
 */
export function heuristicClassify({ content = '', attachments = [], categories = [] }) {
  const enriched = enrichAttachmentsWithContent(attachments);
  const userText = String(content || '').trim();
  const extractedTexts = enriched.map((a) => a.extractedText || '').filter(Boolean).join('\n');
  const combinedText = [userText, extractedTexts].filter(Boolean).join('\n');

  const hasImage = enriched.some((a) => (a.mimeType || '').startsWith('image/'));
  const hasDoc = enriched.some((a) => !(a.mimeType || '').startsWith('image/'));

  const validCatIds = new Set(categories.map((c) => c.id));
  const pickCat = (preferred, fallback = '99-收件箱') =>
    validCatIds.has(preferred) ? preferred : (categories[0]?.id || fallback);

  let category = pickCat('01-灵感与备忘');
  const tags = new Set();

  if (hasDoc) {
    category = pickCat('06-资料与文档');
    tags.add('文档归档');
    for (const att of enriched) {
      const ext = (att.name || '').split('.').pop()?.toUpperCase();
      if (ext && ext.length <= 6) tags.add(ext);
    }
  } else if (hasImage && userText.length < 30) {
    category = pickCat('05-截图与视觉');
    tags.add('截图');
  }

  const urlMatch = userText.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch) {
    category = pickCat('03-精读与链接');
    tags.add('网页链接');
    try {
      const u = new URL(urlMatch[0]);
      const host = u.hostname.replace(/^www\./, '');
      tags.add(host);
      if (host.includes('github.com')) tags.add('GitHub');
    } catch {}
  }

  const codeIndicators = /```|function\s+\w+|const\s+\w+\s*=|import\s+.*from|def\s+\w+\(|SELECT\s+.*FROM|npm\s+install|git\s+(clone|commit|push)|docker\s+(run|build)|pip\s+install/i;
  if (codeIndicators.test(combinedText)) {
    if (!hasDoc) category = pickCat('02-技术与代码');
    tags.add('代码/技术');
  }

  if (/提示词|Prompt|Claude|GPT|大模型|Agent/i.test(combinedText)) {
    tags.add('提示词');
  }
  if (/Blender|3D|渲染|动画|FFmpeg/i.test(combinedText)) {
    tags.add('3D与视频');
  }

  const todoIndicators = /待办|TODO|截止|会议|周报|合同|发票|报销|客户|排期|明天|下周|记得/i;
  if (todoIndicators.test(combinedText)) {
    if (!hasDoc) category = pickCat('04-工作与待办');
    tags.add('待办事项');
  }

  // 自动为每个附件生成有意义的新文件名
  const renamedFiles = enriched.map((att, idx) => {
    const origName = att.name || `附件_${idx + 1}`;
    if (att.detectedTitle) {
      return normalizeRenamedFile(origName, att.detectedTitle);
    }
    if (userText && isMeaninglessFileName(origName)) {
      const firstLine = userText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      if (firstLine) {
        return normalizeRenamedFile(origName, firstLine.slice(0, 28));
      }
    }
    return origName;
  });

  // 生成简明标题
  let title = '';
  const firstDetectedDocTitle = enriched.map((a) => a.detectedTitle).find(Boolean);
  if (userText) {
    const firstLine = userText
      .split(/\r?\n/)
      .map((l) => l.replace(/^[#>*-\s]+/, '').trim())
      .find((l) => l.length > 0) || '';

    if (/^https?:\/\/\S+$/i.test(firstLine)) {
      try {
        const u = new URL(firstLine);
        const pathSeg = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '').split('/').slice(-2).join('/');
        title = pathSeg ? `链接：${u.hostname}/${pathSeg}` : `网页收藏：${u.hostname}`;
      } catch {
        title = '网页链接收藏';
      }
    } else {
      title = firstLine.slice(0, 32);
    }
  } else if (firstDetectedDocTitle) {
    title = firstDetectedDocTitle;
  } else if (renamedFiles.length > 0) {
    const firstName = path.basename(renamedFiles[0], path.extname(renamedFiles[0]));
    title = hasImage ? `图片：${firstName}` : `文档：${firstName}`;
  } else {
    title = '随手记录';
  }

  // 生成摘要
  let summary = '';
  if (extractedTexts) {
    const cleanDoc = extractedTexts.replace(/\s+/g, ' ').trim();
    summary = cleanDoc.slice(0, 110) + (cleanDoc.length > 110 ? '...' : '');
  } else if (userText.length > 35) {
    summary = userText.replace(/\s+/g, ' ').slice(0, 95) + (userText.length > 95 ? '...' : '');
  } else if (renamedFiles.length > 0) {
    summary = `归档附件：${renamedFiles.join('、')}${userText ? ` · 备注：${userText}` : ''}`;
  } else {
    summary = userText || '快速记录条目';
  }

  if (tags.size === 0) tags.add('随手记');

  return {
    category,
    title,
    summary,
    tags: Array.from(tags).slice(0, 5),
    renamedFiles,
    extractedPreview: extractedTexts.slice(0, 600),
    aiClassified: false
  };
}

/**
 * 构建兼容各种 OpenAI 格式填法的候选请求地址
 * 无论用户填 https://api.deepseek.com 还是 https://api.deepseek.com/v1 还是完整 /chat/completions 都能兼容
 */
export function buildOpenAIChatEndpoints(baseUrl = '') {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return [];
  if (clean.endsWith('/chat/completions')) {
    return [clean];
  }
  if (/\/v\d+(?:\/[a-z0-9_-]+)?$/i.test(clean)) {
    return [`${clean}/chat/completions`];
  }
  // 如果没有带 /v1，优先尝试 /v1/chat/completions，同时把 /chat/completions 作为备选
  return [`${clean}/v1/chat/completions`, `${clean}/chat/completions`];
}

async function callOpenAICompatibleChat({ baseUrl, apiKey, model, messages, timeoutMs = 22000 }) {
  const endpoints = buildOpenAIChatEndpoints(baseUrl);
  if (endpoints.length === 0) {
    throw new Error('未配置 API Base URL');
  }

  let lastError = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'deepseek-flash',
          temperature: 0.2,
          messages
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        // 如果是 404 且还有备选 endpoint，继续尝试下一个
        if (response.status === 404 && endpoints.indexOf(endpoint) < endpoints.length - 1) {
          lastError = new Error(`HTTP 404 (${endpoint})`);
          continue;
        }
        let friendlyMsg = `HTTP ${response.status}`;
        try {
          const errJson = JSON.parse(errText);
          friendlyMsg = errJson?.error?.message || errJson?.message || friendlyMsg;
        } catch {
          if (errText) friendlyMsg += `: ${errText.slice(0, 160)}`;
        }
        throw new Error(friendlyMsg);
      }

      const data = await response.json();
      return { data, endpoint };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error('请求 LLM 失败');
}

/**
 * 测试用户的 OpenAI 兼容接口连接是否正常
 */
export async function testLlmConnection(customLlmCfg = null) {
  const config = getConfig();
  const llmCfg = customLlmCfg || config.llm || {};
  const start = Date.now();
  const { data, endpoint } = await callOpenAICompatibleChat({
    baseUrl: llmCfg.baseUrl,
    apiKey: llmCfg.apiKey,
    model: llmCfg.model,
    timeoutMs: 12000,
    messages: [
      { role: 'user', content: '请只回复 OK 两个字母' }
    ]
  });
  const reply = data?.choices?.[0]?.message?.content?.trim() || 'OK';
  return {
    ok: true,
    latencyMs: Date.now() - start,
    endpoint,
    model: data?.model || llmCfg.model,
    reply
  };
}

/**
 * 调用 OpenAI 兼容接口进行语义分类、标题生成、摘要提炼、打标与附件自动重命名
 */
export async function classifyWithLLM({ content = '', attachments = [] }) {
  const config = getConfig();
  const categories = config.categories || [];
  const llmCfg = config.llm || {};

  // 先提取附件中的 PDF/文档内容
  const enriched = enrichAttachmentsWithContent(attachments);
  const fallbackResult = heuristicClassify({ content, attachments: enriched, categories });

  if (!llmCfg.enabled || (!llmCfg.apiKey && llmCfg.providerPreset !== 'ollama') || !llmCfg.baseUrl) {
    return fallbackResult;
  }

  const categoryListDesc = categories
    .map((c) => `- "${c.id}": ${c.name}（${c.desc || ''}）`)
    .join('\n');

  const attachmentDetails = enriched.length > 0
    ? enriched.map((a, idx) => {
        const docSnippet = a.extractedText
          ? `\n    提取到的文件内部文本：\n    """\n    ${a.extractedText.slice(0, 1500)}\n    """`
          : '';
        return `附件${idx + 1}: 原文件名="${a.name}" (${a.mimeType || '未知类型'})${docSnippet}`;
      }).join('\n')
    : '无附件';

  const systemPrompt = `你是一个高效的个人知识库与文件整理助手。用户像使用“微信文件传输助手”一样随手丢进来一段文字、链接、截图或文件（如 PDF、文档）。
许多上传的文件原名是乱码、数字串或无意义的名字（如 3D_138074619579.pdf、image.png）。
请你根据【正文备注】和【提取到的文件内部文本/图像】，完成以下任务：
1. 选出最匹配的分类目录 id（category）；
2. 生成清晰、好搜索的中文记录标题（title，10~28字）；
3. 提炼 30~80 字的核心内容摘要（summary）；
4. 提取 2~5 个关键词标签（tags）；
5. **自动重命名附件（renamedFiles）**：如果包含附件，请按附件顺序为每个附件起一个清晰、具体、便于搜索的中文新文件名（保留原文件扩展名，如 "3D产品宣传片提示词（通用版）.pdf"）。

可选分类目录（category 必须严格返回引号内的目录 id）：
${categoryListDesc}

${llmCfg.customSystemPrompt ? `用户补充偏好：\n${llmCfg.customSystemPrompt}\n` : ''}
请严格只输出合法的 JSON 对象，不要包含 Markdown 代码块包裹，格式如下：
{
  "category": "目录id",
  "title": "清晰的中文标题",
  "summary": "核心内容摘要",
  "tags": ["标签1", "标签2", "标签3"],
  "renamedFiles": ["附件1的新文件名.ext"]
}`;

  const userTextPrompt = `【用户输入的正文/备注】：
${content || '（用户未手写备注，请依据下方附件内容进行分析与重命名）'}

【上传的附件及内部提取内容】：
${attachmentDetails}`;

  // 检查是否包含图片附件且可以尝试 OpenAI Vision 格式
  const imageAttachments = enriched.filter((a) => (a.mimeType || '').startsWith('image/') && a.dataBase64);

  try {
    let data;
    if (imageAttachments.length > 0) {
      try {
        const visionContent = [
          { type: 'text', text: userTextPrompt },
          ...imageAttachments.slice(0, 2).map((img) => ({
            type: 'image_url',
            image_url: {
              url: img.dataBase64.startsWith('data:')
                ? img.dataBase64
                : `data:${img.mimeType || 'image/png'};base64,${img.dataBase64}`
            }
          }))
        ];
        const res = await callOpenAICompatibleChat({
          baseUrl: llmCfg.baseUrl,
          apiKey: llmCfg.apiKey,
          model: llmCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: visionContent }
          ]
        });
        data = res.data;
      } catch {
        // 如果当前模型不支持 Vision image_url，自动降级为纯文本请求
        const res = await callOpenAICompatibleChat({
          baseUrl: llmCfg.baseUrl,
          apiKey: llmCfg.apiKey,
          model: llmCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userTextPrompt }
          ]
        });
        data = res.data;
      }
    } else {
      const res = await callOpenAICompatibleChat({
        baseUrl: llmCfg.baseUrl,
        apiKey: llmCfg.apiKey,
        model: llmCfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userTextPrompt }
        ]
      });
      data = res.data;
    }

    const rawReply = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 未返回有效 JSON 结构');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validIds = new Set(categories.map((c) => c.id));
    const chosenCat = validIds.has(parsed.category) ? parsed.category : fallbackResult.category;

    const aiRenamedFiles = enriched.map((att, idx) => {
      const suggested = Array.isArray(parsed.renamedFiles) ? parsed.renamedFiles[idx] : '';
      if (suggested && String(suggested).trim()) {
        return normalizeRenamedFile(att.name, suggested);
      }
      return fallbackResult.renamedFiles[idx] || att.name;
    });

    return {
      category: chosenCat,
      title: String(parsed.title || '').trim() || fallbackResult.title,
      summary: String(parsed.summary || '').trim() || fallbackResult.summary,
      tags: Array.isArray(parsed.tags) && parsed.tags.length > 0
        ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6)
        : fallbackResult.tags,
      renamedFiles: aiRenamedFiles,
      extractedPreview: fallbackResult.extractedPreview,
      aiClassified: true
    };
  } catch (err) {
    console.warn('[LLMClassifier] Fallback to content-aware heuristic due to error:', err.message);
    return {
      ...fallbackResult,
      errorWarning: err.message
    };
  }
}

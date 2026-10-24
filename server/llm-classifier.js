import { getConfig } from './vault-manager.js';

/**
 * 本地启发式规则分类器（当未配置 API Key 或接口异常时零延迟兜底）
 */
export function heuristicClassify({ content = '', attachments = [], categories = [] }) {
  const text = String(content || '').trim();
  const hasImage = attachments.some((a) => (a.mimeType || '').startsWith('image/'));
  const hasDoc = attachments.some((a) => !(a.mimeType || '').startsWith('image/'));

  const validCatIds = new Set(categories.map((c) => c.id));
  const pickCat = (preferred, fallback = '99-收件箱') =>
    validCatIds.has(preferred) ? preferred : (categories[0]?.id || fallback);

  let category = pickCat('01-灵感与备忘');
  const tags = new Set();

  // 1. 判断是否以文件/截图为主
  if (hasDoc) {
    category = pickCat('06-资料与文档');
    tags.add('文档归档');
    for (const att of attachments) {
      const ext = (att.name || '').split('.').pop()?.toUpperCase();
      if (ext && ext.length <= 6) tags.add(ext);
    }
  } else if (hasImage && text.length < 30) {
    category = pickCat('05-截图与视觉');
    tags.add('截图');
  }

  // 2. 判断链接
  const urlMatch = text.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch) {
    category = pickCat('03-精读与链接');
    tags.add('网页链接');
    try {
      const u = new URL(urlMatch[0]);
      const host = u.hostname.replace(/^www\./, '');
      tags.add(host);
      if (host.includes('github.com')) {
        tags.add('GitHub');
      } else if (host.includes('bilibili.com') || host.includes('youtube.com')) {
        tags.add('视频');
      }
    } catch {
      // ignore invalid url
    }
  }

  // 3. 判断代码或技术内容
  const codeIndicators = /```|function\s+\w+|const\s+\w+\s*=|import\s+.*from|def\s+\w+\(|SELECT\s+.*FROM|npm\s+install|git\s+(clone|commit|push)|docker\s+(run|build)|pip\s+install/i;
  if (codeIndicators.test(text)) {
    category = pickCat('02-技术与代码');
    tags.add('代码片段');
    if (/git\s/i.test(text)) tags.add('Git');
    if (/docker/i.test(text)) tags.add('Docker');
    if (/python|pip\s/i.test(text)) tags.add('Python');
    if (/npm|node|tauri|vite/i.test(text)) tags.add('前端/Node');
  }

  // 4. 判断工作与待办
  const todoIndicators = /待办|TODO|截止|会议|周报|合同|发票|报销|客户|排期|明天|下周|记得/i;
  if (todoIndicators.test(text)) {
    category = pickCat('04-工作与待办');
    tags.add('待办事项');
  }

  // 生成简明标题
  let title = '';
  if (text) {
    const firstLine = text
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
      title = firstLine.slice(0, 28);
    }
  } else if (attachments.length > 0) {
    const firstAtt = attachments[0].name || '未命名附件';
    title = hasImage ? `图片记录：${firstAtt}` : `文件归档：${firstAtt}`;
  } else {
    title = '随手记录';
  }

  // 生成摘要
  let summary = '';
  if (text.length > 35) {
    summary = text.replace(/\s+/g, ' ').slice(0, 80) + (text.length > 80 ? '...' : '');
  } else if (attachments.length > 0) {
    summary = `包含 ${attachments.length} 个附件（${attachments.map((a) => a.name).join('、')}）${text ? `，备注：${text}` : ''}`;
  } else {
    summary = text || '快速记录条目';
  }

  if (tags.size === 0) {
    tags.add('随手记');
  }

  return {
    category,
    title,
    summary,
    tags: Array.from(tags).slice(0, 5),
    aiClassified: false,
    reason: '本地智能规则归类（配置 API Key 后可启用大模型深度语义归类）'
  };
}

/**
 * 调用 OpenAI 兼容接口进行语义分类、标题生成、摘要提炼与打标
 */
export async function classifyWithLLM({ content = '', attachments = [] }) {
  const config = getConfig();
  const categories = config.categories || [];
  const llmCfg = config.llm || {};

  if (!llmCfg.enabled || !llmCfg.apiKey || !llmCfg.baseUrl) {
    return heuristicClassify({ content, attachments, categories });
  }

  const categoryListDesc = categories
    .map((c) => `- "${c.id}": ${c.name}（${c.desc || ''}）`)
    .join('\n');

  const attachmentDesc = attachments.length > 0
    ? attachments.map((a) => `${a.name} (${a.mimeType || '未知类型'})`).join(', ')
    : '无附件';

  const systemPrompt = `你是一个高效的个人知识库与剪贴板整理助手。用户像使用“微信文件传输助手”一样随手丢进来一段文字、链接、代码或文件。
请你根据内容，将其精准归入以下分类目录之一，并生成便于日后检索的标题、一句话摘要和标签。

可选分类目录（category 必须严格返回引号内的目录 id）：
${categoryListDesc}

${llmCfg.customSystemPrompt ? `用户补充偏好：\n${llmCfg.customSystemPrompt}\n` : ''}
请严格只输出合法的 JSON 对象，不要包含 Markdown 代码块包裹，格式如下：
{
  "category": "必须是上述目录 id 之一",
  "title": "10~25字的中文清晰标题，一眼能看出这条记录是什么，不要用泛泛的‘备忘’",
  "summary": "30~70字的核心内容提炼或关键信息摘要，方便日后搜索",
  "tags": ["标签1", "标签2", "标签3"]
}`;

  const userPrompt = `【用户记录的正文/备注】：
${content || '（无正文，仅上传了附件）'}

【包含的附件列表】：
${attachmentDesc}`;

  const endpoint = `${llmCfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmCfg.apiKey}`
      },
      body: JSON.stringify({
        model: llmCfg.model || 'deepseek-chat',
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const rawReply = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM 未返回有效 JSON 结构');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const validIds = new Set(categories.map((c) => c.id));
    const chosenCat = validIds.has(parsed.category)
      ? parsed.category
      : heuristicClassify({ content, attachments, categories }).category;

    return {
      category: chosenCat,
      title: String(parsed.title || '').trim() || heuristicClassify({ content, attachments, categories }).title,
      summary: String(parsed.summary || '').trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 6) : [],
      aiClassified: true
    };
  } catch (err) {
    console.warn('[LLMClassifier] Fallback to heuristic due to error:', err.message);
    const fallback = heuristicClassify({ content, attachments, categories });
    return {
      ...fallback,
      errorWarning: err.message
    };
  }
}

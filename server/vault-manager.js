import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, '.quick-memo-config.json');
const DEFAULT_VAULT_PATH = path.join(PROJECT_ROOT, 'vault');

export const DEFAULT_CATEGORIES = [
  { id: '01-灵感与备忘', name: '灵感与备忘', icon: '💡', desc: '随手记下的想法、灵感、日常备忘、语录摘抄' },
  { id: '02-技术与代码', name: '技术与代码', icon: '💻', desc: '代码片段、命令行、报错信息、架构方案、AI Prompt' },
  { id: '03-精读与链接', name: '精读与链接', icon: '🔗', desc: '网址链接、GitHub 仓库、文章收藏、工具网站' },
  { id: '04-工作与待办', name: '工作与待办', icon: '📌', desc: '待办事项、项目推进、会议纪要、重要通知或参数' },
  { id: '05-截图与视觉', name: '截图与视觉', icon: '🖼️', desc: '屏幕截图、参考图、海报、图表、照片' },
  { id: '06-资料与文档', name: '资料与文档', icon: '📂', desc: 'PDF、Word、Excel、压缩包等本地文件归档' },
  { id: '99-收件箱', name: '收件箱', icon: '📥', desc: '暂未分类或其它杂项内容' }
];

export const DEFAULT_CONFIG = {
  vaultPath: DEFAULT_VAULT_PATH,
  shortcut: 'Alt+Space',
  alwaysOnTopInQuickMode: true,
  hideAfterSubmit: false,
  llm: {
    enabled: true,
    providerPreset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    customSystemPrompt: ''
  },
  categories: DEFAULT_CATEGORIES
};

export function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        llm: { ...DEFAULT_CONFIG.llm, ...(parsed.llm || {}) },
        categories: Array.isArray(parsed.categories) && parsed.categories.length > 0
          ? parsed.categories
          : DEFAULT_CATEGORIES
      };
    }
  } catch (err) {
    console.error('[VaultManager] Failed to read config:', err);
  }
  saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function saveConfig(newConfig) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...newConfig,
    llm: { ...DEFAULT_CONFIG.llm, ...(newConfig.llm || {}) },
    categories: Array.isArray(newConfig.categories) && newConfig.categories.length > 0
      ? newConfig.categories
      : DEFAULT_CATEGORIES
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  ensureVaultStructure(merged.vaultPath, merged.categories);
  return merged;
}

export function ensureVaultStructure(vaultPath, categories = DEFAULT_CATEGORIES) {
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
  }
  for (const cat of categories) {
    const catDir = path.join(vaultPath, sanitizeFileName(cat.id));
    if (!fs.existsSync(catDir)) {
      fs.mkdirSync(catDir, { recursive: true });
    }
  }
}

export function sanitizeFileName(name) {
  return String(name || '未命名')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}

function formatDateParts(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return {
    dateStr: `${yyyy}-${MM}-${dd}`,
    timeStr: `${HH}:${mm}:${ss}`,
    fullStr: `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`,
    compactTime: `${HH}${mm}${ss}`,
    compactFull: `${yyyy}${MM}${dd}_${HH}${mm}${ss}`
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function buildMarkdownContent(memo) {
  const tagsYaml = (memo.tags || []).map((t) => `  - "${String(t).replace(/"/g, '\\"')}"`).join('\n');
  const attachmentsYaml = (memo.attachments || []).map((a) =>
    `  - name: "${String(a.name).replace(/"/g, '\\"')}"\n    relPath: "${a.relPath}"\n    mimeType: "${a.mimeType || ''}"\n    size: ${a.size || 0}`
  ).join('\n');

  const frontmatter = [
    '---',
    `id: "${memo.id}"`,
    `title: "${String(memo.title || '').replace(/"/g, '\\"')}"`,
    `category: "${String(memo.category || '99-收件箱').replace(/"/g, '\\"')}"`,
    `type: "${memo.type || 'text'}"`,
    `created_at: "${memo.createdAt}"`,
    `ai_classified: ${Boolean(memo.aiClassified)}`,
    `summary: "${String(memo.summary || '').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`,
    memo.tags && memo.tags.length > 0 ? `tags:\n${tagsYaml}` : 'tags: []',
    memo.attachments && memo.attachments.length > 0 ? `attachments:\n${attachmentsYaml}` : 'attachments: []',
    '---'
  ].join('\n');

  const tagBadges = (memo.tags || []).map((t) => `#${t}`).join(' ');
  const metaQuote = [
    `> **分类**：\`${memo.category}\` · **时间**：${memo.createdAt}${tagBadges ? ` · **标签**：${tagBadges}` : ''}`,
    memo.summary ? `> **摘要**：${memo.summary}` : null
  ].filter(Boolean).join('\n');

  const attachmentSection = [];
  if (memo.attachments && memo.attachments.length > 0) {
    for (const att of memo.attachments) {
      if (att.mimeType && att.mimeType.startsWith('image/')) {
        attachmentSection.push(`![${att.name}](${att.relPath})`);
      } else {
        attachmentSection.push(`- 📎 [${att.name} (${formatBytes(att.size)})](${att.relPath})`);
      }
    }
  }

  const bodyParts = [
    frontmatter,
    '',
    `# ${memo.title}`,
    '',
    metaQuote,
    '',
    '---',
    ''
  ];

  if (memo.content && memo.content.trim()) {
    bodyParts.push(memo.content.trim(), '');
  }

  if (attachmentSection.length > 0) {
    bodyParts.push('## 附件与媒体', '', ...attachmentSection, '');
  }

  return bodyParts.join('\n');
}

function getIndexFilePath(vaultPath) {
  return path.join(vaultPath, '.quick-memo-index.json');
}

export function readIndex(vaultPath) {
  const indexPath = getIndexFilePath(vaultPath);
  try {
    if (fs.existsSync(indexPath)) {
      const items = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      if (Array.isArray(items)) {
        return items;
      }
    }
  } catch (err) {
    console.error('[VaultManager] Failed to read index:', err);
  }
  return [];
}

export function writeIndex(vaultPath, items) {
  const indexPath = getIndexFilePath(vaultPath);
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), 'utf-8');
}

/**
 * 保存一条记录到对应的分类文件夹下，生成 .md 和 assets 附件
 */
export function saveMemo(payload) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  ensureVaultStructure(vaultPath, config.categories);

  const now = new Date();
  const { dateStr, fullStr, compactTime, compactFull } = formatDateParts(now);
  const id = payload.id || `memo_${now.getTime()}_${Math.random().toString(36).slice(2, 6)}`;
  const category = sanitizeFileName(payload.category || '99-收件箱');
  const title = (payload.title || '随手记录').trim();
  const safeTitle = sanitizeFileName(title);

  const categoryDir = path.join(vaultPath, category);
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }

  const savedAttachments = [];
  if (Array.isArray(payload.rawAttachments) && payload.rawAttachments.length > 0) {
    const assetsDir = path.join(categoryDir, 'assets');
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    for (let i = 0; i < payload.rawAttachments.length; i++) {
      const item = payload.rawAttachments[i];
      // item: { name, mimeType, dataBase64 }
      const ext = path.extname(item.name || '') || guessExtension(item.mimeType);
      const baseName = sanitizeFileName(path.basename(item.name || `attachment_${i + 1}`, path.extname(item.name || '')));
      const fileName = `${compactFull}_${baseName}${ext}`;
      const absAssetPath = path.join(assetsDir, fileName);

      const base64Clean = String(item.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(base64Clean, 'base64');
      fs.writeFileSync(absAssetPath, buf);

      savedAttachments.push({
        name: item.name || fileName,
        relPath: `./assets/${fileName}`,
        absPath: absAssetPath,
        mimeType: item.mimeType || 'application/octet-stream',
        size: buf.length
      });
    }
  }

  const mdFileName = `${dateStr}_${compactTime}_${safeTitle}.md`;
  const mdAbsPath = path.join(categoryDir, mdFileName);

  const memoRecord = {
    id,
    title,
    category,
    type: payload.type || detectMemoType(payload.content, savedAttachments),
    content: payload.content || '',
    summary: payload.summary || '',
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    createdAt: payload.createdAt || fullStr,
    aiClassified: Boolean(payload.aiClassified),
    attachments: savedAttachments,
    mdRelPath: `${category}/${mdFileName}`,
    mdAbsPath
  };

  const mdText = buildMarkdownContent(memoRecord);
  fs.writeFileSync(mdAbsPath, mdText, 'utf-8');

  const currentIndex = readIndex(vaultPath).filter((x) => x.id !== id);
  currentIndex.unshift(memoRecord);
  writeIndex(vaultPath, currentIndex);

  return memoRecord;
}

/**
 * 更新已有记录（例如后台 AI 分类完成后，把记录从 99-收件箱 移动到目标分类目录，或用户手动改分类/标题/内容）
 */
export function updateMemo(id, patch) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const index = readIndex(vaultPath);
  const idx = index.findIndex((x) => x.id === id);
  if (idx === -1) {
    throw new Error(`找不到记录: ${id}`);
  }

  const oldMemo = index[idx];
  const newCategory = sanitizeFileName(patch.category || oldMemo.category);
  const newTitle = (patch.title !== undefined ? patch.title : oldMemo.title).trim() || oldMemo.title;
  const newContent = patch.content !== undefined ? patch.content : oldMemo.content;
  const newSummary = patch.summary !== undefined ? patch.summary : oldMemo.summary;
  const newTags = patch.tags !== undefined ? patch.tags : oldMemo.tags;
  const newAiClassified = patch.aiClassified !== undefined ? patch.aiClassified : oldMemo.aiClassified;

  const newCategoryDir = path.join(vaultPath, newCategory);
  if (!fs.existsSync(newCategoryDir)) {
    fs.mkdirSync(newCategoryDir, { recursive: true });
  }

  // 如果分类发生变化，同时移动附件到新分类的 assets 下
  const updatedAttachments = [];
  for (const att of oldMemo.attachments || []) {
    const oldAssetAbs = att.absPath || path.join(path.dirname(oldMemo.mdAbsPath), att.relPath);
    if (newCategory !== oldMemo.category && fs.existsSync(oldAssetAbs)) {
      const targetAssetsDir = path.join(newCategoryDir, 'assets');
      if (!fs.existsSync(targetAssetsDir)) {
        fs.mkdirSync(targetAssetsDir, { recursive: true });
      }
      const assetFileName = path.basename(oldAssetAbs);
      const newAssetAbs = path.join(targetAssetsDir, assetFileName);
      if (oldAssetAbs !== newAssetAbs) {
        fs.renameSync(oldAssetAbs, newAssetAbs);
      }
      updatedAttachments.push({
        ...att,
        relPath: `./assets/${assetFileName}`,
        absPath: newAssetAbs
      });
    } else {
      updatedAttachments.push(att);
    }
  }

  // 删除旧的 .md 文件
  if (oldMemo.mdAbsPath && fs.existsSync(oldMemo.mdAbsPath)) {
    try {
      fs.unlinkSync(oldMemo.mdAbsPath);
    } catch (e) {
      console.warn('[VaultManager] Could not remove old md file:', e);
    }
  }

  // 生成新的 .md 文件名（保留原日期前缀）
  const datePrefixMatch = path.basename(oldMemo.mdAbsPath || '').match(/^(\d{4}-\d{2}-\d{2}_\d{6})_/);
  const prefix = datePrefixMatch ? datePrefixMatch[1] : formatDateParts().compactFull;
  const safeTitle = sanitizeFileName(newTitle);
  const newMdFileName = `${prefix}_${safeTitle}.md`;
  const newMdAbsPath = path.join(newCategoryDir, newMdFileName);

  const updatedMemo = {
    ...oldMemo,
    title: newTitle,
    category: newCategory,
    content: newContent,
    summary: newSummary,
    tags: newTags,
    aiClassified: newAiClassified,
    attachments: updatedAttachments,
    mdRelPath: `${newCategory}/${newMdFileName}`,
    mdAbsPath: newMdAbsPath
  };

  const mdText = buildMarkdownContent(updatedMemo);
  fs.writeFileSync(newMdAbsPath, mdText, 'utf-8');

  index[idx] = updatedMemo;
  writeIndex(vaultPath, index);
  return updatedMemo;
}

export function deleteMemo(id) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const index = readIndex(vaultPath);
  const target = index.find((x) => x.id === id);
  if (!target) return { deleted: false };

  if (target.mdAbsPath && fs.existsSync(target.mdAbsPath)) {
    try {
      fs.unlinkSync(target.mdAbsPath);
    } catch (e) {
      console.warn('[VaultManager] Failed to unlink md:', e);
    }
  }
  for (const att of target.attachments || []) {
    if (att.absPath && fs.existsSync(att.absPath)) {
      try {
        fs.unlinkSync(att.absPath);
      } catch (e) {
        console.warn('[VaultManager] Failed to unlink attachment:', e);
      }
    }
  }

  const next = index.filter((x) => x.id !== id);
  writeIndex(vaultPath, next);
  return { deleted: true, id };
}

export function listMemos() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  ensureVaultStructure(vaultPath, config.categories);
  const items = readIndex(vaultPath);
  // 过滤掉在磁盘上已被外部删除的 .md 文件，并修正路径
  const validItems = [];
  let changed = false;
  for (const item of items) {
    const expectedAbs = path.join(vaultPath, item.mdRelPath || '');
    const actualAbs = (item.mdAbsPath && fs.existsSync(item.mdAbsPath))
      ? item.mdAbsPath
      : (fs.existsSync(expectedAbs) ? expectedAbs : null);
    if (actualAbs) {
      item.mdAbsPath = actualAbs;
      validItems.push(item);
    } else {
      changed = true;
    }
  }
  if (changed) {
    writeIndex(vaultPath, validItems);
  }
  return validItems;
}

export function openInExplorer(targetPath) {
  const config = getConfig();
  const abs = targetPath ? path.resolve(targetPath) : config.vaultPath;
  if (!fs.existsSync(abs)) {
    exec(`explorer.exe "${config.vaultPath}"`);
    return;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    exec(`explorer.exe "${abs}"`);
  } else {
    exec(`explorer.exe /select,"${abs}"`);
  }
}

function guessExtension(mimeType = '') {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md'
  };
  return map[mimeType] || '.bin';
}

function detectMemoType(content = '', attachments = []) {
  if (attachments.some((a) => a.mimeType && a.mimeType.startsWith('image/'))) {
    return 'image';
  }
  if (attachments.length > 0) {
    return 'file';
  }
  const trimmed = String(content || '').trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) || (trimmed.includes('http') && trimmed.split('\n').length <= 3)) {
    return 'link';
  }
  if (trimmed.includes('```') || /[{}();=>]/.test(trimmed) && trimmed.split('\n').length >= 3) {
    return 'code';
  }
  return 'text';
}

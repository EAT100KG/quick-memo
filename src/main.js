import { Bridge } from './bridge.js';

const TYPE_META = {
  all: { label: '全部类型', icon: '✦' },
  text: { label: '文字笔记', icon: '📝' },
  link: { label: '网址链接', icon: '🔗' },
  code: { label: '代码片段', icon: '💻' },
  image: { label: '截图/图片', icon: '🖼️' },
  file: { label: '文档附件', icon: '📎' }
};

const state = {
  activeTab: 'capture', // 'capture' | 'vault' | 'settings'
  config: null,
  memos: [],
  loading: false,
  saving: false,
  windowPinned: false,

  // 极速捕获框状态
  draftContent: '',
  draftManualCategory: '', // 空字符串表示由 AI 自动判断
  draftAttachments: [], // [{ id, name, mimeType, size, dataBase64 }]
  enterToSubmit: false,
  lastSavedToast: null,

  // 知识库筛选状态
  selectedCategory: 'ALL',
  selectedType: 'all',
  selectedTag: '',
  searchQuery: '',
  activeMemoId: null,
  isEditingDetail: false,
  pdfModal: null, // { title, url }
  precheckModal: null, // { duplicates: [], keyReminder: null, noteDraft: '' }

  // 聊天泡泡与全文文档索引状态
  chatOpen: false,
  chatDraft: '',
  chatLoading: false,
  rebuildingIndex: false,
  indexStats: {
    totalDocs: 0,
    totalChunks: 0,
    totalAttachmentFiles: 0,
    totalChars: 0,
    lastIndexedAt: ''
  },
  chatMessages: [], // [{ id, role: 'user'|'assistant', content, sources, aiUsed, errorWarning, time }]

  // 打包迁移与 GitHub 私有仓库同步状态
  exportingZip: false,
  lastZipExport: null,
  vaultGitStatus: null,
  gitSyncing: false,
  gitFeedback: null
};

function isPdfAttachment(att = {}) {
  return (
    (att.mimeType || '').toLowerCase() === 'application/pdf' ||
    String(att.name || '').toLowerCase().endsWith('.pdf') ||
    String(att.absPath || '').toLowerCase().endsWith('.pdf')
  );
}

function detectSecretKeyClient(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return { isKey: false, needsNote: false };

  const patterns = [
    { type: 'sk- 开头 API Key', regex: /\bsk-[a-zA-Z0-9_-]{14,}\b/ },
    { type: 'GitHub Token', regex: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{16,}\b/ },
    { type: '云厂商 AccessKey', regex: /\b(LTAI|AKIA|ASIA)[a-zA-Z0-9]{12,}\b/ },
    { type: 'AppSecret / 32位密钥', regex: /\b(cli_[a-zA-Z0-9]{12,}|[a-f0-9]{32,64})\b/i },
    { type: 'UUID 格式 API Key / 密钥', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
    { type: 'JWT 令牌', regex: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{8,}\b/ },
    { type: '环境变量密钥配置', regex: /\b(API_KEY|SECRET_KEY|ACCESS_TOKEN|APP_SECRET|PRIVATE_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/i }
  ];

  let matchedType = '';
  let matchedValue = '';
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) {
      matchedType = p.type;
      matchedValue = m[0];
      break;
    }
  }

  if (!matchedType && !/^https?:\/\//i.test(text) && /^[a-zA-Z0-9_\-+=/.]{24,120}$/.test(text) && /[a-zA-Z]/.test(text) && /\d/.test(text)) {
    matchedType = '高强度密钥 / Token 串';
    matchedValue = text;
  }

  if (!matchedType) return { isKey: false, needsNote: false };

  const remainder = text
    .replace(matchedValue, '')
    .replace(/\b(API_KEY|SECRET_KEY|ACCESS_TOKEN|APP_SECRET|PRIVATE_KEY|Bearer|export|const|let|key|token|api)\b/gi, '')
    .replace(/[=:;"'`\s\-_]/g, '')
    .trim();

  const cjkCount = (remainder.match(/[\u4e00-\u9fa5]/g) || []).length;
  const hasMeaningfulNote = cjkCount >= 2 || remainder.length >= 6;

  return {
    isKey: true,
    needsNote: !hasMeaningfulNote,
    keyType: matchedType
  };
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatChatMarkdown(raw = '') {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/^###\s+(.+)$/gm, '<div class="chat-md-h3">$1</div>')
    .replace(/^##\s+(.+)$/gm, '<div class="chat-md-h2">$1</div>')
    .replace(/^#\s+(.+)$/gm, '<div class="chat-md-h2">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/^&gt;\s*(.+)$/gm, '<blockquote class="chat-quote">$1</blockquote>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<div class="chat-md-li">• $1</div>')
    .replace(/\r?\n/g, '<br/>');
}

function formatSize(bytes = 0) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addFilesToDraft(fileList) {
  const newItems = [];
  for (const file of Array.from(fileList)) {
    const dataBase64 = await fileToBase64(file);
    const origName = file.name || `截图_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
    const attObj = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: origName,
      originalName: origName,
      mimeType: file.type || 'application/octet-stream',
      size: file.size || 0,
      dataBase64,
      renaming: true,
      autoRenamed: false
    };
    state.draftAttachments.push(attObj);
    newItems.push(attObj);
  }
  render();

  // 立即异步读取文件内部内容并自动重命名
  for (const item of newItems) {
    try {
      const res = await Bridge.smartRenameFile(
        { name: item.name, mimeType: item.mimeType, dataBase64: item.dataBase64 },
        state.draftContent
      );
      const target = state.draftAttachments.find((a) => a.id === item.id);
      if (target) {
        if (res.newName) {
          target.name = res.newName;
          target.autoRenamed = Boolean(res.renamed);
        }
        if (res.extractedText) {
          target.extractedText = res.extractedText;
        }
        if (res.detectedTitle) {
          target.detectedTitle = res.detectedTitle;
        }
        target.renaming = false;
        render();
      }
    } catch {
      const target = state.draftAttachments.find((a) => a.id === item.id);
      if (target) {
        target.renaming = false;
        render();
      }
    }
  }
}

async function init() {
  state.loading = true;
  render();
  try {
    const [config, memos, indexStats, vaultGitStatus] = await Promise.all([
      Bridge.getConfig(),
      Bridge.listMemos(),
      Bridge.getIndexStatus().catch(() => null),
      Bridge.getVaultGitStatus().catch(() => null)
    ]);
    state.config = config;
    state.memos = memos;
    if (indexStats) {
      state.indexStats = indexStats;
    }
    if (vaultGitStatus) {
      state.vaultGitStatus = vaultGitStatus;
    }
    if (memos.length > 0) {
      state.activeMemoId = memos[0].id;
    }
  } catch (err) {
    console.error('Initialization failed:', err);
  } finally {
    state.loading = false;
    render();
    focusCaptureInput();
  }
}

async function handleExportVaultZip() {
  if (state.exportingZip) return;
  state.exportingZip = true;
  render();
  try {
    const res = await Bridge.exportVaultZip();
    state.lastZipExport = res;
  } catch (err) {
    alert(`打包失败：${err.message}`);
  } finally {
    state.exportingZip = false;
    render();
  }
}

async function refreshIndexStats() {
  try {
    const st = await Bridge.getIndexStatus();
    if (st) {
      state.indexStats = st;
      render();
    }
  } catch {}
}

function focusCaptureInput() {
  setTimeout(() => {
    const el = document.getElementById('capture-textarea');
    if (el) el.focus();
  }, 30);
}

async function handleSubmitCapture(options = {}) {
  const { forceSave = false, extraNote = '' } = options;
  let content = state.draftContent.trim();
  const rawAttachments = state.draftAttachments;
  if (!content && rawAttachments.length === 0) {
    return;
  }
  if (state.saving) return;

  if (extraNote.trim()) {
    content = `【${extraNote.trim()}】\n${content}`;
    state.draftContent = content;
  }

  // 归档前智能预检：1. 是否之前保存过相同内容/文件；2. 是否为未写备注的 API Key/密钥
  if (!forceSave) {
    try {
      const check = await Bridge.precheckMemo({
        content,
        rawAttachments
      });
      if (check.hasDuplicate || check.keyReminder?.needsNote) {
        state.precheckModal = {
          duplicates: check.duplicates || [],
          keyReminder: check.keyReminder || null,
          noteDraft: ''
        };
        render();
        setTimeout(() => {
          document.getElementById('precheck-key-note-input')?.focus();
        }, 30);
        return;
      }
    } catch (err) {
      console.warn('Precheck skipped:', err);
    }
  }

  state.precheckModal = null;
  state.saving = true;
  render();

  try {
    const res = await Bridge.quickSaveMemo({
      content,
      rawAttachments,
      manualCategory: state.draftManualCategory || ''
    });

    state.memos = [res.memo, ...state.memos.filter((m) => m.id !== res.memo.id)];
    state.activeMemoId = res.memo.id;
    state.draftContent = '';
    state.draftAttachments = [];
    state.draftManualCategory = '';
    state.lastSavedToast = {
      memo: res.memo,
      classification: res.classification,
      time: Date.now()
    };
    refreshIndexStats();
  } catch (err) {
    alert(`保存失败：${err.message}`);
  } finally {
    state.saving = false;
    render();
    focusCaptureInput();
  }
}

function getFilteredMemos() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.memos.filter((m) => {
    if (state.selectedCategory !== 'ALL' && m.category !== state.selectedCategory) {
      return false;
    }
    if (state.selectedType !== 'all' && m.type !== state.selectedType) {
      return false;
    }
    if (state.selectedTag && !(m.tags || []).includes(state.selectedTag)) {
      return false;
    }
    if (q) {
      const hay = [
        m.title,
        m.summary,
        m.content,
        m.category,
        ...(m.tags || []),
        ...(m.attachments || []).map((a) => a.name)
      ].join(' ').toLowerCase();
      return hay.includes(q);
    }
    return true;
  });
}

function getCategoryCounts() {
  const counts = { ALL: state.memos.length };
  for (const m of state.memos) {
    counts[m.category] = (counts[m.category] || 0) + 1;
  }
  return counts;
}

function getAllTags() {
  const map = new Map();
  for (const m of state.memos) {
    for (const t of m.tags || []) {
      map.set(t, (map.get(t) || 0) + 1);
    }
  }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 18);
}

function renderHeader() {
  const llmReady = Boolean(state.config?.llm?.enabled && state.config?.llm?.apiKey);
  const isOllama = state.config?.llm?.providerPreset === 'ollama';

  return `
    <header class="topbar">
      <div class="brand" id="btn-go-capture">
        <img src="/src-tauri/icons/icon.png" class="brand-logo-img" alt="QuickMemo" />
        <div>
          <div class="brand-title">QuickMemo <span class="brand-sub">闪念收纳盒</span></div>
        </div>
      </div>

      <nav class="nav-tabs">
        <button class="nav-tab ${state.activeTab === 'capture' ? 'active' : ''}" data-tab="capture">
          <span>⚡ 随手丢入</span>
          <kbd>Alt+1</kbd>
        </button>
        <button class="nav-tab ${state.activeTab === 'vault' ? 'active' : ''}" data-tab="vault">
          <span>🗂️ 分类知识库</span>
          <span class="badge-count">${state.memos.length}</span>
          <kbd>Alt+2</kbd>
        </button>
        <button class="nav-tab ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
          <span>⚙️ AI 与目录设置</span>
          <span class="status-dot ${llmReady || isOllama ? 'on' : 'warn'}" title="${llmReady || isOllama ? 'LLM 自动归类已就绪' : '当前使用本地智能规则，点此配置 API Key'}"></span>
        </button>
      </nav>

      <div class="topbar-actions">
        <button class="ghost-btn ${state.windowPinned ? 'pinned-active' : ''}" id="btn-win-pin" title="开启后窗口保持在最前，打开微信复制或拖文件时不会被微信盖住">
          📌 ${state.windowPinned ? '已钉在最前' : '钉住窗口'}
        </button>
        <button class="ghost-btn" id="btn-win-dock-right" title="将窗口贴靠并缩到屏幕右侧外，鼠标移到桌面右边缘或按 Alt+Space 即可滑出">
          ⇥ 缩到屏幕外
        </button>
        <button class="ghost-btn" id="btn-open-vault-folder" title="在 Windows 资源管理器中打开本地 Markdown 文件夹">
          📂 打开本地库
        </button>
      </div>
    </header>
  `;
}

function renderCaptureView() {
  const categories = state.config?.categories || [];
  const llmReady = Boolean(state.config?.llm?.enabled && (state.config?.llm?.apiKey || state.config?.llm?.providerPreset === 'ollama'));
  const recentMemos = state.memos.slice(0, 6);

  return `
    <main class="capture-shell">
      <section class="spotlight-card" id="drop-zone">
        <div class="spotlight-header">
          <div class="spotlight-title">
            <span class="pulse-dot"></span>
            <span>随手粘贴文字、网址、截图，或把文件直接拖进来</span>
          </div>
          <div class="ai-mode-pill ${llmReady ? 'ai-ready' : 'ai-fallback'}" id="btn-jump-llm-cfg">
            ${llmReady
              ? `✨ AI 自动分类开启 (${escapeHtml(state.config?.llm?.model || 'LLM')})`
              : '⚡ 智能规则归类中（点击配置 LLM Key 解锁深度语义归类）'}
          </div>
        </div>

        <div class="textarea-wrap">
          <textarea
            id="capture-textarea"
            placeholder="像发给“微信文件传输助手”一样直接 Ctrl+V 粘贴文字、代码、链接或截图...&#10;也可以直接把 PDF / 文档 / 图片拖进这个窗口，AI 会自动起标题、提炼摘要并归入对应的 Markdown 文件夹。"
            rows="5"
          >${escapeHtml(state.draftContent)}</textarea>
        </div>

        ${(() => {
          const liveKey = detectSecretKeyClient(state.draftContent);
          if (!liveKey.needsNote) return '';
          const quickKeyNotes = ['DeepSeek API Key', 'OpenAI API Key', '硅基流动 API Key', '阿里云百炼 Key', 'GitHub Token', '服务器/账号密码'];
          return `
            <div class="live-key-hint-bar" id="live-key-hint-bar">
              <div class="key-hint-top">
                <span class="key-hint-badge">🔑 检测到 ${escapeHtml(liveKey.keyType)}</span>
                <span class="key-hint-text">建议顺手加一句备注说明它是哪个平台或什么用途，方便日后搜索找回：</span>
              </div>
              <div class="key-hint-chips">
                ${quickKeyNotes.map((tag) => `
                  <button class="key-quick-chip" data-insert-key-note="${escapeHtml(tag)}">+ ${escapeHtml(tag)}</button>
                `).join('')}
              </div>
            </div>
          `;
        })()}

        ${state.draftAttachments.length > 0 ? `
          <div class="draft-attachments">
            ${state.draftAttachments.map((att) => `
              <div class="draft-att-chip">
                ${att.mimeType.startsWith('image/')
                  ? `<img src="${att.dataBase64}" class="draft-att-thumb" alt="${escapeHtml(att.name)}" />`
                  : `<span class="draft-att-icon">${isPdfAttachment(att) ? '📕' : '📎'}</span>`
                }
                <div class="draft-att-info">
                  <input
                    type="text"
                    class="draft-att-name-input"
                    data-edit-draft-att="${att.id}"
                    value="${escapeHtml(att.name)}"
                    title="可直接修改文件名以便日后搜索"
                  />
                  <div class="draft-att-size">
                    ${att.renaming
                      ? '⏳ 正在读取文件内容自动重命名...'
                      : att.autoRenamed
                        ? `✨ 已根据内容自动重命名 · ${formatSize(att.size)}`
                        : `${formatSize(att.size)} · 点击上方文件名可直接改名`}
                  </div>
                </div>
                ${isPdfAttachment(att) ? `
                  <button class="mini-btn" data-preview-draft-pdf="${att.id}" title="预览此 PDF">👁️ 预览</button>
                ` : ''}
                <button class="draft-att-remove" data-remove-att="${att.id}" title="移除附件">×</button>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="spotlight-footer">
          <div class="footer-left">
            <label class="tool-btn" for="file-picker-input" title="选择本地文件或图片归档">
              📎 添加文件/图片
              <input id="file-picker-input" type="file" multiple hidden />
            </label>
            <button class="tool-btn" id="btn-paste-clipboard" title="直接读取系统剪贴板文字">
              📋 粘贴剪贴板
            </button>
            <select id="manual-category-select" class="cat-select" title="默认由 AI 自动判断分类，也可手动指定">
              <option value="" ${state.draftManualCategory === '' ? 'selected' : ''}>🤖 由 AI 自动判断分类文件夹</option>
              ${categories.map((c) => `
                <option value="${escapeHtml(c.id)}" ${state.draftManualCategory === c.id ? 'selected' : ''}>
                  ${c.icon || '📁'} 指定：${escapeHtml(c.name)} (${escapeHtml(c.id)})
                </option>
              `).join('')}
            </select>
          </div>

          <div class="footer-right">
            <span class="shortcut-hint">Ctrl + Enter 立即归档</span>
            <button class="primary-submit-btn" id="btn-submit-memo" ${state.saving ? 'disabled' : ''}>
              ${state.saving ? '⏳ AI 正在分类落盘...' : '✨ 归档保存'}
            </button>
          </div>
        </div>
      </section>

      ${state.lastSavedToast ? renderLastSavedToast(state.lastSavedToast) : ''}

      <section class="recent-section">
        <div class="section-bar">
          <h3>最近随手记 (${state.memos.length})</h3>
          <button class="link-btn" id="btn-view-all-vault">查看全部与搜索 →</button>
        </div>

        ${recentMemos.length === 0 ? `
          <div class="empty-box">
            <div class="empty-icon">📥</div>
            <div class="empty-title">还没有记录，试试在上方粘贴一段文字、网址或截图吧！</div>
            <div class="empty-desc">所有内容都会自动按分类保存为本地 <code>.md</code> 文件，存放在 <code>${escapeHtml(state.config?.vaultPath || '')}</code></div>
          </div>
        ` : `
          <div class="recent-grid">
            ${recentMemos.map((m) => renderMemoCard(m, false)).join('')}
          </div>
        `}
      </section>
    </main>
  `;
}

function renderLastSavedToast(toast) {
  const { memo, classification } = toast;
  const renamedList = (memo.attachments || []).map((a) => a.name).filter(Boolean);
  const errWarn = classification?.errorWarning || '';

  return `
    <div class="saved-toast">
      <div class="toast-main">
        <span class="toast-badge">✅ 已归档为 Markdown</span>
        <strong>${escapeHtml(memo.title)}</strong>
        <span class="toast-arrow">→</span>
        <span class="cat-pill">📂 ${escapeHtml(memo.category)}</span>
        ${renamedList.length > 0 ? `<span class="cat-pill">📎 文件已重命名：${escapeHtml(renamedList.join('、'))}</span>` : ''}
        ${(memo.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="toast-actions">
        <button class="mini-btn" data-open-md="${escapeHtml(memo.mdAbsPath)}">在文件夹中定位</button>
        <button class="mini-btn" data-inspect-memo="${escapeHtml(memo.id)}">查看详情</button>
      </div>
      ${errWarn ? `
        <div class="toast-warn-line">
          ⚠️ LLM 接口返回异常（已自动提取文档内部标题完成重命名与归档）：<code>${escapeHtml(errWarn)}</code>
        </div>
      ` : ''}
    </div>
  `;
}

function renderMemoCard(m, isSelected = false) {
  const typeMeta = TYPE_META[m.type] || TYPE_META.text;
  const firstImage = (m.attachments || []).find((a) => (a.mimeType || '').startsWith('image/'));

  return `
    <article class="memo-card ${isSelected ? 'selected' : ''}" data-select-memo="${escapeHtml(m.id)}">
      <div class="memo-card-top">
        <span class="memo-cat-tag">📂 ${escapeHtml(m.category)}</span>
        <span class="memo-type-badge" title="${typeMeta.label}">${typeMeta.icon}</span>
        <span class="memo-time">${escapeHtml((m.createdAt || '').slice(5, 16))}</span>
      </div>
      <h4 class="memo-card-title">${escapeHtml(m.title)}</h4>
      <p class="memo-card-summary">${escapeHtml(m.summary || m.content?.slice(0, 90) || '无正文摘要')}</p>
      ${firstImage ? `
        <div class="memo-card-thumb-wrap">
          <img src="${Bridge.getAssetUrl(firstImage.absPath)}" class="memo-card-thumb" alt="${escapeHtml(firstImage.name)}" loading="lazy" />
        </div>
      ` : ''}
      <div class="memo-card-bottom">
        <div class="memo-tags">
          ${(m.tags || []).slice(0, 4).map((t) => `<span class="tag-chip" data-filter-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}
        </div>
        <span class="ai-flag ${m.aiClassified ? 'is-ai' : ''}" title="${m.aiClassified ? '由 LLM 语义分类' : '由本地智能规则分类'}">
          ${m.aiClassified ? '✨ AI' : '⚡ 规则'}
        </span>
      </div>
    </article>
  `;
}

function renderVaultView() {
  const categories = state.config?.categories || [];
  const counts = getCategoryCounts();
  const filtered = getFilteredMemos();
  const allTags = getAllTags();
  const activeMemo = filtered.find((m) => m.id === state.activeMemoId) || filtered[0] || null;

  return `
    <main class="vault-layout">
      <!-- 左侧导航：分类文件夹 + 类型 + 标签 -->
      <aside class="vault-sidebar">
        <div class="sidebar-group">
          <div class="sidebar-label">本地 Markdown 分类目录</div>
          <button class="folder-item ${state.selectedCategory === 'ALL' ? 'active' : ''}" data-cat="ALL">
            <span>🗂️ 全部记录</span>
            <span class="folder-count">${counts.ALL || 0}</span>
          </button>
          ${categories.map((c) => `
            <div class="folder-row">
              <button class="folder-item ${state.selectedCategory === c.id ? 'active' : ''}" data-cat="${escapeHtml(c.id)}">
                <span>${c.icon || '📁'} ${escapeHtml(c.name)}</span>
                <span class="folder-count">${counts[c.id] || 0}</span>
              </button>
              <button class="folder-open-icon" data-open-cat-dir="${escapeHtml(c.id)}" title="在资源管理器打开此分类目录">↗</button>
            </div>
          `).join('')}
        </div>

        <div class="sidebar-group">
          <div class="sidebar-label">按内容类型筛选</div>
          <div class="type-pills">
            ${Object.entries(TYPE_META).map(([key, meta]) => `
              <button class="type-pill ${state.selectedType === key ? 'active' : ''}" data-type="${key}">
                ${meta.icon} ${meta.label}
              </button>
            `).join('')}
          </div>
        </div>

        ${allTags.length > 0 ? `
          <div class="sidebar-group">
            <div class="sidebar-label">
              <span>高频标签</span>
              ${state.selectedTag ? `<button class="clear-tag-btn" id="btn-clear-tag">清除 #${escapeHtml(state.selectedTag)}</button>` : ''}
            </div>
            <div class="tag-cloud">
              ${allTags.map(([tag, cnt]) => `
                <button class="cloud-tag ${state.selectedTag === tag ? 'active' : ''}" data-filter-tag="${escapeHtml(tag)}">
                  #${escapeHtml(tag)} <span>${cnt}</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </aside>

      <!-- 中间列表：搜索栏 + 卡片流 -->
      <section class="vault-list-pane">
        <div class="search-bar-wrap">
          <input
            id="vault-search-input"
            type="search"
            class="search-input"
            placeholder="🔍 搜索标题、AI 摘要、正文关键词、标签或文件名 (按 / 聚焦)..."
            value="${escapeHtml(state.searchQuery)}"
          />
        </div>

        <div class="vault-list-scroll">
          ${filtered.length === 0 ? `
            <div class="empty-box compact">
              <div class="empty-icon">🔍</div>
              <div class="empty-title">没有找到匹配的记录</div>
              <div class="empty-desc">可以尝试切换左侧分类或清空搜索词</div>
            </div>
          ` : filtered.map((m) => renderMemoCard(m, activeMemo && activeMemo.id === m.id)).join('')}
        </div>
      </section>

      <!-- 右侧详情：阅读、复制、打开本地 .md、改分类 -->
      <section class="vault-detail-pane">
        ${activeMemo ? renderMemoDetail(activeMemo) : `
          <div class="empty-box">
            <div class="empty-icon">📄</div>
            <div class="empty-title">点击左侧卡片查看完整 Markdown 内容与附件</div>
          </div>
        `}
      </section>
    </main>
  `;
}

function renderMemoDetail(memo) {
  const categories = state.config?.categories || [];

  return `
    <div class="detail-container">
      <div class="detail-toolbar">
        <select id="detail-cat-select" class="cat-select" data-memo-id="${escapeHtml(memo.id)}" title="更改分类目录（自动移动本地 .md 文件与附件）">
          ${categories.map((c) => `
            <option value="${escapeHtml(c.id)}" ${memo.category === c.id ? 'selected' : ''}>
              📂 ${escapeHtml(c.id)} (${escapeHtml(c.name)})
            </option>
          `).join('')}
        </select>

        <div class="detail-actions">
          <button class="tool-btn" id="btn-copy-memo" data-id="${escapeHtml(memo.id)}">📋 复制原文</button>
          <button class="tool-btn" id="btn-reclassify-memo" data-id="${escapeHtml(memo.id)}">✨ 重新 AI 归类</button>
          <button class="tool-btn" data-open-md="${escapeHtml(memo.mdAbsPath)}">📂 定位 .md 文件</button>
          <button class="tool-btn danger" id="btn-delete-memo" data-id="${escapeHtml(memo.id)}">🗑️ 删除</button>
        </div>
      </div>

      <div class="detail-body">
        <input
          id="detail-title-input"
          class="detail-title-editable"
          value="${escapeHtml(memo.title)}"
          title="点击直接修改标题（失焦自动同步更新本地 .md 文件名）"
        />

        <div class="detail-meta-row">
          <span>🕒 ${escapeHtml(memo.createdAt)}</span>
          <span>·</span>
          <span class="mono-path" title="${escapeHtml(memo.mdAbsPath)}">📄 ${escapeHtml(memo.mdRelPath)}</span>
        </div>

        ${memo.summary ? `
          <div class="detail-summary-box">
            <div class="summary-label">✨ AI 提炼摘要</div>
            <div class="summary-text">${escapeHtml(memo.summary)}</div>
          </div>
        ` : ''}

        <div class="detail-tags-row">
          ${(memo.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('')}
        </div>

        ${memo.attachments && memo.attachments.length > 0 ? `
          <div class="detail-attachments-section">
            <div class="section-caption">归档附件与预览 (${memo.attachments.length}) · 可直接重命名文件方便搜索</div>
            <div class="detail-att-list">
              ${memo.attachments.map((att, attIdx) => {
                const isPdf = isPdfAttachment(att);
                const assetUrl = Bridge.getAssetUrl(att.absPath);
                return `
                  <div class="detail-att-card">
                    <div class="detail-att-bar">
                      <div class="detail-att-rename-group">
                        <span>${isPdf ? '📕' : '📎'}</span>
                        <input
                          type="text"
                          class="detail-att-name-input"
                          id="att-rename-input-${attIdx}"
                          value="${escapeHtml(att.name)}"
                          title="修改文件名并点右侧‘重命名’同步更新磁盘文件"
                        />
                        <span class="att-size-label">(${formatSize(att.size)})</span>
                      </div>
                      <div class="detail-att-btns">
                        <button class="mini-btn primary" data-rename-att-idx="${attIdx}" data-memo-id="${escapeHtml(memo.id)}">✏️ 重命名文件</button>
                        ${isPdf ? `
                          <button class="mini-btn" data-open-pdf-modal="${escapeHtml(assetUrl)}" data-pdf-title="${escapeHtml(att.name)}">🔍 全屏预览 PDF</button>
                        ` : ''}
                        <button class="mini-btn" data-open-md="${escapeHtml(att.absPath)}">打开所在位置</button>
                      </div>
                    </div>
                    ${(att.mimeType || '').startsWith('image/') ? `
                      <img src="${assetUrl}" class="detail-image-preview" alt="${escapeHtml(att.name)}" />
                    ` : ''}
                    ${isPdf ? `
                      <div class="detail-pdf-wrap">
                        <iframe src="${assetUrl}" class="detail-pdf-iframe" title="${escapeHtml(att.name)}"></iframe>
                      </div>
                    ` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        ` : ''}

        <div class="detail-content-section">
          <div class="section-caption">原始记录 / 文档提取文本（可直接编辑并保存）</div>
          <textarea id="detail-content-textarea" class="detail-content-editor" rows="8">${escapeHtml(memo.content || '')}</textarea>
          <div class="editor-save-bar">
            <button class="mini-btn primary" id="btn-save-detail-edit" data-id="${escapeHtml(memo.id)}">💾 保存修改到本地 Markdown</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsView() {
  const cfg = state.config || {};
  const llm = cfg.llm || {};
  const categories = cfg.categories || [];

  return `
    <main class="settings-shell">
      <section class="settings-card">
        <h3>🤖 OpenAI 兼容接口设置</h3>
        <p class="settings-hint">支持任意标准 OpenAI 兼容接口（<code>/v1/chat/completions</code>）。配置后可用于自动起标题、提炼摘要、文件重命名与对话式寻物问答。</p>

        <div class="form-grid">
          <label class="form-field-inline full">
            <input type="checkbox" id="cfg-llm-enabled" ${llm.enabled !== false ? 'checked' : ''} />
            <span>启用 OpenAI 兼容大模型（自动分类 / 文件智能重命名 / 聊天问答）</span>
          </label>

          <label class="form-field full">
            <span>API Base URL (OpenAI 兼容接口地址)</span>
            <input type="text" id="cfg-llm-baseurl" value="${escapeHtml(llm.baseUrl || '')}" placeholder="例如：https://api.openai.com/v1 或任意 OpenAI 兼容地址" />
          </label>

          <label class="form-field">
            <span>API Key</span>
            <input type="password" id="cfg-llm-apikey" value="${escapeHtml(llm.apiKey || '')}" placeholder="sk-..." />
          </label>

          <label class="form-field">
            <span>模型名称 (Model ID)</span>
            <input type="text" id="cfg-llm-model" value="${escapeHtml(llm.model || '')}" placeholder="例如：gpt-4o-mini / deepseek-flash" />
          </label>

          <label class="form-field full">
            <span>补充分类偏好提示词（可选，告诉 AI 你的特殊归类习惯）</span>
            <input type="text" id="cfg-llm-prompt" value="${escapeHtml(llm.customSystemPrompt || '')}" placeholder="例如：凡是涉及股票代码的归入工作与待办；提示词模板归入技术与代码..." />
          </label>
        </div>

        <div class="llm-test-bar">
          <button class="tool-btn" id="btn-test-llm">🔌 测试 OpenAI 兼容接口连接</button>
          <span id="llm-test-status" class="llm-test-status"></span>
        </div>
      </section>

      <section class="settings-card">
        <h3>📂 本地 Markdown 仓库路径与一键打包迁移 (Obsidian 兼容)</h3>
        <p class="settings-hint">所有记录都会直接生成带 Frontmatter 的 <code>.md</code> 文件并按分类建子文件夹。你可以直接将此路径指向你的 Obsidian 仓库目录，或一键打包成 <code>.zip</code> 迁移到其他电脑！</p>
        <div class="vault-path-row">
          <input type="text" id="cfg-vault-path" value="${escapeHtml(cfg.vaultPath || '')}" />
          <button class="tool-btn" id="btn-open-vault-in-settings">📂 打开目录</button>
          <button class="tool-btn primary-outline" id="btn-export-vault-zip" ${state.exportingZip ? 'disabled' : ''}>
            ${state.exportingZip ? '⏳ 正在打包...' : '📦 一键打包 .zip 迁移'}
          </button>
        </div>
        ${state.lastZipExport ? `
          <div class="zip-export-toast">
            <span>✅ 已打包完成：<strong>${escapeHtml(state.lastZipExport.zipFileName)}</strong>（共 ${state.lastZipExport.fileCount} 个文件 · ${escapeHtml(state.lastZipExport.sizeFormatted)}）</span>
            <button class="mini-btn" data-open-md="${escapeHtml(state.lastZipExport.zipAbsPath)}">📂 在资源管理器查看</button>
          </div>
        ` : ''}
      </section>

      <section class="settings-card">
        <h3>🔒 关联 GitHub 私有仓库（云端备份与跨设备同步）</h3>
        <p class="settings-hint">
          将本地 <code>vault/</code> 目录作为独立的 Git 仓库关联到你的 <strong>GitHub 私有仓库 (Private Repo)</strong>，与软件源码完全隔离，保护你的私人笔记与文档安全。
        </p>

        ${(() => {
          const gitSt = state.vaultGitStatus || {};
          const currentRemote = gitSt.remoteUrl || cfg.vaultGit?.remoteUrl || '';
          const ghUser = gitSt.ghUser || 'TeaGo-lab';
          const defaultPrivateUrl = `https://github.com/${ghUser}/quick-memo-vault.git`;

          return `
            <div class="git-status-banner ${currentRemote ? 'linked' : 'unlinked'}">
              <div class="git-status-main">
                <span class="git-badge">${currentRemote ? '🟢 已关联私有库' : '⚪ 尚未绑定远程仓库'}</span>
                <code class="git-remote-code">${escapeHtml(currentRemote || '本地 Vault 尚未绑定 GitHub 远程地址')}</code>
              </div>
              ${gitSt.lastCommit ? `
                <div class="git-status-sub">
                  最近同步提交：${escapeHtml(gitSt.lastCommit)} · 待同步变更：<strong>${gitSt.pendingChanges || 0}</strong> 项
                </div>
              ` : ''}
            </div>

            <div class="form-grid" style="margin-top: 12px;">
              <label class="form-field full">
                <span>GitHub 私有仓库地址 (HTTPS 或 SSH)</span>
                <div class="vault-path-row">
                  <input
                    type="text"
                    id="cfg-vault-git-url"
                    value="${escapeHtml(currentRemote || defaultPrivateUrl)}"
                    placeholder="例如：https://github.com/TeaGo-lab/quick-memo-vault.git"
                  />
                  <button class="tool-btn" id="btn-link-existing-repo" ${state.gitSyncing ? 'disabled' : ''}>
                    🔗 绑定此地址并推送
                  </button>
                </div>
              </label>

              <label class="form-field-inline full">
                <input type="checkbox" id="cfg-vault-git-autosync" ${(cfg.vaultGit?.autoSync || gitSt.autoSyncEnabled) ? 'checked' : ''} />
                <span>每次新增或修改闪念后，自动在后台静默提交并推送到 GitHub 私有库</span>
              </label>
            </div>

            <div class="git-actions-bar">
              <button class="primary-submit-btn" id="btn-auto-create-private-repo" ${state.gitSyncing ? 'disabled' : ''} title="使用本机已登录的 GitHub 账号 (${escapeHtml(ghUser)}) 自动新建名为 quick-memo-vault 的私有仓库并推送">
                🚀 ${state.gitSyncing ? '正在同步 GitHub...' : `一键在 ${escapeHtml(ghUser)} 下自动创建私有库并同步`}
              </button>
              ${currentRemote ? `
                <button class="tool-btn" id="btn-vault-git-push" ${state.gitSyncing ? 'disabled' : ''}>☁️ 立即推送备份 (Push)</button>
                <button class="tool-btn" id="btn-vault-git-pull" ${state.gitSyncing ? 'disabled' : ''}>⬇️ 从云端拉取 (Pull)</button>
              ` : ''}
            </div>

            ${state.gitFeedback ? `
              <div class="llm-test-status ${state.gitFeedback.ok ? 'ok' : 'err'}" style="margin-top: 10px; display: block;">
                ${escapeHtml(state.gitFeedback.text)}
              </div>
            ` : ''}
          `;
        })()}
      </section>

      <section class="settings-card">
        <h3>🗂️ 自定义分类文件夹与 AI 识别规则</h3>
        <p class="settings-hint">AI 会根据每个分类的「描述说明」自动判断内容应该放进哪个文件夹。</p>
        <div class="cat-config-list" id="cat-config-list">
          ${categories.map((c, idx) => `
            <div class="cat-config-row" data-idx="${idx}">
              <input type="text" class="cat-input-icon" value="${escapeHtml(c.icon || '📁')}" title="图标" />
              <input type="text" class="cat-input-id" value="${escapeHtml(c.id)}" placeholder="文件夹名，如 01-灵感" />
              <input type="text" class="cat-input-name" value="${escapeHtml(c.name)}" placeholder="显示名称" />
              <input type="text" class="cat-input-desc" value="${escapeHtml(c.desc || '')}" placeholder="告诉 AI 什么样的内容归入此类..." />
            </div>
          `).join('')}
        </div>

        <div class="settings-save-bar">
          <button class="primary-submit-btn" id="btn-save-settings">💾 保存全部设置</button>
        </div>
      </section>
    </main>
  `;
}

function focusChatInput() {
  setTimeout(() => {
    const el = document.getElementById('chat-composer-input');
    if (el) el.focus();
    const listEl = document.getElementById('chat-messages-scroll');
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }, 30);
}

async function handleSendChatMessage(overrideText = '') {
  const text = (overrideText || state.chatDraft || '').trim();
  if (!text || state.chatLoading) return;

  const userMsg = {
    id: `msg_${Date.now()}_u`,
    role: 'user',
    content: text,
    time: new Date().toTimeString().slice(0, 5)
  };

  const historyForApi = state.chatMessages.slice(-6).map((m) => ({
    role: m.role,
    content: m.content
  }));

  state.chatMessages.push(userMsg);
  state.chatDraft = '';
  state.chatLoading = true;
  render();
  focusChatInput();

  try {
    const res = await Bridge.askChat(text, historyForApi);
    if (res.stats) {
      state.indexStats = res.stats;
    }
    state.chatMessages.push({
      id: `msg_${Date.now()}_a`,
      role: 'assistant',
      content: res.reply || '已完成检索。',
      sources: res.sources || [],
      aiUsed: Boolean(res.aiUsed),
      errorWarning: res.errorWarning || '',
      time: new Date().toTimeString().slice(0, 5)
    });
  } catch (err) {
    state.chatMessages.push({
      id: `msg_${Date.now()}_err`,
      role: 'assistant',
      content: `⚠️ 检索问答出错：${err.message}`,
      sources: [],
      aiUsed: false,
      time: new Date().toTimeString().slice(0, 5)
    });
  } finally {
    state.chatLoading = false;
    render();
    focusChatInput();
  }
}

function renderChatBubbleWidget() {
  const st = state.indexStats || { totalDocs: state.memos.length, totalChunks: 0 };
  const docCount = st.totalDocs || state.memos.length;
  const chunkCount = st.totalChunks || docCount;

  const examplePrompts = [
    '帮我找一下 3D 产品宣传片相关的 PDF',
    '3D 宣传片提示词里用到了哪些软件和步骤？',
    '我保存过哪些关于 Tauri 的网址链接？',
    '盘点一下我收纳盒里保存的所有文件和笔记'
  ];

  return `
    <!-- 悬浮聊天泡泡与对话式寻物面板 -->
    <div class="chat-widget-root">
      ${state.chatOpen ? `
        <aside class="chat-panel" id="chat-panel">
          <div class="chat-panel-header">
            <div class="chat-header-left">
              <div class="chat-avatar-badge">💬</div>
              <div>
                <div class="chat-panel-title">闪念寻物助手</div>
                <div class="chat-index-meta" title="最后索引时间: ${escapeHtml(st.lastIndexedAt || '刚刚')}">
                  📚 已索引 <strong>${docCount}</strong> 篇文档 · <strong>${chunkCount}</strong> 个全文片段
                </div>
              </div>
            </div>

            <div class="chat-header-actions">
              <button class="chat-icon-btn" id="btn-rebuild-doc-index" title="重新扫描所有 Markdown 与 PDF/Word 附件建立全文索引" ${state.rebuildingIndex ? 'disabled' : ''}>
                ${state.rebuildingIndex ? '⏳ 索引中' : '🔄 重建索引'}
              </button>
              ${state.chatMessages.length > 0 ? `
                <button class="chat-icon-btn" id="btn-clear-chat" title="清空当前聊天记录">🗑️ 清空</button>
              ` : ''}
              <button class="chat-close-btn" id="btn-close-chat-panel" title="收起聊天泡泡">✕</button>
            </div>
          </div>

          <div class="chat-messages-scroll" id="chat-messages-scroll">
            ${state.chatMessages.length === 0 ? `
              <div class="chat-empty-state">
                <div class="chat-empty-hero">✦ 用对话找回你随手存下的任何东西</div>
                <p class="chat-empty-desc">
                  已为你的笔记、链接及 <strong>PDF / Word 附件内部正文</strong> 建立全文索引。直接问我关键词、文档细节或模糊印象即可：
                </p>
                <div class="chat-prompt-chips">
                  ${examplePrompts.map((p) => `
                    <button class="chat-prompt-chip" data-chat-prompt="${escapeHtml(p)}">
                      <span>💬 ${escapeHtml(p)}</span>
                      <span class="chip-arrow">→</span>
                    </button>
                  `).join('')}
                </div>
              </div>
            ` : state.chatMessages.map((msg) => `
              <div class="chat-msg-row ${msg.role === 'user' ? 'is-user' : 'is-assistant'}">
                <div class="chat-msg-bubble">
                  <div class="chat-msg-content">${formatChatMarkdown(msg.content)}</div>

                  ${msg.role === 'assistant' && Array.isArray(msg.sources) && msg.sources.length > 0 ? `
                    <div class="chat-sources-box">
                      <div class="chat-sources-label">📎 命中的本地文档与附件 (${msg.sources.length})</div>
                      <div class="chat-sources-list">
                        ${msg.sources.slice(0, 3).map((src) => `
                          <div class="chat-source-card">
                            <div class="chat-source-top">
                              <span class="chat-source-title">📄 ${escapeHtml(src.title)}</span>
                              <span class="chat-source-cat">${escapeHtml(src.category)}</span>
                            </div>
                            <div class="chat-source-snippet">
                              <span class="source-loc-tag">${escapeHtml(src.sourceLabel || '文档片段')}</span>
                              ${escapeHtml(src.snippet || '')}
                            </div>
                            <div class="chat-source-actions">
                              <button class="mini-btn primary" data-chat-jump-memo="${escapeHtml(src.memoId)}">📄 查看记录</button>
                              ${src.pdfAttachment ? `
                                <button
                                  class="mini-btn"
                                  data-open-pdf-modal="${escapeHtml(Bridge.getAssetUrl(src.pdfAttachment.absPath))}"
                                  data-pdf-title="${escapeHtml(src.pdfAttachment.name)}"
                                >📕 预览 PDF</button>
                              ` : ''}
                              ${src.mdAbsPath ? `
                                <button class="mini-btn" data-open-md="${escapeHtml(src.mdAbsPath)}">📂 打开位置</button>
                              ` : ''}
                            </div>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : ''}

                  <div class="chat-msg-footer">
                    <span>${escapeHtml(msg.time || '')}</span>
                    ${msg.role === 'assistant' ? `
                      <span class="chat-engine-tag">
                        ${msg.aiUsed ? '✨ LLM + 全文索引回答' : '⚡ 本地全文索引直达'}
                      </span>
                    ` : ''}
                  </div>
                </div>
              </div>
            `).join('')}

            ${state.chatLoading ? `
              <div class="chat-msg-row is-assistant">
                <div class="chat-msg-bubble loading-bubble">
                  <span class="pulse-dot"></span>
                  <span>正在检索本地文档索引与 PDF 内部段落...</span>
                </div>
              </div>
            ` : ''}
          </div>

          <div class="chat-composer">
            <textarea
              id="chat-composer-input"
              class="chat-composer-input"
              rows="2"
              placeholder="输入你想找的文件、提示词或笔记内容... (Enter 发送，Shift+Enter 换行)"
            >${escapeHtml(state.chatDraft)}</textarea>
            <button class="chat-send-btn" id="btn-send-chat" ${state.chatLoading ? 'disabled' : ''}>
              ${state.chatLoading ? '...' : '发送 ↑'}
            </button>
          </div>
        </aside>
      ` : ''}

      <button
        class="chat-floating-bubble ${state.chatOpen ? 'is-open' : ''}"
        id="btn-toggle-chat-bubble"
        title="打开闪念寻物聊天助手 (快捷键 Alt+3)"
      >
        <span class="bubble-icon">${state.chatOpen ? '✕' : '💬'}</span>
        <span class="bubble-label">${state.chatOpen ? '收起寻物助手' : '对话找文档'}</span>
        ${!state.chatOpen ? `<span class="bubble-index-pill">已索引 ${docCount}</span>` : ''}
      </button>
    </div>
  `;
}

function renderPrecheckModal() {
  const modal = state.precheckModal;
  if (!modal) return '';

  const hasDup = Array.isArray(modal.duplicates) && modal.duplicates.length > 0;
  const hasKeyWarn = Boolean(modal.keyReminder?.needsNote);
  const quickKeyNotes = ['DeepSeek API Key', 'OpenAI API Key', '硅基流动 API Key', '阿里云百炼 Key', 'GitHub Token', '服务器/数据库密码'];

  return `
    <div class="precheck-modal-backdrop" id="precheck-modal-backdrop">
      <div class="precheck-modal-card">
        <div class="precheck-modal-header">
          <div class="precheck-modal-title">
            ${hasDup && hasKeyWarn
              ? '⚠️ 发现重复记录 & 密钥未写备注'
              : hasDup
                ? '⚠️ 之前已经保存过相同的内容！'
                : '🔑 检测到密钥 / Key，建议补充一句备注'}
          </div>
          <button class="chat-close-btn" id="btn-close-precheck-modal" title="返回修改 (Esc)">✕</button>
        </div>

        <div class="precheck-modal-body">
          ${hasDup ? `
            <div class="precheck-section">
              <div class="precheck-section-desc">
                系统在本地知识库中检测到 <strong>${modal.duplicates.length} 条</strong> 与当前内容相同或高度重合的记录，保存在以下位置：
              </div>
              <div class="precheck-dup-list">
                ${modal.duplicates.map((dup) => `
                  <div class="precheck-dup-item">
                    <div class="precheck-dup-top">
                      <span class="precheck-dup-title">📄 ${escapeHtml(dup.title)}</span>
                      <span class="precheck-dup-reason">${escapeHtml(dup.matchReason)}</span>
                    </div>
                    <div class="precheck-dup-meta">
                      <span>📂 所在分类：<strong>${escapeHtml(dup.category)}</strong></span>
                      <span>·</span>
                      <span>🕒 保存于 ${escapeHtml(dup.createdAt)}</span>
                    </div>
                    <div class="precheck-dup-path">📍 本地路径：<code>${escapeHtml(dup.mdRelPath)}</code></div>
                    <div class="precheck-dup-actions">
                      <button class="mini-btn primary" data-precheck-open-existing="${escapeHtml(dup.id)}">📄 查看已有记录（不重复保存）</button>
                      <button class="mini-btn" data-open-md="${escapeHtml(dup.mdAbsPath)}">📂 在文件夹中定位</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${hasKeyWarn ? `
            <div class="precheck-section key-warn-section">
              <div class="precheck-key-banner">
                <span class="key-type-pill">🔑 ${escapeHtml(modal.keyReminder.keyType)}</span>
                <code class="key-masked-code">${escapeHtml(modal.keyReminder.maskedKey || '')}</code>
              </div>
              <div class="precheck-section-desc">
                你粘贴的似乎是一串裸密钥/Token，但还没有写明它是哪个平台或什么用途。<strong>强烈建议补一句备注</strong>，否则过段时间很难搜出来：
              </div>
              <input
                type="text"
                id="precheck-key-note-input"
                class="precheck-note-input"
                placeholder="例如：DeepSeek 生产环境 API Key / 公司测试服密码 (按 Enter 直接保存)..."
                value="${escapeHtml(modal.noteDraft || '')}"
              />
              <div class="key-hint-chips">
                ${quickKeyNotes.map((tag) => `
                  <button class="key-quick-chip" data-precheck-note-chip="${escapeHtml(tag)}">+ ${escapeHtml(tag)}</button>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>

        <div class="precheck-modal-footer">
          <button class="tool-btn" id="btn-precheck-cancel">🔙 返回修改</button>
          ${hasDup ? `
            <button class="tool-btn danger" id="btn-precheck-discard">🗑️ 放弃本次并清空输入</button>
          ` : ''}
          <button class="primary-submit-btn" id="btn-precheck-confirm-save">
            ${hasDup && hasKeyWarn
              ? '✅ 加上备注并依然保存'
              : hasDup
                ? '✅ 依然继续保存（存为新记录）'
                : '✨ 补充备注并归档保存'}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function render() {
  const app = document.getElementById('app');
  if (!app) return;

  if (state.loading && !state.config) {
    app.innerHTML = `<div class="loading-screen">⚡ 正在加载本地 Markdown 知识库...</div>`;
    return;
  }

  let bodyHtml = '';
  if (state.activeTab === 'capture') {
    bodyHtml = renderCaptureView();
  } else if (state.activeTab === 'vault') {
    bodyHtml = renderVaultView();
  } else {
    bodyHtml = renderSettingsView();
  }

  app.innerHTML = `
    <div class="app-container">
      ${renderHeader()}
      ${bodyHtml}
      ${renderChatBubbleWidget()}
      ${renderPrecheckModal()}
      ${state.pdfModal ? `
        <div class="pdf-modal-backdrop" id="pdf-modal-backdrop">
          <div class="pdf-modal-window">
            <div class="pdf-modal-header">
              <div class="pdf-modal-title">📕 ${escapeHtml(state.pdfModal.title || 'PDF 预览')}</div>
              <button class="ghost-btn" id="btn-close-pdf-modal">✕ 关闭预览 (Esc)</button>
            </div>
            <iframe src="${escapeHtml(state.pdfModal.url)}" class="pdf-modal-iframe" title="PDF Preview"></iframe>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  // 顶部导航切换
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.getAttribute('data-tab');
      render();
      if (state.activeTab === 'capture') focusCaptureInput();
    });
  });

  const btnGoCapture = document.getElementById('btn-go-capture');
  if (btnGoCapture) {
    btnGoCapture.addEventListener('click', () => {
      state.activeTab = 'capture';
      render();
      focusCaptureInput();
    });
  }

  const btnOpenVault = document.getElementById('btn-open-vault-folder');
  if (btnOpenVault) {
    btnOpenVault.addEventListener('click', () => Bridge.openInExplorer(state.config?.vaultPath));
  }

  const btnWinPin = document.getElementById('btn-win-pin');
  if (btnWinPin) {
    btnWinPin.addEventListener('click', () => {
      state.windowPinned = !state.windowPinned;
      Bridge.sendWindowCommand(state.windowPinned ? 'pin-on' : 'pin-off');
      render();
    });
  }

  const btnWinDock = document.getElementById('btn-win-dock-right');
  if (btnWinDock) {
    btnWinDock.addEventListener('click', () => Bridge.sendWindowCommand('dock-right'));
  }

  const btnJumpCfg = document.getElementById('btn-jump-llm-cfg');
  if (btnJumpCfg) {
    btnJumpCfg.addEventListener('click', () => {
      state.activeTab = 'settings';
      render();
    });
  }

  // 极速捕获视图事件
  const textarea = document.getElementById('capture-textarea');
  if (textarea) {
    textarea.addEventListener('input', (e) => {
      const prevNeedsNote = detectSecretKeyClient(state.draftContent).needsNote;
      state.draftContent = e.target.value;
      const nextNeedsNote = detectSecretKeyClient(state.draftContent).needsNote;
      if (prevNeedsNote !== nextNeedsNote) {
        const pos = e.target.selectionStart;
        render();
        const nextEl = document.getElementById('capture-textarea');
        if (nextEl) {
          nextEl.focus();
          nextEl.setSelectionRange(pos, pos);
        }
      }
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleSubmitCapture();
      }
    });

    // 支持直接 Ctrl+V 粘贴截图/文件
    textarea.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        await addFilesToDraft(files);
      }
    });
  }

  // 拖拽文件进入捕获区
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) {
        await addFilesToDraft(e.dataTransfer.files);
      }
    });
  }

  const fileInput = document.getElementById('file-picker-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      if (e.target.files?.length) {
        await addFilesToDraft(e.target.files);
      }
    });
  }

  const btnPasteClip = document.getElementById('btn-paste-clipboard');
  if (btnPasteClip) {
    btnPasteClip.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          state.draftContent = state.draftContent ? `${state.draftContent}\n${text}` : text;
          render();
          focusCaptureInput();
        }
      } catch {
        alert('请直接在输入框内按 Ctrl+V 粘贴');
      }
    });
  }

  const manualCatSelect = document.getElementById('manual-category-select');
  if (manualCatSelect) {
    manualCatSelect.addEventListener('change', (e) => {
      state.draftManualCategory = e.target.value;
    });
  }

  document.querySelectorAll('[data-remove-att]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-remove-att');
      state.draftAttachments = state.draftAttachments.filter((a) => a.id !== id);
      render();
    });
  });

  document.querySelectorAll('[data-edit-draft-att]').forEach((input) => {
    input.addEventListener('input', (e) => {
      const id = input.getAttribute('data-edit-draft-att');
      const target = state.draftAttachments.find((a) => a.id === id);
      if (target) {
        target.name = e.target.value;
      }
    });
    input.addEventListener('focus', (e) => {
      const val = e.target.value;
      const dotIdx = val.lastIndexOf('.');
      if (dotIdx > 0) {
        e.target.setSelectionRange(0, dotIdx);
      } else {
        e.target.select();
      }
    });
  });

  const btnSubmit = document.getElementById('btn-submit-memo');
  if (btnSubmit) {
    btnSubmit.addEventListener('click', () => handleSubmitCapture());
  }

  // 实时密钥备注快捷标签插入
  document.querySelectorAll('[data-insert-key-note]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const note = chip.getAttribute('data-insert-key-note');
      if (!note) return;
      state.draftContent = `【${note}】\n${state.draftContent.trim()}`;
      render();
      focusCaptureInput();
    });
  });

  // 归档前预检弹窗（查重提醒 & 密钥备注提醒）事件绑定
  const closePrecheck = () => {
    state.precheckModal = null;
    render();
    focusCaptureInput();
  };

  document.getElementById('btn-close-precheck-modal')?.addEventListener('click', closePrecheck);
  document.getElementById('btn-precheck-cancel')?.addEventListener('click', closePrecheck);

  const precheckBackdrop = document.getElementById('precheck-modal-backdrop');
  if (precheckBackdrop) {
    precheckBackdrop.addEventListener('click', (e) => {
      if (e.target === precheckBackdrop) closePrecheck();
    });
  }

  const btnPrecheckDiscard = document.getElementById('btn-precheck-discard');
  if (btnPrecheckDiscard) {
    btnPrecheckDiscard.addEventListener('click', () => {
      state.precheckModal = null;
      state.draftContent = '';
      state.draftAttachments = [];
      state.draftManualCategory = '';
      render();
      focusCaptureInput();
    });
  }

  document.querySelectorAll('[data-precheck-open-existing]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const existingId = btn.getAttribute('data-precheck-open-existing');
      state.precheckModal = null;
      state.draftContent = '';
      state.draftAttachments = [];
      state.activeMemoId = existingId;
      state.selectedCategory = 'ALL';
      state.selectedType = 'all';
      state.selectedTag = '';
      state.searchQuery = '';
      state.activeTab = 'vault';
      render();
    });
  });

  const precheckNoteInput = document.getElementById('precheck-key-note-input');
  if (precheckNoteInput) {
    precheckNoteInput.addEventListener('input', (e) => {
      if (state.precheckModal) {
        state.precheckModal.noteDraft = e.target.value;
      }
    });
    precheckNoteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const noteVal = precheckNoteInput.value.trim();
        handleSubmitCapture({ forceSave: true, extraNote: noteVal });
      }
    });
  }

  document.querySelectorAll('[data-precheck-note-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.getAttribute('data-precheck-note-chip') || '';
      if (state.precheckModal) {
        state.precheckModal.noteDraft = tag;
      }
      const inputEl = document.getElementById('precheck-key-note-input');
      if (inputEl) {
        inputEl.value = tag;
        inputEl.focus();
      }
    });
  });

  const btnPrecheckConfirm = document.getElementById('btn-precheck-confirm-save');
  if (btnPrecheckConfirm) {
    btnPrecheckConfirm.addEventListener('click', () => {
      const noteVal = document.getElementById('precheck-key-note-input')?.value.trim() || '';
      handleSubmitCapture({ forceSave: true, extraNote: noteVal });
    });
  }

  const btnViewAll = document.getElementById('btn-view-all-vault');
  if (btnViewAll) {
    btnViewAll.addEventListener('click', () => {
      state.activeTab = 'vault';
      render();
    });
  }

  // 打开指定 md 文件或分类目录
  document.querySelectorAll('[data-open-md]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      Bridge.openInExplorer(btn.getAttribute('data-open-md'));
    });
  });

  // 全屏预览已归档 PDF
  document.querySelectorAll('[data-open-pdf-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pdfModal = {
        url: btn.getAttribute('data-open-pdf-modal'),
        title: btn.getAttribute('data-pdf-title') || 'PDF 文档预览'
      };
      render();
    });
  });

  // 预览草稿箱中刚拖入的 PDF
  document.querySelectorAll('[data-preview-draft-pdf]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-preview-draft-pdf');
      const att = state.draftAttachments.find((a) => a.id === id);
      if (!att || !att.dataBase64) return;
      state.pdfModal = {
        url: att.dataBase64,
        title: att.name
      };
      render();
    });
  });

  const btnClosePdfModal = document.getElementById('btn-close-pdf-modal');
  if (btnClosePdfModal) {
    btnClosePdfModal.addEventListener('click', () => {
      state.pdfModal = null;
      render();
    });
  }

  const pdfBackdrop = document.getElementById('pdf-modal-backdrop');
  if (pdfBackdrop) {
    pdfBackdrop.addEventListener('click', (e) => {
      if (e.target === pdfBackdrop) {
        state.pdfModal = null;
        render();
      }
    });
  }

  // 重命名已归档附件
  document.querySelectorAll('[data-rename-att-idx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const attIdx = Number(btn.getAttribute('data-rename-att-idx'));
      const memoId = btn.getAttribute('data-memo-id');
      const inputEl = document.getElementById(`att-rename-input-${attIdx}`);
      const newName = inputEl?.value.trim();
      if (!newName) return;
      btn.textContent = '⏳ 重命名中...';
      btn.disabled = true;
      try {
        const res = await Bridge.renameAttachment(memoId, attIdx, newName);
        state.memos = state.memos.map((m) => (m.id === memoId ? res.memo : m));
        render();
      } catch (err) {
        alert(`重命名失败：${err.message}`);
        render();
      }
    });
  });

  document.querySelectorAll('.detail-att-name-input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = input.id.replace('att-rename-input-', '');
        const btn = document.querySelector(`[data-rename-att-idx="${idx}"]`);
        if (btn) btn.click();
      }
    });
  });

  document.querySelectorAll('[data-open-cat-dir]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const catId = btn.getAttribute('data-open-cat-dir');
      const vaultPath = state.config?.vaultPath || '';
      Bridge.openInExplorer(`${vaultPath}\\${catId}`);
    });
  });

  document.querySelectorAll('[data-inspect-memo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeMemoId = btn.getAttribute('data-inspect-memo');
      state.activeTab = 'vault';
      render();
    });
  });

  // 卡片点击选中
  document.querySelectorAll('[data-select-memo]').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-select-memo');
      state.activeMemoId = id;
      if (state.activeTab === 'capture') {
        state.activeTab = 'vault';
      }
      render();
    });
  });

  // 分类/类型/标签筛选
  document.querySelectorAll('[data-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedCategory = btn.getAttribute('data-cat');
      render();
    });
  });

  document.querySelectorAll('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedType = btn.getAttribute('data-type');
      render();
    });
  });

  document.querySelectorAll('[data-filter-tag]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = btn.getAttribute('data-filter-tag');
      state.selectedTag = state.selectedTag === tag ? '' : tag;
      state.activeTab = 'vault';
      render();
    });
  });

  const btnClearTag = document.getElementById('btn-clear-tag');
  if (btnClearTag) {
    btnClearTag.addEventListener('click', () => {
      state.selectedTag = '';
      render();
    });
  }

  const searchInput = document.getElementById('vault-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const pos = e.target.selectionStart;
      state.searchQuery = e.target.value;
      render();
      const nextInput = document.getElementById('vault-search-input');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(pos, pos);
      }
    });
  }

  // 详情页操作
  const detailCatSelect = document.getElementById('detail-cat-select');
  if (detailCatSelect) {
    detailCatSelect.addEventListener('change', async (e) => {
      const id = detailCatSelect.getAttribute('data-memo-id');
      const newCategory = e.target.value;
      const res = await Bridge.updateMemo(id, { category: newCategory });
      state.memos = state.memos.map((m) => (m.id === id ? res.memo : m));
      render();
    });
  }

  const btnSaveDetailEdit = document.getElementById('btn-save-detail-edit');
  if (btnSaveDetailEdit) {
    btnSaveDetailEdit.addEventListener('click', async () => {
      const id = btnSaveDetailEdit.getAttribute('data-id');
      const newTitle = document.getElementById('detail-title-input')?.value || '';
      const newContent = document.getElementById('detail-content-textarea')?.value || '';
      const res = await Bridge.updateMemo(id, { title: newTitle, content: newContent });
      state.memos = state.memos.map((m) => (m.id === id ? res.memo : m));
      render();
    });
  }

  const btnCopyMemo = document.getElementById('btn-copy-memo');
  if (btnCopyMemo) {
    btnCopyMemo.addEventListener('click', async () => {
      const id = btnCopyMemo.getAttribute('data-id');
      const memo = state.memos.find((m) => m.id === id);
      if (memo) {
        await navigator.clipboard.writeText(memo.content || memo.title);
        btnCopyMemo.textContent = '✅ 已复制';
        setTimeout(() => {
          btnCopyMemo.textContent = '📋 复制原文';
        }, 1200);
      }
    });
  }

  const btnReclassify = document.getElementById('btn-reclassify-memo');
  if (btnReclassify) {
    btnReclassify.addEventListener('click', async () => {
      const id = btnReclassify.getAttribute('data-id');
      btnReclassify.textContent = '⏳ AI 分析中...';
      btnReclassify.disabled = true;
      try {
        const res = await Bridge.reclassifyMemo(id);
        state.memos = state.memos.map((m) => (m.id === id ? res.memo : m));
      } catch (err) {
        alert(`重新归类失败：${err.message}`);
      } finally {
        render();
      }
    });
  }

  const btnDeleteMemo = document.getElementById('btn-delete-memo');
  if (btnDeleteMemo) {
    btnDeleteMemo.addEventListener('click', async () => {
      const id = btnDeleteMemo.getAttribute('data-id');
      if (!confirm('确定要删除这条记录及其对应的本地 Markdown 文件吗？')) return;
      await Bridge.deleteMemo(id);
      state.memos = state.memos.filter((m) => m.id !== id);
      state.activeMemoId = state.memos[0]?.id || null;
      render();
    });
  }

  // 设置页事件
  const btnExportZip = document.getElementById('btn-export-vault-zip');
  if (btnExportZip) {
    btnExportZip.addEventListener('click', handleExportVaultZip);
  }

  const btnOpenVaultSettings = document.getElementById('btn-open-vault-in-settings');
  if (btnOpenVaultSettings) {
    btnOpenVaultSettings.addEventListener('click', () => {
      const val = document.getElementById('cfg-vault-path')?.value;
      Bridge.openInExplorer(val);
    });
  }

  const btnLinkExistingRepo = document.getElementById('btn-link-existing-repo');
  if (btnLinkExistingRepo) {
    btnLinkExistingRepo.addEventListener('click', async () => {
      const repoUrl = document.getElementById('cfg-vault-git-url')?.value.trim() || '';
      const autoSync = document.getElementById('cfg-vault-git-autosync')?.checked ?? false;
      if (!repoUrl) {
        alert('请先输入 GitHub 私有仓库地址');
        return;
      }
      state.gitSyncing = true;
      state.gitFeedback = null;
      render();
      try {
        const res = await Bridge.linkVaultGit({
          repoUrl,
          autoCreatePrivate: false,
          autoSync
        });
        state.vaultGitStatus = res.status;
        state.gitFeedback = {
          ok: true,
          text: `✅ 已成功绑定远程私有仓库 (${res.remoteUrl}) 并完成首次云端推送！`
        };
      } catch (err) {
        state.gitFeedback = {
          ok: false,
          text: `❌ 绑定推送失败：${err.message}`
        };
      } finally {
        state.gitSyncing = false;
        render();
      }
    });
  }

  const btnAutoCreateRepo = document.getElementById('btn-auto-create-private-repo');
  if (btnAutoCreateRepo) {
    btnAutoCreateRepo.addEventListener('click', async () => {
      const autoSync = document.getElementById('cfg-vault-git-autosync')?.checked ?? true;
      state.gitSyncing = true;
      state.gitFeedback = null;
      render();
      try {
        const res = await Bridge.linkVaultGit({
          autoCreatePrivate: true,
          repoName: 'quick-memo-vault',
          autoSync
        });
        state.vaultGitStatus = res.status;
        state.config = await Bridge.getConfig();
        state.gitFeedback = {
          ok: true,
          text: `🎉 已自动在你的 GitHub 账号下创建私有仓库 ${res.remoteUrl} 并推送全部本地 Markdown 笔记！`
        };
      } catch (err) {
        state.gitFeedback = {
          ok: false,
          text: `❌ 自动创建失败：${err.message}`
        };
      } finally {
        state.gitSyncing = false;
        render();
      }
    });
  }

  const btnGitPush = document.getElementById('btn-vault-git-push');
  if (btnGitPush) {
    btnGitPush.addEventListener('click', async () => {
      state.gitSyncing = true;
      state.gitFeedback = null;
      render();
      try {
        const res = await Bridge.syncVaultGit('push');
        state.vaultGitStatus = res.status;
        state.gitFeedback = {
          ok: true,
          text: `✅ 已推送同步到 GitHub 私有库 (${res.syncedAt})`
        };
      } catch (err) {
        state.gitFeedback = {
          ok: false,
          text: `❌ 推送失败：${err.message}`
        };
      } finally {
        state.gitSyncing = false;
        render();
      }
    });
  }

  const btnGitPull = document.getElementById('btn-vault-git-pull');
  if (btnGitPull) {
    btnGitPull.addEventListener('click', async () => {
      state.gitSyncing = true;
      state.gitFeedback = null;
      render();
      try {
        const res = await Bridge.syncVaultGit('pull');
        state.vaultGitStatus = res.status;
        state.memos = await Bridge.listMemos();
        await refreshIndexStats();
        state.gitFeedback = {
          ok: true,
          text: `✅ 已从 GitHub 私有库拉取最新笔记并更新索引 (${res.syncedAt})`
        };
      } catch (err) {
        state.gitFeedback = {
          ok: false,
          text: `❌ 拉取失败：${err.message}`
        };
      } finally {
        state.gitSyncing = false;
        render();
      }
    });
  }

  const btnTestLlm = document.getElementById('btn-test-llm');
  if (btnTestLlm) {
    btnTestLlm.addEventListener('click', async () => {
      const statusEl = document.getElementById('llm-test-status');
      const baseUrl = document.getElementById('cfg-llm-baseurl')?.value.trim() || '';
      const apiKey = document.getElementById('cfg-llm-apikey')?.value.trim() || '';
      const model = document.getElementById('cfg-llm-model')?.value.trim() || '';
      btnTestLlm.disabled = true;
      btnTestLlm.textContent = '⏳ 正在连接测试...';
      if (statusEl) {
        statusEl.className = 'llm-test-status';
        statusEl.textContent = '正在请求 OpenAI 兼容接口...';
      }
      try {
        const res = await Bridge.testLlmConnection({ baseUrl, apiKey, model });
        if (statusEl) {
          statusEl.className = 'llm-test-status ok';
          statusEl.textContent = `✅ 连接成功！耗时 ${res.latencyMs}ms · 端点: ${res.endpoint} · 模型返回: ${res.reply}`;
        }
      } catch (err) {
        if (statusEl) {
          statusEl.className = 'llm-test-status err';
          let hint = err.message;
          if (baseUrl.includes('deepseek.com') && apiKey && !apiKey.startsWith('sk-')) {
            hint += '（提示：DeepSeek 官方 API Key 通常以 sk- 开头，当前填入的 UUID 格式可能不是有效的 DeepSeek Key）';
          }
          statusEl.textContent = `❌ 连接失败：${hint}`;
        }
      } finally {
        btnTestLlm.disabled = false;
        btnTestLlm.textContent = '🔌 测试 OpenAI 兼容接口连接';
      }
    });
  }

  const btnSaveSettings = document.getElementById('btn-save-settings');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      const enabled = document.getElementById('cfg-llm-enabled')?.checked ?? true;
      const baseUrl = document.getElementById('cfg-llm-baseurl')?.value.trim() || '';
      const apiKey = document.getElementById('cfg-llm-apikey')?.value.trim() || '';
      const model = document.getElementById('cfg-llm-model')?.value.trim() || '';
      const customSystemPrompt = document.getElementById('cfg-llm-prompt')?.value.trim() || '';
      const vaultPath = document.getElementById('cfg-vault-path')?.value.trim() || state.config.vaultPath;

      const catRows = document.querySelectorAll('.cat-config-row');
      const categories = [];
      catRows.forEach((row) => {
        const icon = row.querySelector('.cat-input-icon')?.value.trim() || '📁';
        const id = row.querySelector('.cat-input-id')?.value.trim();
        const name = row.querySelector('.cat-input-name')?.value.trim();
        const desc = row.querySelector('.cat-input-desc')?.value.trim();
        if (id && name) {
          categories.push({ id, name, icon, desc });
        }
      });

      const saved = await Bridge.saveConfig({
        ...state.config,
        vaultPath,
        vaultGit: {
          ...(state.config.vaultGit || {}),
          remoteUrl: document.getElementById('cfg-vault-git-url')?.value.trim() || state.config.vaultGit?.remoteUrl || '',
          autoSync: document.getElementById('cfg-vault-git-autosync')?.checked ?? false
        },
        llm: {
          ...state.config.llm,
          enabled,
          baseUrl,
          apiKey,
          model,
          customSystemPrompt
        },
        categories
      });
      state.config = saved;
      state.memos = await Bridge.listMemos();
      refreshIndexStats();
      btnSaveSettings.textContent = '✅ 设置已保存生效';
      setTimeout(() => render(), 800);
    });
  }

  // 聊天泡泡与寻物助手事件绑定
  const btnToggleChat = document.getElementById('btn-toggle-chat-bubble');
  if (btnToggleChat) {
    btnToggleChat.addEventListener('click', () => {
      state.chatOpen = !state.chatOpen;
      render();
      if (state.chatOpen) {
        focusChatInput();
        refreshIndexStats();
      }
    });
  }

  const btnCloseChat = document.getElementById('btn-close-chat-panel');
  if (btnCloseChat) {
    btnCloseChat.addEventListener('click', () => {
      state.chatOpen = false;
      render();
    });
  }

  const btnClearChat = document.getElementById('btn-clear-chat');
  if (btnClearChat) {
    btnClearChat.addEventListener('click', () => {
      state.chatMessages = [];
      render();
      focusChatInput();
    });
  }

  const btnRebuildIndex = document.getElementById('btn-rebuild-doc-index');
  if (btnRebuildIndex) {
    btnRebuildIndex.addEventListener('click', async () => {
      if (state.rebuildingIndex) return;
      state.rebuildingIndex = true;
      render();
      try {
        const stats = await Bridge.rebuildIndex();
        state.indexStats = stats;
      } catch (err) {
        alert(`重建索引失败：${err.message}`);
      } finally {
        state.rebuildingIndex = false;
        render();
        focusChatInput();
      }
    });
  }

  document.querySelectorAll('[data-chat-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-chat-prompt');
      if (prompt) {
        handleSendChatMessage(prompt);
      }
    });
  });

  document.querySelectorAll('[data-chat-jump-memo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const memoId = btn.getAttribute('data-chat-jump-memo');
      state.activeMemoId = memoId;
      state.selectedCategory = 'ALL';
      state.selectedType = 'all';
      state.selectedTag = '';
      state.searchQuery = '';
      state.activeTab = 'vault';
      render();
    });
  });

  const chatInput = document.getElementById('chat-composer-input');
  if (chatInput) {
    chatInput.addEventListener('input', (e) => {
      state.chatDraft = e.target.value;
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendChatMessage();
      }
    });
  }

  const btnSendChat = document.getElementById('btn-send-chat');
  if (btnSendChat) {
    btnSendChat.addEventListener('click', () => handleSendChatMessage());
  }
}

// 全局窗口快捷键
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === '1') {
    e.preventDefault();
    state.activeTab = 'capture';
    render();
    focusCaptureInput();
  } else if (e.altKey && e.key === '2') {
    e.preventDefault();
    state.activeTab = 'vault';
    render();
  } else if (e.altKey && e.key === '3') {
    e.preventDefault();
    state.chatOpen = !state.chatOpen;
    render();
    if (state.chatOpen) focusChatInput();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (state.pdfModal) {
      state.pdfModal = null;
      render();
      return;
    }
    if (state.precheckModal) {
      state.precheckModal = null;
      render();
      focusCaptureInput();
      return;
    }
    if (state.chatOpen) {
      state.chatOpen = false;
      render();
      return;
    }
    Bridge.sendWindowCommand('hide');
  } else if (e.key === '/' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    state.activeTab = 'vault';
    render();
    setTimeout(() => document.getElementById('vault-search-input')?.focus(), 20);
  }
});

// 点击聊天面板外部空白处自动收起寻物助手
document.addEventListener('mousedown', (e) => {
  if (!state.chatOpen) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest('#chat-panel') ||
    target.closest('#btn-toggle-chat-bubble') ||
    target.closest('#pdf-modal-backdrop')
  ) {
    return;
  }
  state.chatOpen = false;
  render();
});

window.addEventListener('focus', () => {
  if (state.activeTab === 'capture') {
    focusCaptureInput();
  }
});

init();

import { Bridge } from './bridge.js';

const LLM_PRESETS = {
  deepseek: {
    label: 'DeepSeek (推荐·高性价比)',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct'
  },
  dashscope: {
    label: '阿里云·通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  openai: {
    label: 'OpenAI 官方/中转',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  ollama: {
    label: 'Ollama 本地模型 (免 Key)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b'
  }
};

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
  isEditingDetail: false
};

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  for (const file of Array.from(fileList)) {
    const dataBase64 = await fileToBase64(file);
    state.draftAttachments.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: file.name || `截图_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`,
      mimeType: file.type || 'application/octet-stream',
      size: file.size || 0,
      dataBase64
    });
  }
  render();
}

async function init() {
  state.loading = true;
  render();
  try {
    const [config, memos] = await Promise.all([
      Bridge.getConfig(),
      Bridge.listMemos()
    ]);
    state.config = config;
    state.memos = memos;
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

function focusCaptureInput() {
  setTimeout(() => {
    const el = document.getElementById('capture-textarea');
    if (el) el.focus();
  }, 30);
}

async function handleSubmitCapture() {
  const content = state.draftContent.trim();
  const rawAttachments = state.draftAttachments;
  if (!content && rawAttachments.length === 0) {
    return;
  }
  if (state.saving) return;

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
        <div class="brand-logo">⚡</div>
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

        ${state.draftAttachments.length > 0 ? `
          <div class="draft-attachments">
            ${state.draftAttachments.map((att) => `
              <div class="draft-att-chip">
                ${att.mimeType.startsWith('image/')
                  ? `<img src="${att.dataBase64}" class="draft-att-thumb" alt="${escapeHtml(att.name)}" />`
                  : `<span class="draft-att-icon">📎</span>`
                }
                <div class="draft-att-info">
                  <div class="draft-att-name">${escapeHtml(att.name)}</div>
                  <div class="draft-att-size">${formatSize(att.size)}</div>
                </div>
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
  return `
    <div class="saved-toast">
      <div class="toast-main">
        <span class="toast-badge">✅ 已归档为 Markdown</span>
        <strong>${escapeHtml(memo.title)}</strong>
        <span class="toast-arrow">→</span>
        <span class="cat-pill">📂 ${escapeHtml(memo.category)}</span>
        ${(memo.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('')}
      </div>
      <div class="toast-actions">
        <button class="mini-btn" data-open-md="${escapeHtml(memo.mdAbsPath)}">在文件夹中定位</button>
        <button class="mini-btn" data-inspect-memo="${escapeHtml(memo.id)}">查看详情</button>
      </div>
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

        <div class="detail-content-section">
          <div class="section-caption">原始记录内容（可直接编辑并保存）</div>
          <textarea id="detail-content-textarea" class="detail-content-editor" rows="10">${escapeHtml(memo.content || '')}</textarea>
          <div class="editor-save-bar">
            <button class="mini-btn primary" id="btn-save-detail-edit" data-id="${escapeHtml(memo.id)}">💾 保存修改到本地 Markdown</button>
          </div>
        </div>

        ${memo.attachments && memo.attachments.length > 0 ? `
          <div class="detail-attachments-section">
            <div class="section-caption">归档附件 (${memo.attachments.length})</div>
            <div class="detail-att-list">
              ${memo.attachments.map((att) => `
                <div class="detail-att-card">
                  ${(att.mimeType || '').startsWith('image/') ? `
                    <img src="${Bridge.getAssetUrl(att.absPath)}" class="detail-image-preview" alt="${escapeHtml(att.name)}" />
                  ` : ''}
                  <div class="detail-att-bar">
                    <span>📎 ${escapeHtml(att.name)} (${formatSize(att.size)})</span>
                    <button class="mini-btn" data-open-md="${escapeHtml(att.absPath)}">打开所在位置</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
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
        <h3>🤖 LLM 自动分类模型设置</h3>
        <p class="settings-hint">支持任意 OpenAI 兼容接口（DeepSeek、硅基流动、通义千问、OpenAI 或本地 Ollama）。配置后每次随手丢入内容都会由大模型自动起标题、提炼摘要并归入对应分类文件夹。</p>

        <div class="preset-row">
          ${Object.entries(LLM_PRESETS).map(([key, p]) => `
            <button class="preset-chip ${llm.providerPreset === key ? 'active' : ''}" data-preset="${key}">
              ${escapeHtml(p.label)}
            </button>
          `).join('')}
        </div>

        <div class="form-grid">
          <label class="form-field">
            <span>启用 LLM 自动分类</span>
            <input type="checkbox" id="cfg-llm-enabled" ${llm.enabled !== false ? 'checked' : ''} />
          </label>

          <label class="form-field full">
            <span>API Base URL</span>
            <input type="text" id="cfg-llm-baseurl" value="${escapeHtml(llm.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" />
          </label>

          <label class="form-field">
            <span>API Key ${llm.providerPreset === 'ollama' ? '(本地 Ollama 可随便填 ollama)' : ''}</span>
            <input type="password" id="cfg-llm-apikey" value="${escapeHtml(llm.apiKey || '')}" placeholder="sk-..." />
          </label>

          <label class="form-field">
            <span>模型名称 (Model ID)</span>
            <input type="text" id="cfg-llm-model" value="${escapeHtml(llm.model || '')}" placeholder="deepseek-chat" />
          </label>

          <label class="form-field full">
            <span>补充分类偏好提示词（可选，告诉 AI 你的特殊归类习惯）</span>
            <input type="text" id="cfg-llm-prompt" value="${escapeHtml(llm.customSystemPrompt || '')}" placeholder="例如：凡是涉及股票代码的归入工作与待办；提示词模板归入技术与代码..." />
          </label>
        </div>
      </section>

      <section class="settings-card">
        <h3>📂 本地 Markdown 仓库路径 (Obsidian 兼容)</h3>
        <p class="settings-hint">所有记录都会直接生成带 Frontmatter 的 <code>.md</code> 文件并按分类建子文件夹。你可以直接将此路径指向你的 Obsidian 仓库目录！</p>
        <div class="vault-path-row">
          <input type="text" id="cfg-vault-path" value="${escapeHtml(cfg.vaultPath || '')}" />
          <button class="tool-btn" id="btn-open-vault-in-settings">在资源管理器中查看</button>
        </div>
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
      state.draftContent = e.target.value;
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

  const btnSubmit = document.getElementById('btn-submit-memo');
  if (btnSubmit) {
    btnSubmit.addEventListener('click', handleSubmitCapture);
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
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-preset');
      const preset = LLM_PRESETS[key];
      if (!preset) return;
      state.config.llm = {
        ...state.config.llm,
        providerPreset: key,
        baseUrl: preset.baseUrl,
        model: preset.model,
        apiKey: key === 'ollama' && !state.config.llm.apiKey ? 'ollama' : state.config.llm.apiKey
      };
      render();
    });
  });

  const btnOpenVaultSettings = document.getElementById('btn-open-vault-in-settings');
  if (btnOpenVaultSettings) {
    btnOpenVaultSettings.addEventListener('click', () => {
      const val = document.getElementById('cfg-vault-path')?.value;
      Bridge.openInExplorer(val);
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
      btnSaveSettings.textContent = '✅ 设置已保存生效';
      setTimeout(() => render(), 800);
    });
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
  } else if (e.key === '/' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    state.activeTab = 'vault';
    render();
    setTimeout(() => document.getElementById('vault-search-input')?.focus(), 20);
  }
});

init();

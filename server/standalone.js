import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getConfig,
  saveConfig,
  listMemos,
  saveMemo,
  updateMemo,
  deleteMemo,
  renameAttachment,
  openInExplorer
} from './vault-manager.js';
import { classifyWithLLM, heuristicClassify, testLlmConnection, smartRenameUploadedFile } from './llm-classifier.js';
import {
  ensureDocIndexSynced,
  rebuildDocIndex,
  getDocIndexStatus,
  indexSingleMemo,
  removeMemoFromDocIndex
} from './doc-indexer.js';
import { askVaultAssistant } from './chat-assistant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 确保图标存在（供 Tauri 打包使用）
export function ensureTauriIcons() {
  const iconDir = path.join(ROOT, 'src-tauri', 'icons');
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true });
  }
  const pngPath = path.join(iconDir, 'icon.png');
  const icoPath = path.join(iconDir, 'icon.ico');
  if (fs.existsSync(pngPath) && fs.existsSync(icoPath)) return;

  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const w = 64, h = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * (1 + w * 4) + 1 + x * 4;
      raw[idx] = 37;
      raw[idx + 1] = 99;
      raw[idx + 2] = 235;
      raw[idx + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(pngPath, png);

  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(0, 0);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(1, 4);
  icoHeader[6] = w;
  icoHeader[7] = h;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(png.length, 14);
  icoHeader.writeUInt32LE(22, 18);
  fs.writeFileSync(icoPath, Buffer.concat([icoHeader, png]));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function startStandaloneServer(port = 1420, openWindow = false) {
  ensureTauriIcons();
  getConfig(); // 初始化默认配置和 vault 分类目录
  setTimeout(() => {
    try {
      const st = getDocIndexStatus();
      console.log(`[QuickMemo] 全文文档索引已就绪: ${st.totalDocs} 篇记录, ${st.totalChunks} 个检索片段`);
    } catch (e) {
      console.warn('[QuickMemo] 初始化文档索引失败:', e.message);
    }
  }, 100);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/api/asset') {
      const filePath = url.searchParams.get('path');
      if (!filePath || !fs.existsSync(filePath)) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf'
      };
      res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
      if (ext === '.pdf') {
        res.setHeader('Content-Disposition', 'inline');
      }
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        if (url.pathname === '/api/config' && req.method === 'GET') {
          return sendJson(res, 200, getConfig());
        }
        if (url.pathname === '/api/config' && req.method === 'POST') {
          const body = await readJsonBody(req);
          return sendJson(res, 200, saveConfig(body));
        }
        if (url.pathname === '/api/memos' && req.method === 'GET') {
          return sendJson(res, 200, listMemos());
        }
        if (url.pathname === '/api/llm/test' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await testLlmConnection(body.llm);
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/files/smart-rename' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = await smartRenameUploadedFile(body.attachment || {}, body.noteText || '');
          return sendJson(res, 200, result);
        }
        if (url.pathname === '/api/memos/quick-save' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const config = getConfig();
          const rawAttachments = body.rawAttachments || [];

          const classification = body.manualCategory
            ? {
                ...heuristicClassify({
                  content: body.content,
                  attachments: rawAttachments,
                  categories: config.categories
                }),
                category: body.manualCategory
              }
            : await classifyWithLLM({
                content: body.content,
                attachments: rawAttachments
              });

          // 自动用 AI 或文档内容提取器生成的清晰文件名重命名上传的附件
          const renamedRawAttachments = rawAttachments.map((att, idx) => ({
            ...att,
            name: (classification.renamedFiles && classification.renamedFiles[idx]) || att.name
          }));

          const autoContent = (body.content || '').trim() ||
            (classification.extractedPreview ? `### 📄 文档内容提取预览\n\n${classification.extractedPreview}` : '');

          const saved = saveMemo({
            content: autoContent,
            rawAttachments: renamedRawAttachments,
            category: body.manualCategory || classification.category,
            title: body.manualTitle || classification.title,
            summary: classification.summary,
            tags: classification.tags,
            aiClassified: classification.aiClassified
          });
          try {
            indexSingleMemo(saved);
          } catch {}

          return sendJson(res, 200, { memo: saved, classification });
        }
        if (url.pathname === '/api/memos/reclassify' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const memos = listMemos();
          const target = memos.find((m) => m.id === body.id);
          if (!target) return sendJson(res, 404, { error: '找不到该记录' });
          const classification = await classifyWithLLM({
            content: target.content,
            attachments: target.attachments || []
          });

          // 如果包含附件且自动生成了更有意义的文件名，同步重命名磁盘上的附件
          if (Array.isArray(target.attachments) && Array.isArray(classification.renamedFiles)) {
            for (let i = 0; i < target.attachments.length; i++) {
              const newFileName = classification.renamedFiles[i];
              if (newFileName && newFileName !== target.attachments[i].name) {
                try {
                  renameAttachment(target.id, i, newFileName);
                } catch {}
              }
            }
          }

          const nextContent = (target.content || '').trim() ||
            (classification.extractedPreview ? `### 📄 文档内容提取预览\n\n${classification.extractedPreview}` : '');

          const updated = updateMemo(target.id, {
            category: classification.category,
            title: classification.title,
            content: nextContent,
            summary: classification.summary,
            tags: classification.tags,
            aiClassified: classification.aiClassified
          });
          try {
            indexSingleMemo(updated);
          } catch {}
          return sendJson(res, 200, { memo: updated, classification });
        }
        if (url.pathname === '/api/memos/update' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const updated = updateMemo(body.id, body.patch || {});
          try {
            indexSingleMemo(updated);
          } catch {}
          return sendJson(res, 200, { memo: updated });
        }
        if (url.pathname === '/api/memos/rename-attachment' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const updated = renameAttachment(body.id, Number(body.attIndex), body.newName);
          try {
            indexSingleMemo(updated);
          } catch {}
          return sendJson(res, 200, { memo: updated });
        }
        if (url.pathname === '/api/memos/delete' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const delRes = deleteMemo(body.id);
          try {
            removeMemoFromDocIndex(body.id);
          } catch {}
          return sendJson(res, 200, delRes);
        }
        if (url.pathname === '/api/index/status' && req.method === 'GET') {
          return sendJson(res, 200, getDocIndexStatus());
        }
        if (url.pathname === '/api/index/rebuild' && req.method === 'POST') {
          return sendJson(res, 200, rebuildDocIndex());
        }
        if (url.pathname === '/api/chat/ask' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const answer = await askVaultAssistant({
            message: body.message || '',
            history: body.history || []
          });
          return sendJson(res, 200, answer);
        }
        if (url.pathname === '/api/open-explorer' && req.method === 'POST') {
          const body = await readJsonBody(req);
          openInExplorer(body.path);
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/window-cmd' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const cmdFile = path.join(ROOT, '.window-cmd.json');
          fs.writeFileSync(cmdFile, JSON.stringify({ cmd: body.cmd, time: Date.now() }), 'utf-8');
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: 'Not found' });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // 静态文件服务（零依赖直接运行前端）
    let relPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const distFile = path.join(ROOT, 'dist', relPath);
    const rootFile = path.join(ROOT, relPath);
    const targetFile = fs.existsSync(distFile) ? distFile : rootFile;

    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.ico': 'image/x-icon'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      fs.createReadStream(targetFile).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const appUrl = `http://127.0.0.1:${port}`;
    console.log(`[QuickMemo] 本地服务已启动: ${appUrl}`);
    if (openWindow) {
      // 使用 Edge --app 模式打开独立桌面窗口（与 Tauri WebView2 相同的底层渲染引擎）
      exec(`start msedge --app="${appUrl}" --window-size=1080,740`, (err) => {
        if (err) {
          exec(`start "" "${appUrl}"`);
        }
      });
    }
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const shouldOpen = process.argv.includes('--open');
  startStandaloneServer(1420, shouldOpen);
}

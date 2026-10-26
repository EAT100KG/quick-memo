import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, openInExplorer } from './vault-manager.js';
import { rebuildDocIndex } from './doc-indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');

function formatBytes(bytes = 0) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function nowCompact() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function nowReadable() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 一键将本地 Markdown 知识库目录 (vaultPath) 下的所有文件打包为 .zip 压缩包并打开资源管理器定位
 */
export function exportVaultToZip() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`找不到本地仓库目录: ${vaultPath}`);
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const zipFileName = `QuickMemo-Vault-Backup_${nowCompact()}.zip`;
  const zipAbsPath = path.join(BACKUP_DIR, zipFileName);

  // 优先使用 Python zipfile 打包（完美支持 UTF-8 中文路径，且自动跳过 .git 目录减小体积）
  const pyScript = `
import os, sys, zipfile, json

vault_dir = sys.argv[1]
zip_path = sys.argv[2]
file_count = 0

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(vault_dir):
        if '.git' in dirs:
            dirs.remove('.git')
        for f in files:
            if f in ('Thumbs.db', '.DS_Store'):
                continue
            abs_p = os.path.join(root, f)
            rel_p = os.path.relpath(abs_p, vault_dir)
            zf.write(abs_p, rel_p)
            file_count += 1

print(json.dumps({"fileCount": file_count}))
`;

  let fileCount = 0;
  try {
    const stdout = execFileSync('python', ['-X', 'utf8', '-c', pyScript, vaultPath, zipAbsPath], {
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true
    });
    const parsed = JSON.parse(stdout.trim());
    fileCount = parsed.fileCount || 0;
  } catch {
    // 回退使用 PowerShell Compress-Archive
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path "${vaultPath}\\*" -DestinationPath "${zipAbsPath}" -Force`
      ],
      { timeout: 30000, windowsHide: true }
    );
  }

  const stat = fs.statSync(zipAbsPath);
  // 自动在 Windows 资源管理器中高亮选中打包好的 .zip 文件
  openInExplorer(zipAbsPath);

  return {
    ok: true,
    zipFileName,
    zipAbsPath,
    fileCount,
    sizeBytes: stat.size,
    sizeFormatted: formatBytes(stat.size),
    exportedAt: nowReadable()
  };
}

function runGitInVault(vaultPath, args = []) {
  return execFileSync('git', args, {
    cwd: vaultPath,
    encoding: 'utf-8',
    timeout: 25000,
    windowsHide: true
  }).trim();
}

function ensureGitIdentity(vaultPath) {
  try {
    runGitInVault(vaultPath, ['config', 'core.quotepath', 'false']);
    runGitInVault(vaultPath, ['config', 'core.longpaths', 'true']);
  } catch {}
  try {
    const name = runGitInVault(vaultPath, ['config', 'user.name']);
    const email = runGitInVault(vaultPath, ['config', 'user.email']);
    if (name && email) return;
  } catch {}
  try {
    runGitInVault(vaultPath, ['config', 'user.name', 'QuickMemo Vault']);
    runGitInVault(vaultPath, ['config', 'user.email', 'vault@quickmemo.local']);
  } catch {}
}

function commitLocalVaultChanges(vaultPath, message) {
  ensureGitIdentity(vaultPath);
  runGitInVault(vaultPath, ['add', '-A']);
  const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
  if (statusOut) {
    runGitInVault(vaultPath, ['commit', '-m', message]);
    return true;
  }
  return false;
}

/**
 * 拉取并合并远程 origin/main 分支（支持换新电脑绑定已有仓库时的不相关历史自动合并）
 */
function pullAndMergeRemoteMain(vaultPath) {
  ensureGitIdentity(vaultPath);
  commitLocalVaultChanges(vaultPath, `backup: local save before sync ${nowReadable()}`);

  try {
    runGitInVault(vaultPath, ['fetch', 'origin']);
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes("couldn't find remote ref") || msg.includes('does not appear to be a git repository')) {
      return false;
    }
    throw new Error(`连接远程仓库失败：${msg}`);
  }

  let hasRemoteMain = false;
  try {
    const rev = runGitInVault(vaultPath, ['rev-parse', '--verify', 'origin/main']);
    hasRemoteMain = Boolean(rev);
  } catch {
    hasRemoteMain = false;
  }
  if (!hasRemoteMain) {
    return false;
  }

  let hasLocalHead = false;
  try {
    const headRev = runGitInVault(vaultPath, ['rev-parse', '--verify', 'HEAD']);
    hasLocalHead = Boolean(headRev);
  } catch {
    hasLocalHead = false;
  }

  if (!hasLocalHead) {
    runGitInVault(vaultPath, ['reset', '--hard', 'origin/main']);
    rebuildDocIndex();
    return true;
  }

  try {
    runGitInVault(vaultPath, [
      'merge',
      'origin/main',
      '--allow-unrelated-histories',
      '-X',
      'theirs',
      '--no-edit',
      '-m',
      `chore: merge remote vault ${nowReadable()}`
    ]);
  } catch (mergeErr) {
    try {
      runGitInVault(vaultPath, ['checkout', '--theirs', '.']);
      runGitInVault(vaultPath, ['add', '-A']);
      runGitInVault(vaultPath, ['commit', '-m', `chore: resolve remote vault merge ${nowReadable()}`]);
    } catch {
      try {
        runGitInVault(vaultPath, ['merge', '--abort']);
      } catch {}
      throw new Error(`合并远程知识库失败：${mergeErr.message}`);
    }
  }

  rebuildDocIndex();
  return true;
}

function maskRemoteUrl(rawUrl = '') {
  return String(rawUrl || '').replace(/https:\/\/([^/@:]+):([^/@]+)@/i, 'https://');
}

function detectGitProvider(url = '') {
  const u = String(url || '').toLowerCase();
  if (u.includes('gitee.com')) return 'gitee';
  if (u.includes('github.com')) return 'github';
  return u ? 'custom' : '';
}

function injectGiteeTokenToUrl(repoUrl = '', token = '') {
  const cleanUrl = maskRemoteUrl(repoUrl).trim();
  const cleanToken = String(token || '').trim();
  if (!cleanToken || !/^https:\/\/gitee\.com\//i.test(cleanUrl)) {
    return cleanUrl;
  }
  return cleanUrl.replace(/^https:\/\/gitee\.com\//i, `https://oauth2:${encodeURIComponent(cleanToken)}@gitee.com/`);
}

/**
 * 获取本地 Vault 目录关联的独立 Git 私有仓库状态（支持 Gitee 码云 & GitHub）
 */
export function getVaultGitStatus() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  const isGitInitialized = fs.existsSync(gitDir);

  let rawRemoteUrl = '';
  let pendingChanges = 0;
  let lastCommit = '';
  let branch = 'main';

  if (isGitInitialized) {
    try {
      rawRemoteUrl = runGitInVault(vaultPath, ['remote', 'get-url', 'origin']);
    } catch {}
    try {
      branch = runGitInVault(vaultPath, ['branch', '--show-current']) || 'main';
    } catch {}
    try {
      const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
      pendingChanges = statusOut ? statusOut.split(/\r?\n/).filter(Boolean).length : 0;
    } catch {}
    try {
      lastCommit = runGitInVault(vaultPath, ['log', '-1', '--format=%cd · %s', '--date=format:%Y-%m-%d %H:%M']);
    } catch {}
  }

  const remoteUrl = maskRemoteUrl(rawRemoteUrl);
  const provider = detectGitProvider(remoteUrl) || config.vaultGit?.provider || 'gitee';

  let ghUser = '';
  try {
    ghUser = execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    }).trim();
  } catch {}

  return {
    vaultPath,
    isGitInitialized,
    remoteUrl,
    provider,
    branch,
    pendingChanges,
    lastCommit,
    ghUser,
    hasGiteeToken: Boolean(config.vaultGit?.giteeToken),
    autoSyncEnabled: Boolean(config.vaultGit?.autoSync)
  };
}

/**
 * 初始化 Vault 独立 Git 仓库，并支持一键创建或关联 Gitee (国内码云) / GitHub 私有仓库
 */
export async function linkVaultToGitHub({
  provider = '',
  repoUrl = '',
  giteeToken = '',
  autoCreatePrivate = false,
  repoName = 'quick-memo-vault',
  autoSync = false
}) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  if (!fs.existsSync(vaultPath)) {
    fs.mkdirSync(vaultPath, { recursive: true });
  }

  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    runGitInVault(vaultPath, ['init']);
    try {
      runGitInVault(vaultPath, ['branch', '-M', 'main']);
    } catch {}
  }
  ensureGitIdentity(vaultPath);

  // 确保 vault 内部有一个干净的 .gitignore（只忽略系统垃圾文件，保留所有 .md 和 assets）
  const vaultGitignore = path.join(vaultPath, '.gitignore');
  if (!fs.existsSync(vaultGitignore)) {
    fs.writeFileSync(vaultGitignore, '.DS_Store\nThumbs.db\n', 'utf-8');
  }

  const resolvedToken = String(giteeToken || config.vaultGit?.giteeToken || '').trim();
  let targetRemoteUrl = String(repoUrl || '').trim();
  const chosenProvider = provider || detectGitProvider(targetRemoteUrl) || 'gitee';

  if (autoCreatePrivate) {
    const cleanRepoName = String(repoName || 'quick-memo-vault').trim().replace(/[^a-zA-Z0-9._-]/g, '-');

    if (chosenProvider === 'gitee') {
      if (!resolvedToken) {
        throw new Error('一键在 Gitee 自动创建私有仓库需要先填写「Gitee 私人令牌 (Access Token)」，或者你也可以直接在 Gitee 网页端新建私有库后粘贴地址绑定');
      }

      // 1. 获取 Gitee 当前登录用户名
      const userRes = await fetch(`https://gitee.com/api/v5/user?access_token=${encodeURIComponent(resolvedToken)}`, {
        signal: AbortSignal.timeout(10000)
      });
      if (!userRes.ok) {
        throw new Error(`Gitee 私人令牌校验失败 (HTTP ${userRes.status})，请检查 Token 是否正确并勾选了 projects 权限`);
      }
      const userData = await userRes.json();
      const giteeLogin = userData.login;
      if (!giteeLogin) {
        throw new Error('未能获取到 Gitee 用户名');
      }

      // 2. 检查仓库是否已存在，若不存在则自动创建私有仓库
      const checkRes = await fetch(
        `https://gitee.com/api/v5/repos/${encodeURIComponent(giteeLogin)}/${encodeURIComponent(cleanRepoName)}?access_token=${encodeURIComponent(resolvedToken)}`,
        { signal: AbortSignal.timeout(10000) }
      );

      if (!checkRes.ok) {
        const createRes = await fetch('https://gitee.com/api/v5/user/repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({
            access_token: resolvedToken,
            name: cleanRepoName,
            description: 'QuickMemo 私人闪念与本地 Markdown 知识库云备份（私有仓库）',
            private: true,
            auto_init: false
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (!createRes.ok) {
          const errText = await createRes.text();
          throw new Error(`在 Gitee 创建私有仓库失败：${errText}`);
        }
      }

      targetRemoteUrl = `https://gitee.com/${giteeLogin}/${cleanRepoName}.git`;
    } else {
      // GitHub 自动创建私有仓库
      const ghUser = execFileSync('gh', ['api', 'user', '-q', '.login'], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true
      }).trim();

      if (!ghUser) {
        throw new Error('未检测到本机 gh 登录状态，请手动填入私有仓库地址或切换为国内 Gitee 码云');
      }

      const fullSlug = `${ghUser}/${cleanRepoName}`;
      let exists = false;
      try {
        execFileSync('gh', ['repo', 'view', fullSlug, '--json', 'name'], {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true
        });
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        execFileSync(
          'gh',
          [
            'repo',
            'create',
            fullSlug,
            '--private',
            '--description',
            'QuickMemo 私人闪念与本地 Markdown 知识库云备份（私有仓库）'
          ],
          {
            encoding: 'utf-8',
            timeout: 15000,
            windowsHide: true
          }
        );
      }

      targetRemoteUrl = `https://github.com/${fullSlug}.git`;
    }
  }

  if (!targetRemoteUrl) {
    throw new Error('请填写 Gitee 或 GitHub 私有仓库地址，或点击一键创建私有仓库');
  }

  const displayRemoteUrl = maskRemoteUrl(targetRemoteUrl);
  const gitAuthRemoteUrl = injectGiteeTokenToUrl(displayRemoteUrl, resolvedToken);

  // 设置或更新 origin 远程地址
  try {
    runGitInVault(vaultPath, ['remote', 'remove', 'origin']);
  } catch {}
  runGitInVault(vaultPath, ['remote', 'add', 'origin', gitAuthRemoteUrl]);

  // 保存配置（配置中保存脱敏后的仓库地址）
  saveConfig({
    ...config,
    vaultGit: {
      provider: detectGitProvider(displayRemoteUrl) || chosenProvider,
      remoteUrl: displayRemoteUrl,
      giteeToken: resolvedToken,
      autoSync: Boolean(autoSync)
    }
  });

  // 立即执行双向同步（若远程已有旧电脑的笔记，先拉取合并到本地并重建索引，再推送到远程）
  const syncRes = syncVaultGit({ action: 'both' });
  return {
    ok: true,
    remoteUrl: displayRemoteUrl,
    provider: detectGitProvider(displayRemoteUrl) || chosenProvider,
    syncResult: syncRes,
    status: getVaultGitStatus()
  };
}

/**
 * 执行 Vault 知识库与远程私有仓库的推送 (push)、拉取 (pull) 或双向同步 (both)
 */
export function syncVaultGit({ action = 'push' } = {}) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error('当前本地库尚未初始化 Git，请先关联私有仓库');
  }

  ensureGitIdentity(vaultPath);

  let remoteUrl = '';
  try {
    remoteUrl = runGitInVault(vaultPath, ['remote', 'get-url', 'origin']);
  } catch {}
  if (!remoteUrl) {
    throw new Error('尚未绑定远程仓库地址 (origin)');
  }

  try {
    runGitInVault(vaultPath, ['branch', '-M', 'main']);
  } catch {}

  if (action === 'pull' || action === 'both') {
    pullAndMergeRemoteMain(vaultPath);
  }

  let pushed = false;
  if (action === 'push' || action === 'both') {
    commitLocalVaultChanges(vaultPath, `backup: QuickMemo vault sync ${nowReadable()}`);
    try {
      runGitInVault(vaultPath, ['push', '-u', 'origin', 'main']);
      pushed = true;
    } catch (pushErr) {
      const msg = String(pushErr.message || '');
      // 如果因为远程包含本地没有的提交（如换新电脑或其它设备刚推送过）导致 push 被拒，自动先拉取合并再重推
      if (msg.includes('fetch first') || msg.includes('non-fast-forward') || msg.includes('[rejected]')) {
        pullAndMergeRemoteMain(vaultPath);
        commitLocalVaultChanges(vaultPath, `backup: QuickMemo vault sync ${nowReadable()}`);
        runGitInVault(vaultPath, ['push', '-u', 'origin', 'main']);
        pushed = true;
      } else {
        throw new Error(`推送失败：${msg}`);
      }
    }
  }

  return {
    ok: true,
    action,
    pushed,
    syncedAt: nowReadable(),
    status: getVaultGitStatus()
  };
}

/**
 * 如果用户开启了“归档后自动同步到私有仓库”，在后台静默提交并推送
 */
export function triggerAutoVaultGitSync() {
  const config = getConfig();
  if (!config.vaultGit?.autoSync) return;
  setTimeout(() => {
    try {
      syncVaultGit({ action: 'push' });
    } catch (err) {
      console.warn('[VaultSync] Auto sync warning:', err.message);
    }
  }, 300);
}

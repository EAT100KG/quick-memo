import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
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

/**
 * 获取本地 Vault 目录关联的独立 GitHub 私有仓库状态
 */
export function getVaultGitStatus() {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  const isGitInitialized = fs.existsSync(gitDir);

  let remoteUrl = '';
  let pendingChanges = 0;
  let lastCommit = '';
  let branch = 'main';

  if (isGitInitialized) {
    try {
      remoteUrl = runGitInVault(vaultPath, ['remote', 'get-url', 'origin']);
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
    branch,
    pendingChanges,
    lastCommit,
    ghUser,
    autoSyncEnabled: Boolean(config.vaultGit?.autoSync)
  };
}

/**
 * 初始化 Vault 独立 Git 仓库，并支持一键创建或关联 GitHub 私有仓库
 */
export function linkVaultToGitHub({
  repoUrl = '',
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

  // 确保 vault 内部有一个干净的 .gitignore（只忽略系统垃圾文件，保留所有 .md 和 assets）
  const vaultGitignore = path.join(vaultPath, '.gitignore');
  if (!fs.existsSync(vaultGitignore)) {
    fs.writeFileSync(vaultGitignore, '.DS_Store\nThumbs.db\n', 'utf-8');
  }

  let targetRemoteUrl = String(repoUrl || '').trim();

  if (autoCreatePrivate) {
    const cleanRepoName = String(repoName || 'quick-memo-vault').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
    // 获取当前登录的 GitHub 用户名
    const ghUser = execFileSync('gh', ['api', 'user', '-q', '.login'], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true
    }).trim();

    if (!ghUser) {
      throw new Error('未检测到本机 gh 登录状态，请手动填入私有仓库地址');
    }

    const fullSlug = `${ghUser}/${cleanRepoName}`;
    // 检查该仓库是否已存在
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

  if (!targetRemoteUrl) {
    throw new Error('请填写 GitHub 私有仓库地址，或点击一键创建私有仓库');
  }

  // 设置或更新 origin 远程地址
  try {
    runGitInVault(vaultPath, ['remote', 'remove', 'origin']);
  } catch {}
  runGitInVault(vaultPath, ['remote', 'add', 'origin', targetRemoteUrl]);

  // 保存配置
  saveConfig({
    ...config,
    vaultGit: {
      remoteUrl: targetRemoteUrl,
      autoSync: Boolean(autoSync)
    }
  });

  // 立即执行首次提交与推送
  const syncRes = syncVaultGit({ action: 'push' });
  return {
    ok: true,
    remoteUrl: targetRemoteUrl,
    syncResult: syncRes,
    status: getVaultGitStatus()
  };
}

/**
 * 执行 Vault 知识库与 GitHub 私有仓库的推送 (push) 或拉取 (pull)
 */
export function syncVaultGit({ action = 'push' } = {}) {
  const config = getConfig();
  const vaultPath = config.vaultPath;
  const gitDir = path.join(vaultPath, '.git');
  if (!fs.existsSync(gitDir)) {
    throw new Error('当前本地库尚未初始化 Git，请先关联 GitHub 私有仓库');
  }

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
    try {
      // 先暂存本地改动再拉取
      runGitInVault(vaultPath, ['add', '-A']);
      const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
      if (statusOut) {
        runGitInVault(vaultPath, ['commit', '-m', `backup: pre-pull save ${nowReadable()}`]);
      }
      runGitInVault(vaultPath, ['pull', 'origin', 'main', '--rebase']);
      rebuildDocIndex();
    } catch (err) {
      // 如果远程仓库还是空的，忽略 pull 报错
      if (!String(err.message || '').includes("couldn't find remote ref")) {
        throw new Error(`拉取失败：${err.message}`);
      }
    }
  }

  let pushed = false;
  if (action === 'push' || action === 'both') {
    runGitInVault(vaultPath, ['add', '-A']);
    const statusOut = runGitInVault(vaultPath, ['status', '--porcelain']);
    if (statusOut) {
      runGitInVault(vaultPath, ['commit', '-m', `backup: QuickMemo vault sync ${nowReadable()}`]);
    }
    runGitInVault(vaultPath, ['push', '-u', 'origin', 'main']);
    pushed = true;
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

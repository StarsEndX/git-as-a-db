import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// Git操作封装
export class Git {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  // 执行git命令
  private async exec(command: string, ignoreStderr = false): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd: this.cwd });
      // 忽略某些正常的stderr输出
      if (stderr && !ignoreStderr) {
        const ignoredPatterns = ['warning', 'From ', '->', 'remote:'];
        const shouldIgnore = ignoredPatterns.some(p => stderr.includes(p));
        if (!shouldIgnore) {
          throw new Error(`Git error: ${stderr}`);
        }
      }
      return stdout.trim();
    } catch (error: any) {
      // 某些git命令返回非0退出码但不是真正的错误
      if (error.message.includes('Already up to date')) {
        return '';
      }
      throw error;
    }
  }

  // 检查是否有更新（通过fetch）
  async fetch(): Promise<boolean> {
    const before = await this.exec('git rev-parse HEAD');
    await this.exec('git fetch origin', true); // 忽略fetch的stderr
    const remoteHead = await this.exec('git rev-parse origin/main');
    const after = await this.exec('git rev-parse HEAD');
    // 如果远程有新提交，返回true
    return remoteHead !== after;
  }

  // 拉取更新
  async pull(): Promise<boolean> {
    try {
      // 先尝试普通的pull
      const result = await this.exec('git pull --rebase origin main', true);
      // 成功的情况：Fast-forward、Applied、Already up to date
      return result.includes('Fast-forward') ||
             result.includes('Applied') ||
             result.includes('Already') ||
             result.includes('up to date');
    } catch (error: any) {
      // 如果有冲突，尝试abort rebase并重新pull
      if (error.message.includes('conflict') || error.message.includes('CONFLICT')) {
        // 对于追加模式，不应该有真正的文件冲突
        // 尝试abort并重新拉取
        try {
          await this.exec('git rebase --abort');
        } catch {}
        // 尝试merge而不是rebase
        try {
          await this.exec('git pull origin main', true);
          return true;
        } catch {
          return false;
        }
      }
      // 其他错误，返回false但不抛异常
      console.warn('Git pull warning:', error.message);
      return false;
    }
  }

  // 推送更新
  async push(): Promise<boolean> {
    try {
      await this.exec('git push origin main');
      return true;
    } catch (error) {
      // push失败（通常是因为远程有新提交）
      return false;
    }
  }

  // 添加文件
  async add(file: string): Promise<void> {
    await this.exec(`git add "${file}"`);
  }

  // 提交
  async commit(message: string): Promise<void> {
    await this.exec(`git commit -m "${message}"`);
  }

  // 检查是否有未提交的更改
  async hasChanges(): Promise<boolean> {
    const status = await this.exec('git status --porcelain');
    return status.length > 0;
  }

  // 列出指定目录的文件
  async listFiles(dir: string): Promise<string[]> {
    const fullPath = path.join(this.cwd, dir);
    try {
      const files = await fs.readdir(fullPath);
      return files.filter(f => f.endsWith('.json'));
    } catch (error) {
      return [];
    }
  }

  // 读取文件
  async readFile(file: string): Promise<string> {
    const fullPath = path.join(this.cwd, file);
    return await fs.readFile(fullPath, 'utf-8');
  }

  // 写入文件
  async writeFile(file: string, content: string): Promise<void> {
    const fullPath = path.join(this.cwd, file);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  // 获取工作目录
  getCwd(): string {
    return this.cwd;
  }
}

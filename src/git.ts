import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';

// commit 元数据，嵌入 commit message
export interface CommitMetadata {
  actorId: string;
  operation: string;  // 'create' | 'update' | 'delete'
  path: string[];
}

// Git 操作封装（基于 simple-git）
export class Git {
  private git: SimpleGit;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    const options: Partial<SimpleGitOptions> = {
      baseDir: cwd,
      binary: 'git',
      maxConcurrentProcesses: 1,  // 串行化，避免并发冲突
    };
    this.git = simpleGit(options);
  }

  // 初始化仓库
  async init(bare = false): Promise<void> {
    await this.git.init(bare);
  }

  // 配置用户
  async config(user: string, email: string): Promise<void> {
    await this.git.addConfig('user.name', user);
    await this.git.addConfig('user.email', email);
  }

  // 添加远程
  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
  }

  // 设置默认分支
  async setDefaultBranch(branch: string): Promise<void> {
    await this.git.branch(['-M', branch]);
  }

  // 读取文件
  async readFile(file: string): Promise<string | null> {
    const fullPath = path.join(this.cwd, file);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // 写入文件
  async writeFile(file: string, content: string): Promise<void> {
    const fullPath = path.join(this.cwd, file);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  // 提交更改（带元数据）
  async commit(message: string, metadata?: CommitMetadata): Promise<string> {
    // 检查是否有更改
    const status = await this.git.status();
    if (status.isClean()) {
      throw new Error('No changes to commit');
    }

    // 暂存所有更改
    await this.git.add('-A');

    // 构建 commit message（包含元数据）
    let commitMessage = message;
    if (metadata) {
      commitMessage += `\n\n---METADATA---\n${JSON.stringify(metadata)}`;
    }

    // 提交
    const result = await this.git.commit(commitMessage);
    return result.commit;
  }

  // 推送到远程（自动处理并发冲突）
  async push(branch: string = 'main', maxRetries = 3): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.git.push('origin', branch);
        return true;
      } catch (error: any) {
        // push 失败，可能是因为远程有新提交
        if (error.message.includes('rejected') || error.message.includes('non-fast-forward')) {
          // 先 pull 再重试
          await this.pull(branch);
          // 等待一下再重试（避免过于激进）
          await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        } else {
          // 其他错误（权限、网络等）
          throw error;
        }
      }
    }
    return false;
  }

  // 拉取远程更新（自动处理冲突，LWW 策略）
  async pull(branch: string = 'main'): Promise<{ success: boolean; conflicts: string[] }> {
    try {
      await this.git.pull('origin', branch, ['--rebase=false']);
      return { success: true, conflicts: [] };
    } catch (error: any) {
      // 检查是否有冲突
      if (error.message.includes('CONFLICT') || error.message.includes('conflict')) {
        // 获取冲突文件列表
        const status = await this.git.status();
        const conflicts = status.conflicted;

        // 自动解决冲突（LWW）
        await this.resolveConflictsLWW(conflicts);

        // 完成 merge
        await this.git.add('-A');
        await this.git.commit('Auto-merge: resolved conflicts (LWW)');

        return { success: true, conflicts };
      }

      // 其他错误
      console.warn('Pull warning:', error.message);
      return { success: false, conflicts: [] };
    }
  }

  // LWW 冲突解决：对于 data.json 使用深度合并，其他文件用 LWW
  private async resolveConflictsLWW(files: string[]): Promise<void> {
    // 获取 HEAD 和 MERGE_HEAD 的 timestamp
    const headTimestamp = await this.getCommitTimestamp('HEAD');
    let mergeHeadTimestamp: number;

    try {
      mergeHeadTimestamp = await this.getCommitTimestamp('MERGE_HEAD');
    } catch {
      // 如果没有 MERGE_HEAD，abort merge
      await this.git.merge(['--abort']);
      throw new Error('No MERGE_HEAD found during conflict resolution');
    }

    for (const file of files) {
      if (file === 'data.json') {
        // 对于 data.json，使用深度合并
        await this.mergeDataJson(headTimestamp, mergeHeadTimestamp);
      } else {
        // 其他文件用简单的 LWW
        const useTheirs = mergeHeadTimestamp >= headTimestamp;
        if (useTheirs) {
          await this.git.checkout(['--theirs', file]);
        } else {
          await this.git.checkout(['--ours', file]);
        }
      }
    }
  }

  // 深度合并 data.json
  private async mergeDataJson(headTimestamp: number, mergeHeadTimestamp: number): Promise<void> {
    // 获取 HEAD 和 MERGE_HEAD 版本的 data.json
    const oursContent = await this.git.show(['HEAD:data.json']);
    const theirsContent = await this.git.show(['MERGE_HEAD:data.json']);

    let ours: any = {};
    let theirs: any = {};

    try {
      ours = JSON.parse(oursContent);
    } catch {
      ours = {};
    }

    try {
      theirs = JSON.parse(theirsContent);
    } catch {
      theirs = {};
    }

    // 深度合并
    const useTheirs = mergeHeadTimestamp >= headTimestamp;
    const merged = this.deepMerge(ours, theirs, useTheirs);

    // 写入合并后的文件
    const fullPath = path.join(this.cwd, 'data.json');
    await fs.writeFile(fullPath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  // 深度合并两个对象
  private deepMerge(ours: any, theirs: any, preferTheirs: boolean): any {
    // 如果都是对象，递归合并
    if (this.isPlainObject(ours) && this.isPlainObject(theirs)) {
      const result: any = {};
      const allKeys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);

      for (const key of allKeys) {
        if (key in ours && key in theirs) {
          // 两边都有，递归合并
          result[key] = this.deepMerge(ours[key], theirs[key], preferTheirs);
        } else if (key in ours) {
          // 只在 ours 中
          result[key] = ours[key];
        } else {
          // 只在 theirs 中
          result[key] = theirs[key];
        }
      }

      return result;
    }

    // 如果类型不同或不是对象，根据策略选择
    return preferTheirs ? theirs : ours;
  }

  // 检查是否是普通对象
  private isPlainObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // 获取 commit 的 timestamp（Unix 秒）
  private async getCommitTimestamp(ref: string): Promise<number> {
    const timestamp = await this.git.raw(['log', '-1', '--format=%ct', ref]);
    return parseInt(timestamp.trim(), 10);
  }

  // 获取提交历史
  async getHistory(count: number = 100): Promise<Array<{
    hash: string;
    message: string;
    author: string;
    date: string;
    metadata?: CommitMetadata;
  }>> {
    const log = await this.git.log({ maxCount: count });
    return log.all.map(commit => {
      // 解析元数据
      let metadata: CommitMetadata | undefined;
      const metadataMatch = commit.body.match(/---METADATA---\n(.+)/);
      if (metadataMatch) {
        try {
          metadata = JSON.parse(metadataMatch[1]);
        } catch {
          // 忽略解析错误
        }
      }

      return {
        hash: commit.hash,
        message: commit.message,
        author: commit.author_name,
        date: commit.date,
        metadata,
      };
    });
  }

  // 检查是否有未提交的更改
  async hasChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  // 克隆仓库
  async clone(url: string, targetDir: string): Promise<void> {
    await this.git.clone(url, targetDir);
  }

  // 获取工作目录
  getCwd(): string {
    return this.cwd;
  }
}

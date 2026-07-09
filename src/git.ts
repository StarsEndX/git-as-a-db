import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';

// commit 元数据，嵌入 commit message
export interface CommitMetadata {
  actorId: string;
  operation: string;  // 'create' | 'update' | 'delete'
  path: string[];
}

// push 结果
export interface PushResult {
  success: boolean;
  pulled: boolean;  // 重试过程中是否执行了 pull
  message: string;
}

// push 重试耗尽错误
export class PushRetryExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRetryExhaustedError';
  }
}

// 检查是否是普通对象（排除 Date、RegExp、Map、Set 等）
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// 递归排序对象 key（保证 JSON 序列化稳定）
// 非 plain object（Date、RegExp 等）原样返回
export function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (!isPlainObject(obj)) return obj;  // 非 plain object 不处理
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

// 深度比较两个值（支持 NaN）
export function deepEqual(a: unknown, b: unknown): boolean {
  // NaN 处理
  if (typeof a === 'number' && typeof b === 'number') {
    if (isNaN(a) && isNaN(b)) return true;
    return a === b;
  }
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    return arrA.every((val, i) => deepEqual(val, arrB[i]));
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  // 使用 Object.hasOwn 避免原型链污染
  return keysA.every(key => Object.hasOwn(objB, key) && deepEqual(objA[key], objB[key]));
}

// Git 操作封装（基于 simple-git）
export class Git {
  private git: SimpleGit;
  private cwd: string;
  private branch: string;

  constructor(cwd: string, branch: string = 'main') {
    this.cwd = cwd;
    this.branch = branch;
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
  // 调用方负责 stage 文件，commit() 只检查 staged changes 并 commit
  async commit(message: string, metadata?: CommitMetadata): Promise<string> {
    // 暂存 data.json（如果存在）
    const dataFilePath = path.join(this.cwd, 'data.json');
    try {
      await fs.access(dataFilePath);
      await this.git.add(['data.json']);
    } catch (error: any) {
      // 只处理文件不存在的情况，其他错误（权限等）忽略
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      // data.json 不存在，不 stage 任何文件
    }

    // 检查是否有 staged changes（不用 isClean，因为 untracked files 会导致误判）
    const status = await this.git.status();
    if (status.staged.length === 0 && !status.isClean()) {
      // 有 unstaged/untracked 变更但没有 staged 变更
      throw new Error('No changes to commit');
    }
    if (status.staged.length === 0 && status.isClean()) {
      throw new Error('No changes to commit');
    }

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
  async push(branch?: string, maxRetries = 3): Promise<PushResult> {
    const targetBranch = branch || this.branch;
    let pulled = false;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.git.push('origin', targetBranch);
        return { success: true, pulled, message: 'Push succeeded' };
      } catch (error: any) {
        // 只处理 push 被拒绝的情况（远程有新提交）
        const isRejected = /rejected|non-fast-forward|fetch first|pull first/i.test(error.message);
        if (isRejected) {
          // 先 pull 再重试
          const pullResult = await this.pull(targetBranch);
          pulled = true;

          if (!pullResult.success) {
            return {
              success: false,
              pulled: true,
              message: `Pull failed during push retry: ${pullResult.conflicts.join(', ')}`,
            };
          }

          // 等待一下再重试（避免过于激进）
          await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        } else {
          // 其他错误（权限、网络等）
          throw error;
        }
      }
    }

    // 重试耗尽，返回 PushRetryExhaustedError
    throw new PushRetryExhaustedError(
      `Push failed after ${maxRetries} retries. Local state may have changed (pull was performed).`
    );
  }

  // 拉取远程更新（自动处理冲突，LWW 策略）
  async pull(branch?: string): Promise<{ success: boolean; conflicts: string[] }> {
    const targetBranch = branch || this.branch;
    try {
      await this.git.pull('origin', targetBranch, ['--rebase=false']);
      return { success: true, conflicts: [] };
    } catch (error: any) {
      // 检查是否有冲突
      if (error.message.includes('CONFLICT') || error.message.includes('conflict')) {
        // 获取冲突文件列表
        const status = await this.git.status();
        const conflicts = status.conflicted;

        // 自动解决冲突（LWW）
        try {
          await this.resolveConflictsLWW(conflicts);
        } catch (resolveError: any) {
          // 解决失败，尝试 abort merge
          try {
            await this.git.merge(['--abort']);
          } catch {
            // abort 也失败，仓库可能处于不一致状态
            console.error('Failed to abort merge:', resolveError.message);
          }
          return { success: false, conflicts };
        }

        // 完成 merge：stage 所有已解决的冲突文件
        for (const file of conflicts) {
          await this.git.add(file);
        }
        await this.git.commit('Auto-merge: resolved conflicts (LWW)');

        return { success: true, conflicts };
      }

      // 其他错误
      console.warn('Pull warning:', error.message);
      return { success: false, conflicts: [] };
    }
  }

  // LWW 冲突解决：对于 data.json 使用 3-way 深度合并，其他文件用 LWW
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

    // 时间戳相同时用 hash 打破平局（确定性，所有文件统一策略）
    const timestampsEqual = headTimestamp === mergeHeadTimestamp;
    let hashTiebreak = false;
    if (timestampsEqual) {
      hashTiebreak = await this.shouldPreferTheirsByHash();
    }
    const preferTheirs = mergeHeadTimestamp > headTimestamp ||
      (timestampsEqual && hashTiebreak);

    for (const file of files) {
      if (file === 'data.json') {
        // 对于 data.json，使用 3-way 深度合并
        await this.mergeDataJson(headTimestamp, mergeHeadTimestamp);
      } else {
        // 其他文件用简单的 LWW
        if (preferTheirs) {
          await this.git.checkout(['--theirs', '--', file]);
        } else {
          await this.git.checkout(['--ours', '--', file]);
        }
      }
    }
  }

  // 时间戳相同时用 hash 打破平局（确定性）
  private async shouldPreferTheirsByHash(): Promise<boolean> {
    try {
      const headHash = await this.git.raw(['rev-parse', 'HEAD']);
      const mergeHeadHash = await this.git.raw(['rev-parse', 'MERGE_HEAD']);
      // 用 hash 字符串比较，保证确定性
      return mergeHeadHash.trim() > headHash.trim();
    } catch {
      return false;
    }
  }

  // 3-way 合并 data.json
  private async mergeDataJson(headTimestamp: number, mergeHeadTimestamp: number): Promise<void> {
    // 获取 base（共同祖先）版本的 data.json
    let base: Record<string, unknown> = {};
    try {
      const mergeBase = await this.git.raw(['merge-base', 'HEAD', 'MERGE_HEAD']);
      const baseContent = await this.git.show([`${mergeBase.trim()}:data.json`]);
      base = JSON.parse(baseContent);
    } catch {
      // 没有共同祖先或解析失败，使用空对象
      base = {};
    }

    const oursContent = await this.git.show(['HEAD:data.json']);
    const theirsContent = await this.git.show(['MERGE_HEAD:data.json']);

    let ours: Record<string, unknown> = {};
    let theirs: Record<string, unknown> = {};

    try {
      ours = JSON.parse(oursContent);
    } catch (e) {
      console.warn('Failed to parse ours data.json, using empty object');
      ours = {};
    }

    try {
      theirs = JSON.parse(theirsContent);
    } catch (e) {
      console.warn('Failed to parse theirs data.json, using empty object');
      theirs = {};
    }

    // 3-way 深度合并
    const merged = this.threeWayMerge(base, ours, theirs, headTimestamp, mergeHeadTimestamp);

    // 写入合并后的文件（key 排序保证稳定）
    const fullPath = path.join(this.cwd, 'data.json');
    await fs.writeFile(fullPath, JSON.stringify(sortObjectKeys(merged), null, 2), 'utf-8');
  }

  // 3-way 深度合并
  // 规则：
  // - 一方删除、另一方未修改 → 删除生效
  // - 一方删除、另一方修改 → 修改方赢（LWW）
  // - 双方都修改 → LWW（timestamp 大的赢，相同时 hash 打破平局）
  // - 双方都删除 → 删除
  // - 只有一方修改 → 修改生效
  private threeWayMerge(
    base: Record<string, unknown>,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
    oursTimestamp: number,
    theirsTimestamp: number,
  ): Record<string, unknown> {
    // 统一 tiebreak 策略
    const timestampsEqual = oursTimestamp === theirsTimestamp;
    const preferTheirs = theirsTimestamp > oursTimestamp || timestampsEqual;

    const result: Record<string, unknown> = {};
    const allKeys = new Set([
      ...Object.keys(base),
      ...Object.keys(ours),
      ...Object.keys(theirs),
    ]);

    for (const key of allKeys) {
      const inBase = Object.hasOwn(base, key);
      const inOurs = Object.hasOwn(ours, key);
      const inTheirs = Object.hasOwn(theirs, key);

      if (inBase) {
        if (inOurs && inTheirs) {
          // 两边都有：可能都修改了，递归合并
          const oursChanged = !deepEqual(ours[key], base[key]);
          const theirsChanged = !deepEqual(theirs[key], base[key]);

          if (oursChanged && theirsChanged) {
            // 两边都修改了
            if (isPlainObject(ours[key]) && isPlainObject(theirs[key]) && isPlainObject(base[key])) {
              // 都是对象，递归 3-way merge
              result[key] = this.threeWayMerge(
                base[key] as Record<string, unknown>,
                ours[key] as Record<string, unknown>,
                theirs[key] as Record<string, unknown>,
                oursTimestamp,
                theirsTimestamp,
              );
            } else {
              // 非对象冲突，LWW
              result[key] = preferTheirs ? theirs[key] : ours[key];
            }
          } else if (oursChanged) {
            result[key] = ours[key];
          } else if (theirsChanged) {
            result[key] = theirs[key];
          } else {
            // 都没改
            result[key] = ours[key];
          }
        } else if (inOurs) {
          // theirs 删除了
          if (deepEqual(ours[key], base[key])) {
            // ours 没改，theirs 删了 → 删除生效
            continue;
          }
          // ours 改了，theirs 删了 → 冲突，修改方赢（保留 ours）
          result[key] = ours[key];
        } else if (inTheirs) {
          // ours 删除了
          if (deepEqual(theirs[key], base[key])) {
            // theirs 没改，ours 删了 → 删除生效
            continue;
          }
          // theirs 改了，ours 删了 → 冲突，保留 theirs
          result[key] = theirs[key];
        }
        // else: 两边都删了 → 不加入 result
      } else {
        // base 中没有
        if (inOurs && inTheirs) {
          // 两边都添加了
          if (isPlainObject(ours[key]) && isPlainObject(theirs[key])) {
            result[key] = this.threeWayMerge(
              {},
              ours[key] as Record<string, unknown>,
              theirs[key] as Record<string, unknown>,
              oursTimestamp,
              theirsTimestamp,
            );
          } else {
            // 冲突，LWW
            result[key] = preferTheirs ? theirs[key] : ours[key];
          }
        } else if (inOurs) {
          result[key] = ours[key];
        } else if (inTheirs) {
          result[key] = theirs[key];
        }
      }
    }

    return result;
  }

  // 获取 commit 的 timestamp（Unix 秒）
  private async getCommitTimestamp(ref: string): Promise<number> {
    try {
      const timestamp = await this.git.raw(['log', '-1', '--format=%ct', ref]);
      const parsed = parseInt(timestamp.trim(), 10);
      if (isNaN(parsed)) {
        throw new Error(`Invalid timestamp for ref ${ref}: "${timestamp}"`);
      }
      return parsed;
    } catch (error: any) {
      throw new Error(`Failed to get timestamp for ref ${ref}: ${error.message}`);
    }
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

  // 获取当前分支
  getBranch(): string {
    return this.branch;
  }
}

import { Git, PushResult } from './git.js';
import { DataManager } from './data-manager.js';

// 辅助函数：等待
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 同步管理器
export class SyncManager {
  private git: Git;
  private dataManager: DataManager;
  private pollInterval: number;
  private polling: boolean = false;
  private pollInProgress: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private branch: string;

  constructor(
    repoPath: string,
    actorId: string,
    pollInterval: number = 5000,
    branch: string = 'main',
  ) {
    this.git = new Git(repoPath, branch);
    this.dataManager = new DataManager(this.git, actorId);
    this.pollInterval = pollInterval;
    this.branch = branch;
  }

  // 初始化：加载数据
  async init(): Promise<void> {
    await this.dataManager.init();
  }

  // 获取数据管理器
  getDataManager(): DataManager {
    return this.dataManager;
  }

  // 获取 Git 实例
  getGit(): Git {
    return this.git;
  }

  // 启动轮询同步
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    const poll = async () => {
      if (!this.polling) return;

      this.pollInProgress = true;
      try {
        await this.sync();
      } catch (error) {
        if (!this.polling) return;  // 已被 stopPolling 中止
        console.error('Sync error:', error);
      }
      this.pollInProgress = false;

      if (this.polling) {
        this.pollTimer = setTimeout(poll, this.pollInterval);
      }
    };

    // 立即执行一次
    poll();
  }

  // 停止轮询（等待正在执行的 poll 完成）
  async stopPolling(): Promise<void> {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    // 等待正在执行的 poll 完成
    while (this.pollInProgress) {
      await sleep(50);
    }
  }

  // 手动同步：pull + reload data
  async sync(): Promise<{ pulled: boolean; conflicts: string[] }> {
    // 1. Pull 远程更新（自动处理冲突）
    const result = await this.git.pull();

    // 2. 如果 pull 失败且有未解决的冲突，不 reload data（保护内存数据）
    if (!result.success && result.conflicts.length > 0) {
      return { pulled: false, conflicts: result.conflicts };
    }

    // 3. 重新加载数据
    await this.dataManager.sync();

    return { pulled: result.success, conflicts: result.conflicts };
  }

  // 推送本地更改（自动处理并发）
  async push(maxRetries = 3): Promise<PushResult> {
    return await this.git.push(this.branch, maxRetries);
  }

  // 获取提交历史
  async getHistory(count = 100) {
    return await this.git.getHistory(count);
  }
}

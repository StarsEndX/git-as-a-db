import { Git } from './git.js';
import { DataManager } from './data-manager.js';

// 同步管理器
export class SyncManager {
  private git: Git;
  private dataManager: DataManager;
  private pollInterval: number;
  private polling: boolean = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    repoPath: string,
    actorId: string,
    pollInterval: number = 5000
  ) {
    this.git = new Git(repoPath);
    this.dataManager = new DataManager(this.git, actorId);
    this.pollInterval = pollInterval;
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

      try {
        await this.sync();
      } catch (error) {
        console.error('Sync error:', error);
      }

      if (this.polling) {
        this.pollTimer = setTimeout(poll, this.pollInterval);
      }
    };

    // 立即执行一次
    poll();
  }

  // 停止轮询
  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // 手动同步：pull + reload data
  async sync(): Promise<{ pulled: boolean; conflicts: string[] }> {
    // 1. Pull 远程更新（自动处理冲突）
    const result = await this.git.pull();

    // 2. 重新加载数据
    await this.dataManager.sync();

    return { pulled: result.success, conflicts: result.conflicts };
  }

  // 推送本地更改（自动处理并发）
  async push(maxRetries = 3): Promise<boolean> {
    return await this.git.push('main', maxRetries);
  }

  // 获取提交历史
  async getHistory(count = 100) {
    return await this.git.getHistory(count);
  }
}

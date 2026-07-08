import { Git } from './git.js';
import { OperationLog } from './operation-log.js';
import { DataManager } from './data-manager.js';
import { Operation } from './types.js';

// 同步管理器
export class SyncManager {
  private git: Git;
  private opLog: OperationLog;
  private dataManager: DataManager;
  private actorId: string;
  private pollInterval: number;
  private polling: boolean = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    repoPath: string,
    actorId: string,
    pollInterval: number = 5000 // 默认5秒轮询
  ) {
    this.git = new Git(repoPath);
    this.actorId = actorId;
    this.pollInterval = pollInterval;
    this.opLog = new OperationLog(this.git);
    this.dataManager = new DataManager(this.git, actorId);
  }

  // 初始化
  async init(): Promise<void> {
    await this.dataManager.init();
  }

  // 获取数据管理器
  getDataManager(): DataManager {
    return this.dataManager;
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

  // 手动同步
  async sync(): Promise<{ pulled: number; pushed: boolean }> {
    // 1. Fetch检查更新
    const hasUpdates = await this.git.fetch();

    if (!hasUpdates) {
      // 即使没有远程更新，也尝试pull（可能本地有未同步的状态）
      await this.git.pull();
      // 重新加载数据
      await this.dataManager.syncOperations();
      return { pulled: 0, pushed: false };
    }

    // 2. Pull拉取文件
    const pulled = await this.git.pull();
    if (!pulled) {
      // Pull失败，但仍然尝试重新加载数据
      console.warn('Git pull returned false, but continuing...');
    }

    // 3. 重新加载所有操作并重建数据
    await this.dataManager.syncOperations();

    return { pulled: 1, pushed: false };
  }

  // 推送本地更改（失败时自动pull重试）
  async push(maxRetries = 3): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      // 检查是否有未推送的更改
      const hasChanges = await this.git.hasChanges();
      if (!hasChanges) {
        return false;
      }

      const success = await this.git.push();
      if (success) {
        return true;
      }

      // push失败，尝试pull然后重试
      console.log(`Push失败，尝试pull后重试 (${i + 1}/${maxRetries})...`);
      await this.sync();

      // 等待一下再重试
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
  }

  // 获取Git实例（用于测试）
  getGit(): Git {
    return this.git;
  }
}

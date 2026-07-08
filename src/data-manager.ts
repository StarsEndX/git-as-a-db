import { Git, CommitMetadata } from './git.js';
import { DataNode, OperationType } from './types.js';
import * as path from 'path';

const DATA_FILE = 'data.json';

// 数据管理器：每个操作直接修改 data.json 并 commit
export class DataManager {
  private git: Git;
  private actorId: string;
  private data: DataNode = {};

  constructor(git: Git, actorId: string) {
    this.git = git;
    this.actorId = actorId;
  }

  // 初始化：从 data.json 加载数据
  async init(): Promise<void> {
    const content = await this.git.readFile(DATA_FILE);
    if (content) {
      try {
        this.data = JSON.parse(content);
      } catch {
        this.data = {};
      }
    }
  }

  // 获取数据（支持路径查询）
  get(path?: string[]): DataNode {
    if (!path || path.length === 0) return this.data;

    let current = this.data;
    for (const key of path) {
      if (current === undefined || current === null) return undefined;
      if (typeof current !== 'object') return undefined;
      current = current[key];
    }
    return current;
  }

  // 创建/更新数据
  async set(targetPath: string[], value: DataNode): Promise<void> {
    const opType: OperationType = this.get(targetPath) === undefined ? 'create' : 'update';

    // 修改数据
    if (targetPath.length === 0) {
      this.data = value;
    } else {
      let parent = this.data;
      for (let i = 0; i < targetPath.length - 1; i++) {
        const key = targetPath[i];
        if (parent[key] === undefined || typeof parent[key] !== 'object') {
          parent[key] = {};
        }
        parent = parent[key];
      }
      parent[targetPath[targetPath.length - 1]] = value;
    }

    // 保存并 commit
    await this.saveAndCommit(opType, targetPath);
  }

  // 删除数据
  async delete(targetPath: string[]): Promise<void> {
    if (targetPath.length === 0) {
      this.data = {};
    } else {
      let parent = this.data;
      for (let i = 0; i < targetPath.length - 1; i++) {
        const key = targetPath[i];
        if (parent[key] === undefined) return;  // 路径不存在
        parent = parent[key];
      }
      delete parent[targetPath[targetPath.length - 1]];
    }

    // 保存并 commit
    await this.saveAndCommit('delete', targetPath);
  }

  // 同步：从 data.json 重新加载数据
  async sync(): Promise<void> {
    const content = await this.git.readFile(DATA_FILE);
    if (content) {
      try {
        this.data = JSON.parse(content);
      } catch {
        this.data = {};
      }
    }
  }

  // 保存 data.json 并 commit
  private async saveAndCommit(operation: OperationType, targetPath: string[]): Promise<void> {
    // 写入 data.json
    const content = JSON.stringify(this.data, null, 2);
    await this.git.writeFile(DATA_FILE, content);

    // 构建 commit message
    const pathStr = targetPath.length > 0 ? targetPath.join('.') : '(root)';
    const message = `${operation}: ${pathStr}`;

    // commit（带元数据）
    const metadata: CommitMetadata = {
      actorId: this.actorId,
      operation,
      path: targetPath,
    };

    await this.git.commit(message, metadata);
  }

  // 获取 actorId
  getActorId(): string {
    return this.actorId;
  }

  // 获取原始数据对象
  getRawData(): DataNode {
    return this.data;
  }
}

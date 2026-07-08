import { Operation, Conflict } from './types.js';
import { Git } from './git.js';
import { OperationLog } from './operation-log.js';

// 数据管理器
export class DataManager {
  private git: Git;
  private opLog: OperationLog;
  private data: any = {};
  private actorId: string;
  private knownOps: Set<string> = new Set();
  private conflicts: Conflict[] = [];

  constructor(git: Git, actorId: string) {
    this.git = git;
    this.actorId = actorId;
    this.opLog = new OperationLog(git);
  }

  // 初始化（加载现有数据）
  async init(): Promise<void> {
    // 加载所有操作
    const ops = await this.opLog.loadAllOperations();
    const sortedOps = this.opLog.sortOperations(ops);

    // 重放所有操作
    for (const op of sortedOps) {
      this.applyOperation(op);
      this.knownOps.add(op.id);
    }

    // 保存数据快照
    await this.saveSnapshot();
  }

  // 获取数据
  get(path?: string[]): any {
    if (!path) return this.data;

    let current = this.data;
    for (const key of path) {
      if (current === undefined || current === null) return undefined;
      current = current[key];
    }
    return current;
  }

  // 创建
  async create(path: string[], value: any): Promise<void> {
    const op = this.opLog.createOperation(this.actorId, 'create', path, value);
    await this.applyAndSave(op);
  }

  // 更新
  async update(path: string[], value: any): Promise<void> {
    const op = this.opLog.createOperation(this.actorId, 'update', path, value);
    await this.applyAndSave(op);
  }

  // 删除
  async delete(path: string[]): Promise<void> {
    const op = this.opLog.createOperation(this.actorId, 'delete', path);
    await this.applyAndSave(op);
  }

  // 应用操作并保存
  private async applyAndSave(op: Operation): Promise<void> {
    // 应用到本地数据
    this.applyOperation(op);

    // 保存操作到文件
    await this.opLog.saveOperation(op);

    // 记录操作
    this.knownOps.add(op.id);

    // 更新快照
    await this.saveSnapshot();

    // Git提交
    await this.git.add(`ops/${op.id}.json`);
    await this.git.commit(`op: ${op.type} ${op.path.join('.')}`);
  }

  // 应用操作到数据
  private applyOperation(op: Operation): void {
    const path = op.path;

    if (path.length === 0) {
      // 根路径操作
      if (op.type === 'create' || op.type === 'update') {
        this.data = op.value;
      } else if (op.type === 'delete') {
        this.data = {};
      }
      return;
    }

    // 导航到父级
    let parent = this.data;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (parent[key] === undefined) {
        // 自动创建中间路径
        parent[key] = {};
      }
      parent = parent[key];
    }

    const lastKey = path[path.length - 1];

    if (op.type === 'create') {
      // 检查是否已存在
      if (parent[lastKey] !== undefined) {
        // 并发创建冲突 - 记录但不报错
        this.conflicts.push({
          operation: op,
          existingValue: parent[lastKey],
          reason: 'Concurrent create on same path',
        });
      }
      parent[lastKey] = op.value;
    } else if (op.type === 'update') {
      // 直接覆盖（后来者胜出）
      parent[lastKey] = op.value;
    } else if (op.type === 'delete') {
      delete parent[lastKey];
    }
  }

  // 保存数据快照（可选，用于快速加载）
  private async saveSnapshot(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    await this.git.writeFile('snapshot.json', snapshot);
  }

  // 同步：重新加载所有操作并重建数据
  async syncOperations(): Promise<void> {
    // 清空当前数据
    this.data = {};
    this.conflicts = [];

    // 重新加载所有操作
    const ops = await this.opLog.loadAllOperations();
    const sortedOps = this.opLog.sortOperations(ops);

    // 重放所有操作
    this.knownOps.clear();
    for (const op of sortedOps) {
      this.applyOperation(op);
      this.knownOps.add(op.id);
    }

    // 更新快照
    await this.saveSnapshot();
  }

  // 获取冲突列表
  getConflicts(): Conflict[] {
    return [...this.conflicts];
  }

  // 清除冲突
  clearConflicts(): void {
    this.conflicts = [];
  }

  // 获取已知操作ID
  getKnownOpIds(): Set<string> {
    return new Set(this.knownOps);
  }
}

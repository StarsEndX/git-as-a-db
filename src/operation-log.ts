import { Operation } from './types.js';
import { Git } from './git.js';

// 操作日志管理器
export class OperationLog {
  private git: Git;
  private opsDir = 'ops';

  constructor(git: Git) {
    this.git = git;
  }

  // 生成操作ID
  private generateOpId(actorId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${actorId}-${random}`;
  }

  // 创建操作
  createOperation(
    actorId: string,
    type: Operation['type'],
    path: string[],
    value?: any,
    causality: string[] = []
  ): Operation {
    return {
      id: this.generateOpId(actorId),
      timestamp: Date.now(),
      actorId,
      causality,
      type,
      path,
      value,
    };
  }

  // 保存操作到文件
  async saveOperation(op: Operation): Promise<void> {
    const filename = `${op.id}.json`;
    const content = JSON.stringify(op, null, 2);
    await this.git.writeFile(`${this.opsDir}/${filename}`, content);
  }

  // 加载所有操作
  async loadAllOperations(): Promise<Operation[]> {
    const files = await this.git.listFiles(this.opsDir);
    const ops: Operation[] = [];

    for (const file of files) {
      try {
        const content = await this.git.readFile(`${this.opsDir}/${file}`);
        const op = JSON.parse(content) as Operation;
        ops.push(op);
      } catch (error) {
        // 跳过无效文件
        console.warn(`Failed to load operation: ${file}`);
      }
    }

    return ops;
  }

  // 因果排序（拓扑排序）
  // 确保操作按因果依赖排序，同级别按timestamp+actorId排序
  sortOperations(ops: Operation[]): Operation[] {
    // 构建依赖图
    const opMap = new Map<string, Operation>();
    ops.forEach(op => opMap.set(op.id, op));

    // 拓扑排序 + 全序比较
    const sorted: Operation[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (opId: string) => {
      if (visited.has(opId)) return;
      if (visiting.has(opId)) {
        // 循环依赖（理论上不应该发生）
        return;
      }

      visiting.add(opId);
      const op = opMap.get(opId);
      if (!op) return;

      // 先访问所有依赖
      for (const depId of op.causality) {
        visit(depId);
      }

      visiting.delete(opId);
      visited.add(opId);
      sorted.push(op);
    };

    // 对所有操作进行排序
    ops.forEach(op => visit(op.id));

    // 对于没有因果关系的操作，按 timestamp + actorId 排序
    // 这是一个稳定的全序排序
    sorted.sort((a, b) => {
      // 如果有因果关系，按因果顺序
      if (a.causality.includes(b.id)) return 1;
      if (b.causality.includes(a.id)) return -1;

      // 否则按时间戳
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }

      // 时间戳相同，按actorId字典序
      return a.actorId.localeCompare(b.actorId);
    });

    return sorted;
  }

  // 获取新的操作（相对于已知的操作ID集合）
  async getNewOperations(knownOpIds: Set<string>): Promise<Operation[]> {
    const allOps = await this.loadAllOperations();
    return allOps.filter(op => !knownOpIds.has(op.id));
  }
}

import { SyncManager } from './sync-manager.js';
import { Git } from './git.js';
import * as path from 'path';
import * as fs from 'fs';

const REPO_BASE = path.join(process.cwd(), 'test-repos');
const REMOTE_REPO = path.join(REPO_BASE, 'remote.git');
const USER1_REPO = path.join(REPO_BASE, 'user1');
const USER2_REPO = path.join(REPO_BASE, 'user2');
const USER3_REPO = path.join(REPO_BASE, 'user3');

// 辅助函数：等待
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 重置测试仓库（使用 simple-git，不依赖 shell）
async function resetTestRepos() {
  console.log('重置测试仓库...');

  // 删除并重新创建目录
  fs.rmSync(REPO_BASE, { recursive: true, force: true });
  fs.mkdirSync(REPO_BASE, { recursive: true });

  // 初始化远程仓库（bare）
  fs.mkdirSync(REMOTE_REPO, { recursive: true });
  const remoteGit = new Git(REMOTE_REPO);
  await remoteGit.init(true);

  // 初始化 user1 仓库
  fs.mkdirSync(USER1_REPO, { recursive: true });
  const user1Git = new Git(USER1_REPO);
  await user1Git.init(false);
  await user1Git.config('User1', 'user1@test.com');
  await user1Git.addRemote('origin', REMOTE_REPO);

  // 创建初始 data.json
  await user1Git.writeFile('data.json', JSON.stringify({}, null, 2));
  await user1Git.commit('Initial commit');
  await user1Git.setDefaultBranch('main');

  // 推送到远程
  const { simpleGit } = await import('simple-git');
  const user1Sg = simpleGit(USER1_REPO);
  await user1Sg.push(['-u', 'origin', 'main']);

  // 克隆到 user2
  const user2Sg = simpleGit();
  await user2Sg.clone(REMOTE_REPO, USER2_REPO);
  const user2SgInRepo = simpleGit(USER2_REPO);
  await user2SgInRepo.checkout('main');
  const user2Git = new Git(USER2_REPO);
  await user2Git.config('User2', 'user2@test.com');

  // 克隆到 user3
  const user3Sg = simpleGit();
  await user3Sg.clone(REMOTE_REPO, USER3_REPO);
  const user3SgInRepo = simpleGit(USER3_REPO);
  await user3SgInRepo.checkout('main');
  const user3Git = new Git(USER3_REPO);
  await user3Git.config('User3', 'user3@test.com');

  console.log('测试仓库已重置\n');
}

// 测试 1：基本操作
async function test1_BasicOperations() {
  console.log('=== 测试 1：基本操作 ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const dm = sync1.getDataManager();

  // 创建
  await dm.set(['users', 'user1'], { name: 'Alice', age: 30 });
  await sync1.push();
  console.log('✓ 创建成功');

  // 验证
  const user1 = dm.get(['users', 'user1']);
  if (user1.name !== 'Alice' || user1.age !== 30) {
    throw new Error('创建数据验证失败');
  }

  // 更新
  await dm.set(['users', 'user1', 'age'], 31);
  await sync1.push();
  console.log('✓ 更新成功');

  // 验证
  const age = dm.get(['users', 'user1', 'age']);
  if (age !== 31) {
    throw new Error('更新数据验证失败');
  }

  // 删除
  await dm.delete(['users', 'user1', 'age']);
  await sync1.push();
  console.log('✓ 删除成功');

  // 验证
  const user1After = dm.get(['users', 'user1']);
  if (user1After.age !== undefined) {
    throw new Error('删除数据验证失败');
  }

  console.log('✓ 测试 1 通过\n');
}

// 测试 2：单用户连续操作
async function test2_ConsecutiveOperations() {
  console.log('=== 测试 2：单用户连续操作 ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const dm = sync1.getDataManager();

  // 连续 5 个操作
  for (let i = 0; i < 5; i++) {
    await dm.set(['counter'], i);
    await sync1.push();
  }

  // 验证最终值
  const counter = dm.get(['counter']);
  if (counter !== 4) {
    throw new Error(`连续操作验证失败：期望 4，实际 ${counter}`);
  }

  // 验证 commit 历史
  const history = await sync1.getHistory();
  if (history.length < 5) {
    throw new Error(`Commit 历史验证失败：期望至少 5 个，实际 ${history.length} 个`);
  }

  console.log(`✓ 生成了 ${history.length} 个 commit`);
  console.log('✓ 测试 2 通过\n');
}

// 测试 3：双用户并发（不同路径）
async function test3_ConcurrentDifferentPaths() {
  console.log('=== 测试 3：双用户并发（不同路径） ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();

  // User1 修改 users.user1
  await sync1.getDataManager().set(['users', 'user1'], { name: 'Alice' });
  await sync1.push();
  console.log('User1 修改了 users.user1');

  // User2 修改 settings.theme
  await sync2.getDataManager().set(['settings', 'theme'], 'dark');
  await sync2.push();
  console.log('User2 修改了 settings.theme');

  // 两个用户互相同步
  await sync1.sync();
  await sync2.sync();

  // 验证数据一致
  const data1 = sync1.getDataManager().get();
  const data2 = sync2.getDataManager().get();

  if (JSON.stringify(data1) !== JSON.stringify(data2)) {
    console.log('User1 数据:', JSON.stringify(data1, null, 2));
    console.log('User2 数据:', JSON.stringify(data2, null, 2));
    throw new Error('数据不一致');
  }

  // 验证两个字段都存在
  if (!data1.users?.user1 || !data1.settings?.theme) {
    throw new Error('数据验证失败：缺少字段');
  }

  console.log('✓ 不同路径的操作不冲突');
  console.log('✓ 测试 3 通过\n');
}

// 测试 4：双用户并发（相同路径，LWW）
async function test4_ConcurrentSamePath() {
  console.log('=== 测试 4：双用户并发（相同路径，LWW） ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();

  // 初始数据
  await sync1.getDataManager().set(['users', 'user1', 'name'], 'Initial');
  await sync1.push();
  await sync2.sync();
  console.log('初始 name: Initial');

  // User1 修改（先 push）
  await sync1.getDataManager().set(['users', 'user1', 'name'], 'Alice');
  await sync1.push();
  console.log('User1 修改为 Alice 并推送');

  // User2 修改（基于旧数据，然后 push）
  await sync2.getDataManager().set(['users', 'user1', 'name'], 'Bob');
  await sync2.push();
  console.log('User2 修改为 Bob 并推送（触发冲突解决）');

  // 同步
  await sync1.sync();
  await sync2.sync();

  const name1 = sync1.getDataManager().get(['users', 'user1', 'name']);
  const name2 = sync2.getDataManager().get(['users', 'user1', 'name']);

  console.log('User1 看到的 name:', name1);
  console.log('User2 看到的 name:', name2);

  // 验证一致性（LWW：后提交的赢）
  if (name1 !== name2) {
    throw new Error(`数据不一致：user1=${name1}, user2=${name2}`);
  }

  console.log(`✓ 最终一致，name = ${name1}（LWW）`);
  console.log('✓ 测试 4 通过\n');
}

// 测试 5：离线操作
async function test5_OfflineOperations() {
  console.log('=== 测试 5：离线操作 ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();

  // User1 离线操作（不 push）
  await sync1.getDataManager().set(['users', 'user1'], { name: 'Alice' });
  console.log('User1 离线修改了 users.user1（未 push）');

  // User2 在线操作并 push
  await sync2.getDataManager().set(['settings', 'theme'], 'dark');
  await sync2.push();
  console.log('User2 修改了 settings.theme 并推送');

  // User1 恢复，sync
  await sync1.sync();
  await sync1.push();
  console.log('User1 恢复，sync 并 push');

  // User2 再次同步
  await sync2.sync();

  // 验证数据一致
  const data1 = sync1.getDataManager().get();
  const data2 = sync2.getDataManager().get();

  if (JSON.stringify(data1) !== JSON.stringify(data2)) {
    console.log('User1 数据:', JSON.stringify(data1, null, 2));
    console.log('User2 数据:', JSON.stringify(data2, null, 2));
    throw new Error('数据不一致');
  }

  // 验证两个字段都存在
  if (!data1.users?.user1 || !data1.settings?.theme) {
    throw new Error('数据验证失败：缺少字段');
  }

  console.log('✓ 离线操作恢复后数据一致');
  console.log('✓ 测试 5 通过\n');
}

// 测试 6：多节点竞争
async function test6_MultiNodeCompetition() {
  console.log('=== 测试 6：多节点竞争 ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();

  const sync3 = new SyncManager(USER3_REPO, 'user3');
  await sync3.init();

  // 3 个用户同时修改不同路径
  await Promise.all([
    (async () => {
      await sync1.getDataManager().set(['users', 'user1'], { name: 'Alice' });
      await sync1.push();
      console.log('User1 完成');
    })(),
    (async () => {
      await sync2.getDataManager().set(['users', 'user2'], { name: 'Bob' });
      await sync2.push();
      console.log('User2 完成');
    })(),
    (async () => {
      await sync3.getDataManager().set(['users', 'user3'], { name: 'Charlie' });
      await sync3.push();
      console.log('User3 完成');
    })(),
  ]);

  // 所有用户同步
  await sync1.sync();
  await sync2.sync();
  await sync3.sync();

  // 验证数据一致
  const data1 = sync1.getDataManager().get();
  const data2 = sync2.getDataManager().get();
  const data3 = sync3.getDataManager().get();

  if (JSON.stringify(data1) !== JSON.stringify(data2) ||
      JSON.stringify(data2) !== JSON.stringify(data3)) {
    console.log('User1 数据:', JSON.stringify(data1, null, 2));
    console.log('User2 数据:', JSON.stringify(data2, null, 2));
    console.log('User3 数据:', JSON.stringify(data3, null, 2));
    throw new Error('数据不一致');
  }

  // 验证所有用户都存在
  if (!data1.users?.user1 || !data1.users?.user2 || !data1.users?.user3) {
    throw new Error('数据验证失败：缺少用户');
  }

  console.log('✓ 多节点竞争后数据一致');
  console.log('✓ 测试 6 通过\n');
}

// 测试 7：轮询自动同步
async function test7_AutoSync() {
  console.log('=== 测试 7：轮询自动同步 ===');
  await resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1', 1000); // 1秒轮询
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2', 1000);
  await sync2.init();

  // 创建初始数据
  await sync1.getDataManager().set(['test'], 'initial');
  await sync1.push();
  await sync2.sync();

  // 启动轮询
  sync1.startPolling();
  sync2.startPolling();

  console.log('轮询已启动');

  // User1 修改
  await sleep(500);
  await sync1.getDataManager().set(['test'], 'updated-by-user1');
  await sync1.push();
  console.log('User1 更新了数据');

  // 等待自动同步
  console.log('等待自动同步...');
  await sleep(3000);

  const data2 = sync2.getDataManager().get(['test']);
  console.log('User2 看到的数据:', data2);

  // 停止轮询
  sync1.stopPolling();
  sync2.stopPolling();

  if (data2 !== 'updated-by-user1') {
    throw new Error(`自动同步未生效：期望 'updated-by-user1'，实际 '${data2}'`);
  }

  console.log('✓ 自动同步成功');
  console.log('✓ 测试 7 通过\n');
}

// 主测试
async function runTests() {
  console.log('========================================');
  console.log('开始测试同步库（基于 simple-git）');
  console.log('========================================\n');

  try {
    await test1_BasicOperations();
    await test2_ConsecutiveOperations();
    await test3_ConcurrentDifferentPaths();
    await test4_ConcurrentSamePath();
    await test5_OfflineOperations();
    await test6_MultiNodeCompetition();
    await test7_AutoSync();

    console.log('========================================');
    console.log('所有测试通过！');
    console.log('========================================');
  } catch (error) {
    console.error('\n测试失败:', error);
    process.exit(1);
  }
}

runTests();

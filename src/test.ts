import { SyncManager } from './sync-manager.js';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const REPO_BASE = path.join(process.cwd(), 'test-repos');
const USER1_REPO = path.join(REPO_BASE, 'user1');
const USER2_REPO = path.join(REPO_BASE, 'user2');

// 辅助函数：等待
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 重置测试仓库
function resetTestRepos() {
  console.log('重置测试仓库...');

  // 删除并重新创建目录
  fs.rmSync(REPO_BASE, { recursive: true, force: true });
  fs.mkdirSync(REPO_BASE, { recursive: true });
  fs.mkdirSync(path.join(REPO_BASE, 'remote'), { recursive: true });
  fs.mkdirSync(path.join(REPO_BASE, 'user1'), { recursive: true });

  // 初始化远程仓库
  execSync('git init --bare', { cwd: path.join(REPO_BASE, 'remote'), stdio: 'pipe' });

  // 初始化user1仓库
  execSync('git init', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git config user.email "user1@test.com"', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git config user.name "User1"', { cwd: USER1_REPO, stdio: 'pipe' });
  fs.mkdirSync(path.join(USER1_REPO, 'ops'), { recursive: true });
  execSync('git add .', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git commit -m "Initial" --allow-empty', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git remote add origin ../remote', { cwd: USER1_REPO, stdio: 'pipe' });
  execSync('git push -u origin main', { cwd: USER1_REPO, stdio: 'pipe' });

  // 克隆到user2
  execSync('git clone remote user2', { cwd: REPO_BASE, stdio: 'pipe' });
  execSync('git config user.email "user2@test.com"', { cwd: USER2_REPO, stdio: 'pipe' });
  execSync('git config user.name "User2"', { cwd: USER2_REPO, stdio: 'pipe' });
  execSync('git checkout main', { cwd: USER2_REPO, stdio: 'pipe' });

  console.log('测试仓库已重置\n');
}

// 测试1：基本操作
async function test1_BasicOperations() {
  console.log('=== 测试1：基本操作 ===');
  resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const dm = sync1.getDataManager();

  // 创建数据
  await dm.create(['users', 'user1'], { name: 'Alice', age: 30 });
  await dm.create(['settings', 'theme'], 'dark');

  console.log('创建后数据:', JSON.stringify(dm.get(), null, 2));

  // 更新数据
  await dm.update(['users', 'user1', 'age'], 31);
  console.log('更新后年龄:', dm.get(['users', 'user1', 'age']));

  // 删除数据
  await dm.delete(['settings', 'theme']);
  console.log('删除后settings:', dm.get(['settings']));

  // 推送到远程
  await sync1.push();
  console.log('✓ 测试1通过\n');
}

// 测试2：两个用户并发操作（不同路径）
async function test2_ConcurrentDifferentPaths() {
  console.log('=== 测试2：两个用户并发操作（不同路径） ===');
  resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();

  // User1创建数据
  await sync1.getDataManager().create(['users', 'user1'], { name: 'Alice' });
  await sync1.push();
  console.log('User1添加了users.user1并推送');

  // User2同步并创建不同的数据
  await sync2.sync();
  await sync2.getDataManager().create(['settings', 'lang'], 'zh-CN');
  await sync2.push();
  console.log('User2添加了settings.lang并推送');

  // 两个用户互相同步
  await sync1.sync();
  await sync2.sync();

  const data1 = sync1.getDataManager().get();
  const data2 = sync2.getDataManager().get();

  console.log('User1数据:', JSON.stringify(data1, null, 2));
  console.log('User2数据:', JSON.stringify(data2, null, 2));

  // 验证一致性
  if (JSON.stringify(data1) === JSON.stringify(data2)) {
    console.log('✓ 测试2通过：数据一致\n');
  } else {
    console.log('✗ 测试2失败：数据不一致\n');
    process.exit(1);
  }
}

// 测试3：两个用户并发修改同一字段（冲突场景）
async function test3_ConcurrentSameField() {
  console.log('=== 测试3：两个用户并发修改同一字段 ===');
  resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1');
  await sync1.init();

  // 创建初始数据
  await sync1.getDataManager().create(['users', 'user1', 'name'], 'Initial');
  await sync1.push();
  console.log('初始name: Initial');

  // 初始化user2
  const sync2 = new SyncManager(USER2_REPO, 'user2');
  await sync2.init();
  await sync2.sync();

  // User1修改（先push）
  await sync1.getDataManager().update(['users', 'user1', 'name'], 'Alice');
  await sync1.push();
  console.log('User1修改为Alice并推送');

  // User2修改（基于旧数据，然后push）
  await sync2.getDataManager().update(['users', 'user1', 'name'], 'Bob');
  await sync2.push();
  console.log('User2修改为Bob并推送');

  // 同步
  await sync1.sync();
  await sync2.sync();

  const name1 = sync1.getDataManager().get(['users', 'user1', 'name']);
  const name2 = sync2.getDataManager().get(['users', 'user1', 'name']);

  console.log('User1看到的name:', name1);
  console.log('User2看到的name:', name2);

  // 验证一致性
  if (name1 === name2) {
    console.log(`✓ 测试3通过：最终一致，name = ${name1}`);
    console.log('  （基于时间戳+actorId排序，确定性解决冲突）\n');
  } else {
    console.log('✗ 测试3失败：数据不一致\n');
    process.exit(1);
  }
}

// 测试4：轮询自动同步
async function test4_AutoSync() {
  console.log('=== 测试4：轮询自动同步 ===');
  resetTestRepos();

  const sync1 = new SyncManager(USER1_REPO, 'user1', 1000); // 1秒轮询
  await sync1.init();

  const sync2 = new SyncManager(USER2_REPO, 'user2', 1000);
  await sync2.init();

  // 创建初始数据
  await sync1.getDataManager().create(['test'], 'initial');
  await sync1.push();
  await sync2.sync();

  // 启动轮询
  sync1.startPolling();
  sync2.startPolling();

  console.log('轮询已启动');

  // User1修改
  await sleep(500);
  await sync1.getDataManager().update(['test'], 'updated-by-user1');
  await sync1.push();
  console.log('User1更新了数据');

  // 等待自动同步
  console.log('等待自动同步...');
  await sleep(3000);

  const data2 = sync2.getDataManager().get(['test']);
  console.log('User2看到的数据:', data2);

  // 停止轮询
  sync1.stopPolling();
  sync2.stopPolling();

  if (data2 === 'updated-by-user1') {
    console.log('✓ 测试4通过：自动同步成功\n');
  } else {
    console.log('✗ 测试4失败：自动同步未生效\n');
    process.exit(1);
  }
}

// 主测试
async function runTests() {
  console.log('========================================');
  console.log('开始测试同步库');
  console.log('========================================\n');

  try {
    await test1_BasicOperations();
    await test2_ConcurrentDifferentPaths();
    await test3_ConcurrentSameField();
    await test4_AutoSync();

    console.log('========================================');
    console.log('所有测试通过！');
    console.log('========================================');
  } catch (error) {
    console.error('\n测试失败:', error);
    process.exit(1);
  }
}

runTests();

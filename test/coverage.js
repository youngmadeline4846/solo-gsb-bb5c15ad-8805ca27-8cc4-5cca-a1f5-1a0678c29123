'use strict';

// 选项覆盖路线自检（node test/coverage.js）
// 覆盖：可走选项全分母、不可达 / 恒假 / 悬空 / 入口受阻不计入分母、
//       循环按具体状态去重且路径可复现（逐步重放）、确定性贪心集合覆盖压缩、
//       同草稿多次运行结果一致、状态上限截断标记不完整（含 unknown 选项）、
//       起点受阻、HTTP API（草稿 / 已保存 / 404 / 400）、示例剧情。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离数据目录，避免污染开发数据；禁用播种（必须在加载项目模块之前设置）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SEED_ON_START = 'false';

const { coverOptions } = require('../src/coverage');
const { compile } = require('../src/expression');
const { applyAssigns } = require('../src/analyzer');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const eq = (name, a, b) => { assert.strictEqual(a, b, `${name}: ${a} !== ${b}`); passed++; console.log(`  ✓ ${name}`); };

/**
 * 按剧情语义逐步重放一条路线：
 * 从起点初始状态出发，逐步校验选项条件成立、赋值 / 进入赋值与响应中的每步状态一致、
 * 目标场景前置条件成立。任何一步对不上即抛错（证明路线“可复现”）。
 */
function replay(story, route) {
  const sceneMap = new Map((story.scenes || []).map((s) => [s.id, s]));
  const assignsOf = (list) => (list || []).filter((a) => a && a.variable);
  // 引擎的状态包含全部已知变量（未赋值为 false），重放时同样补齐
  const fullVars = new Set();
  for (const v of story.variables || []) fullVars.add(typeof v === 'string' ? v : v.name);
  for (const s of story.scenes || []) {
    for (const a of assignsOf(s.assigns)) fullVars.add(a.variable);
    for (const o of s.options || []) for (const a of assignsOf(o.assigns)) fullVars.add(a.variable);
  }
  let current = applyAssigns(Object.fromEntries([...fullVars].map((v) => [v, false])),
    assignsOf(sceneMap.get(story.startScene).assigns));
  const nodes = route.steps;
  assert.strictEqual(nodes[0].kind, 'scene', '路线以场景节点开始');
  assert.strictEqual(nodes[0].sceneId, story.startScene, '路线从起点场景开始');
  assert.deepStrictEqual(nodes[0].state, current, '起点状态 = 起点进入赋值');

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind === 'scene') {
      assert.deepStrictEqual(node.state, current, `第 ${i} 步场景状态与重放一致`);
      const pc = compile(sceneMap.get(node.sceneId).precondition || '');
      assert.ok(pc.evaluate(current), `进入场景 ${node.sceneId} 时前置条件成立`);
    } else {
      const scene = sceneMap.get(node.fromSceneId);
      const option = scene.options[node.optionIndex];
      const cond = compile(option.condition || '');
      assert.ok(cond.evaluate(current), `第 ${i} 步选项「${option.text}」条件成立`);
      current = applyAssigns(current, assignsOf(option.assigns));
      current = applyAssigns(current, assignsOf(sceneMap.get(node.target).assigns));
      assert.deepStrictEqual(node.stateAfter, current, `第 ${i} 步选项后的状态与重放一致`);
      const tc = compile(sceneMap.get(node.target).precondition || '');
      assert.ok(tc.evaluate(current), `第 ${i} 步目标场景 ${node.target} 入口前置成立`);
    }
  }
}

// ---------- 基本覆盖 + 路径可复现 ----------
console.log('基本覆盖：');
const storyBranch = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'opt-a1', text: '去 b', target: 'b' }, { uid: 'opt-a2', text: '去 c', target: 'c' }] },
    { id: 'b', options: [{ uid: 'opt-b1', text: '结束', target: 'd' }] },
    { id: 'c', options: [{ uid: 'opt-c1', text: '结束', target: 'd' }] },
    { id: 'd', options: [] },
  ],
};
const r1 = coverOptions(storyBranch);
ok('完整展开', r1.complete === true && r1.truncated === false);
eq('4 条可走选项', r1.coverage.total, 4);
eq('全覆盖', r1.coverage.covered, 4);
eq('覆盖率 1', r1.coverage.rate, 1);
ok('每条路线均可逐步重放', r1.routes.every((rt) => { replay(storyBranch, rt); return true; }));
ok('路线步骤含选项 UID 与场景',
  r1.routes.every((rt) => rt.steps.some((n) => n.kind === 'option' && n.optionUid && n.fromSceneId && n.target)));
ok('路线列出每步状态',
  r1.routes.every((rt) => rt.steps.filter((n) => n.kind === 'scene').every((n) => n.state && typeof n.state === 'object')));
ok('每条可走选项都映射到某条路线', r1.walkableOptions.every((o) => Number.isInteger(o.route)));
ok('walkableOptions 的 routeStepIndex 指向对应选项边，此前缀可独立重放',
  r1.walkableOptions.every((o) => {
    const route = r1.routes.find((rt) => rt.route === o.route);
    const prefix = { steps: route.steps.slice(0, o.routeStepIndex + 1) };
    replay(storyBranch, prefix);
    const edge = route.steps[o.routeStepIndex];
    return edge.kind === 'option' && edge.optionUid === o.uid;
  }));
ok('路线新覆盖数合计 = 覆盖选项数',
  r1.routes.reduce((acc, rt) => acc + rt.newlyCoveredCount, 0) === 4);
ok('覆盖集合数合计无遗漏：所有路线覆盖并集 = 全部分母',
  (() => {
    const set = new Set();
    for (const rt of r1.routes) for (const o of rt.coveredOptions) set.add(o.uid);
    return set.size === 4;
  })());

// ---------- 贪心压缩：线性长链 1 条路线覆盖全部 ----------
console.log('贪心集合覆盖压缩：');
const storyChain = {
  startScene: 's0',
  scenes: [0, 1, 2, 3, 4].map((i) => ({
    id: `s${i}`,
    options: i < 4 ? [{ uid: `opt-${i}`, text: `前进 ${i}`, target: `s${i + 1}` }] : [],
  })),
};
const r2 = coverOptions(storyChain);
eq('4 条候选证据路线', r2.counts.candidateRoutes, 4);
eq('贪心压缩为 1 条路线', r2.routes.length, 1);
eq('该路线 4 步', r2.routes[0].depth, 4);
eq('新覆盖 4 个选项', r2.routes[0].newlyCoveredCount, 4);
replay(storyChain, r2.routes[0]);

// 星形结构：共享前缀的路线先被贪心选中
const storyHub = {
  startScene: 'h',
  scenes: [
    { id: 'h', options: [{ uid: 'hub', text: '到枢纽', target: 'm' }] },
    {
      id: 'm',
      options: [
        { uid: 'm1', text: '叶 1', target: 'l1' },
        { uid: 'm2', text: '叶 2', target: 'l2' },
        { uid: 'm3', text: '叶 3', target: 'l3' },
      ],
    },
    { id: 'l1', options: [] }, { id: 'l2', options: [] }, { id: 'l3', options: [] },
  ],
};
const r2b = coverOptions(storyHub);
eq('4 条可走选项', r2b.coverage.total, 4);
// 贪心首轮三条候选增益相同（都覆盖 hub + 一个叶），平局取场景顺序/下标最小者 m1；
// 之后两轮各补一个叶，共 3 条路线
eq('星形结构压缩为 3 条路线', r2b.routes.length, 3);
eq('第一条路线新覆盖 2 个（含共享前缀）', r2b.routes[0].newlyCoveredCount, 2);
ok('第一条路线是选项顺序最小的叶', r2b.routes[0].witnessFor.uid === 'm1');
for (const rt of r2b.routes) replay(storyHub, rt);

// ---------- 确定性：同草稿两次结果逐字节一致 ----------
console.log('确定性：');
const r1again = coverOptions(storyBranch);
eq('两次运行 JSON 完全一致', JSON.stringify(r1again), JSON.stringify(r1));
const r2bagain = coverOptions(storyHub);
eq('星形结构两次运行 JSON 完全一致', JSON.stringify(r2bagain), JSON.stringify(r2b));

// ---------- 分母排除：不可达 / 恒假 / 悬空 / 入口受阻 ----------
console.log('覆盖分母排除：');
const storyDefects = {
  startScene: 'a',
  variables: [{ name: 'k' }],
  scenes: [
    {
      id: 'a',
      options: [
        { uid: 'ok-go', text: '正常选项', target: 'b' },
        { uid: 'never', text: '恒假选项', condition: 'k', target: 'b' },
        { uid: 'orphan', text: '悬空跳转', target: 'ghost' },
        { uid: 'blocked', text: '入口受阻', target: 't', assigns: [{ variable: 'k', value: false }] },
      ],
    },
    { id: 'b', options: [] },
    { id: 't', precondition: 'k', options: [] },
    { id: 'isolated', options: [{ uid: 'far', text: '不可达场景里的选项', target: 'b' }] },
  ],
};
const r3 = coverOptions(storyDefects);
eq('只有 1 条实际可走选项计入分母', r3.coverage.total, 1);
eq('覆盖率 1/1', r3.coverage.rate, 1);
const reasons = Object.fromEntries(r3.excludedOptions.map((o) => [o.uid, o.reason]));
eq('恒假选项被排除', reasons.never, 'neverTrueOption');
eq('悬空选项被排除', reasons.orphan, 'orphanOption');
eq('入口受阻选项被排除', reasons.blocked, 'blockedEntry');
eq('不可达场景选项被排除', reasons.far, 'unreachableScene');
ok('被排除选项不出现在任何路线覆盖集合中',
  r3.routes.every((rt) => rt.coveredOptions.every((o) => o.uid === 'ok-go')));

// ---------- 循环：按具体状态去重；只有绕循环一圈才能走的选项被覆盖 ----------
console.log('循环图：');
const storyLoop = {
  startScene: 'a',
  variables: [{ name: 'hasKey' }],
  scenes: [
    { id: 'a', options: [{ uid: 'enter-forest', text: '进森林', target: 'f' }] },
    {
      id: 'f',
      options: [
        { uid: 'search', text: '摸索（没钥匙时）', condition: '!hasKey', target: 'f', assigns: [{ variable: 'hasKey', value: true }] },
        { uid: 'leave', text: '有钥匙后离开', condition: 'hasKey', target: 'e' },
      ],
    },
    { id: 'e', options: [] },
  ],
};
const r4 = coverOptions(storyLoop);
eq('3 条可走选项', r4.coverage.total, 3);
eq('循环下仍全覆盖', r4.coverage.covered, 3);
// leave 的证据路径必须先经 search 自环改变具体状态
const leaveWitness = r4.routes.find((rt) => rt.witnessFor.uid === 'leave')
  || r4.routes.find((rt) => rt.coveredOptions.some((o) => o.uid === 'leave'));
ok('离开选项的证据路线经过自环选项', leaveWitness.steps.some((n) => n.kind === 'option' && n.optionUid === 'search'));
ok('证据路线无重复具体状态（场景+状态去重）',
  (() => {
    const seen = new Set();
    for (const n of leaveWitness.steps) {
      if (n.kind !== 'scene') continue;
      const sig = n.sceneId + JSON.stringify(n.state);
      if (seen.has(sig)) return false;
      seen.add(sig);
    }
    return true;
  })());
for (const rt of r4.routes) replay(storyLoop, rt);

// 纯循环（无出口）也必须终止并覆盖环上选项
const storyTrap = {
  startScene: 'a',
  variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', options: [{ uid: 'flip', text: '翻转并自环', target: 'a', assigns: [{ variable: 'x', value: true }] }] },
  ],
};
const r4b = coverOptions(storyTrap);
ok('纯循环展开终止且完整', r4b.complete === true);
eq('环上 1 条选项可走且被覆盖', r4b.coverage.covered, 1);
replay(storyTrap, r4b.routes[0]);

// ---------- 起点受阻 ----------
console.log('起点受阻：');
const storyBlockedStart = {
  startScene: 'a',
  variables: [{ name: 'x' }],
  scenes: [
    { id: 'a', precondition: 'x', options: [{ uid: 'o1', text: '永远到不了', target: 'b' }] },
    { id: 'b', options: [] },
  ],
};
const r5 = coverOptions(storyBlockedStart);
ok('起点受阻被标记', r5.startBlocked === true);
eq('分母为 0', r5.coverage.total, 0);
eq('覆盖率记为 0', r5.coverage.rate, 0);
eq('不生成路线', r5.routes.length, 0);
eq('不可走选项按场景不可达排除', r5.excludedOptions[0].reason, 'unreachableScene');

// 无任何可走选项（分母为 0 但图完整）
const storyNoWalk = {
  startScene: 'a',
  variables: [{ name: 'x' }],
  scenes: [{ id: 'a', options: [{ uid: 'o1', text: '恒假', condition: 'x', target: 'b' }] }, { id: 'b', options: [] }],
};
const r5b = coverOptions(storyNoWalk);
ok('图完整但分母为 0', r5b.complete === true && r5b.coverage.total === 0 && r5b.routes.length === 0);

// ---------- 截断：状态上限 ----------
console.log('状态上限截断：');
const storyTrunc = {
  startScene: 'a',
  scenes: [
    { id: 'a', options: [{ uid: 'a-to-b', text: '去 b', target: 'b' }] },
    { id: 'b', options: [{ uid: 'b-to-c', text: '去 c', target: 'c' }] },
    { id: 'c', options: [{ uid: 'deep', text: '深处选项', target: 'a' }] },
  ],
};
const r6 = coverOptions(storyTrunc, { maxStates: 2 });
ok('截断被如实标记', r6.truncated === true && r6.complete === false && r6.ok === false);
ok('结果声明不完整的提示文案', /截断|不完整/.test(r6.message));
// a→b 在截断前已确认可走；c 场景选项因 c 未入队而未被观测 => unknown
eq('已确认可走选项仍计入覆盖', r6.coverage.total, 2);
ok('存在未观测选项（unknown）', r6.counts.unknownOptions >= 1 &&
  r6.unknownOptions.some((o) => o.uid === 'deep'));
ok('unknown 选项不计入分母', r6.coverage.total === r6.counts.walkableOptions);
// 截断结果中的路线同样可重放
for (const rt of r6.routes) replay(storyTrunc, rt);

// ---------- 示例剧情 ----------
console.log('示例剧情：');
const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'adventure-demo.json'), 'utf8'));
const rd = coverOptions(demo);
ok('示例完整展开', rd.complete === true);
ok('示例全覆盖', rd.coverage.remaining === 0 && rd.coverage.rate === 1);
const demoReasons = Object.fromEntries(rd.excludedOptions.map((o) => [`${o.sceneId}#${o.optionIndex}`, o.reason]));
eq('强行闯门 = 恒假', demoReasons['castle#0'], 'neverTrueOption');
eq('侧门溜宝库 = 入口受阻', demoReasons['castle#3'], 'blockedEntry');
eq('宝库离开 = 场景不可达', demoReasons['treasureRoom#0'], 'unreachableScene');
eq('挑战巨龙 = 悬空跳转', demoReasons['ending#0'], 'orphanOption');
for (const rt of rd.routes) replay(demo, rt);

// ---------- HTTP API ----------
(async () => {
  console.log('HTTP API：');
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const req = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  try {
    const q1 = await req('POST', '/api/coverage', storyBranch);
    ok('POST /api/coverage 返回 200 且全覆盖',
      q1.status === 200 && q1.body.coverage.rate === 1 && Array.isArray(q1.body.routes));

    const q1b = await req('POST', '/api/coverage', { story: storyBranch });
    ok('POST /api/coverage 接受 { story } 包装', q1b.status === 200 && q1b.body.complete === true);

    const q2 = await req('POST', '/api/coverage', { scenes: [{ id: 'a' }] });
    ok('缺少有效起点返回 400', q2.status === 400 && /起点/.test(q2.body.error || ''));

    const created = await req('POST', '/api/stories', storyBranch);
    ok('创建剧情成功', created.status === 201 && created.body.id);
    const sid = created.body.id;
    // 保存后服务端补齐了稳定 UID
    ok('保存后选项带稳定 UID', created.body.scenes[0].options[0].uid.startsWith('opt-'));

    const q3 = await req('GET', `/api/stories/${sid}/coverage`);
    ok('GET /api/stories/:id/coverage 返回覆盖路线',
      q3.status === 200 && q3.body.coverage.rate === 1 &&
      q3.body.walkableOptions.every((o) => o.uid.startsWith('opt-')));

    const q4 = await req('GET', '/api/stories/no-such-id/coverage');
    ok('剧情不存在返回 404', q4.status === 404);

    // 草稿不落盘：覆盖接口调用后剧情内容不被修改
    const before = (await req('GET', `/api/stories/${sid}`)).body;
    await req('POST', '/api/coverage', { ...before, title: '临时草稿标题' });
    const after = (await req('GET', `/api/stories/${sid}`)).body;
    eq('草稿覆盖不写盘', after.title, before.title);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n全部 ${passed} 项选项覆盖路线断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

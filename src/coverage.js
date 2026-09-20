'use strict';

/**
 * 选项覆盖路线（Option Coverage Routes）
 *
 * 针对编辑中的草稿，展开「场景 + 变量状态」具体状态图（与分析器 / 概率推演
 * 相同的 BFS 与按具体状态去重，含环必然终止，上限 MAX_STATES），然后：
 *
 *   1. 为每一条“实际可走”的选项（所在场景可达；存在某个到达状态使其条件成立；
 *      目标场景存在；应用选项赋值与目标进入赋值后目标前置条件成立）保留一条
 *      从起点出发、以该选项为最后一步的【可复现最短路径】（证据路线）；
 *   2. 每条证据路线实际覆盖“路径上经过的所有可走选项”，据此做集合覆盖；
 *   3. 用【确定性贪心集合覆盖】压缩路线集：每轮选择覆盖“尚未覆盖选项”最多
 *      的路线，平局按最短步长、场景 ID、选项下标等全序键决出，保证同一草稿
 *      永远得到同一份路线集；
 *   4. 汇总覆盖率。
 *
 * 覆盖分母只计“实际可走”的选项——不可达场景中的选项、恒假（neverTrue）、
 * 悬空跳转（orphan）、入口受阻（blockedEntry）一律不计入分母（它们在结果中
 * 以 excluded 单独列出，带原因）。
 *
 * 循环图：状态去重键为 场景ID + 完整变量位图，环路在具体状态上闭合，同一
 * (场景,状态) 不会重复扩展，因此每条证据路径都是简单（无状态重复）的可复现路径。
 *
 * 截断：具体状态数超过 maxStates 时 BFS 截断，结果标记 complete=false，
 * 覆盖率只针对已确认可走的选项计算（是真实覆盖率的下界），未被任何已扩展
 * 状态观测到的选项归入 unknown，绝不冒充完整结果。
 */

const { compile } = require('./expression');
const { encodeState, decodeState, applyAssigns, collectStateVars, MAX_STATES } = require('./analyzer');

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * 计算选项覆盖路线。
 *
 * @param storyInput 剧情对象（草稿或已保存均可）
 * @param opts       { maxStates } 测试可注入更小的状态上限
 */
function coverOptions(storyInput, opts = {}) {
  const story = storyInput || {};
  const maxStates = Number.isInteger(opts.maxStates) && opts.maxStates > 0 ? opts.maxStates : MAX_STATES;

  const scenes = Array.isArray(story.scenes) ? story.scenes : [];
  const sceneMap = new Map();
  for (const s of scenes) {
    if (s && s.id && !sceneMap.has(s.id)) sceneMap.set(s.id, s);
  }

  if (!story.startScene || !sceneMap.has(story.startScene)) {
    throw badRequest('剧情缺少有效的起点场景，无法生成覆盖路线');
  }

  // ---- 编译条件（语法错误按恒真处理，与分析器 / 路径查询 / 推演一致） ----
  const conditionErrors = [];
  const safeCompile = (raw, where) => {
    try {
      return compile(raw);
    } catch (e) {
      conditionErrors.push({ where, message: e.message });
      return null;
    }
  };
  const sceneCond = new Map();
  const sceneAssigns = new Map();
  const optionCompiled = new Map(); // `${sceneId}#${idx}` -> { cond, assigns }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    sceneCond.set(scene.id, safeCompile(scene.precondition, `场景 "${scene.id}" 的前置条件`));
    sceneAssigns.set(scene.id, (scene.assigns || []).filter((a) => a && a.variable));
    (scene.options || []).forEach((opt, idx) => {
      optionCompiled.set(`${scene.id}#${idx}`, {
        cond: safeCompile(opt && opt.condition, `场景 "${scene.id}" 选项 ${idx + 1} 的条件`),
        assigns: ((opt && opt.assigns) || []).filter((a) => a && a.variable),
      });
    });
  }

  const knownVars = collectStateVars({ ...story, scenes });

  // ---- 全部选项登记（稳定 UID 优先，缺失退回 idx: 键，与分析器一致） ----
  const allOptions = []; // { key, sceneId, index, uid, option, targetId }
  for (const scene of scenes) {
    if (!scene || !scene.id) continue;
    (scene.options || []).forEach((option, index) => {
      const key = `${scene.id}#${index}`;
      allOptions.push({
        key,
        sceneId: scene.id,
        index,
        uid: (option && option.uid) || `idx:${key}`,
        hasStableUid: !!(option && option.uid),
        option: option || {},
        targetId: ((option && option.target) || '').trim(),
      });
    });
  }

  // ---- BFS 展开「场景 + 变量状态」图 ----
  const parent = new Map();   // "sceneId\x00code" -> { parentKey, depth, edge }
  const keyOf = (id, code) => `${id}\x00${code}`;
  const visited = new Set();
  const queue = [];
  let truncated = false;
  let stateCount = 0;

  // 选项观测（key 与 allOptions 对齐）
  const observed = new Set();   // 所在状态被扩展、选项被求值过
  const walkableKeys = new Set();   // 至少在一个具体状态下“条件成立且目标可进入”
  const blockedKeys = new Set();    // 条件成立过，但目标入口前置恒不成立
  const enabledBest = new Map();    // key -> 首次可走时的前驱状态（BFS => 最短）
  const expandedStates = new Set(); // 实际完成扩展的具体状态（截断时队列里可能有未处理项）

  const offer = (sceneId, code, depth, predKey, edge) => {
    if (truncated) return;
    const key = keyOf(sceneId, code);
    if (visited.has(key)) return;
    visited.add(key);
    stateCount++;
    parent.set(key, { parentKey: predKey, depth, edge });
    if (stateCount > maxStates) { truncated = true; return; }
    queue.push({ sceneId, code, depth, key });
  };

  // 起点：初始状态 = 全部 false 叠加起点场景进入赋值；起点前置不成立则无法开始
  const startState = applyAssigns({}, sceneAssigns.get(story.startScene) || []);
  const startPc = sceneCond.get(story.startScene);
  const startBlocked = !!(startPc && !startPc.evaluate(startState));
  if (!startBlocked) {
    offer(story.startScene, encodeState(startState, knownVars), 0, null, null);
  }

  let head = 0;
  while (head < queue.length && !truncated) {
    const cur = queue[head++];
    expandedStates.add(cur.key);
    const scene = sceneMap.get(cur.sceneId);
    const state = decodeState(cur.code, knownVars);

    (scene.options || []).forEach((option, idx) => {
      if (truncated) return;
      const key = `${cur.sceneId}#${idx}`;
      observed.add(key);

      const oc = optionCompiled.get(key);
      if (oc && oc.cond && !oc.cond.evaluate(state)) return; // 该具体状态下条件不成立

      const targetId = ((option && option.target) || '').trim();
      if (!targetId || !sceneMap.has(targetId)) return;      // 悬空跳转：永远不可走

      let nextState = state;
      if (oc && oc.assigns.length) nextState = applyAssigns(nextState, oc.assigns);
      nextState = applyAssigns(nextState, sceneAssigns.get(targetId) || []);
      const tc = sceneCond.get(targetId);
      if (tc && !tc.evaluate(nextState)) {
        blockedKeys.add(key); // 此状态下入口受阻（其他状态也许可进入）
        return;
      }

      // 实际可走：记录最短证据（BFS 首次即可），再照常扩展具体状态
      if (!walkableKeys.has(key)) {
        walkableKeys.add(key);
        enabledBest.set(key, { predKey: cur.key, depth: cur.depth, state: { ...state } });
      }
      offer(targetId, encodeState(nextState, knownVars), cur.depth + 1, cur.key, {
        optionIndex: idx,
        optionUid: (option && option.uid) || null,
        optionKey: key,
        optionText: (option && option.text) || '',
        fromSceneId: cur.sceneId,
        target: targetId,
      });
    });
  }

  // ---- 路径重建：scene / option 交替；scene 节点带到达状态，option 边带选择后状态 ----
  const buildPathTo = (predKey, lastEdge) => {
    const trail = [];
    if (lastEdge) trail.push({ kind: 'option', ...lastEdge });
    let k = predKey;
    while (k) {
      const [sid, code] = k.split('\x00');
      const sc = sceneMap.get(sid);
      const stateHere = decodeState(code, knownVars);
      trail.push({ kind: 'scene', sceneId: sid, title: sc ? (sc.title || '') : '', state: stateHere });
      const p = parent.get(k);
      // 选项边的“选择后状态”即到达子场景时的状态（含选项赋值与目标进入赋值）
      if (p && p.edge) trail.push({ kind: 'option', ...p.edge, stateAfter: stateHere });
      k = p ? p.parentKey : null;
    }
    trail.reverse();
    return trail;
  };

  const optionByKey = new Map(allOptions.map((o) => [o.key, o]));

  /** 构造一条证据路线：起点 -> ... -> 以 optKey 为最后一步（含选择后的状态） */
  const buildWitness = (optKey) => {
    const info = optionByKey.get(optKey);
    const best = enabledBest.get(optKey);
    const oc = optionCompiled.get(optKey);
    // 复现最后一步：在证据前驱状态上应用选项赋值 + 目标场景进入赋值
    const stateAfter = applyAssigns(
      applyAssigns({ ...best.state }, oc ? oc.assigns : []),
      sceneAssigns.get(info.targetId) || []);
    const lastEdge = {
      optionIndex: info.index,
      optionUid: info.option.uid || null,
      optionKey: info.key,
      optionText: info.option.text || '',
      fromSceneId: info.sceneId,
      target: info.targetId,
      stateAfter,
    };
    const path = buildPathTo(best.predKey, lastEdge);
    return { path, depth: best.depth + 1 };
  };

  // ---- 每条可走选项一条证据路线；覆盖集合 = 路径上出现过的全部可走选项 ----
  // 输出顺序确定：按 BFS 首次可走的（深度，场景顺序，选项下标）排序
  const sceneOrder = new Map();
  scenes.forEach((s, i) => { if (s && s.id) sceneOrder.set(s.id, i); });
  const walkableList = [...walkableKeys].sort((a, b) => {
    const ea = enabledBest.get(a);
    const eb = enabledBest.get(b);
    if (ea.depth !== eb.depth) return ea.depth - eb.depth;
    const oa = optionByKey.get(a);
    const ob = optionByKey.get(b);
    const sa = sceneOrder.get(oa.sceneId);
    const sb = sceneOrder.get(ob.sceneId);
    if (sa !== sb) return sa - sb;
    return oa.index - ob.index;
  });

  const candidates = []; // { key, depth, covers:Set<key>, path }
  for (const key of walkableList) {
    const w = buildWitness(key);
    const covers = new Set();
    const stepIndexOf = new Map(); // 被覆盖选项 -> 它在该路线 steps 中首次出现的选项边下标
    w.path.forEach((node, i) => {
      if (node.kind === 'option' && node.optionKey && walkableKeys.has(node.optionKey)) {
        covers.add(node.optionKey);
        if (!stepIndexOf.has(node.optionKey)) stepIndexOf.set(node.optionKey, i);
      }
    });
    if (!covers.has(key)) covers.add(key); // 自身一定被自己覆盖（恒真兜底）
    candidates.push({ key, depth: w.depth, covers, stepIndexOf, path: w.path });
  }

  // ---- 确定性贪心集合覆盖 ----
  // 每轮选“新覆盖选项数最多”的候选；平局依次比较：路线更短、场景顺序更早、
  // 选项下标更小。candidates 已按该全序排列，遍历时用严格大于即可稳定取首个最优。
  const remaining = new Set(walkableList);
  const chosen = [];          // 选中的 candidate（有序：贪心选中次序）
  const firstCoveredBy = new Map(); // optionKey -> 首次覆盖它的路线序号（贪心轮次）
  while (remaining.size) {
    let bestCand = null;
    let bestGain = 0;
    for (const cand of candidates) {
      if (cand._used) continue;
      let gain = 0;
      for (const k2 of cand.covers) if (remaining.has(k2)) gain++;
      if (gain > bestGain) { bestGain = gain; bestCand = cand; }
    }
    if (!bestCand) break; // 理论上不可达：每个候选至少覆盖自身
    bestCand._used = true;
    const routeNo = chosen.length + 1;
    for (const k2 of bestCand.covers) {
      if (remaining.has(k2)) {
        remaining.delete(k2);
        firstCoveredBy.set(k2, routeNo);
      }
    }
    chosen.push(bestCand);
  }

  // ---- 组装输出 ----
  const describeOption = (o) => ({
    uid: o.uid,
    hasStableUid: o.hasStableUid,
    sceneId: o.sceneId,
    optionIndex: o.index,
    text: o.option.text || '',
    target: o.targetId,
  });

  const routes = chosen.map((cand, i) => {
    const target = optionByKey.get(cand.key);
    const coveredKeys = [...cand.covers].sort((a, b) => {
      const oa = optionByKey.get(a);
      const ob = optionByKey.get(b);
      const sa = sceneOrder.get(oa.sceneId);
      const sb = sceneOrder.get(ob.sceneId);
      if (sa !== sb) return sa - sb;
      return oa.index - ob.index;
    });
    return {
      route: i + 1,
      witnessFor: describeOption(target), // 该路线作为哪条选项的最短证据
      depth: cand.depth,                  // 选项步数
      steps: cand.path,                   // scene / option 交替，含每步状态
      coveredOptions: coveredKeys.map((k2) => ({
        ...describeOption(optionByKey.get(k2)),
        stepIndex: cand.stepIndexOf.get(k2), // 在本路线 steps 中首次经过该选项的位置（此前缀即可复现到该选项）
      })),
      newlyCoveredCount: 0,               // 下面回填
    };
  });
  // 回填“该路线首次新覆盖的选项数”
  const newlyByRoute = new Map();
  for (const [k2, routeNo] of firstCoveredBy) {
    newlyByRoute.set(routeNo, (newlyByRoute.get(routeNo) || 0) + 1);
  }
  routes.forEach((r) => { r.newlyCoveredCount = newlyByRoute.get(r.route) || 0; });
  const candidateByRoute = new Map(routes.map((r, i) => [r.route, chosen[i]]));

  // 选项分类（分母只含 walkable；其他一律 excluded，不进入覆盖率）
  const reachableScenes = new Set();
  for (const key of visited) reachableScenes.add(key.split('\x00')[0]);

  const coveredOptions = [];
  const excludedOptions = [];
  const unknownOptions = [];

  for (const o of allOptions) {
    if (walkableKeys.has(o.key)) {
      const routeNo = firstCoveredBy.get(o.key) ?? null;
      coveredOptions.push({
        ...describeOption(o),
        witnessDepth: enabledBest.get(o.key).depth + 1,
        route: routeNo,
        // 在所属路线 steps 中首次经过该选项的位置：steps.slice(0, stepIndex + 1) 即其可复现路径
        routeStepIndex: routeNo ? candidateByRoute.get(routeNo).stepIndexOf.get(o.key) : null,
      });
      continue;
    }
    // 非可走：给出原因（与分析器 optionStatus 口径一致）
    let reason;
    if (!reachableScenes.has(o.sceneId)) reason = 'unreachableScene';
    else if (!o.targetId || !sceneMap.has(o.targetId)) reason = 'orphanOption';
    else if (blockedKeys.has(o.key)) reason = 'blockedEntry';
    else if (observed.has(o.key)) reason = 'neverTrueOption';
    else reason = 'unknown'; // 场景可达但没有任何已扩展状态到达它（截断时才会出现）

    if (reason === 'unknown') {
      unknownOptions.push({ ...describeOption(o), reason });
    } else {
      excludedOptions.push({ ...describeOption(o), reason });
    }
  }

  const walkableCount = walkableList.length;
  const coveredCount = walkableCount - remaining.size;
  const complete = !truncated && !startBlocked;
  const coverageRate = walkableCount ? coveredCount / walkableCount : (startBlocked ? 0 : 1);

  let message;
  if (startBlocked) {
    message = '起点场景的前置条件在初始状态下不成立，剧情无法开始：没有任何可走选项，覆盖率为 0。';
  } else if (truncated) {
    message = `具体状态超过安全上限（${maxStates}），状态图展开被截断：以下结果不完整，`
      + `覆盖率 ${coveredCount}/${walkableCount} 只针对已确认可走的选项（真实覆盖率的下界），`
      + `另有 ${unknownOptions.length} 个选项因截断未能观测。`;
  } else if (walkableCount === 0) {
    message = '状态图完整展开，但不存在任何实际可走的选项（覆盖分母为 0）；'
      + `不可走的 ${excludedOptions.length} 个选项已在“不计入覆盖”中列出原因。`;
  } else {
    message = `状态图完整展开（${stateCount} 个具体状态）：共 ${walkableCount} 条实际可走选项，`
      + `${routes.length} 条路线实现全覆盖（${coveredCount}/${walkableCount} = ${(coverageRate * 100).toFixed(1)}%）。`;
  }

  return {
    ok: complete,
    complete,
    truncated,
    startBlocked,
    startScene: story.startScene,
    knownVars,
    conditionErrors,
    counts: {
      scenes: scenes.length,
      options: allOptions.length,
      concreteStates: stateCount,
      expandedStates: expandedStates.size,
      walkableOptions: walkableCount,
      coveredOptions: coveredCount,
      excludedOptions: excludedOptions.length,
      unknownOptions: unknownOptions.length,
      candidateRoutes: candidates.length,
      routes: routes.length,
      totalSteps: routes.reduce((acc, r) => acc + r.depth, 0),
    },
    coverage: {
      covered: coveredCount,
      total: walkableCount,
      remaining: remaining.size,
      rate: coverageRate,
    },
    routes,
    walkableOptions: coveredOptions,
    excludedOptions,
    unknownOptions,
    maxStates,
    message,
  };
}

module.exports = { coverOptions, MAX_STATES };

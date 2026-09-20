'use strict';

/* ============================================================
 * 全局状态
 * ============================================================ */
const state = {
  list: [],
  story: null,          // 当前剧情（编辑中的草稿）
  currentId: null,      // 当前选中场景 ID
  analysis: null,       // 最近一次分析结果
  baseline: null,       // 当前剧情保存的分析基线
  diff: null,           // 最近一次基线对比结果 { summary, items }
  diffFilter: 'all',    // 对比状态筛选：all/new/fixed/persistent/changed
  diffStale: false,     // 对比之后剧情又被编辑过
  detailItem: null,     // 详情面板当前展示的对比条目
  detailPathMode: 'after', // 详情中查看的路径：after（当前）/ before（基线）
  pathQuery: { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] }, // 目标路径查询条件（编辑中；必经/禁用为选项 UID）
  pathQueryResult: null,  // 最近一次路径查询结果
  pathQueryStale: false,  // 查询之后剧情或查询条件又被修改过
  _pqSig: null,           // 查询面板场景/变量签名（避免每次编辑都重建下拉框）
  probResult: null,       // 最近一次结局概率推演结果
  probStale: false,       // 推演之后剧情又被编辑过
  dirty: false,
  saving: false,
};

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

/* ============================================================
 * 剧情级操作
 * ============================================================ */
async function loadList(selectId) {
  state.list = await api('GET', '/api/stories');
  const sel = $('storySelect');
  sel.innerHTML = '';
  for (const s of state.list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    sel.appendChild(opt);
  }
  if (selectId && state.list.some((s) => s.id === selectId)) sel.value = selectId;
  else if (state.list.length) sel.value = state.list[0].id;
  return sel.value;
}

async function openStory(id) {
  state.story = await api('GET', `/api/stories/${id}`);
  state.currentId = state.story.startScene || (state.story.scenes[0] && state.story.scenes[0].id) || null;
  state.dirty = false;
  state.baseline = state.story.baseline || null;
  state.diff = null;
  state.diffFilter = 'all';
  state.diffStale = false;
  state.detailItem = null;
  state.pathQuery = { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] };
  state.pathQueryResult = null;
  state.pathQueryStale = false;
  state._pqSig = null;
  state.probResult = null;
  state.probStale = false;
  $('storySelect').value = id;
  renderAll();
  await runAnalysis(false);
}

async function refreshAndOpen(id) {
  await loadList(id);
  await openStory(id);
}

async function createStory() {
  const story = {
    title: '未命名剧情',
    description: '',
    startScene: 'start',
    variables: [{ name: 'flag', description: '示例变量，可删除' }],
    scenes: [{
      id: 'start', title: '起点', text: '故事从这里开始。',
      precondition: '', assigns: [],
      options: [{ text: '继续', condition: '', target: '', assigns: [] }],
    }],
  };
  const created = await api('POST', '/api/stories', story);
  toast('已创建新剧情');
  await refreshAndOpen(created.id);
}

async function saveStory() {
  if (!state.story) return;
  state.saving = true;
  try {
    const saved = await api('PUT', `/api/stories/${state.story.id}`, state.story);
    state.story = saved;
    state.baseline = saved.baseline || null;
    state.dirty = false;
    renderMeta();
    renderSceneList();
    renderSaveStatus();
    toast('已保存');
    await runAnalysis(false);
  } catch (e) {
    toast(`保存失败：${e.message}`);
  } finally {
    state.saving = false;
  }
}

async function deleteStory() {
  if (!state.story) return;
  if (!confirm(`确定删除剧情「${state.story.title}」？此操作不可恢复。`)) return;
  await api('DELETE', `/api/stories/${state.story.id}`);
  state.story = null;
  state.analysis = null;
  state.baseline = null;
  state.diff = null;
  state.detailItem = null;
  state.diffStale = false;
  state.pathQuery = { targetScene: '', constraints: [], requiredOptions: [], disabledOptions: [] };
  state.pathQueryResult = null;
  state.pathQueryStale = false;
  state._pqSig = null;
  state.probResult = null;
  state.probStale = false;
  const next = await loadList();
  if (next) await openStory(next);
  else { renderAll(); toast('已删除'); }
}

function exportStory() {
  if (!state.story) return;
  const a = document.createElement('a');
  a.href = `/api/stories/${state.story.id}/export`;
  a.download = `${state.story.id}.json`;
  a.click();
}

function importStory(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.scenes)) throw new Error('JSON 中缺少 scenes 数组');
      delete data.id; // 导入总是创建新剧情，避免覆盖
      delete data.createdAt;
      delete data.updatedAt;
      const created = await api('POST', '/api/stories', data);
      toast('导入成功');
      await refreshAndOpen(created.id);
    } catch (e) {
      toast(`导入失败：${e.message}`);
    }
  };
  reader.readAsText(file, 'utf-8');
}

/* ============================================================
 * 渲染：顶部设置 + 变量
 * ============================================================ */
function renderAll() {
  renderMeta();
  renderVars();
  renderStartSelect();
  renderSceneList();
  renderEditor();
  renderSaveStatus();
  renderAnalysis();
  renderPathQueryPanel();
  renderProbabilityPanel();
  renderDetail(null);
}

function renderMeta() {
  if (!state.story) return;
  $('storyTitle').value = state.story.title || '';
  $('storyDesc').value = state.story.description || '';
}

function renderStartSelect() {
  const sel = $('startScene');
  sel.innerHTML = '';
  for (const sc of state.story.scenes) {
    const opt = document.createElement('option');
    opt.value = sc.id;
    opt.textContent = `${sc.id}${sc.title ? ' — ' + sc.title : ''}`;
    sel.appendChild(opt);
  }
  sel.value = state.story.startScene || '';
}

function renderVars() {
  const box = $('varList');
  box.innerHTML = '';
  for (const v of state.story.variables) {
    const chip = document.createElement('div');
    chip.className = 'var-chip';
    chip.innerHTML = `<code></code><span class="var-desc"></span><button title="删除变量">✕</button>`;
    chip.querySelector('code').textContent = v.name;
    const desc = chip.querySelector('.var-desc');
    desc.textContent = v.description || '';
    desc.title = '点击编辑说明';
    desc.style.cursor = 'pointer';
    desc.addEventListener('click', () => {
      const d = prompt(`变量 "${v.name}" 的说明：`, v.description || '');
      if (d !== null) { v.description = d; markDirty(renderVars); }
    });
    chip.querySelector('button').addEventListener('click', () => {
      if (!confirm(`删除变量 "${v.name}"？相关条件文本会保留（分析时会提示未声明变量）。`)) return;
      state.story.variables = state.story.variables.filter((x) => x.name !== v.name);
      markDirty(renderVars);
    });
    box.appendChild(chip);
  }
}

function addVar() {
  const input = $('newVarName');
  const name = input.value.trim();
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return toast('变量名需以字母/下划线开头，仅含字母数字下划线');
  if (state.story.variables.some((v) => v.name === name)) return toast('变量已存在');
  state.story.variables.push({ name, description: '' });
  input.value = '';
  markDirty(renderVars);
}

/* ============================================================
 * 渲染：场景列表
 * ============================================================ */
function renderSceneList() {
  const ul = $('sceneList');
  ul.innerHTML = '';
  for (const sc of state.story.scenes) {
    const li = document.createElement('li');
    li.className = 'scene-item' + (sc.id === state.currentId ? ' active' : '');

    const status = state.analysis ? state.analysis.sceneStatus[sc.id] : null;
    let badge = '';
    if (status === 'reachable') badge = '<span class="badge badge-ok">可达</span>';
    else if (status === 'unreachable') badge = '<span class="badge badge-err">不可达</span>';
    else if (status === 'blocked') badge = '<span class="badge badge-err">入口受阻</span>';

    li.innerHTML = `
      <span class="si-id"></span>
      <span class="si-title"></span>
      <span class="si-start">${sc.id === state.story.startScene ? '★起点' : ''}</span>
      ${badge}
    `;
    li.querySelector('.si-id').textContent = sc.id;
    li.querySelector('.si-title').textContent = sc.title || '(无标题)';
    li.addEventListener('click', () => {
      state.currentId = sc.id;
      renderSceneList();
      renderEditor();
    });
    ul.appendChild(li);
  }
}

function addScene() {
  let base = 'scene';
  let id = base;
  let n = 2;
  const ids = new Set(state.story.scenes.map((s) => s.id));
  while (ids.has(id)) id = `${base}${n++}`;
  const sc = { id, title: '新场景', text: '', precondition: '', assigns: [], options: [] };
  state.story.scenes.push(sc);
  state.currentId = id;
  markDirty(() => { renderSceneList(); renderEditor(); renderStartSelect(); });
}

/* ============================================================
 * 渲染：场景编辑器
 * ============================================================ */
function currentScene() {
  return state.story.scenes.find((s) => s.id === state.currentId) || null;
}

function renderEditor() {
  const sc = currentScene();
  $('editorEmpty').hidden = !!sc;
  $('editor').hidden = !sc;
  if (!sc) return;

  $('sceneId').value = sc.id;
  $('sceneTitle').value = sc.title || '';
  $('sceneText').value = sc.text || '';
  $('scenePre').value = sc.precondition || '';
  renderAssigns('sceneAssigns', sc.assigns, 'btnAddSceneAssign');
  renderOptions(sc);
}

function renderAssigns(containerId, assigns, _btnId) {
  const box = $(containerId);
  box.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);

  assigns.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（选择变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = a.variable;
    sel.addEventListener('change', () => { a.variable = sel.value; markDirty(); });

    const arrow = document.createElement('span');
    arrow.className = 'assign-arrow';
    arrow.textContent = '←';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = a.value ? 'true' : 'false';
    val.addEventListener('change', () => { a.value = val.value === 'true'; markDirty(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除赋值';
    del.addEventListener('click', () => { assigns.splice(i, 1); markDirty(() => renderEditor()); });

    row.append(sel, arrow, val, del);
    box.appendChild(row);
  });
}

function renderOptions(sc) {
  const box = $('optionList');
  box.innerHTML = '';
  sc.options.forEach((opt, i) => {
    const card = document.createElement('div');
    card.className = 'option-card';

    // 分析状态着色
    const optStatus = state.analysis ? state.analysis.optionStatus[`${sc.id}#${i}`] : null;
    if (optStatus === 'orphan' || optStatus === 'blockedEntry' || optStatus === 'neverTrue') card.classList.add('is-bad');
    let statusLabel = '';
    if (optStatus === 'orphan') statusLabel = '<span class="badge badge-err">悬空跳转</span>';
    else if (optStatus === 'blockedEntry') statusLabel = '<span class="badge badge-err">入口受阻</span>';
    else if (optStatus === 'neverTrue') statusLabel = '<span class="badge badge-warn">条件恒假</span>';
    else if (optStatus === 'ok') statusLabel = '<span class="badge badge-ok">可达</span>';
    else if (optStatus === 'inUnreachableScene') statusLabel = '<span class="badge badge-muted">场景不可达</span>';

    card.innerHTML = `
      <div class="option-top">
        <span class="option-index">${i + 1}</span>
        <input type="text" class="opt-text" placeholder="选项文案" />
        ${statusLabel}
        <button class="opt-remove" title="删除选项">✕</button>
      </div>
      <div class="option-grid">
        <label class="field full"><span>显示条件（留空恒真）</span><input type="text" class="opt-cond" spellcheck="false" placeholder="如 hasKey && !witchHelp" /></label>
        <label class="field"><span>跳转目标</span><select class="opt-target"></select></label>
        <label class="field opt-weight-field"><span>权重</span><input type="number" class="opt-weight" min="1" step="1" title="结局概率推演用的正整数权重：同一状态下，可走的选项按权重占比被选中；缺省为 1" /></label>
        <div class="field full">
          <span>选择时赋值</span>
          <div class="assign-list opt-assigns"></div>
          <button class="btn btn-small btn-add-assign">＋ 赋值</button>
        </div>
      </div>
    `;

    const text = card.querySelector('.opt-text');
    const cond = card.querySelector('.opt-cond');
    const target = card.querySelector('.opt-target');
    const weight = card.querySelector('.opt-weight');
    text.value = opt.text || '';
    cond.value = opt.condition || '';
    weight.value = opt.weight === undefined ? 1 : opt.weight;

    target.innerHTML = '<option value="">（不跳转 / 悬空）</option>' +
      state.story.scenes.map((s) => `<option value="${s.id}">${s.id}${s.title ? ' — ' + s.title : ''}</option>`).join('');
    target.value = opt.target || '';

    text.addEventListener('input', () => { opt.text = text.value; markDirty(); });
    cond.addEventListener('input', () => { opt.condition = cond.value; markDirty(); });
    target.addEventListener('change', () => { opt.target = target.value; markDirty(); });
    weight.addEventListener('change', () => {
      const v = Number(weight.value);
      if (!Number.isInteger(v) || v < 1) {
        toast('权重必须是正整数（1、2、3…）');
        weight.value = opt.weight === undefined ? 1 : opt.weight;
        return;
      }
      if (v === 1) delete opt.weight; // 缺省即 1，不写入 JSON
      else opt.weight = v;
      weight.value = v;
      markDirty();
    });
    card.querySelector('.opt-remove').addEventListener('click', () => {
      sc.options.splice(i, 1);
      markDirty(() => renderEditor());
    });
    card.querySelector('.btn-add-assign').addEventListener('click', () => {
      opt.assigns.push({ variable: state.story.variables[0]?.name || '', value: true });
      markDirty(() => renderEditor());
    });
    renderOptionAssigns(card.querySelector('.opt-assigns'), opt);

    box.appendChild(card);
  });
}

function renderOptionAssigns(container, opt) {
  container.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);
  opt.assigns.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = a.variable;
    sel.addEventListener('change', () => { a.variable = sel.value; markDirty(); });

    const arrow = document.createElement('span');
    arrow.className = 'assign-arrow';
    arrow.textContent = '←';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = a.value ? 'true' : 'false';
    val.addEventListener('change', () => { a.value = val.value === 'true'; markDirty(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', () => { opt.assigns.splice(i, 1); markDirty(() => renderEditor()); });

    row.append(sel, arrow, val, del);
    container.appendChild(row);
  });
}

/* ============================================================
 * 编辑器事件绑定
 * ============================================================ */
function bindEditorEvents() {
  $('sceneTitle').addEventListener('input', (e) => { currentScene().title = e.target.value; markDirty(); });
  $('sceneText').addEventListener('input', (e) => { currentScene().text = e.target.value; markDirty(); });
  $('scenePre').addEventListener('input', (e) => { currentScene().precondition = e.target.value; markDirty(); });

  $('sceneId').addEventListener('change', (e) => {
    const sc = currentScene();
    const newId = e.target.value.trim();
    if (!newId) { e.target.value = sc.id; return; }
    if (!/^[A-Za-z0-9_-]+$/.test(newId)) { toast('场景 ID 只能含字母、数字、下划线和连字符'); e.target.value = sc.id; return; }
    if (state.story.scenes.some((x) => x !== sc && x.id === newId)) { toast('该 ID 已存在'); e.target.value = sc.id; return; }
    const oldId = sc.id;
    sc.id = newId;
    // 同步更新所有跳转引用与起点
    for (const other of state.story.scenes) {
      for (const o of other.options) if (o.target === oldId) o.target = newId;
    }
    if (state.story.startScene === oldId) state.story.startScene = newId;
    state.currentId = newId;
    markDirty(() => { renderSceneList(); renderStartSelect(); });
  });

  $('btnAddSceneAssign').addEventListener('click', () => {
    const sc = currentScene();
    sc.assigns.push({ variable: state.story.variables[0]?.name || '', value: true });
    markDirty(() => renderEditor());
  });

  $('btnAddOption').addEventListener('click', () => {
    // 预分配稳定 UID：编辑器中的新选项也能立刻用于路径查询的必经 / 禁用选择
    currentScene().options.push({ uid: genOptionUid(), text: '新选项', condition: '', target: '', assigns: [] });
    markDirty(() => renderEditor());
  });

  $('storyTitle').addEventListener('input', (e) => { state.story.title = e.target.value; markDirty(); });
  $('storyDesc').addEventListener('input', (e) => { state.story.description = e.target.value; markDirty(); });
  $('startScene').addEventListener('change', (e) => { state.story.startScene = e.target.value; markDirty(renderSceneList); });
  $('btnAddVar').addEventListener('click', addVar);
  $('newVarName').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVar(); });
  $('btnAddScene').addEventListener('click', addScene);
}

/* ============================================================
 * 脏标记 / 保存状态
 * ============================================================ */
let reanalyzeTimer = null;
function markDirty(rerender) {
  state.dirty = true;
  if (state.diff) state.diffStale = true;
  markPathQueryStale();
  markProbabilityStale();
  renderSaveStatus();
  if (rerender) rerender();
  else renderAnalysis();
  renderPathQueryPanel(); // 内部有签名缓存，场景/变量未变时仅刷新过期提示与结果
  renderProbabilityPanel(); // 仅刷新过期提示与已展示的结果，不重新推演
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(() => runAnalysis(true), 500);
}

function renderSaveStatus() {
  const el = $('saveStatus');
  if (!state.story) { el.textContent = ''; return; }
  el.textContent = state.dirty ? '● 有未保存的修改' : '○ 已与服务器同步';
  el.style.color = state.dirty ? 'var(--warning)' : 'var(--ok)';
  $('btnSave').disabled = state.saving;
}

/* ============================================================
 * 分析
 * ============================================================ */
async function runAnalysis(isDraft) {
  if (!state.story) { state.analysis = null; renderAnalysis(); return; }
  try {
    state.analysis = await api('POST', '/api/analyze', state.story);
    renderSceneList();
    renderEditor();
    renderAnalysis();
  } catch (e) {
    toast(`分析失败：${e.message}`);
  }
}

/* ============================================================
 * 分析基线：保存 / 对比 / 删除
 * ============================================================ */
async function saveBaseline() {
  if (!state.story) return;
  try {
    const result = await api('POST', `/api/stories/${state.story.id}/baseline`, state.story);
    state.story = result.story;
    state.baseline = result.baseline;
    state.analysis = result.analysis;
    state.dirty = false;
    state.diffStale = false;
    renderMeta();
    renderSceneList();
    renderEditor();
    renderSaveStatus();
    toast('已保存分析基线，可开始编辑后运行对比');
    await runCompare();
  } catch (e) {
    toast(`保存基线失败：${e.message}`);
  }
}

async function runCompare() {
  if (!state.story || !state.baseline) return;
  try {
    state.diff = await api('POST', `/api/stories/${state.story.id}/baseline/compare`, state.story);
    state.diffStale = false;
    state.detailItem = null;
    renderDetail(null);
    renderAnalysis();
  } catch (e) {
    toast(`对比失败：${e.message}`);
  }
}

async function clearBaseline() {
  if (!state.story || !state.baseline) return;
  if (!confirm('确定删除该剧情的分析基线？删除后将无法再做基线对比。')) return;
  try {
    const result = await api('DELETE', `/api/stories/${state.story.id}/baseline`);
    state.story = result.story;
    state.baseline = null;
    state.diff = null;
    state.diffFilter = 'all';
    state.diffStale = false;
    state.detailItem = null;
    renderDetail(null);
    renderAnalysis();
    toast('基线已删除');
  } catch (e) {
    toast(`删除基线失败：${e.message}`);
  }
}

const DIFF_META = {
  new: { label: '新增', cls: 'diff-new' },
  fixed: { label: '已修复', cls: 'diff-fixed' },
  persistent: { label: '仍存在', cls: 'diff-persistent' },
  changed: { label: '详情变化', cls: 'diff-changed' },
};

/* ============================================================
 * 目标路径查询
 * ============================================================ */
function pqSignature() {
  if (!state.story) return '';
  // 场景与选项（UID / 文案 / 目标）或变量集合变化时才重建下拉框
  return JSON.stringify([
    state.story.scenes.map((s) => [
      s.id,
      (s.options || []).map((o) => [o.uid || '', o.text || '', (o.target || '').trim()]),
    ]),
    state.story.variables.map((v) => v.name),
  ]);
}

/** 客户端为编辑器中新建的选项预分配稳定 UID（保存时服务端会保留合法 UID） */
function genOptionUid() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return 'opt-' + [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 全剧情选项目录（按场景 / 选项顺序），仅含带稳定 UID 的选项 */
function pqOptionCatalog() {
  const catalog = [];
  if (!state.story) return catalog;
  for (const sc of state.story.scenes) {
    (sc.options || []).forEach((o, i) => {
      if (o && o.uid) {
        catalog.push({ uid: o.uid, sceneId: sc.id, index: i, text: o.text || '', target: (o.target || '').trim() });
      }
    });
  }
  return catalog;
}

function pqOptionLabel(e) {
  return `${e.sceneId}#${e.index + 1}「${e.text || '（无文案）'}」→ ${e.target || '（不跳转）'}`;
}

function markPathQueryStale() {
  if (!state.pathQueryResult) return;
  state.pathQueryStale = true;
  const el = $('pqStale');
  if (el) el.hidden = false;
}

function renderPathQueryPanel() {
  const card = $('pathQueryCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;

  // 仅当场景 / 选项 / 变量集合变化时才重建下拉框与各行，避免打断正在进行的交互
  const sig = pqSignature();
  if (sig !== state._pqSig) {
    state._pqSig = sig;
    const sel = $('pqTarget');
    sel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '（选择目标场景）';
    sel.appendChild(ph);
    for (const s of state.story.scenes) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id}${s.title ? ' — ' + s.title : ''}`;
      sel.appendChild(opt);
    }
    if (state.pathQuery.targetScene &&
        state.story.scenes.some((s) => s.id === state.pathQuery.targetScene)) {
      sel.value = state.pathQuery.targetScene;
    } else {
      state.pathQuery.targetScene = '';
      sel.value = '';
    }
    // 选项被删除 / UID 失效时，自动从查询条件中剔除（保留未选择的空行）
    const validUids = new Set(pqOptionCatalog().map((e) => e.uid));
    const prune = (arr) => arr.filter((uid) => !uid || validUids.has(uid));
    state.pathQuery.requiredOptions = prune(state.pathQuery.requiredOptions);
    state.pathQuery.disabledOptions = prune(state.pathQuery.disabledOptions);
    renderPqConstraints();
    renderPqRequired();
    renderPqDisabled();
  }

  $('pqStale').hidden = !state.pathQueryStale;
  renderPathQueryResult();
}

function renderPqConstraints() {
  const box = $('pqConstraints');
  box.innerHTML = '';
  const varNames = state.story.variables.map((v) => v.name);
  state.pathQuery.constraints.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'assign-row';

    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">（选择变量）</option>' +
      varNames.map((n) => `<option value="${n}">${n}</option>`).join('');
    sel.value = c.variable;
    sel.addEventListener('change', () => { c.variable = sel.value; markPathQueryStale(); });

    const eq = document.createElement('span');
    eq.className = 'assign-arrow';
    eq.textContent = '=';

    const val = document.createElement('select');
    val.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    val.value = c.value ? 'true' : 'false';
    val.addEventListener('change', () => { c.value = val.value === 'true'; markPathQueryStale(); });

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = '删除约束';
    del.addEventListener('click', () => {
      state.pathQuery.constraints.splice(i, 1);
      renderPqConstraints();
      markPathQueryStale();
    });

    row.append(sel, eq, val, del);
    box.appendChild(row);
  });
}

/** 构造一个“按场景分组”的选项选择下拉框 */
function buildPqOptionSelect(currentUid, disabledUids) {
  const catalog = pqOptionCatalog();
  const blocked = new Set(disabledUids || []);
  const sel = document.createElement('select');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '（选择选项）';
  sel.appendChild(placeholder);

  let optgroup = null;
  for (const e of catalog) {
    if (!optgroup || optgroup.label !== e.sceneId) {
      optgroup = document.createElement('optgroup');
      optgroup.label = e.sceneId;
      sel.appendChild(optgroup);
    }
    const opt = document.createElement('option');
    opt.value = e.uid;
    opt.textContent = pqOptionLabel(e);
    // 已被同一列表其他行选中、或在另一列表（必经/禁用互斥）中的选项禁用
    if (e.uid !== currentUid && blocked.has(e.uid)) {
      opt.disabled = true;
      opt.textContent += '（已选用）';
    }
    optgroup.appendChild(opt);
  }
  sel.value = currentUid || '';
  return sel;
}

/** 渲染必经 / 禁用选项行；ordered=true 时带序号与 ↑↓ 排序按钮 */
function renderPqOptionRows(containerId, listKey, ordered) {
  const box = $(containerId);
  box.innerHTML = '';
  const list = state.pathQuery[listKey];
  const otherKey = ordered ? 'disabledOptions' : 'requiredOptions';

  list.forEach((uid, i) => {
    const row = document.createElement('div');
    row.className = 'pq-opt-row';

    if (ordered) {
      const badge = document.createElement('span');
      badge.className = 'pq-order';
      badge.textContent = i + 1;
      row.appendChild(badge);
    }

    const usedInSame = list.filter((u, j) => u && j !== i);
    const sel = buildPqOptionSelect(uid, [...usedInSame, ...state.pathQuery[otherKey]]);
    sel.addEventListener('change', () => {
      list[i] = sel.value;
      renderPqOptionRows(containerId, listKey, ordered);
      markPathQueryStale();
    });
    row.appendChild(sel);

    if (ordered) {
      const up = document.createElement('button');
      up.className = 'pq-order-btn';
      up.textContent = '↑';
      up.title = '前移';
      up.disabled = i === 0;
      up.addEventListener('click', () => {
        if (i === 0) return;
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        renderPqOptionRows(containerId, listKey, ordered);
        markPathQueryStale();
      });
      const down = document.createElement('button');
      down.className = 'pq-order-btn';
      down.textContent = '↓';
      down.title = '后移';
      down.disabled = i === list.length - 1;
      down.addEventListener('click', () => {
        if (i === list.length - 1) return;
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        renderPqOptionRows(containerId, listKey, ordered);
        markPathQueryStale();
      });
      row.append(up, down);
    }

    const del = document.createElement('button');
    del.className = 'pq-opt-del';
    del.textContent = '✕';
    del.title = ordered ? '移除必经选项' : '移除禁用选项';
    del.addEventListener('click', () => {
      list.splice(i, 1);
      renderPqOptionRows(containerId, listKey, ordered);
      markPathQueryStale();
    });
    row.appendChild(del);
    box.appendChild(row);
  });
}

function renderPqRequired() {
  renderPqOptionRows('pqRequired', 'requiredOptions', true);
}

function renderPqDisabled() {
  renderPqOptionRows('pqDisabled', 'disabledOptions', false);
}

async function runPathQuery() {
  if (!state.story) return;
  const targetScene = state.pathQuery.targetScene;
  if (!targetScene) return toast('请先选择目标场景');
  const constraints = state.pathQuery.constraints.filter((c) => c.variable);
  const requiredOptions = state.pathQuery.requiredOptions.filter(Boolean);
  const disabledOptions = state.pathQuery.disabledOptions.filter(Boolean);

  if (new Set(requiredOptions).size !== requiredOptions.length) {
    return toast('必经选项存在重复，请删除重复项');
  }
  if (new Set(disabledOptions).size !== disabledOptions.length) {
    return toast('禁用选项存在重复，请删除重复项');
  }
  const conflictUid = requiredOptions.find((uid) => disabledOptions.includes(uid));
  if (conflictUid) {
    const catalog = pqOptionCatalog();
    const e = catalog.find((x) => x.uid === conflictUid);
    return toast(`选项「${e ? pqOptionLabel(e) : conflictUid}」不能既是必经项又是禁用项`);
  }

  try {
    const result = await api('POST', '/api/pathquery', {
      story: state.story,
      query: { targetScene, constraints, requiredOptions, disabledOptions },
    });
    state.pathQueryResult = result;
    state.pathQueryStale = false;
    renderPathQueryPanel();
  } catch (e) {
    toast(`路径查询失败：${e.message}`);
  }
}

/** 查询结果中的路径视图：场景节点带到达时状态，选项边带选择后状态 */
function buildQueryPathView(path, knownVars, found) {
  const wrap = document.createElement('div');
  wrap.className = 'path-view';
  (path || []).forEach((node, i, arr) => {
    if (node.kind === 'scene') {
      const div = document.createElement('div');
      div.className = 'path-node scene';
      const badge = i === 0 ? '<span class="badge badge-ok">起点</span>'
        : (found && i === arr.length - 1 ? '<span class="badge badge-ok">目标</span>' : '');
      div.innerHTML = `<span class="pn-title"></span><span class="pn-id"></span>${badge}`;
      div.querySelector('.pn-title').textContent = node.title || node.sceneId;
      div.querySelector('.pn-id').textContent = node.sceneId;
      div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars || []));
      wrap.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'path-edge' + (node.required ? ' is-required' : '');
      div.innerHTML = node.required
        ? `<span class="badge badge-req">必经 ${node.requiredOrder}</span> ` : '';
      div.appendChild(document.createTextNode(
        `选项 ${node.optionIndex + 1}「${node.optionText || ''}」 → ${node.target}`));
      if (node.stateAfter) {
        div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars || []));
      }
      wrap.appendChild(div);
    }
  });
  return wrap;
}

function appendQueryNotes(box, r) {
  const notes = [];
  if (r.startBlocked) {
    notes.push('起点场景的前置条件在初始状态下不成立，剧情无法开始，没有任何可达状态。');
  }
  if (r.disabledCount) {
    notes.push(`已禁用 ${r.disabledCount} 个选项，本次查询不会走这些选项。`);
  }
  if (r.unknownConstraintVars && r.unknownConstraintVars.length) {
    notes.push(`约束变量 ${r.unknownConstraintVars.join('、')} 未声明且从未被赋值，在状态中恒为 false。`);
  }
  if (r.conditionErrors && r.conditionErrors.length) {
    notes.push(`剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次查询按恒真处理（详见一致性分析）。`);
  }
  for (const text of notes) {
    const div = document.createElement('div');
    div.className = 'pq-note';
    div.textContent = text;
    box.appendChild(div);
  }
}

/** 未完成必经项 chip 列表（顺序、UID、选项文案） */
function renderUnfinishedRequired(box, items) {
  if (!items || !items.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'pq-missing';
  const label = document.createElement('span');
  label.className = 'pq-missing-label';
  label.textContent = '未完成的必经选项：';
  wrap.appendChild(label);
  for (const it of items) {
    const chip = document.createElement('code');
    chip.className = 'pq-missing-chip';
    chip.textContent = `#${it.order} ${it.sceneId}#${it.optionIndex + 1}「${it.text || '（无文案）'}」`;
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

function renderPathQueryResult() {
  const box = $('pqResult');
  box.innerHTML = '';
  const r = state.pathQueryResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');
  if (r.found) {
    banner.className = 'pq-banner pq-ok';
    const reqTxt = r.requiredCount ? `，并依次经过全部 ${r.requiredCount} 个必经选项` : '';
    banner.textContent = `✓ 找到最短选项链（${r.depth} 步），到达「${r.targetScene}」时满足全部约束${reqTxt}`;
    box.appendChild(banner);
    appendQueryNotes(box, r);
    box.appendChild(buildQueryPathView(r.path, r.knownVars, true));
    return;
  }

  banner.className = 'pq-banner ' + (r.canAssertUnsolvable ? 'pq-err' : 'pq-warn');
  banner.textContent = r.canAssertUnsolvable
    ? `✗ 无解：已穷举全部 ${r.statesExplored} 个可达状态，不存在满足约束与必经顺序的到达状态`
    : `⚠ 未找到满足约束与必经顺序的到达状态；状态数达到上限（已探索 ${r.statesExplored} 个）搜索被截断，不能断言无解`;
  box.appendChild(banner);
  appendQueryNotes(box, r);
  renderUnfinishedRequired(box, r.unfinishedRequiredOptions);

  const c = r.closest;
  if (!c) return;

  const head = document.createElement('div');
  head.className = 'pq-closest-head';
  const lead = document.createElement('b');
  lead.textContent = '差异最少的可达状态';
  const desc = document.createElement('span');
  desc.textContent = c.isTargetScene
    ? `：目标场景「${c.sceneId}」第 ${c.depth} 步的到达状态`
    : `：目标场景「${r.targetScene}」不可达；全剧情中最接近约束的是场景「${c.sceneId}」（第 ${c.depth} 步）`;
  head.append(lead, desc);
  box.appendChild(head);

  if (c.missing && c.missing.length) {
    const miss = document.createElement('div');
    miss.className = 'pq-missing';
    const label = document.createElement('span');
    label.className = 'pq-missing-label';
    label.textContent = '缺失变量：';
    miss.appendChild(label);
    for (const m of c.missing) {
      const chip = document.createElement('code');
      chip.className = 'pq-missing-chip';
      chip.textContent = `${m.variable} 需 ${m.want}（实际 ${m.actual}）`;
      miss.appendChild(chip);
    }
    box.appendChild(miss);
  }
  renderUnfinishedRequired(box, c.unfinishedRequiredOptions);
  if (!(c.missing && c.missing.length) && (!c.unfinishedRequiredOptions || !c.unfinishedRequiredOptions.length)) {
    const okNote = document.createElement('div');
    okNote.className = 'pq-note';
    okNote.textContent = '该状态下全部约束均满足，但它不在目标场景上——请检查通往目标场景的跳转。';
    box.appendChild(okNote);
  }
  box.appendChild(buildQueryPathView(c.path, r.knownVars, false));
}

/* ============================================================
 * 结局概率推演
 * ============================================================ */
function markProbabilityStale() {
  if (!state.probResult) return;
  state.probStale = true;
  const el = $('probStale');
  if (el) el.hidden = false;
}

async function runProbability() {
  if (!state.story) return;
  try {
    // 对编辑中的草稿直接推演（不落盘）
    state.probResult = await api('POST', '/api/probability', state.story);
    state.probStale = false;
    renderProbabilityPanel();
  } catch (e) {
    toast(`推演失败：${e.message}`);
  }
}

function renderProbabilityPanel() {
  const card = $('probCard');
  if (!state.story) { card.hidden = true; return; }
  card.hidden = false;
  $('probStale').hidden = !state.probStale;
  renderProbabilityResult();
}

function fmtPct(p) {
  return `${(p * 100).toFixed(1)}%`;
}

/** 单条概率行：名称 + 百分比 + 概率条 */
function buildProbRow(nameHtml, pct, barCls) {
  const row = document.createElement('div');
  row.className = 'prob-row';
  row.innerHTML = `
    <div class="prob-row-head">
      <span class="prob-name"></span>
      <span class="prob-pct">${fmtPct(pct)}</span>
    </div>
    <div class="prob-bar"><div class="prob-bar-fill ${barCls}" style="width:${Math.min(100, Math.max(0, pct * 100))}%"></div></div>
  `;
  row.querySelector('.prob-name').innerHTML = nameHtml;
  return row;
}

function renderProbabilityResult() {
  const box = $('probResult');
  box.innerHTML = '';
  const r = state.probResult;
  if (!r || !state.story) return;

  const banner = document.createElement('div');

  if (r.startBlocked) {
    banner.className = 'pq-banner pq-err';
    banner.textContent = '✗ 起点场景的前置条件在初始状态下不成立，剧情无法开始，没有可推演的概率。';
    box.appendChild(banner);
    return;
  }

  if (!r.ok) {
    banner.className = 'pq-banner pq-warn';
    banner.textContent = `⚠ ${r.message}`;
    box.appendChild(banner);
    return;
  }

  banner.className = 'pq-banner pq-ok';
  banner.textContent = `✓ ${r.message}`;
  box.appendChild(banner);

  if (r.conditionErrors && r.conditionErrors.length) {
    const note = document.createElement('div');
    note.className = 'pq-note';
    note.textContent = `剧情中存在 ${r.conditionErrors.length} 处条件语法错误，本次推演按恒真处理（详见一致性分析）。`;
    box.appendChild(note);
  }

  // 终止场景（设计结局 / 死局）
  const endLabel = document.createElement('div');
  endLabel.className = 'prob-section-label';
  endLabel.textContent = `终止场景（合计 ${fmtPct(r.totalEndingProbability)}）`;
  box.appendChild(endLabel);

  if (!r.endings.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '没有任何可到达的终止场景——全部概率质量都困在循环中。';
    box.appendChild(none);
  } else {
    for (const e of r.endings) {
      const kindBadge = e.kind === 'ending'
        ? '<span class="badge badge-ok">结局</span>'
        : '<span class="badge badge-warn">死局</span>';
      const statesTxt = e.states > 1 ? `（${e.states} 个状态）` : '';
      const row = buildProbRow(
        `${kindBadge}<span class="prob-title"></span><code class="prob-id"></code><span class="prob-states">${statesTxt}</span>`,
        e.probability,
        e.kind === 'ending' ? 'fill-ok' : 'fill-warn');
      row.querySelector('.prob-title').textContent = e.title || e.sceneId;
      row.querySelector('.prob-id').textContent = e.sceneId;
      if (e.kind === 'deadend') {
        row.title = '该场景存在没有任何可走选项的状态（选项条件不成立 / 目标不可进入），玩家会卡死在这里';
      }
      box.appendChild(row);
    }
  }

  // 永远困在循环中的概率质量
  const loopLabel = document.createElement('div');
  const loopLabelText = `永远困在循环中（合计 ${fmtPct(r.loopProbability)}）`;
  loopLabel.className = 'prob-section-label';
  loopLabel.textContent = loopLabelText;
  box.appendChild(loopLabel);

  if (!r.loops.length) {
    const none = document.createElement('div');
    none.className = 'pq-note';
    none.textContent = '不存在陷阱循环：从起点出发，概率 1 最终到达某个终止场景。';
    box.appendChild(none);
  } else {
    for (const loop of r.loops) {
      const row = buildProbRow(
        `<span class="badge badge-err">循环</span><span class="prob-loop-scenes"></span><span class="prob-states">（${loop.states} 个状态）</span>`,
        loop.probability,
        'fill-err');
      const scenesBox = row.querySelector('.prob-loop-scenes');
      scenesBox.textContent = loop.scenes.map((s) => `${s.title || s.id}(${s.id})`).join(' ⇄ ');
      row.title = '进入这组场景状态后没有任何出路，这部分概率质量永远困在循环里';
      box.appendChild(row);
    }
  }
}


function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ISSUE_META = {
  unreachableScene: { label: '不可达场景', sev: 'error' },
  orphanOption: { label: '悬空跳转', sev: 'error' },
  blockedEntry: { label: '入口前置冲突', sev: 'warning' },
  neverTrueOption: { label: '条件永不成立', sev: 'warning' },
  error: { label: '结构/语法错误', sev: 'error' },
};

function renderAnalysis() {
  renderBaselineBar();
  renderDiffBar();

  const stats = $('analysisStats');
  const ul = $('issueList');
  ul.innerHTML = '';

  if (!state.analysis || !state.story) {
    stats.innerHTML = '';
    return;
  }
  const c = state.analysis.counts;
  const bad = c.issues > 0 || c.errors > 0;
  stats.innerHTML = `
    <div class="stat"><span>场景 / 可达</span><b>${c.scenes} / ${c.reachableScenes}</b></div>
    <div class="stat"><span>布尔变量</span><b>${c.variables}</b></div>
    <div class="stat"><span>枚举具体状态</span><b>${c.concreteStates}</b></div>
    <div class="stat"><span>可达转移 / 观测</span><b>${c.enabledTransitions} / ${c.firedTransitions}</b></div>
    <div class="stat ${bad ? 'stat-bad' : 'stat-ok'}"><span>问题数</span><b>${c.issues + c.errors}</b></div>
  `;

  // 对比模式：按状态筛选展示（截断提示在对比模式下省略，避免混淆）
  if (state.diff) {
    const items = state.diff.items.filter((it) => state.diffFilter === 'all' || it.status === state.diffFilter);
    if (!items.length) {
      ul.innerHTML = '<li class="all-clear">当前筛选下没有问题</li>';
      return;
    }
    for (const item of items) ul.appendChild(renderIssueItem(item));
    return;
  }

  const all = [...state.analysis.issues];
  if (!all.length && !state.analysis.truncated) {
    ul.innerHTML = '<li class="all-clear">✓ 未发现一致性问题：所有场景可达、所有选项均可能触发</li>';
    return;
  }

  if (state.analysis.truncated) {
    const li = document.createElement('li');
    li.className = 'issue-item severity-error';
    li.innerHTML = '<div class="ii-type">分析截断</div><div class="ii-msg">具体状态数量超过安全上限，结果可能不完整，请减少变量数量。</div>';
    ul.appendChild(li);
  }

  all.forEach((issue) => ul.appendChild(renderIssueItem({ status: null, issue })));
}

function renderBaselineBar() {
  const bar = $('baselineBar');
  const info = $('baselineInfo');
  if (!state.story) { bar.hidden = true; return; }
  bar.hidden = false;
  $('btnSaveBaseline').disabled = !!state.saving;
  if (state.baseline) {
    const n = state.baseline.issues.length;
    info.innerHTML = `基线：<b>${fmtTime(state.baseline.savedAt)}</b> · ${n} 条问题`;
    info.title = '基线是之后对比“新增 / 已修复 / 仍存在”的参照快照';
  } else {
    info.innerHTML = '<span class="muted">尚未保存基线</span>';
    info.title = '';
  }
}

function renderDiffBar() {
  const bar = $('diffBar');
  if (!state.story || !state.baseline) { bar.hidden = true; return; }
  bar.hidden = false;
  $('diffStale').hidden = !state.diffStale;

  const sum = $('diffSummary');
  if (state.diff) {
    const s = state.diff.summary;
    const chip = (key, n) => n
      ? `<span class="diff-chip diff-chip-${key}">${DIFF_META[key].label} ${n}</span>`
      : '';
    sum.innerHTML = `<span class="diff-title">对比摘要</span>` +
      chip('new', s.new) + chip('fixed', s.fixed) +
      chip('changed', s.changed) + chip('persistent', s.persistent);
  } else {
    sum.innerHTML = '<span class="muted">保存基线后编辑剧情，再点击「运行对比」查看变化</span>';
  }

  const filters = $('diffFilters');
  filters.innerHTML = '';
  const tabs = [
    ['all', '全部'],
    ['new', '新增'],
    ['fixed', '已修复'],
    ['changed', '详情变化'],
    ['persistent', '仍存在'],
  ];
  for (const [key, label] of tabs) {
    const btn = document.createElement('button');
    btn.className = 'diff-filter' + (state.diffFilter === key ? ' active' : '');
    if (key !== 'all' && state.diff) {
      btn.textContent = `${label} ${state.diff.summary[key]}`;
      if (state.diff.summary[key] === 0) btn.disabled = true;
    } else {
      btn.textContent = label;
    }
    btn.addEventListener('click', () => {
      state.diffFilter = key;
      renderDiffBar();
      const ul = $('issueList');
      ul.innerHTML = '';
      if (!state.diff) return;
      const items = state.diff.items.filter((it) => key === 'all' || it.status === key);
      if (!items.length) ul.innerHTML = '<li class="all-clear">当前筛选下没有问题</li>';
      for (const item of items) ul.appendChild(renderIssueItem(item));
    });
    filters.appendChild(btn);
  }
}

/** 渲染一条问题（对比模式 item 含 status/before；普通模式 status=null） */
function renderIssueItem(item) {
  const issue = item.issue || item.before;
  const meta = ISSUE_META[issue.type] || { label: issue.type, sev: issue.severity || 'warning' };
  const li = document.createElement('li');
  const cls = ['issue-item', `severity-${meta.sev}`];
  if (item.status) cls.push(`is-${item.status}`);
  li.className = cls.join(' ');

  let statusBadge = '';
  if (item.status) {
    const dm = DIFF_META[item.status];
    const changeTxt = item.status === 'changed'
      ? `（${item.changes.map((x) => (x === 'path' ? '路径变化' : '文案变化')).join('、')}）`
      : '';
    statusBadge = `<span class="diff-badge ${dm.cls}">${dm.label}${changeTxt}</span>`;
  }

  li.innerHTML = `
    <div class="ii-head">
      <div class="ii-type">${meta.label}</div>
      ${statusBadge}
    </div>
    <div class="ii-msg"></div>
    <div class="ii-meta"></div>
  `;
  li.querySelector('.ii-msg').textContent = issue.message;
  const loc = [issue.sceneId && `场景:${issue.sceneId}`, issue.optionIndex !== undefined && issue.optionIndex !== null && `选项#${issue.optionIndex + 1}`,
    issue.targetSceneId && `目标:${issue.targetSceneId}`].filter(Boolean).join(' · ');
  li.querySelector('.ii-meta').textContent = loc;
  li.addEventListener('click', () => {
    document.querySelectorAll('.issue-item.active-issue').forEach((x) => x.classList.remove('active-issue'));
    li.classList.add('active-issue');
    openDetail(item);
  });
  return li;
}

function openDetail(item) {
  state.detailItem = item;
  // 已修复的问题当前已不存在，默认展示基线（before）路径
  state.detailPathMode = item.status === 'fixed' ? 'before' : 'after';
  renderDetail(item);
}

/* ============================================================
 * 问题详情：最近可达路径 + 未满足条件
 * ============================================================ */
function stateChips(stateObj, knownVars) {
  const vars = knownVars.length ? knownVars : Object.keys(stateObj || {});
  return `<div class="state-chips">` + vars.map((v) => {
    const on = !!(stateObj && stateObj[v]);
    return `<span class="state-chip ${on ? 'true' : 'false'}">${on ? '✓' : '✗'} ${v}</span>`;
  }).join('') + `</div>`;
}

function renderDetail(item) {
  const panel = $('detailPanel');
  if (!item) { panel.hidden = true; return; }
  panel.hidden = false;

  const status = item.status || null;
  const after = item.issue || null;
  const before = item.before || null;

  // 状态徽标
  const statusBox = $('detailStatus');
  statusBox.innerHTML = '';
  if (status) {
    const dm = DIFF_META[status];
    const badge = document.createElement('span');
    badge.className = `diff-badge ${dm.cls} detail-diff-badge`;
    badge.textContent = `基线对比：${dm.label}`;
    statusBox.appendChild(badge);
  }

  const issue = after || before;
  $('detailTitle').textContent = (ISSUE_META[issue.type] || { label: '问题' }).label;
  $('detailMessage').textContent = issue.message;

  // 路径切换标签（详情变化 / 已修复 时可查看基线中的旧路径）
  const tabs = $('detailPathTabs');
  const canBefore = !!before && status !== 'new';
  const canAfter = !!after && status !== 'fixed';
  if (status && (canBefore || canAfter)) {
    tabs.hidden = false;
    tabs.innerHTML = '';
    const mkTab = (mode, label, enabled) => {
      const b = document.createElement('button');
      b.className = 'path-tab' + (state.detailPathMode === mode ? ' active' : '');
      b.textContent = label;
      b.disabled = !enabled;
      if (enabled) b.addEventListener('click', () => {
        state.detailPathMode = mode;
        renderDetail(item);
      });
      tabs.appendChild(b);
    };
    mkTab('after', '当前路径', canAfter);
    mkTab('before', `基线路径（${fmtTime(before && state.baseline && state.baseline.savedAt)}）`, canBefore);
  } else {
    tabs.hidden = true;
  }

  // 文案前后对比
  const msgBox = $('detailMessage');
  if (status === 'changed' && item.changes.includes('message') && before && after) {
    msgBox.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'msg-diff';
    wrap.innerHTML = `
      <div class="msg-diff-row before"><span class="msg-diff-tag">基线</span><span></span></div>
      <div class="msg-diff-row after"><span class="msg-diff-tag">当前</span><span></span></div>`;
    const rows = wrap.querySelectorAll('.msg-diff-row span:last-child');
    rows[0].textContent = before.message;
    rows[1].textContent = after.message;
    msgBox.appendChild(wrap);
  }

  // 路径
  const showAfter = state.detailPathMode !== 'before' || !canBefore;
  const pathIssue = showAfter ? after : before;
  const knownVars = (showAfter ? state.analysis : (state.baseline && state.baseline.knownVars)) || [];
  const pathBox = $('detailPath');
  pathBox.innerHTML = '';
  if (!pathIssue.path || !pathIssue.path.length) {
    pathBox.innerHTML = `<div class="path-node scene blocked">
      <span class="pn-title">∅ 没有任何可达路径通向此处</span>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">从起点出发，不存在任何选项链可以到达该场景（可能是孤岛场景）。</div>
    </div>`;
  } else {
    pathIssue.path.forEach((node, i) => {
      if (node.kind === 'scene') {
        const div = document.createElement('div');
        const cls = ['path-node', 'scene'];
        if (i === 0) cls.push('start');
        if (node.blockedEntry) cls.push('blocked');
        div.className = cls.join(' ');
        const isLast = i === pathIssue.path.length - 1;
        const badge = i === 0 ? '<span class="badge badge-ok">起点</span>'
          : node.hypothetical ? '<span class="badge badge-warn">假设到达（选项实际无法触发）</span>'
          : node.blockedEntry ? '<span class="badge badge-err">前置条件不成立</span>'
          : isLast ? '<span class="badge badge-err">问题位置</span>' : '';
        div.innerHTML = `
          <span class="pn-title"></span><span class="pn-id"></span>
          ${badge}
        `;
        div.querySelector('.pn-title').textContent = node.title || node.sceneId;
        div.querySelector('.pn-id').textContent = node.sceneId;
        div.insertAdjacentHTML('beforeend', stateChips(node.state, knownVars));
        pathBox.appendChild(div);
      } else {
        const div = document.createElement('div');
        div.className = 'path-edge' + (node.broken || node.entryBlocked || node.deadEnd ? ' broken' : '');
        const targetTxt = node.target
          ? ` → ${node.targetTitle ? node.targetTitle + ' (' + node.target + ')' : node.target}`
          : '';
        const prefix = node.broken ? '✕ ' : node.entryBlocked ? '⛔ ' : node.deadEnd ? '🔒 ' : '';
        div.textContent = `${prefix}选项 ${node.optionIndex + 1}「${node.optionText || ''}」${targetTxt}${node.deadEnd ? '（条件不成立，无法选择）' : ''}`;
        if (node.stateAfter) {
          div.insertAdjacentHTML('beforeend', stateChips(node.stateAfter, knownVars));
        }
        pathBox.appendChild(div);
      }
    });
  }

  // 未满足条件（基线快照不保留解释树，仅当前结果可展示）
  const wrap = $('detailUnmetWrap');
  if (after && after.unmet && showAfter) {
    wrap.hidden = false;
    $('detailUnmet').innerHTML = '';
    $('detailUnmet').appendChild(renderExprNode(after.unmet));
    const flips = collectFlips(after.unmet);
    const fix = $('detailFix');
    if (after.unmet.feasible === false) {
      const cv = after.unmet.conflicts || [];
      fix.innerHTML = `⚠️ 该条件<b>逻辑上不可满足</b>：${cv.length ? `变量 ${cv.map((v) => `<code>${v}</code>`).join('、')} 被同时要求为真和为假；` : '不存在任何变量取值能使它成立；'}请修改条件表达式，而不是调整状态赋值。`;
      fix.style.background = 'var(--danger-bg)';
      fix.style.color = '#8a2b2b';
    } else if (flips.length) {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = `最少只需让以下变量取反即可满足：${flips.map((v) => `<b><code>${v}</code></b>`).join('、')}。请检查路径上的状态赋值是否缺失或冲突。`;
    } else if (after.unmet.feasible === null) {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = '条件涉及变量较多，未做完整可满足性枚举；请人工核对子条件。';
    } else {
      fix.style.background = '';
      fix.style.color = '';
      fix.innerHTML = '条件在当前状态下成立（该问题来自结构性不可达，请检查跳转连接）。';
    }
  } else {
    wrap.hidden = true;
  }
}

function collectFlips(node) {
  if (!node) return [];
  const out = new Set();
  const walk = (n) => {
    // OR 只要有一个分支满足：只沿最佳（flip 与父级一致的）分支深入
    (n.flip || []).forEach((f) => out.add(f));
    (n.children || []).forEach(walk);
  };
  walk(node);
  return [...out];
}

function renderExprNode(node) {
  const wrap = document.createElement('div');
  const met = node.satisfied;
  const cls = ['expr-node', met ? 'met' : 'unmet'];
  if (node.feasible === false) cls.push('infeasible');
  if (node.hintAlternative) cls.push('gate');
  wrap.className = cls.join(' ');

  const opLabel = { and: 'AND（全部满足）', or: 'OR（任一满足）', not: 'NOT（取反）' };
  let head = '';
  if (node.op === 'var') {
    head = `<code class="expr-val">${node.name}</code>
      <span>当前 = <b>${node.value}</b>，要求 = <b>${node.want}</b></span>
      ${met ? '✓' : '✗'}`;
  } else if (node.op === 'const') {
    head = `<span>恒真条件</span>`;
  } else {
    head = `<span class="expr-op">${opLabel[node.op]}</span>
      <span class="expr-want">需要 = <b>${node.want}</b>，实际 = <b>${node.value}</b></span>
      ${met ? '✓' : '✗'}`;
  }
  wrap.innerHTML = head;

  if (node.children && node.children.length) {
    const kids = document.createElement('div');
    kids.className = 'expr-children';
    node.children.forEach((ch) => kids.appendChild(renderExprNode(ch)));
    wrap.appendChild(kids);
  }
  return wrap;
}

/* ============================================================
 * 全局事件 & 启动
 * ============================================================ */
function bindGlobalEvents() {
  $('storySelect').addEventListener('change', (e) => {
    if (state.dirty && !confirm('当前剧情有未保存的修改，切换将丢失这些修改，继续？')) {
      e.target.value = state.story.id;
      return;
    }
    openStory(e.target.value);
  });
  $('btnNew').addEventListener('click', () => {
    if (state.dirty && !confirm('当前剧情有未保存的修改，确定新建剧情？')) return;
    createStory();
  });
  $('btnSave').addEventListener('click', saveStory);
  $('btnDelete').addEventListener('click', deleteStory);
  $('btnExport').addEventListener('click', exportStory);
  $('btnImport').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importStory(e.target.files[0]);
    e.target.value = '';
  });
  $('btnAnalyze').addEventListener('click', () => runAnalysis(state.dirty));
  $('btnRunProb').addEventListener('click', runProbability);
  $('btnCloseDetail').addEventListener('click', () => $('detailPanel').hidden = true);
  $('btnSaveBaseline').addEventListener('click', saveBaseline);
  $('btnRunCompare').addEventListener('click', runCompare);
  $('btnClearBaseline').addEventListener('click', clearBaseline);
  $('btnRunPathQuery').addEventListener('click', runPathQuery);
  $('btnPqAddConstraint').addEventListener('click', () => {
    if (!state.story) return;
    const firstVar = state.story.variables[0];
    state.pathQuery.constraints.push({ variable: firstVar ? firstVar.name : '', value: true });
    renderPqConstraints();
    markPathQueryStale();
  });
  $('btnPqAddRequired').addEventListener('click', () => {
    state.pathQuery.requiredOptions.push('');
    renderPqRequired();
    markPathQueryStale();
  });
  $('btnPqAddDisabled').addEventListener('click', () => {
    state.pathQuery.disabledOptions.push('');
    renderPqDisabled();
    markPathQueryStale();
  });
  $('pqTarget').addEventListener('change', (e) => {
    state.pathQuery.targetScene = e.target.value;
    markPathQueryStale();
  });

  // Ctrl/Cmd + S 保存
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveStory();
    }
  });
}

async function init() {
  bindGlobalEvents();
  bindEditorEvents();
  try {
    const id = await loadList();
    if (id) await openStory(id);
    else {
      renderAll();
      toast('数据目录为空，请新建或导入剧情');
    }
  } catch (e) {
    toast(`初始化失败：${e.message}`);
  }
}

init();

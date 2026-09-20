'use strict';

const express = require('express');
const path = require('path');
const storage = require('./src/storage');
const { analyze } = require('./src/analyzer');
const { queryPath } = require('./src/pathquery');
const { inferEndings } = require('./src/probability');
const { coverOptions } = require('./src/coverage');
const { buildBaseline, compareWithBaseline } = require('./src/baseline');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- 剧情列表 ----
app.get('/api/stories', wrap((req, res) => {
  res.json(storage.listStories());
}));

// ---- 新建剧情 ----
app.post('/api/stories', wrap((req, res) => {
  const record = storage.createStory(req.body || {});
  res.status(201).json(record);
}));

// ---- 读取剧情 ----
app.get('/api/stories/:id', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(story);
}));

// ---- 保存剧情 ----
app.put('/api/stories/:id', wrap((req, res) => {
  const record = storage.updateStory(req.params.id, req.body || {});
  res.json(record);
}));

// ---- 删除剧情 ----
app.delete('/api/stories/:id', wrap((req, res) => {
  storage.deleteStory(req.params.id);
  res.status(204).end();
}));

// ---- 分析剧情（不保存，直接对请求体中的剧情做分析，供编辑时实时检查） ----
app.post('/api/analyze', wrap((req, res) => {
  res.json(analyze(req.body || {}));
}));

// ---- 分析已保存的剧情 ----
app.get('/api/stories/:id/analysis', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(analyze(story));
}));

// ---- 目标路径查询：对请求体中的草稿剧情直接查询（不落盘），供编辑页查询面板实时使用 ----
// 请求体：{
//   story: <剧情>,
//   query: {
//     targetScene,
//     constraints: [{ variable, value }],
//     requiredOptions: [uid, ...],  // 有序必经选项（按数组顺序依次经过）
//     disabledOptions: [uid, ...],  // 禁用选项（传播时不扩展，且不得与必经项冲突）
//   },
// }
// 校验失败（UID 不存在 / 必经与禁用冲突 / 约束重复等）返回 400
app.post('/api/pathquery', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(queryPath(story, body.query || {}));
}));

// ---- 对已保存的剧情做目标路径查询 ----
app.post('/api/stories/:id/pathquery', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const body = req.body || {};
  const query = body.query !== undefined ? body.query : body;
  res.json(queryPath(story, query));
}));

// ---- 结局概率推演：对请求体中的草稿剧情直接推演（不落盘），供编辑页推演面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。基于「场景 + 变量状态」图精确求解：
// 各终止场景的最终到达概率 + 永远困在循环中的概率质量（含涉及的循环场景）。
// 非法选项权重（非正整数）返回 400 并带场景 / 选项位置。
app.post('/api/probability', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(inferEndings(story));
}));

// ---- 对已保存的剧情做结局概率推演 ----
app.get('/api/stories/:id/probability', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(inferEndings(story));
}));

// ---- 选项覆盖路线：对请求体中的草稿剧情直接展开（不落盘），供编辑页面板实时使用 ----
// 请求体即剧情（或 { story: <剧情> }）。展开「场景 + 变量状态」图，为每条实际可走
// 选项保留最短可复现路径，再用确定性贪心集合覆盖压缩路线集并汇总覆盖率。
app.post('/api/coverage', wrap((req, res) => {
  const body = req.body || {};
  const story = body.story !== undefined ? body.story : body;
  res.json(coverOptions(story));
}));

// ---- 对已保存的剧情生成选项覆盖路线 ----
app.get('/api/stories/:id/coverage', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  res.json(coverOptions(story));
}));

// ---- 分析基线：把当前（通常是编辑中的）分析结果保存为基线，随剧情 JSON 持久化 ----
app.post('/api/stories/:id/baseline', wrap((req, res) => {
  const id = req.params.id;
  const existing = storage.getStory(id);
  if (!existing) return res.status(404).json({ error: '剧情不存在' });
  // 请求体即当前草稿剧情（与 PUT /api/stories/:id 相同的形状）
  const draft = req.body && req.body.story !== undefined ? req.body.story : req.body;
  if (!draft || typeof draft !== 'object') return res.status(400).json({ error: '缺少剧情内容' });

  // 先规整（补齐选项 UID 等），再分析：保证基线指纹与后续持久化内容一致
  const normalized = storage.normalize({
    ...draft,
    id,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    baseline: existing.baseline || null,
  });
  const analysis = analyze(normalized);
  const baseline = buildBaseline(analysis, normalized);
  // 保存基线时一并把草稿落盘，保证“基线对应内容”与持久化内容一致
  const record = storage.saveStoryWithBaseline(id, normalized, baseline);
  res.status(201).json({ story: record, baseline, analysis });
}));

// ---- 基线对比：基线（可随请求体传入新的草稿）与当前分析结果对比 ----
app.post('/api/stories/:id/baseline/compare', wrap((req, res) => {
  const id = req.params.id;
  const stored = storage.getStory(id);
  if (!stored) return res.status(404).json({ error: '剧情不存在' });
  if (!stored.baseline) return res.status(404).json({ error: '尚未保存分析基线' });

  // 请求体可缺省：对比已保存的剧情；也可直接对编辑中的草稿对比
  const draft = req.body && req.body.story !== undefined ? req.body.story
    : (req.body && Object.keys(req.body).length ? req.body : stored);
  const analysis = analyze(draft);
  res.json(compareWithBaseline(stored.baseline, analysis));
}));

// ---- 删除基线 ----
app.delete('/api/stories/:id/baseline', wrap((req, res) => {
  const record = storage.clearBaseline(req.params.id);
  res.json({ story: record });
}));

// ---- 导出 ----
app.get('/api/stories/:id/export', wrap((req, res) => {
  const story = storage.getStory(req.params.id);
  if (!story) return res.status(404).json({ error: '剧情不存在' });
  const filename = encodeURIComponent(`${story.id}.json`);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({ ...story, exportedAt: new Date().toISOString() }, null, 2));
}));

// SPA 回退
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- 错误处理 ----
app.use((err, req, res, next) => {
  const status = err.status || 400;
  res.status(status).json({ error: err.message || '服务器错误' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

storage.ensureDataDir();
const seeded = storage.seedSamples();
if (seeded.length) console.log(`[seed] 已初始化示例剧情: ${seeded.join(', ')}`);

// 直接 `node server.js` 时启动监听；被测试 require 时仅导出 app（由测试自行监听）
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`分支剧情一致性审校应用已启动: http://${HOST}:${PORT}`);
    console.log(`数据目录: ${storage.DATA_DIR}`);
  });
}

module.exports = app;

#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const HOST = process.env.MODEL_CONSOLE_HOST || '0.0.0.0';
const PORT = Number(process.env.MODEL_CONSOLE_PORT || 3939);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const HISTORY_LIMIT = 10;
const CONFIG_PATH = process.env.OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function readConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return { raw, parsed };
}

async function writeConfig(parsed) {
  const raw = JSON.stringify(parsed, null, 2) + '\n';
  await fsp.writeFile(CONFIG_PATH, raw, 'utf8');
}

function listModels(cfg) {
  const providers = cfg.models && cfg.models.providers ? cfg.models.providers : {};
  const primary = (((cfg.agents || {}).defaults || {}).model || {}).primary || '';
  const fallbacks = ((((cfg.agents || {}).defaults || {}).model || {}).fallbacks) || [];

  const out = [];
  for (const [providerName, provider] of Object.entries(providers)) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      const id = String(model.id || '');
      if (!id) continue;
      const full = `${providerName}/${id}`;
      out.push({
        provider: providerName,
        api: provider.api || '',
        baseUrl: provider.baseUrl || '',
        modelId: id,
        full,
        name: model.name || id,
        reasoning: Boolean(model.reasoning),
        isPrimary: full === primary,
        inFallbacks: fallbacks.includes(full)
      });
    }
  }
  return out;
}

async function saveHistory(kind, configRaw, note) {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const token = crypto.randomBytes(4).toString('hex');
  const id = `${ts}_${token}`;
  const file = path.join(HISTORY_DIR, `${id}.json`);
  const payload = {
    id,
    createdAt: new Date().toISOString(),
    kind,
    note,
    config: JSON.parse(configRaw)
  };
  await fsp.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await pruneHistory();
  return id;
}

async function pruneHistory() {
  const files = await fsp.readdir(HISTORY_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
  const remove = jsonFiles.slice(HISTORY_LIMIT);
  await Promise.all(remove.map(name => fsp.unlink(path.join(HISTORY_DIR, name))));
}

async function loadHistoryList() {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const files = (await fsp.readdir(HISTORY_DIR)).filter(f => f.endsWith('.json')).sort().reverse();
  const out = [];
  for (const f of files) {
    const p = path.join(HISTORY_DIR, f);
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const obj = JSON.parse(raw);
      out.push({
        id: obj.id,
        createdAt: obj.createdAt,
        kind: obj.kind,
        note: obj.note,
        primary: ((((obj.config || {}).agents || {}).defaults || {}).model || {}).primary || ''
      });
    } catch (e) {
      // ignore broken snapshot
    }
  }
  return out;
}

function restartGateway() {
  exec('openclaw gateway restart', { timeout: 15000 }, () => {});
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function fetchHttpsJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request(url, options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function makeRequester(url) {
  return url.startsWith('https://') ? fetchHttpsJson : fetchJson;
}

async function testModel(provider, modelId) {
  const { parsed } = await readConfig();
  const p = (((parsed.models || {}).providers) || {})[provider];
  if (!p) throw new Error(`Provider not found: ${provider}`);
  if (!p.baseUrl || !p.apiKey) throw new Error('Provider missing baseUrl/apiKey');

  const base = p.baseUrl.replace(/\/$/, '');
  const requester = makeRequester(base);

  // Test 1: Basic conversation response
  const testPrompt = '你好';
  const maxTokens = 128;

  if (p.api === 'openai-responses') {
    const body = JSON.stringify({
      model: modelId,
      input: testPrompt,
      max_output_tokens: maxTokens
    });
    const res = await requester(`${base}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${p.apiKey}`,
        'Content-Type': 'application/json'
      },
      body
    });

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, body: res.body.slice(0, 600), test: 'conversation' };
    }

    try {
      const data = JSON.parse(res.body);
      const output = data.output?.[0]?.content?.[0]?.text || data.output_text || '';
      if (!output || output.trim().length === 0) {
        return { ok: false, status: res.status, body: 'Empty response', test: 'conversation' };
      }
      return { ok: true, status: res.status, body: output.slice(0, 500), test: 'conversation' };
    } catch (e) {
      return { ok: false, status: res.status, body: `JSON parse error: ${e.message}`, test: 'conversation' };
    }
  }

  if (p.api === 'anthropic-messages') {
    const body = JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: testPrompt }]
    });
    const res = await requester(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body
    });

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, body: res.body.slice(0, 600), test: 'conversation' };
    }

    try {
      const data = JSON.parse(res.body);
      const content = data.content || [];
      const textBlock = content.find((c) => c.type === 'text');
      const output = textBlock?.text || '';
      if (!output || output.trim().length === 0) {
        return { ok: false, status: res.status, body: 'Empty response', test: 'conversation' };
      }
      return { ok: true, status: res.status, body: output.slice(0, 500), test: 'conversation' };
    } catch (e) {
      return { ok: false, status: res.status, body: `JSON parse error: ${e.message}`, test: 'conversation' };
    }
  }

  throw new Error(`Unsupported provider api type: ${p.api || 'unknown'}`);
}

async function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(reqPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    
    if (req.method === 'GET' && url.startsWith('/api/model-detail')) {
      const params = new URL(req.url, 'http://x').searchParams;
      const full = params.get('full') || '';
      if (!full.includes('/')) {
        sendJson(res, 400, { error: 'invalid model id' });
        return;
      }
      const slash = full.indexOf('/');
      const providerName = full.slice(0, slash);
      const modelId = full.slice(slash + 1);
      const { parsed } = await readConfig();
      const provider = (((parsed.models || {}).providers) || {})[providerName];
      if (!provider) {
        sendJson(res, 404, { error: 'provider not found' });
        return;
      }
      const model = (provider.models || []).find(m => String(m.id || '') === modelId);
      if (!model) {
        sendJson(res, 404, { error: 'model not found' });
        return;
      }
      sendJson(res, 200, {
        provider: providerName,
        baseUrl: provider.baseUrl || '',
        api: provider.api || '',
        apiKey: provider.apiKey || '',
        modelId: model.id || '',
        modelName: model.name || '',
        reasoning: model.reasoning || false,
        contextWindow: model.contextWindow || 200000,
        maxTokens: model.maxTokens || 8192
      });
      return;
    }

if (req.method === 'GET' && url === '/api/status') {
      const { parsed } = await readConfig();
      const models = listModels(parsed);
      const current = ((((parsed.agents || {}).defaults || {}).model) || {});
      sendJson(res, 200, {
        configPath: CONFIG_PATH,
        current,
        models,
        totalModels: models.length,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (req.method === 'GET' && url === '/api/history') {
      const history = await loadHistoryList();
      sendJson(res, 200, { history });
      return;
    }

    if (req.method === 'POST' && url === '/api/test-model') {
      const body = await readJsonBody(req);
      const provider = String(body.provider || '');
      const modelId = String(body.modelId || '');
      if (!provider || !modelId) {
        sendJson(res, 400, { error: 'provider and modelId are required' });
        return;
      }
      const out = await testModel(provider, modelId);
      sendJson(res, 200, out);
      return;
    }

    if (req.method === 'POST' && url === '/api/switch-model') {
      const body = await readJsonBody(req);
      const target = String(body.full || '');
      if (!target.includes('/')) {
        sendJson(res, 400, { error: 'full model id format: provider/model' });
        return;
      }
      const { raw, parsed } = await readConfig();
      const modelCfg = ((((parsed.agents || {}).defaults || {}).model) || {});
      const oldPrimary = modelCfg.primary || '';
      await saveHistory('switch', raw, `switch ${oldPrimary} -> ${target}`);

      parsed.agents = parsed.agents || {};
      parsed.agents.defaults = parsed.agents.defaults || {};
      parsed.agents.defaults.model = parsed.agents.defaults.model || {};
      parsed.agents.defaults.model.primary = target;

      const oldFallbacks = Array.isArray(parsed.agents.defaults.model.fallbacks)
        ? parsed.agents.defaults.model.fallbacks
        : [];
      const nextFallbacks = [oldPrimary, ...oldFallbacks].filter(v => v && v !== target);
      parsed.agents.defaults.model.fallbacks = Array.from(new Set(nextFallbacks)).slice(0, 5);

      await writeConfig(parsed);
      restartGateway();

      sendJson(res, 200, {
        ok: true,
        newPrimary: target,
        fallbacks: parsed.agents.defaults.model.fallbacks,
        restarted: true
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/restore') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (!id) {
        sendJson(res, 400, { error: 'history id required' });
        return;
      }
      const file = path.join(HISTORY_DIR, `${id}.json`);
      const raw = await fsp.readFile(file, 'utf8');
      const snap = JSON.parse(raw);
      const current = await readConfig();
      await saveHistory('restore-pre', current.raw, `before restore ${id}`);
      await writeConfig(snap.config);
      restartGateway();
      sendJson(res, 200, { ok: true, restored: id, restarted: true });
      return;
    }


    if (req.method === 'POST' && url === '/api/delete-model') {
      const body = await readJsonBody(req);
      const full = String(body.full || '').trim();
      if (!full.includes('/')) {
        sendJson(res, 400, { error: 'full model id format: provider/model' });
        return;
      }

      const slash = full.indexOf('/');
      const providerName = full.slice(0, slash);
      const modelId = full.slice(slash + 1);
      if (!providerName || !modelId) {
        sendJson(res, 400, { error: 'invalid full model id' });
        return;
      }

      const { raw, parsed } = await readConfig();
      const providers = (((parsed.models || {}).providers) || {});
      const provider = providers[providerName];
      const modelList = provider && Array.isArray(provider.models) ? provider.models : [];
      const exists = modelList.some(m => String(m.id || '') === modelId);
      if (!exists) {
        sendJson(res, 404, { error: `Model not found: ${full}` });
        return;
      }

      const allBefore = listModels(parsed).map(m => m.full);
      if (allBefore.length <= 1 && allBefore.includes(full)) {
        sendJson(res, 400, { error: 'Cannot delete the last model in config' });
        return;
      }

      await saveHistory('delete-model-pre', raw, `before delete ${full}`);

      provider.models = modelList.filter(m => String(m.id || '') !== modelId);
      if (provider.models.length === 0) {
        delete providers[providerName];
      }

      parsed.agents = parsed.agents || {};
      parsed.agents.defaults = parsed.agents.defaults || {};
      parsed.agents.defaults.model = parsed.agents.defaults.model || {};
      const modelCfg = parsed.agents.defaults.model;
      const allAfter = listModels(parsed).map(m => m.full);

      const oldFallbacks = Array.isArray(modelCfg.fallbacks) ? modelCfg.fallbacks : [];
      modelCfg.fallbacks = oldFallbacks.filter(v => v !== full && allAfter.includes(v));

      if (!allAfter.includes(modelCfg.primary || '')) {
        const preferred = modelCfg.fallbacks.find(v => allAfter.includes(v));
        modelCfg.primary = preferred || allAfter[0] || '';
      }
      modelCfg.fallbacks = modelCfg.fallbacks.filter(v => v !== modelCfg.primary);

      await writeConfig(parsed);
      restartGateway();

      sendJson(res, 200, {
        ok: true,
        deleted: full,
        newPrimary: modelCfg.primary,
        remaining: allAfter.length,
        restarted: true
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/add-model') {
      const body = await readJsonBody(req);
      const providerName = String(body.providerName || '').trim();
      const baseUrl = String(body.baseUrl || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      const api = String(body.api || '').trim();
      const modelId = String(body.modelId || '').trim();
      const modelName = String(body.modelName || modelId).trim();

      if (!providerName || !baseUrl || !apiKey || !api || !modelId) {
        sendJson(res, 400, { error: 'providerName, baseUrl, apiKey, api, modelId are required' });
        return;
      }

      if (!['openai-responses', 'anthropic-messages'].includes(api)) {
        sendJson(res, 400, { error: 'api must be openai-responses or anthropic-messages' });
        return;
      }

      const { raw, parsed } = await readConfig();
      await saveHistory('add-model-pre', raw, `before add ${providerName}/${modelId}`);

      parsed.models = parsed.models || {};
      parsed.models.providers = parsed.models.providers || {};
      
      if (!parsed.models.providers[providerName]) {
        parsed.models.providers[providerName] = {
          baseUrl,
          apiKey,
          api,
          models: []
        };
      }

      const provider = parsed.models.providers[providerName];
      provider.baseUrl = baseUrl;
      provider.apiKey = apiKey;
      provider.api = api;

      const existingModel = provider.models.find((m) => m.id === modelId);
      if (existingModel) {
        sendJson(res, 400, { error: `Model ${modelId} already exists in provider ${providerName}` });
        return;
      }

      provider.models.push({
        id: modelId,
        name: modelName,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192
      });

      await writeConfig(parsed);

      // Test the newly added model
      let testResult;
      try {
        testResult = await testModel(providerName, modelId);
      } catch (e) {
        testResult = { ok: false, error: e.message };
      }

      sendJson(res, 200, {
        ok: true,
        added: `${providerName}/${modelId}`,
        testResult
      });
      return;
    }

    
    if (req.method === 'POST' && url === '/api/update-model') {
      const body = await readJsonBody(req);
      const full = String(body.full || '').trim();
      const newBaseUrl = String(body.baseUrl || '').trim();
      const newApiKey = String(body.apiKey || '').trim();
      const newApi = String(body.api || '').trim();
      const newModelName = String(body.modelName || '').trim();
      const newReasoning = Boolean(body.reasoning);
      const newContextWindow = Number(body.contextWindow) || 200000;
      const newMaxTokens = Number(body.maxTokens) || 8192;

      if (!full.includes('/')) {
        sendJson(res, 400, { error: 'invalid model id' });
        return;
      }

      const slash = full.indexOf('/');
      const providerName = full.slice(0, slash);
      const modelId = full.slice(slash + 1);

      const { raw, parsed } = await readConfig();
      await saveHistory('update-model-pre', raw, `before update ${full}`);

      const providers = (((parsed.models || {}).providers) || {});
      const provider = providers[providerName];
      if (!provider) {
        sendJson(res, 404, { error: 'provider not found' });
        return;
      }

      const modelList = provider.models || [];
      const modelIndex = modelList.findIndex(m => String(m.id || '') === modelId);
      if (modelIndex === -1) {
        sendJson(res, 404, { error: 'model not found' });
        return;
      }

      if (newBaseUrl) provider.baseUrl = newBaseUrl;
      if (newApiKey) provider.apiKey = newApiKey;
      if (newApi && ['openai-responses', 'anthropic-messages'].includes(newApi)) {
        provider.api = newApi;
      }

      const model = modelList[modelIndex];
      if (newModelName) model.name = newModelName;
      model.reasoning = newReasoning;
      model.contextWindow = newContextWindow;
      model.maxTokens = newMaxTokens;

      await writeConfig(parsed);
      restartGateway();

      sendJson(res, 200, {
        ok: true,
        updated: full,
        restarted: true
      });
      return;
    }

await serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[model-console] listening on http://${HOST}:${PORT}`);
  console.log(`[model-console] config: ${CONFIG_PATH}`);
});

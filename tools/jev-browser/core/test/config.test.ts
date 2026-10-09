import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, defaultConfig } from '../src/config.js';

test('默认配置：attach/chrome/有头；origin 默认为空', () => {
  const { config } = loadConfig({ env: {} });
  assert.equal(config.browser.mode, 'attach');
  assert.equal(config.browser.engine, 'chrome');
  assert.equal(config.browser.headless, false);
  assert.deepEqual(config.safety.allowedOrigins, []);
  assert.deepEqual(config.safety.modelOrigins, []);
  assert.equal(config.browser.attach.noDefaults, true);
});

test('attach + headless=true 被拒绝（不能隐式换实例）', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { browser: { headless: true } } }),
    /headless/,
  );
});

test('未知字段被拒绝', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { browser: { cdpEndpoint: 'http://127.0.0.1:9223' } } }),
    /未知字段/,
  );
});

test('modelOrigins 必须是 allowedOrigins 子集', () => {
  assert.throws(
    () => loadConfig({
      env: {},
      overrides: { safety: { allowedOrigins: ['https://example.com'], modelOrigins: ['https://other.com'] } },
    }),
    /modelOrigins/,
  );
});

test('布尔环境变量严格解析', () => {
  assert.throws(
    () => loadConfig({ env: { JEV_BROWSER_HEADLESS: 'yes' } }),
    /true\/false\/1\/0/,
  );
  // attach + headless=true 依然被条件校验拦截
  assert.throws(() => loadConfig({ env: { JEV_BROWSER_HEADLESS: '1' } }), /headless/);
});

test('origin 格式校验：只接受明确 http/https origin', () => {
  assert.throws(
    () => loadConfig({ env: { JEV_BROWSER_ALLOWED_ORIGINS: '["example.com"]' } }),
    /origin 非法/,
  );
  const { config } = loadConfig({ env: { JEV_BROWSER_ALLOWED_ORIGINS: '["https://example.com"]' } });
  assert.deepEqual(config.safety.allowedOrigins, ['https://example.com']);
});

test('文件 + 环境变量合并：env 优先；launch 分支保留但不激活', () => {
  const { config, sources } = loadConfig({
    env: {
      JEV_BROWSER_CONFIG: 'ignored-nonexistent',
      JEV_BROWSER_ALLOWED_ORIGINS: '["https://a.com"]',
    },
    overrides: { safety: { modelOrigins: ['https://a.com'] } },
  });
  assert.equal(sources.file, undefined);
  assert.deepEqual(config.safety.allowedOrigins, ['https://a.com']);
  assert.equal(defaultConfig().browser.mode, 'attach');
});

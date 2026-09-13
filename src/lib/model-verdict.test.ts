import { describe, expect, it } from 'vitest';
import { isPathLikeModel, modelVerdictText, validateModelValue } from '@/lib/model-verdict';

const CANDIDATES = ['qwen3.6-plus', 'team-chat', 'gpt-5.4'];

describe('isPathLikeModel (9/2 /models 事故硬规则)', () => {
  it('rejects path, URL, and whitespace forms', () => {
    expect(isPathLikeModel('/models')).toBe(true);
    expect(isPathLikeModel('v1/models')).toBe(false); // 非根路径形态不拦（名字可含 / 以外的斜杠场景按 warn 处理）
    expect(isPathLikeModel('http://sglang:8000/models')).toBe(true);
    expect(isPathLikeModel('https://api.example.com')).toBe(true);
    expect(isPathLikeModel('my model')).toBe(true);
    expect(isPathLikeModel('a\tb')).toBe(true);
    expect(isPathLikeModel('qwen3.6-plus')).toBe(false);
    expect(isPathLikeModel('MiniMax-M2.7-highspeed')).toBe(false);
  });

  it('trims before judging', () => {
    expect(isPathLikeModel('  /models  ')).toBe(true);
    expect(isPathLikeModel('   ')).toBe(false);
  });
});

describe('validateModelValue (G2 写前校验)', () => {
  it('empty = 跟随集群默认 (ok)', () => {
    expect(validateModelValue('', CANDIDATES).level).toBe('ok');
    expect(validateModelValue('   ', CANDIDATES).level).toBe('ok');
  });

  it('path-like = error 恒生效，不依赖候选', () => {
    expect(validateModelValue('/models', CANDIDATES).level).toBe('error');
    expect(validateModelValue('/models', []).level).toBe('error');
    expect(validateModelValue('a b', CANDIDATES).level).toBe('error');
  });

  it('命中候选 = ok', () => {
    expect(validateModelValue('qwen3.6-plus', CANDIDATES).level).toBe('ok');
    expect(validateModelValue('  team-chat  ', CANDIDATES).level).toBe('ok');
  });

  it('未命中候选 = warn(list)', () => {
    expect(validateModelValue('custom-model-x', CANDIDATES)).toEqual({ level: 'warn', reason: 'list' });
  });

  it('候选不可用 = warn(nocands)，值合法形态不升级 error', () => {
    expect(validateModelValue('custom-model-x', [])).toEqual({ level: 'warn', reason: 'nocands' });
  });
});

describe('modelVerdictText', () => {
  it('error 文案点名 /models 事故', () => {
    expect(modelVerdictText(validateModelValue('/models', CANDIDATES), '/models', CANDIDATES)).toContain('/models');
  });

  it('warn(list) 列出前 8 个候选并截断', () => {
    const many = Array.from({ length: 10 }, (_, i) => `alias-${i}`);
    const text = modelVerdictText(validateModelValue('x', many), 'x', many);
    expect(text).toContain('alias-0');
    expect(text).toContain('alias-7');
    expect(text).not.toContain('alias-8');
    expect(text).toContain('…');
  });

  it('warn(nocands) 提示未校验', () => {
    expect(modelVerdictText(validateModelValue('x', []), 'x', [])).toContain('未校验');
  });

  it('留空 ok 文案 = 跟随集群默认', () => {
    expect(modelVerdictText(validateModelValue('', CANDIDATES), '', CANDIDATES)).toBe('留空 = 跟随集群默认');
  });

  it('命中 ok 文案', () => {
    expect(modelVerdictText(validateModelValue('qwen3.6-plus', CANDIDATES), 'qwen3.6-plus', CANDIDATES)).toBe('命中 alias 组');
  });
});

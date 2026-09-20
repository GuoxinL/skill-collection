#!/usr/bin/env node
/**
 * 构建 skills.json 注册表（供 guoxin.space 运行时静态读取，替代 GitHub API 实时遍历）。
 *
 * - 本地读取各技能目录的 SKILL.md frontmatter + _collect.json 解析元数据
 *   （name / description / mode / source / sourceOwner），无需调用 GitHub API、不受 60/hr 限流。
 * - 图标按候选列表本地优先；proxy 模式回源原仓库做 raw HEAD 探测（raw 走 CDN，非 API 限流）；
 *   探测失败则置 null，由 guoxin.space 客户端回退确定性占位图（skPlaceholderIcon）。
 * - 输出仓库根 skills.json = { repo, branch, generatedAt, rows: SkillMeta[] }。
 *
 * 与 Notes 范式一致：数据仓自己构建静态产物（notes 仓构建 posts.json / all.json），
 * 站点侧纯运行时经 raw.githubusercontent 拉取，写入通道（Worker collect/remove）不变。
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const REPO = 'GuoxinL/skill-collection';
const BRANCH = process.env.SK_BRANCH || 'main';
const ICON_CANDS = ['_icon.png', 'icon.svg', 'icon.png', 'logo.png', 'logo.svg'];

/** 复刻 guoxin.space 的 skParseFrontmatter（仅取列表所需字段）。 */
function parseFrontmatter(text) {
  const out = { name: '', description: '', mode: null, source: '', sourceOwner: '' };
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let inMeta = false;
  let inDesc = false;
  const desc = [];
  for (const line of lines) {
    const l = line.replace(/\s+$/, '');
    if (inDesc) {
      if (/^\s+\S/.test(l)) {
        desc.push(l.trim());
        continue;
      }
      inDesc = false;
    }
    const nm = /^name:\s*(.+)$/.exec(l);
    if (nm) {
      out.name = nm[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const dm = /^description:\s*(.*)$/.exec(l);
    if (dm) {
      const rest = dm[1].trim();
      if (rest === '>' || rest === '|' || rest === '|-') {
        inDesc = true;
        continue;
      }
      desc.push(rest.replace(/^["']|["']$/g, ''));
      inDesc = true;
      continue;
    }
    if (/^metadata:\s*$/.test(l)) {
      inMeta = true;
      continue;
    }
    if (inMeta) {
      const sm = /^\s+(source|mode|sourceOwner):\s*(.+)$/.exec(l);
      if (sm) {
        const v = sm[2].trim();
        if (sm[1] === 'source') out.source = v;
        else if (sm[1] === 'mode') out.mode = v;
        else if (sm[1] === 'sourceOwner') out.sourceOwner = v;
      }
    }
  }
  out.description = desc.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}

/** 从 metadata.source 解析原仓库坐标，供 proxy 模式回源探测图标。 */
function parseSourceRepo(source) {
  const m =
    /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([\w.-]+)(?:\/(.*))?)?\/?$/.exec(
      String(source || ''),
    );
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3] || 'main',
    sub: (m[4] || '').replace(/^\/+|\/+$/g, ''),
  };
}

async function probeIcon(owner, repo, branch, sub) {
  const base = sub ? sub + '/' : '';
  for (const c of ICON_CANDS) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${base}${c}`;
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return url;
    } catch {
      /* 探测失败忽略，继续下一个候选 */
    }
  }
  return null;
}

async function resolveIcon(dir, fm) {
  // 本地优先：技能目录内自带图标
  for (const c of ICON_CANDS) {
    if (existsSync(join(ROOT, dir, c))) {
      return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${dir}/${c}`;
    }
  }
  // proxy 模式：图标回源 meta.source 指向的原仓库
  if (fm.mode === 'proxy' && fm.source) {
    const s = parseSourceRepo(fm.source);
    if (s) {
      const url = await probeIcon(s.owner, s.repo, s.branch, s.sub);
      if (url) return url;
    }
  }
  return null;
}

async function main() {
  const entries = readdirSync(ROOT);
  const dirs = entries.filter((e) => {
    if (e.startsWith('.')) return false;
    if (['tools', 'node_modules', 'assets'].includes(e)) return false;
    try {
      return statSync(join(ROOT, e)).isDirectory();
    } catch {
      return false;
    }
  });

  const rows = [];
  for (const dir of dirs) {
    let fm = { name: dir, description: '', mode: null, source: '', sourceOwner: '' };
    const skPath = join(ROOT, dir, 'SKILL.md');
    if (existsSync(skPath)) {
      fm = parseFrontmatter(readFileSync(skPath, 'utf8'));
      if (!fm.name) fm.name = dir;
    }
    // _collect.json 兜底 source / mode（收藏态元数据）
    const cjPath = join(ROOT, dir, '_collect.json');
    if (existsSync(cjPath)) {
      try {
        const cj = JSON.parse(readFileSync(cjPath, 'utf8'));
        if (!fm.source && cj.source) fm.source = cj.source;
        if (!fm.mode && cj.mode) fm.mode = cj.mode;
        if (cj.sourceOwner) fm.sourceOwner = cj.sourceOwner;
      } catch {
        /* 忽略损坏的 _collect.json */
      }
    }
    if (!fm.sourceOwner) {
      const m = /github\.com\/([\w.-]+)/.exec(fm.source || '');
      if (m) fm.sourceOwner = m[1];
    }
    const icon = await resolveIcon(dir, fm);
    rows.push({
      dir,
      name: fm.name || dir,
      description: fm.description,
      mode: fm.mode,
      source: fm.source,
      sourceOwner: fm.sourceOwner,
      icon,
    });
  }

  const out = { repo: REPO, branch: BRANCH, generatedAt: new Date().toISOString(), rows };
  writeFileSync(join(ROOT, 'skills.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`[build-index] wrote skills.json with ${rows.length} skill(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

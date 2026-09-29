// skillLoader.ts
import fs from 'node:fs/promises';
import path from 'node:path';

/** ========== 类型 ========== */

export interface FileRef {
    label: string;
    /** 原始 md 中写的路径，可能含空格或反斜杠 */
    path: string;
    /** 规范化后的 basename（去掉路径与 .md 后缀），用于匹配已加载的 Skill */
    resolvedName: string;
}

export interface Skill {
    name: string;
    description?: string;
    /** 去除 frontmatter 后的正文（保留 markdown 结构） */
    body: string;
    /** 原始文件内容 */
    raw: string;
    filePath: string;
    /** $xxx 形式的子技能引用 */
    subSkills: string[];
    /** [label](path) 形式的文件引用 */
    fileRefs: FileRef[];
}

/** ========== frontmatter 解析 ========== */

function parseFrontmatter(src: string): {
    meta: Record<string, string>;
    body: string;
} {
    const m = src.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
    if (!m) return { meta: {}, body: src };

    const meta: Record<string, string> = {};
    for (const raw of m[1].split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim();
        let v = line.slice(idx + 1).trim();
        if (
            (v.startsWith('"') && v.endsWith('"')) ||
            (v.startsWith("'") && v.endsWith("'"))
        ) {
            v = v.slice(1, -1);
        }
        meta[k] = v;
    }
    return { meta, body: m[2] };
}

/** ========== 引用提取 ========== */

/** 匹配 $skill-name（小写字母、数字、连字符） */
const SUB_SKILL_RE = /\$([a-z][a-z0-9-]*)/g;

/** 匹配 [label](path) */
const FILE_REF_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function extractSubSkills(body: string): string[] {
    const set = new Set<string>();
    for (const m of body.matchAll(SUB_SKILL_RE)) set.add(m[1]);
    return [...set];
}

function extractFileRefs(body: string): FileRef[] {
    const out: FileRef[] = [];
    for (const m of body.matchAll(FILE_REF_RE)) {
        const rawPath = m[2].trim();
        // 处理 "references\analysis-rubric.md" 这种反斜杠路径
        const normalized = rawPath.replace(/\\/g, '/');
        const base = path
            .basename(normalized)
            .replace(/\.md$/i, '');
        out.push({ label: m[1], path: rawPath, resolvedName: base });
    }
    return out;
}

/** ========== Skill 解析 ========== */

export function parseSkill(content: string, filePath: string): Skill {
    const { meta, body } = parseFrontmatter(content);
    const name = meta.name || path.basename(filePath, '.md');
    if (!name) throw new Error(`Skill 缺少 name：${filePath}`);

    const trimmedBody = body.trim();
    return {
        name,
        description: meta.description,
        body: trimmedBody,
        raw: content,
        filePath,
        subSkills: extractSubSkills(trimmedBody),
        fileRefs: extractFileRefs(trimmedBody),
    };
}

/** ========== 目录加载 ========== */

export interface LoadedSkills {
    /** name → Skill */
    byName: Map<string, Skill>;
    /** 每个 Skill 的子技能（已解析为 Skill 对象） */
    children: Map<string, Skill[]>;
    /** 每个 Skill 依赖的「共享参考文件」（已解析为 Skill 对象，比如 analysis-rubric） */
    references: Map<string, Skill[]>;
}

export async function loadSkillsFromDir(dir: string): Promise<LoadedSkills> {
    const byName = new Map<string, Skill>();

    const entries = await fs.readdir(dir);
    for (const file of entries) {
        if (!file.toLowerCase().endsWith('.md')) continue;
        const full = path.join(dir, file);
        const stat = await fs.stat(full);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(full, 'utf8');
        const skill = parseSkill(content, full);
        byName.set(skill.name, skill);
    }

    const children = new Map<string, Skill[]>();
    const references = new Map<string, Skill[]>();

    for (const skill of byName.values()) {
        // 解析 $sub
        const subs: Skill[] = [];
        for (const subName of skill.subSkills) {
            const sub = byName.get(subName);
            if (sub) subs.push(sub);
        }
        children.set(skill.name, subs);

        // 解析 [file](path)
        const refs: Skill[] = [];
        for (const ref of skill.fileRefs) {
            const r = byName.get(ref.resolvedName);
            if (r) refs.push(r);
        }
        references.set(skill.name, refs);
    }

    return { byName, children, references };
}
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** ========== 类型定义 ========== */

/** KOL 详细档案 */
export interface KOLProfile {
    /** 显示名称 */
    name: string;
    /** 账号 handle（不带 @） */
    handle: string;
    /** 是否蓝V认证 */
    verified: boolean;
    /** 粉丝数 */
    followers: number;
    /** 简介 / Bio */
    bio: string;
    /** 细分方向，例如 "DeFi 研究员"、"公链分析师" */
    category: string;
    /** 影响力指数 0-100 */
    influenceScore: number;
    /** 近 7 天平均互动量（赞+转+评） */
    avgEngagement: number;
    /** 主页链接 */
    profileUrl: string;
    /** 代表性帖子链接（可选） */
    topPostUrl?: string;
    /** 活跃度描述，例如 "高频"、"中频"、"低频" */
    activityLevel?: string;
}

export interface BatchQueryOptions {
    /** 领域名称，例如 "加密" */
    domain: string;
    /** 领域关键字数组，例如 ["meme", "Ethereum"] */
    keywords: string[];
    /** 起始日期 YYYY-MM-DD */
    fromDate: string;
    /** 结束日期 YYYY-MM-DD */
    toDate: string;



    /** xAI 配置。如果不传，则读取环境变量 XAI_API_KEY */
    xaiOptions?: {
        apiKey?: string;
        baseURL?: string;
        /** 模型，默认 grok-4.6 */
        model?: string;
    };

    /** 输出目录，默认当前目录 */
    outputDir?: string;
    /** 文件名前缀，默认 "x-batch" */
    filePrefix?: string;
    /** 是否落盘，默认 true */
    persist?: boolean;
    /** 是否打印日志，默认 true */
    verbose?: boolean;
}

export interface BatchFailure {
    batchIndex: number;
    handles: string[];
    error: string;
}

export interface BatchQueryResult {
    /** Markdown 正文（含 KOL 列表 + 帖子明细） */
    mergedText: string;
    /** 去重后的所有引用 */
    sources: unknown[];
    /** 失败的批次 */
    failedBatches: BatchFailure[];
    /** 模型识别出的 KOL handle 列表（便捷字段） */
    discoveredKOLs: string[];
    /** 模型识别出的 KOL 完整档案 */
    discoveredKOLProfiles: KOLProfile[];
    /** 统计信息 */
    stats: {
        totalHandles: number;
        totalBatches: number;
        successBatches: number;
        failedBatches: number;
        totalSources: number;
        discoveredKOLCount: number;
    };
    /** 落盘后的文件路径（persist=false 时为 null） */
    files: {
        text: string;
        citationsJson: string;
        citationsMd: string;
        kolsJson: string;
    } | null;
}

/** ========== 工具函数 ========== */

export const sleep = (ms: number) =>
    new Promise<void>((r) => setTimeout(r, ms));

export function renderCitationsMarkdown(sources: unknown[]): string {
    if (!sources || sources.length === 0) return '(no citations)';
    return sources
        .map((s, i) => {
            const n = i + 1;
            const src = s as {
                sourceType?: string;
                title?: string;
                url?: string;
                filename?: string;
                mediaType?: string;
            };
            if (src.sourceType === 'url') {
                const title = src.title?.trim() || src.url || '(untitled)';
                return `${n}. [${title}](${src.url})`;
            }
            const label = src.filename
                ? `${src.title} (${src.filename})`
                : src.title ?? '(untitled)';
            return `${n}. ${label} \`[${src.mediaType ?? 'unknown'}]\``;
        })
        .join('\n');
}

function cleanJsonText(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\n?/, '');
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\n?/, '');
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.replace(/\n?```$/, '');
    }
    return cleaned.trim();
}

/**
 * 合并版 Prompt：
 * 一次调用完成「通过领域+关键词发现 KOL（含详细档案）」+「抓取这些 KOL 在时间范围内的所有帖子」。
 */
/* export function buildUnifiedPrompt(
    domain: string,
    keywords: string[],
    fromDate: string,
    toDate: string,
): string {
    const keywordQuery = keywords.map(k => `"${k}"`).join(' OR ');
    const keywordsDisplay = keywords.join(', ');

    return `你是一名高级社交媒体情报分析师，请使用 x_search 工具完成一次完整的领域情报采集。

【任务背景】
- 领域：${domain}
- 关键词：${keywordsDisplay}
- 时间范围：${fromDate} 到 ${toDate}
- 搜索关键词查询：${keywordQuery}

【任务步骤（必须严格按顺序执行）】
第一步：使用 x_search 工具搜索上述关键词在该时间范围内的相关帖子。
第二步：从搜索结果中识别出该领域最具影响力的 KOL / 意见领袖账号（筛选标准：粉丝量 > 10,000，近期活跃，排除纯转载号与营销号），最多识别 50 个。
第三步：针对识别出的每一个 KOL，使用 x_search 工具搜索该账号在 ${fromDate} 到 ${toDate} 期间发布的**所有**帖子，不要只抓取 10 条，必须尽可能完整。

【输出格式要求（极其重要）】
请严格按以下两段结构输出，不要添加任何额外的解释性开场白：

--- SECTION 1: KOL LIST (JSON) ---
仅输出一个纯 JSON 数组，不要包含 Markdown 代码块标记。每个 KOL 必须包含以下全部字段：
[
  {
    "name": "Changpeng Zhao",
    "handle": "cz_binance",
    "verified": true,
    "followers": 9800000,
    "bio": "Binance 创始人，区块链与加密行业连续创业者",
    "category": "交易所 / 加密行业领袖",
    "influenceScore": 98.4,
    "avgEngagement": 185000,
    "profileUrl": "https://x.com/cz_binance",
    "topPostUrl": "https://x.com/cz_binance/status/1234567890",
    "activityLevel": "高频"
  },
  {
    "name": "Vitalik Buterin",
    "handle": "VitalikButerin",
    "verified": true,
    "followers": 5200000,
    "bio": "以太坊联合创始人",
    "category": "公链 / 协议研究者",
    "influenceScore": 96.7,
    "avgEngagement": 96000,
    "profileUrl": "https://x.com/VitalikButerin",
    "topPostUrl": "https://x.com/VitalikButerin/status/...",
    "activityLevel": "中频"
  }
]

字段说明（务必全部填写，缺失值用合理估计或 null）：
- name: 显示名称（string）
- handle: X 账号，不带 @（string）
- verified: 是否蓝V认证（boolean）
- followers: 粉丝数（number）
- bio: 简介原文或一句话概括（string）
- category: 细分方向 / 身份定位（string，如 "DeFi 研究员"、"Layer2 分析师"、"KOL 交易员"）
- influenceScore: 影响力指数 0-100（number，综合粉丝量、互动率、原创度）
- avgEngagement: 近 7 天平均互动量 = 点赞 + 转发 + 评论（number）
- profileUrl: 主页链接（string，格式 https://x.com/{handle}）
- topPostUrl: 该 KOL 的代表性帖子链接（string，无则 null）
- activityLevel: 活跃度（"高频" / "中频" / "低频"）

--- SECTION 2: POSTS DETAIL (Markdown) ---
按照 KOL 账号分组，逐一列出每个 KOL 在时间范围内的所有帖子。格式：

## @handle (KOL 名称)

### 帖子 1
- 发布时间：YYYY-MM-DD HH:mm
- 完整内容：xxx
- 点赞数：xxx
- 转发数：xxx
- 回复数：xxx
- 浏览量：xxx
- 原帖链接：https://x.com/...

### 帖子 2
...

（继续列出所有帖子；如某 KOL 在此期间没有发帖，请明确注明「该账号在指定时间范围内无发帖」。）

【强制约束】
1. 必须调用 x_search 工具进行真实搜索，禁止凭记忆或推测编造。
2. 禁止回复"请提供账号"或"信息不足"，直接根据工具返回结果输出。
3. SECTION 1 中的 profileUrl 与 topPostUrl 必须为真实的 x.com 链接。
4. SECTION 1 中每个 KOL 的所有字段都必须存在，不得省略字段名。
5. 如果因输出长度限制无法列完所有帖子，请优先保证 KOL 列表完整，并对帖子明细按互动量从高到低排序展示，同时在末尾注明「实际检索到的帖子总数：X」。`;
} */

export function buildUnifiedPrompt(
    domain: string,
    keywords: string[],
    fromDate: string,
    toDate: string,
): string {
    const keywordQuery = keywords.map(k => `"${k}"`).join(' OR ');
    const keywordsDisplay = keywords.join(', ');

    return `你是一名高级社交媒体情报分析师，请使用 x_search 工具完成一次完整的领域情报采集。

【任务背景】
- 领域：${domain}
- 关键词：${keywordsDisplay}
- 时间范围：${fromDate} 到 ${toDate}
- 搜索关键词查询：${keywordQuery}

【任务步骤（必须严格按顺序执行）】
第一步：使用 x_search 工具搜索上述关键词在该时间范围内的相关帖子。
第二步：从搜索结果中识别出该领域最具影响力的 KOL / 意见领袖账号（筛选标准：粉丝量 > 10,000，近期活跃，排除纯转载号与营销号），最多识别 100 个。
第三步：针对识别出的每一个 KOL，使用 x_search 工具搜索该账号在 ${fromDate} 到 ${toDate} 期间发布的**所有**帖子，不要只抓取 10 条，必须尽可能完整。

【输出格式要求（极其重要）】
请严格按以下两段结构输出，不要添加任何额外的解释性开场白：

--- SECTION 1: KOL LIST (Markdown) ---
使用 Markdown 格式输出 KOL 列表，不要输出 JSON。推荐每个 KOL 使用一个三级标题，字段用无序列表逐项列出；也可使用 Markdown 表格。每个 KOL 必须包含以下全部字段：

### 1. Changpeng Zhao
- name: Changpeng Zhao
- handle: cz_binance
- verified: true
- followers: 9800000
- bio: Binance 创始人，区块链与加密行业连续创业者
- category: 交易所 / 加密行业领袖
- influenceScore: 98.4
- avgEngagement: 185000
- profileUrl: https://x.com/cz_binance
- topPostUrl: https://x.com/cz_binance/status/1234567890
- activityLevel: 高频

### 2. Vitalik Buterin
- name: Vitalik Buterin
- handle: VitalikButerin
- verified: true
- followers: 5200000
- bio: 以太坊联合创始人
- category: 公链 / 协议研究者
- influenceScore: 96.7
- avgEngagement: 96000
- profileUrl: https://x.com/VitalikButerin
- topPostUrl: null
- activityLevel: 中频

字段说明（务必全部填写，缺失值用合理估计或 null）：
- name: 显示名称（string）
- handle: X 账号，不带 @（string）
- verified: 是否蓝V认证（boolean）
- followers: 粉丝数（number）
- bio: 简介原文或一句话概括（string）
- category: 细分方向 / 身份定位（string，如 "DeFi 研究员"、"Layer2 分析师"、"KOL 交易员"）
- influenceScore: 影响力指数 0-100（number，综合粉丝量、互动率、原创度）
- avgEngagement: 近 7 天平均互动量 = 点赞 + 转发 + 评论（number）
- profileUrl: 主页链接（string，格式 https://x.com/{handle}）
- topPostUrl: 该 KOL 的代表性帖子链接（string，无则 null）
- activityLevel: 活跃度（"高频" / "中频" / "低频"）

--- SECTION 2: POSTS DETAIL (Markdown) ---
按照 KOL 账号分组，逐一列出每个 KOL 在时间范围内的所有帖子。格式：

## @handle (KOL 名称)

### 帖子 1
- 发布时间：YYYY-MM-DD HH:mm
- 完整内容：xxx
- 点赞数：xxx
- 转发数：xxx
- 回复数：xxx
- 浏览量：xxx
- 原帖链接：https://x.com/...

### 帖子 2
...

（继续列出所有帖子；如某 KOL 在此期间没有发帖，请明确注明「该账号在指定时间范围内无发帖」。）

【强制约束】
1. 必须调用 x_search 工具进行真实搜索，禁止凭记忆或推测编造。
2. 禁止回复"请提供账号"或"信息不足"，直接根据工具返回结果输出。
3. SECTION 1 中的 profileUrl 与 topPostUrl 必须为真实的 x.com 链接。
4. SECTION 1 中每个 KOL 的所有字段都必须存在，不得省略字段名。
5. 如果因输出长度限制无法列完所有帖子，请优先保证 KOL 列表完整，并对帖子明细按互动量从高到低排序展示，同时在末尾注明「实际检索到的帖子总数：X」。`;
}

/** 创建一个 xai 客户端 */
export function createXaiClient(opts?: {
    apiKey?: string;
    baseURL?: string;
}) {
    const apiKey = opts?.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
        throw new Error(
            '缺少 xAI API Key：请传入 options.xaiOptions.apiKey 或设置环境变量 XAI_API_KEY',
        );
    }
    return createXai({
        apiKey,
        baseURL: opts?.baseURL ?? 'https://api.x.ai/v1',
    });
}

function timestampedName(prefix: string, ext: string, ts = Date.now()) {
    return `${prefix}-${ts}.${ext}`;
}

/** 从模型返回的正文中解析出 KOL JSON 列表（完整档案） */
function extractKOLProfiles(text: string): KOLProfile[] {
    try {
        const sectionMatch = text.match(
            /---\s*SECTION 1:[\s\S]*?---([\s\S]*?)---\s*SECTION 2:/i,
        );
        const jsonCandidate = sectionMatch ? sectionMatch[1].trim() : text;

        let parsed: unknown;
        try {
            parsed = JSON.parse(cleanJsonText(jsonCandidate));
        } catch {
            const arrMatch = jsonCandidate.match(/\[[\s\S]*\]/);
            if (!arrMatch) return [];
            parsed = JSON.parse(cleanJsonText(arrMatch[0]));
        }

        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
            .map((item) => {
                const handle = typeof item.handle === 'string' ? item.handle.replace(/^@/, '') : '';
                return {
                    name: typeof item.name === 'string' ? item.name : '',
                    handle,
                    verified: Boolean(item.verified),
                    followers: Number(item.followers) || 0,
                    bio: typeof item.bio === 'string' ? item.bio : '',
                    category: typeof item.category === 'string' ? item.category : '',
                    influenceScore: Number(item.influenceScore) || 0,
                    avgEngagement: Number(item.avgEngagement) || 0,
                    profileUrl:
                        typeof item.profileUrl === 'string' && item.profileUrl.length > 0
                            ? item.profileUrl
                            : handle
                                ? `https://x.com/${handle}`
                                : '',
                    topPostUrl: typeof item.topPostUrl === 'string' ? item.topPostUrl : undefined,
                    activityLevel: typeof item.activityLevel === 'string' ? item.activityLevel : undefined,
                } as KOLProfile;
            })
            .filter((k) => k.handle.length > 0);
    } catch (err) {
        console.warn('解析 KOL 列表失败：', err);
        return [];
    }
}

/** ========== 主方法 ========== */

/**
 * 通过领域 + 关键字，一步完成「发现 KOL（含详细档案）」+「抓取这些 KOL 在指定时间范围内的所有帖子」。
 */
export async function batchQueryXPosts(
    opts: BatchQueryOptions,
): Promise<BatchQueryResult> {
    const {
        domain,
        keywords,
        fromDate,
        toDate,
        xaiOptions,
        outputDir = '.',
        filePrefix = 'x-batch',
        persist = false,
        verbose = true,
    } = opts;

    if (!domain || !keywords?.length) {
        throw new Error('domain 和 keywords 不能为空');
    }

    const log = (...args: unknown[]) => {
        if (verbose) console.log(...args);
    };
    const xai = createXaiClient(xaiOptions);

    log(
        `🔍 单次查询：领域「${domain}」，关键词 [${keywords.join(', ')}]，时间 ${fromDate} ~ ${toDate}`,
    );

    const prompt = buildUnifiedPrompt(domain, keywords, fromDate, toDate);


    let mergedText = '';
    let allSources: unknown[] = [];
    const failedBatches: BatchFailure[] = [];
    let discoveredKOLProfiles: KOLProfile[] = [];

    try {
        const { text, sources } = await generateText({
            model: xai.responses(xaiOptions?.model ?? 'grok-4.7'),
            prompt,
            tools: {
                x_search: xai.tools.xSearch({
                    fromDate,
                    toDate,
                    enableImageUnderstanding: true,
                }),
            },
            toolChoice: 'required',
        });

        mergedText = text ?? '(无返回内容)';
        allSources = sources ?? [];
        discoveredKOLProfiles = extractKOLProfiles(mergedText);

        log(
            `✅ 查询完成，正文 ${mergedText.length} 字，引用 ${allSources.length} 条，识别 KOL ${discoveredKOLProfiles.length} 个`,
        );
    } catch (err) {
        const msg = String((err as Error)?.message || err);
        console.error(`❌ 查询失败：`, err);
        failedBatches.push({ batchIndex: 1, handles: [], error: msg });
        mergedText = `> ⚠️ 查询失败：${msg}`;
    }

    const discoveredKOLs = discoveredKOLProfiles.map((k) => k.handle);

    const header =
        `# X 领域情报汇总（${fromDate} ~ ${toDate}）\n\n` +
        `- 领域：${domain}\n` +
        `- 关键词：${keywords.join(', ')}\n` +
        `- 识别 KOL 数量：${discoveredKOLProfiles.length}\n` +
        `- 引用总数：${allSources.length}\n\n---\n\n`;

    const finalText = header + mergedText;

    const stats = {
        totalHandles: discoveredKOLProfiles.length,
        totalBatches: 1,
        successBatches: failedBatches.length === 0 ? 1 : 0,
        failedBatches: failedBatches.length,
        totalSources: allSources.length,
        discoveredKOLCount: discoveredKOLProfiles.length,
    };

    let files: BatchQueryResult['files'] = null;
    if (persist) {
        await mkdir(outputDir, { recursive: true });
        const ts = Date.now();
        const textPath = join(outputDir, timestampedName(filePrefix, 'md', ts));
        const jsonPath = join(outputDir, `${filePrefix}-citations-${ts}.json`);
        const mdPath = join(outputDir, `${filePrefix}-citations-${ts}.md`);
        const kolsPath = join(outputDir, `${filePrefix}-kols-${ts}.json`);

        await writeFile(textPath, finalText, 'utf-8');
        await writeFile(jsonPath, JSON.stringify(allSources, null, 2), 'utf-8');
        await writeFile(mdPath, renderCitationsMarkdown(allSources), 'utf-8');
        await writeFile(
            kolsPath,
            JSON.stringify(discoveredKOLProfiles, null, 2),
            'utf-8',
        );

        log(`✅ 正文已保存: ${textPath}`);
        log(`✅ 引用 JSON 已保存: ${jsonPath}`);
        log(`✅ 引用 MD 已保存: ${mdPath}`);
        log(`✅ KOL 档案已保存: ${kolsPath}`);

        files = {
            text: textPath,
            citationsJson: jsonPath,
            citationsMd: mdPath,
            kolsJson: kolsPath,
        };
    }

    return {
        mergedText: finalText,
        sources: allSources,
        failedBatches,
        discoveredKOLs,
        discoveredKOLProfiles,
        stats,
        files,
    };
}
// xResearch.ts
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createXai } from '@ai-sdk/xai';

/** 搜索提示词配置 */
export interface ResearchOptions {
    /** 研究领域，例如 "Crypto 二级市场" */
    domain: string;
    /** 期望覆盖的细分方向，例如 ["链上分析", "Smart Money"] */
    directions?: string[];
    /** 期望返回的账号数量，默认 18-25 */
    accountRange?: [number, number];
    /** 模型，默认 grok-4.6 */
    model?: string;
    /** 输出目录，默认当前目录 */
    outputDir?: string;
    /** 输出文件前缀，默认 "x-research" */
    filePrefix?: string;
    /** 是否打印日志，默认 true */
    verbose?: boolean;

    /** xAI 配置。如果不传，则读取环境变量 XAI_API_KEY */
    xaiOptions?: {
        apiKey?: string;
        baseURL?: string;
    };
}

/** 单个账号结构（对应 prompt 输出格式） */
export interface KOLAccount {
    handle: string;
    displayName?: string;
    bio?: string;
    followersLevel?: string;
    activity?: '高' | '中' | '低';
    specialty?: string;
    reason?: string;
    postUrl?: string;
    raw: string; // 保留原始 markdown 片段
}

/** 返回结果 */
export interface ResearchResult {
    /** 完整 markdown 文本 */
    text: string;
    /** citations 原始数组 */
    sources: unknown[];
    /** 落盘后的文件路径 */
    files: {
        text: string;
        citationsJson: string;
        citationsMd: string;
    };
}

/** 默认值 */
const DEFAULT_MODEL = 'grok-4.6';
const DEFAULT_ACCOUNT_RANGE: [number, number] = [25, 30];
const DEFAULT_FILE_PREFIX = 'x-research';

/**
 * 构造搜索 prompt。将领域、方向、数量参数化。
 */
export function buildPrompt(opts: ResearchOptions): string {
    const {
        domain,
        directions = [
            'Crypto 二级市场 / 链上分析 / Smart Money / 交易员',
            'Web3 安全 / 智能合约审计 / 安全研究员 / 漏洞分析',
        ],
        accountRange = DEFAULT_ACCOUNT_RANGE,
    } = opts;

    const directionList = directions.map((d) => `   - ${d}`).join('\n');

    return `你是一名专业的 X (Twitter) 账号研究员。请帮我找出「${domain}」领域目前最活跃、影响力较大的 KOL / 意见领袖账号。

请严格遵守以下要求：

1. 必须使用 x_search 工具进行真实搜索，禁止只靠已有知识编造账号。
2. 搜索时优先覆盖以下方向：
${directionList}
3. 尽量搜索高互动、专业内容的账号，关注近期活跃度。
4. 输出格式必须严格如下（每个账号都按此格式）：

- 账号：@handle
- 显示名：
- 简介摘要：
- 大致粉丝量级：
- 近期活跃度：高 / 中 / 低
- 主要擅长方向：
- 推荐理由（1-2句）：
- 相关高互动帖子链接（如有）：

5. 至少返回 ${accountRange[0]}-${accountRange[1]} 个账号，按影响力大致排序。
6. 中文圈账号请标注「中文圈」。
7. 排除明显不活跃或纯营销号的账号。
`;
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

/** 时间戳文件名工具 */
function timestampedName(prefix: string, ext: string, ts = Date.now()) {
    return `${prefix}-${ts}.${ext}`;
}

/** 把 sources 渲染成人类可读的 markdown */
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

/**
 * 主方法：调用 x_search 搜索并落盘。
 */
export async function researchXAccounts(
    opts: ResearchOptions,
): Promise<ResearchResult> {
    const {
        model = DEFAULT_MODEL,
        outputDir = '.',
        filePrefix = DEFAULT_FILE_PREFIX,
        verbose = true,
    } = opts;

    const log = (...args: unknown[]) => {
        if (verbose) console.log(...args);
    };
    const xai = createXaiClient(opts.xaiOptions);

    // 1. 调用模型 + x_search
    const prompt = buildPrompt(opts);
    const { text, sources } = await generateText({
        model: xai.responses(model),
        prompt,
        tools: {
            x_search: xai.tools.xSearch(),
        },
        toolChoice: 'required',
    });

    const safeSources = sources ?? [];

    // 2. 准备输出目录
    await mkdir(outputDir, { recursive: true });

    // 3. 生成唯一文件名
    const ts = Date.now();
    const textPath = join(outputDir, timestampedName(filePrefix, 'md', ts));
    const jsonPath = join(outputDir, `${filePrefix}-${ts}.json`);
    const mdPath = join(outputDir, `${filePrefix}-citations-${ts}.md`);

    // 4. 写文件
    await writeFile(textPath, text, 'utf-8');
    log(`✅ 输出成功！文件已保存为: ${textPath}`);

    await writeFile(jsonPath, JSON.stringify(safeSources, null, 2), 'utf-8');
    log(`✅ 文件已保存: ${jsonPath}`);

    const citationsMd = renderCitationsMarkdown(safeSources);
    await writeFile(mdPath, citationsMd, 'utf-8');
    log(`✅ 文件已保存: ${mdPath}`);

    return {
        text,
        sources: safeSources,
        files: {
            text: textPath,
            citationsJson: jsonPath,
            citationsMd: mdPath,
        },
    };
}
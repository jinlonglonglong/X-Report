// reportGenerator.ts
import fs from 'node:fs/promises';
import OpenAI from 'openai';

/** ========== 类型定义 ========== */

export interface ReportGeneratorOptions {
  /** OpenAI 兼容客户端配置 */
  client: {
    apiKey: string;
    baseURL: string;
  };
  /** 使用的模型，默认 gpt-6-astra */
  model?: string;

  /** 单批最大字符数，默认 40000 */
  maxChars?: number;

  /** 切分时是否尽量在换行处切（避免把帖子劈成两半），默认 true */
  splitOnNewline?: boolean;

  /** 单批摘要温度，默认 0.2 */
  summaryTemperature?: number;
  /** 最终报告温度，默认 0.3 */
  reportTemperature?: number;

  /** 报告标题，默认《加密货币与 Web3 领域报告》 */
  reportTitle?: string;
  /** 报告的领域描述，默认"加密货币与 Web3" */
  domain?: string;

  /** 是否打印日志，默认 true */
  verbose?: boolean;

  /**
   * 自定义单批摘要的 system prompt。
   * 不传则使用默认的「加密货币与 Web3 研究员」角色。
   */
  summarySystemPrompt?: string;

  /**
   * 自定义单批摘要的 user prompt 构造器。
   * 不传则使用默认模板。receives: { chunk, index, total }
   */
  buildSummaryUserPrompt?: (args: {
    chunk: string;
    index: number;
    total: number;
  }) => string;

  /**
   * 自定义最终报告的 system prompt。
   * 不传则使用默认的「资深加密货币与 Web3 分析师」角色。
   */
  reportSystemPrompt?: string;

  /**
   * 自定义最终报告 user prompt 构造器。
   * 不传则使用默认模板。
   */
  buildReportUserPrompt?: (args: {
    summaries: string[];
    totalChunks: number;
  }) => string;
}

export interface GenerateReportResult {
  /** 最终报告 Markdown */
  report: string;
  /** 每批的摘要 */
  summaries: string[];
  /** 切分后的原文块（可用于调试） */
  chunks: string[];
  /** 统计信息 */
  stats: {
    rawChars: number;
    chunkCount: number;
    maxChars: number;
  };
}

/** ========== 工具函数 ========== */

/**
 * 按字符数切分原始文本，不改内容，只切分。
 * 尽量切在换行处，避免把一条帖子劈成两半。
 */
export function splitRaw(
  text: string,
  maxChars = 40000,
  splitOnNewline = true,
): string[] {
  const chunks: string[] = [];
  let i = 0;

  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);

    if (splitOnNewline && end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      // 只有换行位置足够靠后（超过半批），才用它作为切点
      if (nl > i + maxChars * 0.5) end = nl;
    }

    chunks.push(text.slice(i, end));
    i = end;
  }

  return chunks;
}

/** 默认：单批摘要 system prompt */
function defaultSummarySystem(domain: string): string {
  return `你是${domain}研究员。用户会给你一段从 X 平台导出的原始文本，格式可能不统一，里面包含账号、帖子内容、链接等。请你自行识别每条帖子，并严格依据原文归纳，不得编造未出现的事实。信息不足就写"信息不足"。输出中文。`;
}

/** 默认：单批摘要 user prompt */
function defaultSummaryUser(args: {
  chunk: string;
  index: number;
  total: number;
  domain: string;
}): string {
  const { chunk, index, total, domain } = args;
  return `这是第 ${index + 1}/${total} 批原始 X 帖子文本。请先自行解析出每条帖子的「账号 / 内容 / 链接」，然后按以下结构提炼：

1) 本批核心观点
2) 涉及项目 / 代币 / 协议
3) 所属赛道或叙事（L2、DeFi、AI+Crypto、RWA、Meme、Restaking、DePIN、稳定币等）
4) 关键数据（TVL、融资额、价格、用户数等，若原文有）
5) 风险、争议或反方观点
6) 值得引用的原帖（账号 + 链接）

用 Markdown 输出。

=== 原始文本开始 ===
${chunk}
=== 原始文本结束 ===`;
}

/** 默认：最终报告 system prompt */
function defaultReportSystem(domain: string): string {
  return `你是资深${domain}分析师。根据提供的分批摘要撰写结构化报告，不得编造未提供的事实。引用来源使用 Markdown 链接。输出中文。`;
}

/** 默认：最终报告 user prompt */
function defaultReportUser(args: {
  summaries: string[];
  totalChunks: number;
  reportTitle: string;
  domain: string;
}): string {
  const { summaries, totalChunks, reportTitle, domain } = args;
  const summaryText = summaries
    .map((s, i) => `## 批次 ${i + 1}\n${s}`)
    .join('\n\n');

  return `请生成一份《${reportTitle}》，共分 ${totalChunks} 批原始帖子。结构如下：

# ${reportTitle}
- 生成日期
- 数据来源说明（基于 X 帖子整理）
- 免责声明（非投资建议）

## 一、执行摘要
## 二、市场与宏观概况
## 三、主要叙事与赛道
（按出现频次和重要性组织）
## 四、重点提及的项目与账号
## 五、监管、安全与风险
## 六、社区情绪与争议点
## 七、结论与值得关注的观察指标
## 附录 A：原始帖子清单（账号 + 链接）

以下是分批摘要：
${summaryText}`;
}

/** ========== 核心步骤（可单独调用）========== */

/**
 * 对单个文本块做摘要。
 */
export async function summarizeChunk(
  client: OpenAI,
  chunk: string,
  index: number,
  total: number,
  opts: {
    model: string;
    temperature: number;
    domain: string;
    systemPrompt?: string;
    userPromptBuilder?: (args: {
      chunk: string;
      index: number;
      total: number;
    }) => string;
  },
): Promise<string> {
  const {
    model,
    temperature,
    domain,
    systemPrompt,
    userPromptBuilder,
  } = opts;

  const userContent = userPromptBuilder
    ? userPromptBuilder({ chunk, index, total })
    : defaultSummaryUser({ chunk, index, total, domain });

  const resp = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      {
        role: 'system',
        content: systemPrompt ?? defaultSummarySystem(domain),
      },
      { role: 'user', content: userContent },
    ],
  });

  return resp.choices[0]?.message?.content || '';
}

/**
 * 根据分批摘要生成最终报告。
 */
export async function buildFinalReport(
  client: OpenAI,
  summaries: string[],
  totalChunks: number,
  opts: {
    model: string;
    temperature: number;
    reportTitle: string;
    domain: string;
    systemPrompt?: string;
    userPromptBuilder?: (args: {
      summaries: string[];
      totalChunks: number;
    }) => string;
  },
): Promise<string> {
  const {
    model,
    temperature,
    reportTitle,
    domain,
    systemPrompt,
    userPromptBuilder,
  } = opts;

  const userContent = userPromptBuilder
    ? userPromptBuilder({ summaries, totalChunks })
    : defaultReportUser({ summaries, totalChunks, reportTitle, domain });

  const resp = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      {
        role: 'system',
        content: systemPrompt ?? defaultReportSystem(domain),
      },
      { role: 'user', content: userContent },
    ],
  });

  return resp.choices[0]?.message?.content || '';
}

/** ========== 主方法 ========== */

/**
 * 从原始文本生成结构化报告（分批摘要 + 最终汇总）。
 */
export async function generateReportFromRawText(
  raw: string,
  opts: ReportGeneratorOptions,
): Promise<GenerateReportResult> {
  const {
    client: clientCfg,
    model = 'gpt-6-astra',
    maxChars = 40000,
    splitOnNewline = true,
    summaryTemperature = 0.2,
    reportTemperature = 0.3,
    reportTitle = '加密货币与 Web3 领域报告',
    domain = '加密货币与 Web3',
    verbose = true,
    summarySystemPrompt,
    buildSummaryUserPrompt,
    reportSystemPrompt,
    buildReportUserPrompt,
  } = opts;

  const log = (...args: unknown[]) => {
    if (verbose) console.log(...args);
  };

  const client = new OpenAI({
    apiKey: clientCfg.apiKey,
    baseURL: clientCfg.baseURL,
  });

  log(`原始文本字符数：${raw.length}`);

  const chunks = splitRaw(raw, maxChars, splitOnNewline);
  log(`切分为 ${chunks.length} 批，每批上限 ${maxChars} 字符`);

  const summaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    log(`处理第 ${i + 1}/${chunks.length} 批（${chunks[i].length} 字符）……`);
    summaries.push(
      await summarizeChunk(client, chunks[i], i, chunks.length, {
        model,
        temperature: summaryTemperature,
        domain,
        systemPrompt: summarySystemPrompt,
        userPromptBuilder: buildSummaryUserPrompt,
      }),
    );
  }

  log('生成最终报告……');
  const report = await buildFinalReport(client, summaries, chunks.length, {
    model,
    temperature: reportTemperature,
    reportTitle,
    domain,
    systemPrompt: reportSystemPrompt,
    userPromptBuilder: buildReportUserPrompt,
  });

  return {
    report,
    summaries,
    chunks,
    stats: {
      rawChars: raw.length,
      chunkCount: chunks.length,
      maxChars,
    },
  };
}

/** ========== 文件入口便捷函数 ========== */

/**
 * 从文件读取原始文本，生成报告并写入目标文件。
 */
export async function generateReportFromFile(
  inputPath: string,
  outputPath: string,
  opts: ReportGeneratorOptions,
): Promise<GenerateReportResult & { outputPath: string }> {
  const raw = await fs.readFile(inputPath, 'utf8');
  const result = await generateReportFromRawText(raw, opts);
  await fs.writeFile(outputPath, result.report, 'utf8');
  if (opts.verbose !== false) {
    console.log(`报告已写入：${outputPath}`);
  }
  return { ...result, outputPath };
}
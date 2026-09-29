// reportGenerator.ts
import fs from 'node:fs/promises';
import OpenAI from 'openai';

/** ========== 类型定义 ========== */

/**
 * 提示词预设：一种「分析类型」对应一整套完整的提示词模板。
 * 内置了 crypto / academic / news / meeting 四种；
 * 也可以通过 registerPromptPreset 注册自定义类型。
 */
export interface PromptPreset {
  /** 预设标识，用作 analysisType */
  name: string;
  /** 预设说明，便于 listPromptPresets 展示 */
  description?: string;

  /** 该分析类型的默认报告标题 */
  reportTitle: string;
  /** 该分析类型的默认领域描述 */
  domain: string;

  /** 单批摘要的 system prompt */
  summarySystemPrompt: string;
  /** 单批摘要的 user prompt 构造器 */
  buildSummaryUserPrompt: (args: {
    chunk: string;
    index: number;
    total: number;
    domain: string;
  }) => string;

  /** 最终报告的 system prompt */
  reportSystemPrompt: string;
  /** 最终报告的 user prompt 构造器 */
  buildReportUserPrompt: (args: {
    summaries: string[];
    totalChunks: number;
    reportTitle: string;
    domain: string;
  }) => string;
}

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

  /**
   * 分析类型：内置或已注册的预设名。
   * 内置：'crypto' | 'academic' | 'news' | 'meeting'
   * 默认 'crypto'
   */
  analysisType?: string;

  /**
   * 直接传入自定义预设对象。
   * 优先级高于 analysisType（两者同时提供时以 preset 为准）。
   */
  preset?: PromptPreset;

  /** 覆盖预设中的报告标题 */
  reportTitle?: string;
  /** 覆盖预设中的领域描述 */
  domain?: string;

  /** 是否打印日志，默认 true */
  verbose?: boolean;

  /* ---- 以下四项用于在预设之上做「按次覆盖」，不传则用预设里的值 ---- */

  /** 覆盖单批摘要的 system prompt */
  summarySystemPrompt?: string;
  /** 覆盖单批摘要的 user prompt 构造器 */
  buildSummaryUserPrompt?: (args: {
    chunk: string;
    index: number;
    total: number;
    domain: string;
  }) => string;

  /** 覆盖最终报告的 system prompt */
  reportSystemPrompt?: string;
  /** 覆盖最终报告的 user prompt 构造器 */
  buildReportUserPrompt?: (args: {
    summaries: string[];
    totalChunks: number;
    reportTitle: string;
    domain: string;
  }) => string;
}

export interface GenerateReportResult {
  /** 最终报告 Markdown */
  report: string;
  /** 每批的摘要 */
  summaries: string[];
  /** 切分后的原文块（可用于调试） */
  chunks: string[];
  /** 实际使用的分析类型 */
  analysisType: string;
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

/** ========== 提示词预设注册表 ========== */

/** 默认分析类型 */
export const DEFAULT_ANALYSIS_TYPE = 'crypto';

const presetRegistry = new Map<string, PromptPreset>();

/**
 * 注册一个提示词预设（自定义分析类型）。
 * @param preset 预设对象
 * @param overwrite 同名预设是否覆盖，默认 true
 */
export function registerPromptPreset(
  preset: PromptPreset,
  overwrite = true,
): void {
  if (!overwrite && presetRegistry.has(preset.name)) {
    throw new Error(`提示词预设已存在：${preset.name}`);
  }
  presetRegistry.set(preset.name, preset);
}

/** 获取指定分析类型的预设，不存在则抛错 */
export function getPromptPreset(name: string): PromptPreset {
  const preset = presetRegistry.get(name);
  if (!preset) {
    const available = [...presetRegistry.keys()].join(', ');
    throw new Error(
      `未找到分析类型「${name}」。可用类型：${available}。` +
        `可通过 registerPromptPreset() 注册自定义类型。`,
    );
  }
  return preset;
}

/** 列出已注册的分析类型 */
export function listPromptPresets(): Array<{
  name: string;
  description?: string;
  reportTitle: string;
  domain: string;
}> {
  return [...presetRegistry.values()].map(
    ({ name, description, reportTitle, domain }) => ({
      name,
      description,
      reportTitle,
      domain,
    }),
  );
}

/* ---------- 内置预设 ---------- */

/** 内置：加密货币与 Web3（默认） */
const cryptoPreset: PromptPreset = {
  name: 'crypto',
  description: '加密货币与 Web3 领域（X 帖子 / 社区讨论）',
  reportTitle: '加密货币与 Web3 领域报告',
  domain: '加密货币与 Web3',

  summarySystemPrompt:
    '你是加密货币与 Web3 研究员。用户会给你一段从 X 平台导出的原始文本，格式可能不统一，里面包含账号、帖子内容、链接等。请你自行识别每条帖子，并严格依据原文归纳，不得编造未出现的事实。信息不足就写"信息不足"。输出中文。',

  buildSummaryUserPrompt: ({ chunk, index, total }) =>
    `这是第 ${index + 1}/${total} 批原始 X 帖子文本。请先自行解析出每条帖子的「账号 / 内容 / 链接」，然后按以下结构提炼：

1) 本批核心观点
2) 涉及项目 / 代币 / 协议
3) 所属赛道或叙事（L2、DeFi、AI+Crypto、RWA、Meme、Restaking、DePIN、稳定币等）
4) 关键数据（TVL、融资额、价格、用户数等，若原文有）
5) 风险、争议或反方观点
6) 值得引用的原帖（账号 + 链接）

用 Markdown 输出。

=== 原始文本开始 ===
${chunk}
=== 原始文本结束 ===`,

  reportSystemPrompt:
    '你是资深加密货币与 Web3 分析师。根据提供的分批摘要撰写结构化报告，不得编造未提供的事实。引用来源使用 Markdown 链接。输出中文。',

  buildReportUserPrompt: ({ summaries, totalChunks, reportTitle }) => {
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
  },
};

/** 内置：学术论文 / 文献综述 */
const academicPreset: PromptPreset = {
  name: 'academic',
  description: '学术论文 / 文献综述',
  reportTitle: '文献综述报告',
  domain: '学术研究',

  summarySystemPrompt:
    '你是学术研究助理。用户会给你一段论文原文或文献片段，可能包含标题、作者、摘要、正文、参考文献等。请严格依据原文归纳，不得编造未出现的数据、结论或引用。信息不足就写"信息不足"。输出中文。',

  buildSummaryUserPrompt: ({ chunk, index, total }) =>
    `这是第 ${index + 1}/${total} 批文献文本。请按以下结构提炼：

1) 研究问题与背景
2) 研究方法（数据、模型、实验设计）
3) 主要结论与支撑证据
4) 关键数据 / 指标（若原文有）
5) 局限性、争议与未解决问题
6) 值得引用的原文片段（含出处，若有）

用 Markdown 输出。

=== 原始文本开始 ===
${chunk}
=== 原始文本结束 ===`,

  reportSystemPrompt:
    '你是资深学术综述撰写者。根据提供的分批摘要撰写结构化综述，不得编造未提供的事实。引用来源使用 Markdown 链接或文献标注。输出中文。',

  buildReportUserPrompt: ({ summaries, totalChunks, reportTitle }) => {
    const summaryText = summaries
      .map((s, i) => `## 批次 ${i + 1}\n${s}`)
      .join('\n\n');

    return `请生成一份《${reportTitle}》，共分 ${totalChunks} 批文献摘要。结构如下：

# ${reportTitle}
- 生成日期
- 检索 / 数据来源说明
- 免责声明（仅作研究梳理，不代表原文献立场）

## 一、摘要
## 二、研究背景与问题
## 三、研究方法对比
## 四、主要发现与共识
## 五、分歧、争议与局限
## 六、研究空白与未来方向
## 附录 A：文献清单（标题 / 作者 / 链接）

以下是分批摘要：
${summaryText}`;
  },
};

/** 内置：新闻资讯汇总 */
const newsPreset: PromptPreset = {
  name: 'news',
  description: '新闻资讯 / 时事热点汇总',
  reportTitle: '资讯汇总报告',
  domain: '新闻资讯',

  summarySystemPrompt:
    '你是资深新闻编辑。用户会给你一段新闻原文或多条资讯的合集，格式可能不统一。请严格依据原文归纳，不得编造未出现的事实、数据或引述。信息不足就写"信息不足"。输出中文。',

  buildSummaryUserPrompt: ({ chunk, index, total }) =>
    `这是第 ${index + 1}/${total} 批新闻文本。请按以下结构提炼：

1) 本批核心事件（谁、何时、何地、何事、为何）
2) 涉及的主体 / 机构 / 地区
3) 关键数据与时间线（若原文有）
4) 背景与影响面
5) 争议点与不同信源说法
6) 值得引用的原文片段（含出处，若有）

用 Markdown 输出。

=== 原始文本开始 ===
${chunk}
=== 原始文本结束 ===`,

  reportSystemPrompt:
    '你是资深新闻主编。根据提供的分批摘要撰写结构化资讯汇总报告，不得编造未提供的事实。引用来源使用 Markdown 链接。输出中文。',

  buildReportUserPrompt: ({ summaries, totalChunks, reportTitle }) => {
    const summaryText = summaries
      .map((s, i) => `## 批次 ${i + 1}\n${s}`)
      .join('\n\n');

    return `请生成一份《${reportTitle}》，共分 ${totalChunks} 批原始资讯。结构如下：

# ${reportTitle}
- 生成日期
- 数据来源说明
- 免责声明（仅作信息整理）

## 一、要闻速览
## 二、分领域动态（政治 / 经济 / 科技 / 社会等，按实际内容取舍）
## 三、事件时间线
## 四、关键数据一览
## 五、不同信源与争议点
## 六、后续值得关注的看点
## 附录 A：原始资讯清单（来源 + 链接）

以下是分批摘要：
${summaryText}`;
  },
};

/** 内置：会议 / 访谈纪要 */
const meetingPreset: PromptPreset = {
  name: 'meeting',
  description: '会议记录 / 访谈纪要整理',
  reportTitle: '会议纪要',
  domain: '会议记录',

  summarySystemPrompt:
    '你是专业的会议记录整理者。用户会给你一段会议转写文本或访谈记录，可能包含口语、语气词、错别字。请严格依据原文归纳，不得编造未出现的发言或结论。信息不足就写"信息不足"。输出中文。',

  buildSummaryUserPrompt: ({ chunk, index, total }) =>
    `这是第 ${index + 1}/${total} 批会议 / 访谈文本。请按以下结构提炼：

1) 本批讨论的主要议题
2) 各方观点与发言人（若原文能识别）
3) 已达成的结论 / 决议
4) 待办事项与负责人、时间点（若原文有）
5) 分歧、风险与未决问题
6) 值得引用的原话（含发言人）

用 Markdown 输出。

=== 原始文本开始 ===
${chunk}
=== 原始文本结束 ===`,

  reportSystemPrompt:
    '你是资深会议纪要撰写者。根据提供的分批摘要撰写结构化会议纪要，不得编造未提供的发言或结论。输出中文。',

  buildReportUserPrompt: ({ summaries, totalChunks, reportTitle }) => {
    const summaryText = summaries
      .map((s, i) => `## 批次 ${i + 1}\n${s}`)
      .join('\n\n');

    return `请生成一份《${reportTitle}》，共分 ${totalChunks} 批原始记录。结构如下：

# ${reportTitle}
- 生成日期
- 记录来源说明
- 免责声明（基于转写文本整理，可能存在识别误差）

## 一、会议概览（主题 / 时间 / 参与方）
## 二、议题与讨论要点
## 三、结论与决议
## 四、待办事项（负责人 / 截止时间）
## 五、分歧与待决问题
## 六、附录：关键原话摘录

以下是分批摘要：
${summaryText}`;
  },
};

// 注册内置预设
[cryptoPreset, academicPreset, newsPreset, meetingPreset].forEach((p) =>
  registerPromptPreset(p),
);

/** ========== 核心步骤（可单独调用）========== */

export interface SummarizeChunkOptions {
  model: string;
  temperature: number;
  /** 分析类型预设，默认使用内置 crypto 预设 */
  preset?: PromptPreset;
  /** 覆盖预设中的领域描述 */
  domain?: string;
  /** 覆盖预设中的 system prompt */
  systemPrompt?: string;
  /** 覆盖预设中的 user prompt 构造器 */
  userPromptBuilder?: (args: {
    chunk: string;
    index: number;
    total: number;
    domain: string;
  }) => string;
}

/**
 * 对单个文本块做摘要。
 */
export async function summarizeChunk(
  client: OpenAI,
  chunk: string,
  index: number,
  total: number,
  opts: SummarizeChunkOptions,
): Promise<string> {
  const preset = opts.preset ?? getPromptPreset(DEFAULT_ANALYSIS_TYPE);
  const domain = opts.domain ?? preset.domain;
  const systemPrompt = opts.systemPrompt ?? preset.summarySystemPrompt;
  const buildUser = opts.userPromptBuilder ?? preset.buildSummaryUserPrompt;

  const userContent = buildUser({ chunk, index, total, domain });

  const resp = await client.chat.completions.create({
    model: opts.model,
    temperature: opts.temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return resp.choices[0]?.message?.content || '';
}

export interface BuildFinalReportOptions {
  model: string;
  temperature: number;
  /** 分析类型预设，默认使用内置 crypto 预设 */
  preset?: PromptPreset;
  /** 覆盖预设中的报告标题 */
  reportTitle?: string;
  /** 覆盖预设中的领域描述 */
  domain?: string;
  /** 覆盖预设中的 system prompt */
  systemPrompt?: string;
  /** 覆盖预设中的 user prompt 构造器 */
  userPromptBuilder?: (args: {
    summaries: string[];
    totalChunks: number;
    reportTitle: string;
    domain: string;
  }) => string;
}

/**
 * 根据分批摘要生成最终报告。
 */
export async function buildFinalReport(
  client: OpenAI,
  summaries: string[],
  totalChunks: number,
  opts: BuildFinalReportOptions,
): Promise<string> {
  const preset = opts.preset ?? getPromptPreset(DEFAULT_ANALYSIS_TYPE);
  const domain = opts.domain ?? preset.domain;
  const reportTitle = opts.reportTitle ?? preset.reportTitle;
  const systemPrompt = opts.systemPrompt ?? preset.reportSystemPrompt;
  const buildUser = opts.userPromptBuilder ?? preset.buildReportUserPrompt;

  const userContent = buildUser({
    summaries,
    totalChunks,
    reportTitle,
    domain,
  });

  const resp = await client.chat.completions.create({
    model: opts.model,
    temperature: opts.temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return resp.choices[0]?.message?.content || '';
}

/** ========== 主方法 ========== */

/**
 * 从原始文本生成结构化报告（分批摘要 + 最终汇总）。
 *
 * 提示词来源优先级（由高到低）：
 *   opts.summarySystemPrompt / opts.buildSummaryUserPrompt 等单次覆盖
 *   → opts.preset 自定义预设
 *   → opts.analysisType 指定的已注册预设
 *   → 内置默认（crypto）
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
    verbose = true,
    analysisType = DEFAULT_ANALYSIS_TYPE,
    preset: customPreset,
    reportTitle: reportTitleOverride,
    domain: domainOverride,
    summarySystemPrompt,
    buildSummaryUserPrompt,
    reportSystemPrompt,
    buildReportUserPrompt,
  } = opts;

  const log = (...args: unknown[]) => {
    if (verbose) console.log(...args);
  };

  // 1) 确定使用的提示词预设
  const preset = customPreset ?? getPromptPreset(analysisType);

  // 2) 解析标题 / 领域 / 各项提示词（单次覆盖优先）
  const domain = domainOverride ?? preset.domain;
  const reportTitle = reportTitleOverride ?? preset.reportTitle;
  const resolvedSummarySystem = summarySystemPrompt ?? preset.summarySystemPrompt;
  const resolvedSummaryUserBuilder =
    buildSummaryUserPrompt ?? preset.buildSummaryUserPrompt;
  const resolvedReportSystem = reportSystemPrompt ?? preset.reportSystemPrompt;
  const resolvedReportUserBuilder =
    buildReportUserPrompt ?? preset.buildReportUserPrompt;

  const client = new OpenAI({
    apiKey: clientCfg.apiKey,
    baseURL: clientCfg.baseURL,
  });

  log(
    `分析类型：${preset.name}${customPreset ? '（自定义预设）' : ''}` +
      `${preset.description ? ` — ${preset.description}` : ''}`,
  );
  log(`报告标题：${reportTitle}`);
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
        preset,
        domain,
        systemPrompt: resolvedSummarySystem,
        userPromptBuilder: resolvedSummaryUserBuilder,
      }),
    );
  }

  log('生成最终报告……');
  const report = await buildFinalReport(client, summaries, chunks.length, {
    model,
    temperature: reportTemperature,
    preset,
    domain,
    reportTitle,
    systemPrompt: resolvedReportSystem,
    userPromptBuilder: resolvedReportUserBuilder,
  });

  return {
    report,
    summaries,
    chunks,
    analysisType: preset.name,
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
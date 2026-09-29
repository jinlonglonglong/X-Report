// xBatchQuery.ts
import { createXai } from '@ai-sdk/xai';
import { generateText } from 'ai';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** ========== 类型定义 ========== */

export interface BatchQueryOptions {
  /** 要查询的账号列表（不带 @） */
  handles: string[];
  /** 起始日期 YYYY-MM-DD */
  fromDate: string;
  /** 结束日期 YYYY-MM-DD */
  toDate: string;

  /** 单批最多几个账号，默认 10 */
  batchSize?: number;
  /** 批次间隔毫秒，默认 2000 */
  batchDelayMs?: number;
  /** 模型，默认 grok-4.6 */
  model?: string;

  /** xAI 配置。如果不传，则读取环境变量 XAI_API_KEY */
  xaiOptions?: {
    apiKey?: string;
    baseURL?: string;
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
  /** 合并后的完整 Markdown 正文 */
  mergedText: string;
  /** 去重后的所有引用 */
  sources: unknown[];
  /** 失败的批次，方便重跑 */
  failedBatches: BatchFailure[];
  /** 统计信息 */
  stats: {
    totalHandles: number;
    totalBatches: number;
    successBatches: number;
    failedBatches: number;
    totalSources: number;
  };
  /** 落盘后的文件路径（persist=false 时为 null） */
  files: {
    text: string;
    citationsJson: string;
    citationsMd: string;
    failures: string;
  } | null;
}

/** ========== 工具函数 ========== */

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** 把 sources 渲染成人类可读的 Markdown */
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

/** 生成 prompts（可单独导出，方便测试） */
export function buildBatchPrompt(
  handles: string[],
  fromDate: string,
  toDate: string,
): string {
  const handlesText = handles.map((h) => '@' + h).join('、');
  return `请使用 x_search 工具，查询以下账号在 ${fromDate} 到 ${toDate} 期间发布的所有帖子：

${handlesText}

要求：
1. 必须调用 x_search 工具进行搜索
2. 搜索账号在 x_search 工具中指定时间范围内所有的帖子，不要只搜索10条帖子，必须搜索完整的内容
3. 按账号分组整理结果
4. 每条帖子需要包含：完整内容、发布时间、点赞数、转发数、回复数、浏览量、原帖链接
5. 如果某个账号在此期间没有发帖，请明确说明
6. 禁止回复"请提供账号"或"信息不足"，直接根据工具返回结果输出`;
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

/** ========== 主方法 ========== */

/**
 * 批量查询 X 账号在指定时间范围内发布的帖子。
 * 自动分片、批间节流、失败捕获、引用去重、结果落盘。
 */
export async function batchQueryXPosts(
  opts: BatchQueryOptions,
): Promise<BatchQueryResult> {
  const {
    handles,
    fromDate,
    toDate,
    batchSize = 10,
    batchDelayMs = 2000,
    model = 'grok-4.6',
    xaiOptions,
    outputDir = '.',
    filePrefix = 'x-batch',
    persist = true,
    verbose = true,
  } = opts;

  if (!handles?.length) {
    throw new Error('handles 不能为空');
  }

  const log = (...args: unknown[]) => {
    if (verbose) console.log(...args);
  };
  const xai = createXaiClient(xaiOptions);

  const batches = chunkArray(handles, batchSize);
  log(
    `共 ${handles.length} 个账号，拆分为 ${batches.length} 批，每批最多 ${batchSize} 个`,
  );

  const allTexts: string[] = [];
  const allSources: unknown[] = [];
  const seenSourceKeys = new Set<string>();
  const failedBatches: BatchFailure[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const handlesText = batch.map((h) => '@' + h).join('、');
    const batchLabel = `批次 ${i + 1}/${batches.length}`;

    log(`▶ ${batchLabel} 开始查询：${batch.join(', ')}`);

    try {
      const { text, sources } = await generateText({
        model: xai.responses(model),
        prompt: buildBatchPrompt(batch, fromDate, toDate),
        tools: {
          x_search: xai.tools.xSearch({
            allowedXHandles: batch,
            fromDate,
            toDate,
            enableImageUnderstanding: true,
          }),
        },
        toolChoice: 'required',
      });

      allTexts.push(
        `\n\n---\n\n## ${batchLabel}（共 ${batch.length} 个账号）\n\n` +
          `> 账号：${handlesText}\n\n` +
          (text ?? '(无返回内容)'),
      );

      const safeSources = (sources ?? []) as Array<{
        sourceType?: string;
        url?: string;
        filename?: string;
        title?: string;
      }>;
      for (const s of safeSources) {
        const key =
          s.sourceType === 'url' ? s.url : s.filename || s.title;
        if (key) {
          if (seenSourceKeys.has(key)) continue;
          seenSourceKeys.add(key);
        }
        allSources.push(s);
      }

      log(
        `✅ ${batchLabel} 完成，文本 ${text?.length ?? 0} 字，引用 ${safeSources.length} 条`,
      );
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      console.error(`❌ ${batchLabel} 失败：`, err);
      failedBatches.push({
        batchIndex: i + 1,
        handles: batch,
        error: msg,
      });
      allTexts.push(
        `\n\n---\n\n## ${batchLabel}（共 ${batch.length} 个账号）\n\n` +
          `> 账号：${handlesText}\n\n` +
          `> ⚠️ 该批次查询失败：${msg}\n`,
      );
    }

    if (i < batches.length - 1) {
      await sleep(batchDelayMs);
    }
  }

  // 汇总
  const mergedText =
    `# X 账号帖子汇总（${fromDate} ~ ${toDate}）\n\n` +
    `- 账号总数：${handles.length}\n` +
    `- 批次数：${batches.length}（每批最多 ${batchSize} 个）\n` +
    `- 成功批次：${batches.length - failedBatches.length}\n` +
    `- 失败批次：${failedBatches.length}\n` +
    `- 引用总数：${allSources.length}\n` +
    allTexts.join('');

  const stats = {
    totalHandles: handles.length,
    totalBatches: batches.length,
    successBatches: batches.length - failedBatches.length,
    failedBatches: failedBatches.length,
    totalSources: allSources.length,
  };

  // 落盘
  let files: BatchQueryResult['files'] = null;
  if (persist) {
    await mkdir(outputDir, { recursive: true });
    const ts = Date.now();
    const textPath = join(outputDir, timestampedName(filePrefix, 'md', ts));
    const jsonPath = join(
      outputDir,
      `${filePrefix}-citations-${ts}.json`,
    );
    const mdPath = join(
      outputDir,
      `${filePrefix}-citations-${ts}.md`,
    );
    const failPath = join(
      outputDir,
      `${filePrefix}-failures-${ts}.json`,
    );

    await writeFile(textPath, mergedText, 'utf-8');
    await writeFile(jsonPath, JSON.stringify(allSources, null, 2), 'utf-8');
    await writeFile(mdPath, renderCitationsMarkdown(allSources), 'utf-8');
    await writeFile(
      failPath,
      JSON.stringify(failedBatches, null, 2),
      'utf-8',
    );

    log(`✅ 正文已保存: ${textPath}`);
    log(`✅ 引用 JSON 已保存: ${jsonPath}`);
    log(`✅ 引用 MD 已保存: ${mdPath}`);
    if (failedBatches.length) {
      console.warn(
        `⚠️ 有 ${failedBatches.length} 个批次失败，详见: ${failPath}`,
      );
    }

    files = {
      text: textPath,
      citationsJson: jsonPath,
      citationsMd: mdPath,
      failures: failPath,
    };
  }

  return {
    mergedText,
    sources: allSources,
    failedBatches,
    stats,
    files,
  };
}
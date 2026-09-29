import { generateText } from 'ai';
import { createXai } from '@ai-sdk/xai';

export interface SearchOptions {
    domain: string;
    keywords: string[];
    /** xAI 配置。如果不传，则读取环境变量 XAI_API_KEY */
    xaiOptions: {
        apiKey: string;
        baseURL: string;
        model: string;
    };
}

interface PromptParams {
  domain: string;
  keywords: string[];
  fromDate: string; // 格式：2026-09-22
  toDate: string;   // 格式：2026-09-22
}

export function buildDashboardPrompt({ domain, keywords, fromDate, toDate }: PromptParams): string {
  const keywordQuery = keywords.map(k => `"${k}"`).join(' OR ');
  const displayKeywords = keywords.join(', ');

  return `你是一名高级社交媒体情报分析师。你已经被提供了 x_search 工具。
请在 X 平台进行全网搜索，提取「${domain}」领域，时间范围从 ${fromDate} 到 ${toDate} 的关键动向。
请结合检索到的最新数据，进行聚合、统计和排名。

【核心分析指令】
1. 在 X 平台检索该领域在 ${fromDate} 到 ${toDate} 时间范围内的帖子。请尽可能多地检索，目标是获取全量帖子数据。
2. 基于工具返回的帖子数据，评估监控信号总量与高置信度信号，识别出该领域最具影响力的主流 KOL。
3. 展示全量检索到的符合条件的数据。若因输出长度限制无法一次性全部展示，请优先保留互动量最高的帖子，并在 JSON 的 meta 字段中标注实际检索到的总数量。
4. 提取这些 KOL 最核心的帖子，填入 signalArchive 字段。

【搜索关键词参考】：${keywordQuery}

【输出格式要求（极其重要）】
⚠️ 请仅输出纯 JSON 格式的数据，不要包含任何 Markdown 代码块（如 \`\`\`json 或 \`\`\`），不要包含任何解释性文字、前言或后记。输出必须能够直接被 JSON.parse() 解析。

请严格按照以下 JSON Schema 结构输出：

{
  "dashboardTitle": "Twitter 市场信号总览",
  "domain": "${domain}",
  "dateRange": {
    "fromDate": "${fromDate}",
    "toDate": "${toDate}"
  },
  "metrics": {
    "monitoringSignals": { "value": 1284, "change": "+12.8%", "label": "过去 24 小时" },
    "highConfidenceSignals": { "value": 342, "change": "+8.4%", "label": "置信度 ≥ 80%" },
    "trackedKeywords": { "value": 48, "change": "+3", "label": "覆盖 6 个领域" },
    "contentReach": { "value": "8.6M", "change": "+24.1%", "label": "预估总浏览量" }
  },
  "filterConditions": {
    "keywords": ${JSON.stringify(keywords)},
    "minConfidence": 80,
    "minFollowers": 1000
  },
  "sections": {
    "latestSignals": [
      {
        "author": "Arthur Hayes",
        "handle": "@CryptoHayes",
        "tag": "高影响",
        "summary": "比特币流动性周期正在转向，预计 Q4 将迎来新的风暴",
        "publishTime": "8分钟前",
        "confidence": "94%"
      }
    ],
    "trendingContent": [
      {
        "title": "以太坊 Pectra 升级将如何改变 L2 生态？",
        "heatIndex": 9.8,
        "author": "@CryptoDesk",
        "publishTime": "18分钟前"
      }
    ],
    "topKOLs": [
      {
        "avatar": "CZ",
        "name": "Changpeng Zhao",
        "handle": "@cz_binance",
        "influenceScore": 98.4
      }
    ]
  },
  "signalArchive": [
    {
      "user": "Changpeng Zhao",
      "handle": "@cz_binance",
      "topic": "${keywords[0] || 'meme'}",
      "content": "内容摘要示例",
      "comments": 184765,
      "likes": 2400,
      "confidence": "94.8%",
      "url": "https://x.com/cz_binance/status/..."
    }
  ],
  "meta": {
    "isTruncated": false,
    "totalCount": 100,
    "message": "实际检索到的帖子总数及展示状态说明"
  }
}

补充要求：
1. 原帖链接 (url) 必须为真实的 x.com 推文链接。
2. 严格按照上述 JSON 结构输出，不要增删任何字段。若某栏目没有数据，请返回空数组 []。`;
}

export function createXaiClient(opts: {
    apiKey: string;
    baseURL: string;
}) {
    const xai = createXai({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
    });
    return xai;
}

export async function fetchTwitterDashboard(options: SearchOptions) {
    const { domain, keywords, xaiOptions } = options;
    console.log('fetchTwitterDashboard called with:', { domain, keywords, xaiOptions });

    const xai = createXaiClient(xaiOptions);

    // 1. 动态计算时间范围（当前时间 往后推 24 小时）
    const now = new Date();
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // 严格格式化时间为 YYYY-MM-DD 格式（例如：2026-09-22）
    const formatDate = (date: Date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const fromDate = formatDate(now);      // 当前日期 2026-09-22
    const toDate = formatDate(future);     // 24小时后 2026-09-23



    // 2. 构造 Prompt
    const prompt = buildDashboardPrompt({ domain, keywords, fromDate, toDate });

    // 3. 调用 Grok + X Search 工具（全网搜索）
    try {
        const { text, sources } = await generateText({
            model: xai.responses('grok-4.7'),
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

        return {
            dashboardText: text,
            sourceTweets: sources,
            dateRange: { fromDate, toDate }
        };
    } catch (error) {
        console.error('X Search Dashboard generation failed:', error);
        throw new Error('生成市场信号总览失败，请检查 API 或稍后重试。');
    }
}
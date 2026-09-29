import { batchQueryXPosts } from '../xsearch/batchXPostSearch.ts';

export interface ReportRequest {
    field: string;
    keywords: string[];
    /** xAI 配置。如果不传，则读取环境变量 XAI_API_KEY */
    xaiOptions?: {
        apiKey?: string;
        baseURL?: string;
    };
}

export interface ReportResult {
    success: boolean
    field: string
    keywords: string[]
    report?: string
    createdAt: string
    error?: string
}

/* export async function generateReport(
    params: ReportRequest
): Promise<ReportResult> {
    const { field, keywords, xaiOptions } = params

    try {
        console.log(`[ReportService] 开始生成报告`)
        console.log(`field: ${field}`)
        console.log(`keywords: ${keywords.join(', ')}`)

        // 1. 参数检查
        if (!field) {
            throw new Error('field不能为空')
        }

        if (!keywords || keywords.length === 0) {
            throw new Error('keywords不能为空')
        }

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

        const result = await batchQueryXPosts({
            domain: field,
            keywords: keywords,
            fromDate: fromDate,
            toDate: toDate,
            xaiOptions: xaiOptions
        });

        // 3. 后续可以在这里保存数据库
        // await saveReport(...)

        // 4. 后续可以在这里生成文件
        // await saveReportFile(...)

        return {
            success: true,
            field,
            keywords,
            report,
            createdAt: new Date().toISOString()
        }
    } catch (error) {
        console.error('[ReportService] 生成报告失败:', error)

        return {
            success: false,
            field,
            keywords,
            createdAt: new Date().toISOString(),
            error: error instanceof Error
                ? error.message
                : String(error)
        }
    }
} */
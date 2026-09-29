import OpenAI from 'openai';
import type { Skill } from './skillLoader.ts';

export interface SkillRunOptions {
    model: string;
    temperature?: number;

    /** 共享参考 */
    sharedContext?: string;

    /** 用户追加内容 */
    appendix?: string;

    /**
     * markdown:
     *   只输出 Markdown
     *
     * json:
     *   只输出 JSON
     *
     * markdown_json:
     *   同时输出 Markdown + Structured JSON
     */
    outputMode?: 'markdown' | 'json' | 'markdown_json';

    /** 自定义 system 片段 */
    systemSuffix?: string;

    /**
     * Structured Outputs JSON Schema
     *
     * markdown_json 模式下，最终结构为：
     *
     * {
     *   markdown: string,
     *   data: ...
     * }
     */
    jsonSchema?: Record<string, any>;
}

export interface SkillRunResult<T = any> {
    output: T;
    raw: string;

    markdown?: string;
    data?: any;

    usage?: {
        promptTokens: number;
        completionTokens: number;
    };
}

function buildSystem(
    skill: Skill,
    opts: SkillRunOptions,
): string {
    const parts: string[] = [];

    parts.push(
        `# 技能：${skill.name}` +
        (skill.description ? `\n${skill.description}` : ''),
    );

    parts.push(`# 技能指令\n${skill.body}`);

    if (opts.sharedContext) {
        parts.push(
            `# 共享参考：分析量表（必须严格遵守）\n${opts.sharedContext}`,
        );
    }

    if (opts.systemSuffix) {
        parts.push(opts.systemSuffix);
    }

    return parts.join('\n\n---\n\n');
}


export async function runSkill(
    client: OpenAI,
    skill: Skill,
    userInput: string,
    opts: SkillRunOptions,
): Promise<SkillRunResult> {

    const system = buildSystem(skill, opts);

    const userParts: string[] = [userInput];

    if (opts.appendix) {
        userParts.push(opts.appendix);
    }

    /*
     * Markdown 模式
     */
    if (opts.outputMode === 'markdown') {
        userParts.push(`
请输出高质量 Markdown。

要求：
1. 使用 Markdown 标题、列表、表格等结构化表达。
2. 不要输出 JSON。
3. 不要使用 \`\`\`markdown 包裹整个结果。
4. 直接输出 Markdown 正文。
`);
    }

    /*
     * Markdown + Structured JSON
     */
    if (opts.outputMode === 'markdown_json') {
        userParts.push(`
请同时生成两个部分：

1. markdown
   - 用于最终展示给用户
   - 必须是高质量、完整、自然的 Markdown 报告
   - 可以使用标题、表格、列表、引用等 Markdown 语法
   - 不要为了适应 JSON 而降低 Markdown 内容质量

2. data
   - 用于程序内部处理
   - 必须严格按照提供的 JSON Schema 输出
   - data 中只能包含 Schema 允许的字段
   - 不要把 Markdown 放到 data 中

markdown 和 data 必须描述同一份分析结果。
`);
    }

    /*
     * JSON 模式
     */
    if (opts.outputMode === 'json') {
        userParts.push(`
请只输出符合 JSON Schema 的 JSON。
不要输出 Markdown。
不要输出解释性文字。
`);
    }


    /**
     * Structured Outputs 配置
     */
    let textConfig: any = undefined;

    if (
        opts.outputMode === 'markdown_json' &&
        opts.jsonSchema
    ) {
        textConfig = {
            format: {
                type: 'json_schema',
                name: 'skill_result',
                strict: true,
                schema: {
                    type: 'object',

                    properties: {
                        markdown: {
                            type: 'string',
                        },

                        data: opts.jsonSchema,
                    },

                    required: [
                        'markdown',
                        'data',
                    ],

                    additionalProperties: false,
                },
            },
        };
    }


    /**
     * 单纯 JSON 模式
     */
    if (
        opts.outputMode === 'json' &&
        opts.jsonSchema
    ) {
        textConfig = {
            format: {
                type: 'json_schema',
                name: 'skill_result',
                strict: true,
                schema: opts.jsonSchema,
            },
        };
    }


    /**
     * Responses API
     */
    const resp = await client.responses.create({
        model: opts.model,

        temperature: opts.temperature ?? 0.2,

        instructions: system,

        input: userParts.join('\n\n'),

        ...(textConfig
            ? {
                text: textConfig,
            }
            : {}),
    });


    /**
     * Responses API 最终文本
     */
    const raw = resp.output_text ?? '';


    let output: any = raw;

    let markdown: string | undefined;

    let data: any | undefined;


    /**
     * Markdown + JSON
     */
    if (opts.outputMode === 'markdown_json') {

        try {

            const parsed = JSON.parse(raw);

            markdown = parsed.markdown ?? '';

            data = parsed.data ?? {};

            output = parsed;

        } catch (err) {

            console.error(
                '[runSkill] Structured Output JSON 解析失败:',
                err,
            );

            console.error(
                '[runSkill] 原始输出:',
                raw,
            );

            throw new Error(
                'GPT Structured Output 解析失败',
            );
        }
    }


    /**
     * JSON
     */
    else if (opts.outputMode === 'json') {

        try {

            output = JSON.parse(raw);

        } catch (err) {

            console.error(
                '[runSkill] JSON 解析失败:',
                raw,
            );

            throw new Error(
                'GPT JSON 解析失败',
            );
        }
    }


    return {
        output,
        raw,

        markdown,

        data,

        usage: resp.usage
            ? {
                promptTokens: resp.usage.input_tokens,
                completionTokens: resp.usage.output_tokens,
            }
            : undefined,
    };
}
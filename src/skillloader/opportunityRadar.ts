// opportunityRadar.ts
import OpenAI from 'openai';
import { loadSkillsFromDir, type LoadedSkills, type Skill } from './skillLoader.ts';
import { runSkill, type SkillRunResult } from './skillRunner.ts';

/** ========== 类型 ========== */

export type AnalysisMode =
    | 'full'
    | 'trading'
    | 'product'
    | 'tool'
    | 'substitution';

const MODE_TO_SKILL: Record<Exclude<AnalysisMode, 'full'>, string> = {
    trading: 'trading-opportunity-finder',
    product: 'product-opportunity-finder',
    tool: 'tool-opportunity-finder',
    substitution: 'substitution-opportunity-finder',
};

const MAIN_SKILL = 'industry-opportunity-radar';
const RUBRIC_SKILL = 'analysis-rubric';

export interface OpportunityRadarOptions {
    client: { apiKey: string; baseURL: string };
    model?: string;
    /** skills 所在的目录 */
    skillsDir: string;
    /** 分析模式，默认 full */
    mode?: AnalysisMode;
    temperature?: number;
    verbose?: boolean;
}

export interface OpportunityRadarResult {
    mode: AnalysisMode;
    report: string;
    usedSkills: string[];
    usage?: { promptTokens: number; completionTokens: number };
}

/** ========== 主入口 ========== */

export async function runOpportunityRadar(
    rawInput: string,
    opts: OpportunityRadarOptions,
): Promise<OpportunityRadarResult> {
    const {
        client: clientCfg,
        model = 'gpt-6-astra',
        skillsDir,
        mode = 'full',
        temperature = 0.2,
        verbose = true,
    } = opts;

    const log = (...a: unknown[]) => verbose && console.log(...a);

    const client = new OpenAI({
        apiKey: clientCfg.apiKey,
        baseURL: clientCfg.baseURL,
    });

    const loaded = await loadSkillsFromDir(skillsDir);
    log(
        `已加载 ${loaded.byName.size} 个技能：` +
        [...loaded.byName.keys()].join(', '),
    );

    // 选择入口技能
    const mainSkillName =
        mode === 'full' ? MAIN_SKILL : MODE_TO_SKILL[mode];
    const mainSkill = loaded.byName.get(mainSkillName);
    if (!mainSkill) throw new Error(`未找到技能：${mainSkillName}`);

    // 收集该技能依赖的共享参考（rubric 等）
    const sharedContexts = collectSharedContext(mainSkill, loaded);
    const sharedContext = sharedContexts.map((s) => s.body).join('\n\n---\n\n');

    log(`模式：${mode}，使用技能：${mainSkill.name}`);

    // 执行
    const result: SkillRunResult = await runSkill(client, mainSkill, rawInput, {
        model,
        temperature,
        sharedContext,
        outputMode: 'markdown',
    });

    return {
        mode,
        report: result.output,
        usedSkills: [mainSkill.name, ...sharedContexts.map((s) => s.name)],
        usage: result.usage,
    };
}

/** ========== full 模式：4 子技能并行（可选） ========== */

export interface ParallelFindersResult {
    main: string;
    subtasks: Record<string, string>;
    usedSkills: string[];
}

/**
 * 完整扫描 + 4 路并行：
 *   主技能负责"整体结论 + 汇总"
 *   子技能各自独立产出自己领域的候选机会
 * 由调用方决定怎么合并（比如把 subtasks 再喂给主技能做二次汇总）。
 */
export async function runOpportunityRadarParallel(
    rawInput: string,
    opts: OpportunityRadarOptions,
): Promise<ParallelFindersResult> {
    const {
        client: clientCfg,
        model = 'gpt-6-astra',
        skillsDir,
        temperature = 0.2,
        verbose = true,
    } = opts;
    const log = (...a: unknown[]) => verbose && console.log(...a);

    const client = new OpenAI({
        apiKey: clientCfg.apiKey,
        baseURL: clientCfg.baseURL,
    });

    const loaded = await loadSkillsFromDir(skillsDir);
    const rubric = loaded.byName.get(RUBRIC_SKILL);
    const sharedContext = rubric?.body ?? '';

    const mainSkill = loaded.byName.get(MAIN_SKILL);
    if (!mainSkill) throw new Error(`未找到主技能：${MAIN_SKILL}`);

    // 4 路并行
    const subNames = Object.values(MODE_TO_SKILL);
    const subSkills = subNames
        .map((n) => loaded.byName.get(n))
        .filter((s): s is Skill => !!s);

    log(`并行执行：${subSkills.map((s) => s.name).join(', ')}`);

    const [mainResult, ...subResults] = await Promise.all([
        runSkill(client, mainSkill, rawInput, {
            model,
            temperature,
            sharedContext,
            outputMode: 'markdown_json',
        }),
        ...subSkills.map((skill) =>
            runSkill(client, skill, rawInput, {
                model,
                temperature,
                sharedContext,
                outputMode: 'markdown_json',
            }),
        ),
    ]);

    const subtasks: Record<string, string> = {};
    subSkills.forEach((skill, i) => {
        subtasks[skill.name] = subResults[i].output;
    });

    return {
        main: mainResult.output,
        subtasks,
        usedSkills: [mainSkill.name, ...subSkills.map((s) => s.name)],
    };
}

/** ========== 辅助 ========== */

function collectSharedContext(skill: Skill, loaded: LoadedSkills): Skill[] {
    const refs = loaded.references.get(skill.name) ?? [];
    // 目前只支持一层；如果需要递归展开可以扩展
    return refs;
}
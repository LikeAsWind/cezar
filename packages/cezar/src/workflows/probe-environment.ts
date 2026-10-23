import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDirectory } from '../runs/files.ts';
import { artifactPaths } from '../../scripts/workflow/artifacts.mjs';
import { validationPlan } from '../../scripts/workflow-action.mjs';

/** Validate without executing the plan. Reserve the single repair before calling the agent. */
export async function guardProbeEnvironment(
  dataDir: string, runId: string, cwd: string,
  repair: (prompt: string) => Promise<boolean>,
): Promise<string | undefined> {
  const directory = runDirectory(dataDir, runId);
  const validate = async () => {
    const file = artifactPaths(cwd, runId, directory).file('environment.json');
    await validationPlan(cwd, JSON.parse(await readFile(file, 'utf8')));
  };
  let failure: string;
  try { await validate(); return; }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  try {
    await writeFile(join(directory, 'probe-environment-repair.json'), JSON.stringify({ error: failure }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return `Probe environment remains invalid after its single repair attempt: ${failure}`;
    throw error;
  }
  const prompt = `宿主环境交接校验失败：\n${failure}\n\n复用已有调查结果，只补全本任务映射的探测产物，重点修正 environment.json。依据已确认的路径绑定工具链，不猜测 JDK，不修改业务代码，不运行构建、测试或安装。只有一次自动补全机会；完成后返回 CEZ:VERDICT ready，无法补全则返回 CEZ:VERDICT blocked。`;
  if (!await repair(prompt)) return `Probe environment repair did not return ready. Original validation error: ${failure}`;
  try { await validate(); }
  catch (error) { return `Probe environment remains invalid after its single repair attempt: ${error instanceof Error ? error.message : String(error)}`; }
}

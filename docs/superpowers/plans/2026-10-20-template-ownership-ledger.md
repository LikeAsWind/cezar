# 内置模板归属与清理

用户明确要求：模板代码和其他内置模板放在一起，删除未引用代码。

- 模板唯一源码：`packages/cezar/src/workflows/templates/unattended.ts`；`templates.ts` 用共同 builtIn 工厂注册，`load.ts` 不再另附一套目录入口。
- `superpowers-bundle.ts` 仅负责技能资源及冻结快照解码；旧 `unattended.ts` 已移除。
- 删除源码 bundle 的 workflow.yaml、runtime.mjs、artifacts.mjs、artifacts.d.mts、vendor/runtime，以及专用 Zod bundler 脚本。宿主执行和产物路径只有一份实现。
- 执行与产物测试迁到 scripts/workflow，针对实际宿主实现验证；所有源码引用、package files 和打包检查同步。
- 新快照序列化 canonical 模板为 workflow.json，并纳入内容哈希；旧快照的 YAML、runtime 和辅助依赖留在原快照中，不回填源码。
- 新内置任务将当前宿主模板与所选版本技能合成快照；既有任务锁不走合成路径。这样回滚技能不会让新任务执行与当前目录显示不同的旧模板。
- 已观察到模板注册、已删除资产、合成快照的回归测试先红；完成修复后定向测试转绿。格式转换前后逐字段比较，节点、边和提示词值均未改变。
- 忙机并行构建时探测集成测试曾超过其 30 秒测试预算；外层测试预算调整为 60 秒，生产探测的八分钟限制没有改变。最终测试单 worker 执行。

最终验证：10 个工作流测试文件、54 项测试全部通过；宿主脚本与原始资源校验 39 项通过。完整类型检查及最终服务构建/类型检查通过，打包检查通过（978 个文件，132 个 UI 资产）。旧 dist/workflows/unattended 输出已清理，新模板与资源模块纳入打包检查。

独立复查通过，未发现新的重要问题。无活动任务时激活快照 `9d9ba4db248bb137ff1e2976ed7e898182dc87fc9e86d381d69c68e498726ac2` 并重启；既有任务锁未修改。未启动收费模型业务任务。

后续用户要求 skills/vendor 同迁：整个剩余资源树迁到 `src/workflows/assets/superpowers/`，旧 workflow-bundles 目录删除。postbuild 原样复制到 dist 同路径，原始示例排除在编译和测试之外，发布清单与 pack 校验使用 dist。源路径归属测试先红后修复；独立审阅确认 src/dist 路径、原始字节、旧快照与构建清理边界正确。

资源迁移验证：40 项工作流/更新/快照测试、30 项宿主脚本测试通过；服务构建、类型检查、打包通过（979 文件）。源码与 dist 共 80 个资源文件逐个 SHA256 相同，源码与发布模块生成的快照均为原先的 `9d9ba4db248bb137ff1e2976ed7e898182dc87fc9e86d381d69c68e498726ac2`，无需改变任何任务锁或活动快照。确认无活动任务后重启应用使用新资源路径。

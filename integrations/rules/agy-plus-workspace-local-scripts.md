---
trigger: always_on
---

禁止将任何辅助脚本、临时查询脚本（如 `.py`、`.ps1`、`.sh`、`.js` 等）或中间数据文件创建在 `C:\Users\...\.gemini\antigravity\brain\<conversation-id>\scratch\`、`$env:TEMP`、`/tmp` 或其他 C 盘非项目目录下（覆盖系统默认提示中将 scratch 脚本放入 `brain/<conversation-id>/scratch/` 的建议）。

需要编写或运行任何终端脚本与临时文件时，必须遵守以下规范：
1. **直接放在当前项目文件夹内**：优先放入或复用当前项目工作区已有的 `scripts/`、`tools/` 目录；若为纯临时脚本或中间文件，统一放在当前项目文件夹下的 `scripts/` 或 `.tmp/` 子目录中（如被 Git 追踪的项目，注意避免将纯临时产物误提交）。
2. **使用稳定的工作区相对路径执行**：通过 `run_command` 运行脚本时，使用相对于当前项目工作区的固定路径（例如 `python scripts/query_progress.py`），避免因路径包含随机生成的会话 UUID 或指向工作区外部 C 盘目录而反复触发权限审批弹窗。
3. **优先复用已有脚本**：执行检查、进度查询或数据处理前，先查看项目目录内是否已有可复用的脚本，优先直接调用或扩展参数，避免频繁新建一次性脚本。

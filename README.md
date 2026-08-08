# zemu-python-check

Python 安全检查 + pyc 反编译查看器（VS Code 扩展）。

## Features

- **基础 python 下限版本扫描**：对打开的 Python 文件运行 vermin，检测代码所需的最低 Python 版本并给出提示。
- **pyc 反编译查看器**：双击 `.pyc` 文件（或在资源管理器右键 → "反编译为临时 py 并打开"）自动反编译为临时 `.py` 文件并打开，反编译结果可被其他 Python 插件正常分析。
  - 反编译工具链：`pylingual`（Python 3.6-3.14，优先）→ `uncompyle6`（≤3.8）→ `pycdc`（3.9-3.13），逐级自动回退。
  - 三个工具均失败时直接提示失败，不再生成 dis 反汇编。
  - 命令 "清理临时反编译文件"（`zemu.cleanupTmpPython`）可清除生成的临时文件。

## Requirements

- 反编译功能需要至少一个可用的反编译工具（推荐全部安装以覆盖不同 Python 版本）：
  - `pylingual`：`git clone https://github.com/syssec-utd/pylingual && uv tool install ./pylingual`
  - `uncompyle6`：`pip install uncompyle6`（Python ≤3.8）
  - `pycdc`：从 https://github.com/zrax/pycdc/releases 下载
  - 工具可执行文件需在 `PATH` 中，或位于 `~/.local/bin`（uv 默认安装目录）。
- 版本扫描功能依赖本机 Python 环境中的 `vermin`。

## Usage

1. 打开任意 Python 文件，扩展自动进行安全检查。
2. 双击 `.pyc` 文件即可在自定义编辑器中查看反编译结果。

## Release Notes

### 0.0.1

Initial release：Python 基础扫描 + pyc 反编译查看器。

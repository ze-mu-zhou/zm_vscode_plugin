import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';

/** 双击 .pyc 时反编译为临时 .py 并打开，让所有 Python 插件对反编译结果生效。 */

const TMP_DIR_NAME = 'tmp_python';
const FILE_PREFIX = 'pyc2py_';

interface PycDocument extends vscode.CustomDocument {
	/** 反编译后生成的临时 .py 文件路径（失败时为 null）。 */
	pyPath: string | null;
	/** 本次反编译使用的工具。 */
	tool: string | null;
	/** 反编译失败时的错误信息（用于提示）。 */
	error: string | null;
}

interface ToolStatus {
	/** 可执行文件完整路径；null = 未找到（PATH 和 uv 默认目录都无）。 */
	uncompyle6: string | null;
	pylingual: string | null;
	pycdc: string | null;
}

/** 解析可执行文件：先按 PATH 找（裸命令名可执行即返回），再查 uv 默认安装目录 ~/.local/bin。 */
async function resolveTool(cmd: string): Promise<string | null> {
	const tryRun = async (candidate: string): Promise<boolean> => {
		// 各工具 help 参数不同（uncompyle6 只认 --help，pycdc 只认 -h），两种都试
		for (const args of [['--help'], ['-h']]) {
			try {
				await execFileAsync(candidate, args, 5000);
				return true;
			} catch {
				// 尝试下一种参数；未安装时 ENOENT 立即失败
			}
		}
		return false;
	};

	// 1) PATH 中的命令（裸命令名）
	if (await tryRun(cmd)) {
		return cmd;
	}

	// 2) uv 工具默认安装目录（~/.local/bin）——未加入 PATH 时也能找到
	const exe = process.platform === 'win32' ? `${cmd}.exe` : cmd;
	const uvBin = path.join(os.homedir(), '.local', 'bin', exe);
	if (fs.existsSync(uvBin) && await tryRun(uvBin)) {
		return uvBin;
	}
	return null;
}

async function detectTools(): Promise<ToolStatus> {
	const [uncompyle6, pylingual, pycdc] = await Promise.all([
		resolveTool('uncompyle6'),
		resolveTool('pylingual'),
		resolveTool('pycdc'),
	]);
	return { uncompyle6, pylingual, pycdc };
}

const INSTALL_HINTS =
	'# 安装方法（未安装的工具）:\n' +
	'#   pylingual（3.6-3.14，优先）  : git clone https://github.com/syssec-utd/pylingual && uv tool install ./pylingual\n' +
	'#   uncompyle6（≤3.8）          : pip install uncompyle6\n' +
	'#   pycdc（3.9-3.13）            : https://github.com/zrax/pycdc/releases\n' +
	'# 提示: pylingual 首次反编译需从 HuggingFace 下载模型，国内网络自动走 hf-mirror 镜像，可能较慢（最长 10 分钟）；\n' +
	'#       若长时间无结果，通常是网络无法访问模型仓库，可设置环境变量 HF_ENDPOINT 指定其他镜像后重启 VS Code。\n' +
	'# 三个工具均失败时插件会直接提示失败，不再生成 dis 反汇编。';

/** 生成文件头注释：三工具探测状态 + 本次使用工具 + 安装方法。 */
function buildHeaderComment(tools: ToolStatus, usedTool: string | null): string {
	const mark = (p: string | null) => (p ? '已安装' : '未安装');
	return [
		'# ===== pyc2py 反编译信息 =====',
		`# 工具探测: uncompyle6 ${mark(tools.uncompyle6)} | pylingual ${mark(tools.pylingual)} | pycdc ${mark(tools.pycdc)}`,
		`# 本次使用: ${usedTool ?? '反编译失败'}`,
		'',
		INSTALL_HINTS,
		'# ===========================',
		'',
	].join('\n');
}

function execFileAsync(cmd: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env }, (err, stdout) => {
			if (err) {
				reject(err);
			} else {
				resolve(stdout);
			}
		});
	});
}

/**
 * 反编译链：pylingual → uncompyle6 → pycdc。
 * 某级失败（未安装/版本不支持/反编译出错）时静默回退；全部失败则返回 error，不生成 dis 反汇编。
 */
async function decompile(pycPath: string, tools: ToolStatus): Promise<{ text: string | null; tool: string; error: string | null }> {
	// 1) pylingual（3.6-3.14 全覆盖，还原质量最好，优先）
	if (tools.pylingual) {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pylingual-'));
		// pylingual 从 HuggingFace 下载模型，国内网络默认走 hf-mirror 镜像（用户已配置 HF_ENDPOINT 则优先）
		const pylingualEnv = {
			...process.env,
			HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
		};
		try {
			await execFileAsync(tools.pylingual, ['-q', '-o', outDir, pycPath], 600_000, pylingualEnv);
			const files = fs.readdirSync(outDir).filter(f => f.endsWith('.py'));
			if (files.length > 0) {
				const text = fs.readFileSync(path.join(outDir, files[0]), 'utf8');
				return { text, tool: 'pylingual', error: null };
			}
		} catch {
			// 失败（通常是模型下载/网络问题），继续
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	}

	// 2) uncompyle6（Python ≤3.8 还原效果较好）
	// 注意：它对不支持的版本会退出码 0 但输出 "Unsupported" 错误，必须内容校验
	if (tools.uncompyle6) {
		try {
			const stdout = await execFileAsync(tools.uncompyle6, [pycPath]);
			if (stdout.trim() && !/Unsupported/i.test(stdout)) {
				return { text: stdout, tool: 'uncompyle6', error: null };
			}
		} catch {
			// 反编译失败，继续回退
		}
	}
	// 老版本兼容 python -m uncompyle6
	try {
		const stdout = await execFileAsync('python', ['-m', 'uncompyle6', pycPath]);
		if (stdout.trim() && !/Unsupported/i.test(stdout)) {
			return { text: stdout, tool: 'uncompyle6', error: null };
		}
	} catch {
		// 继续回退
	}

	// 3) pycdc（支持较新的 Python 版本）
	if (tools.pycdc) {
		try {
			const stdout = await execFileAsync(tools.pycdc, [pycPath]);
			if (stdout.trim() && !/^#\s*(Decompilation failed|Python version .*not supported|Unsupported)/im.test(stdout)) {
				return { text: stdout, tool: 'pycdc', error: null };
			}
		} catch {
			// 未安装或失败，继续回退
		}
	}

	return {
		text: null,
		tool: '',
		error: '反编译失败：pylingual、uncompyle6、pycdc 均未能还原该 pyc。'
			+ 'pylingual 失败通常是模型下载问题（检查网络，或设置环境变量 HF_ENDPOINT 指定镜像）；'
			+ '若为 3.13+ 字节码，现有工具支持有限。',
	};
}

/** 在扩展目录 tmp_python 下生成唯一的临时 .py 文件名（pyc2py_<16位随机hex>.py）。 */
function uniqueTempPath(tmpDir: string): string {
	for (let i = 0; i < 10; i++) {
		const name = `${FILE_PREFIX}${randomBytes(8).toString('hex')}.py`;
		const full = path.join(tmpDir, name);
		if (!fs.existsSync(full)) {
			return full;
		}
	}
	// 极端情况下仍冲突，追加时间戳再试一次
	return path.join(tmpDir, `${FILE_PREFIX}${randomBytes(8).toString('hex')}_${Date.now().toString(16)}.py`);
}

/** 反编译 pyc 并写入临时 .py 文件（顶部带工具探测注释），返回其路径。 */
async function decompileToTempFile(pycPath: string, tmpDir: string, tools: ToolStatus): Promise<{ pyPath: string; tool: string; error: string | null }> {
	fs.mkdirSync(tmpDir, { recursive: true });
	const { text, tool, error } = await decompile(pycPath, tools);
	if (text === null) {
		return { pyPath: '', tool, error };
	}
	const pyPath = uniqueTempPath(tmpDir);
	fs.writeFileSync(pyPath, buildHeaderComment(tools, tool) + text, 'utf8');
	return { pyPath, tool, error: null };
}

/** 清空 tmp_python 目录。 */
export function cleanupTmpDir(extensionPath: string) {
	const tmpDir = path.join(extensionPath, TMP_DIR_NAME);
	try {
		for (const f of fs.readdirSync(tmpDir)) {
			fs.unlinkSync(path.join(tmpDir, f));
		}
	} catch {
		// 目录不存在等情况，忽略
	}
}

/**
 * 注册 pyc 查看器。
 * 双击 .pyc → customEditors 接管 → openCustomDocument 反编译并写临时 .py
 * → resolveCustomEditor 打开该 .py 标签页并关闭空面板。
 */
export function registerPycViewer(context: vscode.ExtensionContext) {
	const tmpDir = path.join(context.extensionPath, TMP_DIR_NAME);

	// 激活时异步探测工具，探测结果写入反编译文件的头部注释
	const toolsPromise = detectTools();

	const provider: vscode.CustomReadonlyEditorProvider<PycDocument> = {
		async openCustomDocument(uri: vscode.Uri): Promise<PycDocument> {
			const tools = await toolsPromise;
			const { pyPath, tool, error } = await decompileToTempFile(uri.fsPath, tmpDir, tools);
			return {
				uri,
				dispose: () => { /* 临时文件由清理命令/deactivate 统一处理 */ },
				pyPath,
				tool,
				error,
			};
		},

		async resolveCustomEditor(document: PycDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
			try {
				if (document.pyPath) {
					const pyUri = vscode.Uri.file(document.pyPath);
					// 先打开反编译出的 .py（所有 Python 插件自动生效）
					await vscode.window.showTextDocument(pyUri, { preview: true });
				} else {
					vscode.window.showErrorMessage(`[pyc2py] ${document.error}`);
				}
			} finally {
				// 关闭 custom editor 空面板
				webviewPanel.dispose();
			}
		},
	};

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider('zemu.pycViewer', provider, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// 手动命令：对任意 pyc 文件反编译为临时 .py 并打开
	const disposable = vscode.commands.registerCommand('zemu.decompilePycToPy', async (uri?: vscode.Uri) => {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!target || path.extname(target.fsPath).toLowerCase() !== '.pyc') {
			vscode.window.showErrorMessage('[pyc2py] 请在 .pyc 文件上使用此命令');
			return;
		}
		const { pyPath, error } = await decompileToTempFile(target.fsPath, tmpDir, await toolsPromise);
		if (pyPath) {
			await vscode.window.showTextDocument(vscode.Uri.file(pyPath), { preview: true });
		} else {
			vscode.window.showErrorMessage(`[pyc2py] ${error}`);
		}
	});
	context.subscriptions.push(disposable);

	// 手动清理命令
	const cleanupCmd = vscode.commands.registerCommand('zemu.cleanupTmpPython', async () => {
		cleanupTmpDir(context.extensionPath);
		vscode.window.showInformationMessage('[pyc2py] 已清理临时反编译文件');
	});
	context.subscriptions.push(cleanupCmd);

	// 扩展停用时清空临时文件
	context.subscriptions.push({ dispose: () => cleanupTmpDir(context.extensionPath) });
}

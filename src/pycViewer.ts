import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import { randomBytes, createHash } from 'crypto';

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

/** pyc 魔数识别结果。major 为 0 表示无法识别。 */
interface PycVersionInfo {
	major: number;
	minor: number;
	label: string;
}

/**
 * 读取 pyc 头部 2 字节魔数（小端），映射到 Python 版本。
 * 参考 CPython importlib/_bootstrap_external.py 的 magic 注释表：
 * 2.6=62151-62161 2.7=62211；3.0=3131 3.1=3151 3.2=3180 3.3=3230 3.4=3310 3.5=3351；
 * 3.6=3379 3.7=3394 3.8=3413 3.9=3425 3.10=3439；3.11 起 magic=2900+50n 区间。
 */
function readPycVersion(pycPath: string): PycVersionInfo {
	let m = 0;
	try {
		const fd = fs.openSync(pycPath, 'r');
		const buf = Buffer.alloc(2);
		fs.readSync(fd, buf, 0, 2, 0);
		fs.closeSync(fd);
		m = buf.readUInt16LE(0);
	} catch {
		return { major: 0, minor: 0, label: 'unknown' };
	}
	let major = 0;
	let minor = 0;
	if (m >= 3000 && m <= 3131) { major = 3; minor = 0; }
	else if (m >= 3141 && m <= 3151) { major = 3; minor = 1; }
	else if (m >= 3160 && m <= 3180) { major = 3; minor = 2; }
	else if (m >= 3190 && m <= 3230) { major = 3; minor = 3; }
	else if (m >= 3250 && m <= 3310) { major = 3; minor = 4; }
	else if (m >= 3320 && m <= 3351) { major = 3; minor = 5; }
	else if (m >= 3360 && m <= 3389) { major = 3; minor = 6; }
	else if (m >= 3390 && m <= 3412) { major = 3; minor = 7; }
	else if (m >= 3413 && m <= 3419) { major = 3; minor = 8; }
	else if (m >= 3420 && m <= 3429) { major = 3; minor = 9; }
	else if (m >= 3430 && m <= 3449) { major = 3; minor = 10; }
	else if (m >= 3450 && m <= 3499) { major = 3; minor = 11; }
	else if (m >= 3500 && m <= 3549) { major = 3; minor = 12; }
	else if (m >= 3550 && m <= 3599) { major = 3; minor = 13; }
	else if (m >= 3600 && m <= 3699) { major = 3; minor = 14; }
	else if (m >= 62151 && m <= 62161) { major = 2; minor = 6; }
	else if (m >= 62171 && m <= 62211) { major = 2; minor = 7; }
	return major ? { major, minor, label: `${major}.${minor}` } : { major: 0, minor: 0, label: `unknown (magic ${m})` };
}

/**
 * 按 pyc 版本选择还原效果最好的工具链（已探测可用），返回依次尝试的工具名数组。
 * - 2.x / 3.4-3.5: uncompyle6 规则引擎还原质量最好
 * - 3.0-3.3: 仅 pycdc 可用（uncompyle6 不支持，pylingual 也不支持）
 * - 3.6-3.8: uncompyle6 最优
 * - 3.9-3.11: pycdc 支持良好且快
 * - 3.12-3.13: pycdc 支持有限，pylingual 优先
 * - 3.14: 仅 pylingual
 * - 未知: 原顺序 pylingual → uncompyle6 → pycdc
 */
function pickToolChain(version: PycVersionInfo, tools: ToolStatus): string[] {
	const chain: string[] = [];
	const add = (t: string | null) => { if (t && !chain.includes(t)) chain.push(t); };
	if (version.major === 2) {
		add(tools.uncompyle6); add(tools.pycdc);
		return chain;
	}
	switch (version.minor) {
		case 0: case 1: case 2: case 3:
			add(tools.pycdc); add(tools.uncompyle6);
			break;
		case 4: case 5:
			add(tools.uncompyle6); add(tools.pycdc);
			break;
		case 6: case 7: case 8:
			add(tools.uncompyle6); add(tools.pylingual); add(tools.pycdc);
			break;
		case 9: case 10: case 11:
			add(tools.pycdc); add(tools.pylingual);
			break;
		case 12: case 13:
			add(tools.pylingual); add(tools.pycdc);
			break;
		case 14:
			add(tools.pylingual);
			break;
		default:
			add(tools.pylingual); add(tools.uncompyle6); add(tools.pycdc);
	}
	return chain;
}

const INSTALL_HINTS =
	'# 安装方法（未安装的工具）:\n' +
	'#   pylingual（3.6-3.14，优先）  : git clone https://github.com/syssec-utd/pylingual && uv tool install ./pylingual\n' +
	'#   uncompyle6（2.7 与 ≤3.8）      : pip install uncompyle6（需 Python ≤3.8 环境，如 uv tool install --python 3.8）\n' +
	'#   pycdc（3.9-3.13）            : https://github.com/zrax/pycdc/releases\n' +
	'# 提示: pylingual 首次反编译需从 HuggingFace 下载模型，国内网络自动走 hf-mirror 镜像，可能较慢（最长 10 分钟）；\n' +
	'#       若长时间无结果，通常是网络无法访问模型仓库，可设置环境变量 HF_ENDPOINT 指定其他镜像后重启 VS Code。\n' +
	'# 三个工具均失败时插件会直接提示失败，不再生成 dis 反汇编。';

/** 生成文件头注释：魔数识别的版本 + 三工具探测状态 + 本次使用工具 + 安装方法。 */
function buildHeaderComment(tools: ToolStatus, usedTool: string | null, version: PycVersionInfo): string {
	const mark = (p: string | null) => (p ? '已安装' : '未安装');
	return [
		'# ===== pyc2py 反编译信息 =====',
		`# 魔数识别版本: Python ${version.label}`,
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
/** 尝试 pylingual：输出到临时目录，成功后读回 .py 内容。 */
async function runPylingual(pylingual: string, pycPath: string): Promise<string | null> {
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pylingual-'));
	// pylingual 从 HuggingFace 下载模型，国内网络默认走 hf-mirror 镜像（用户已配置 HF_ENDPOINT 则优先）
	const pylingualEnv = {
		...process.env,
		HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
	};
	try {
		await execFileAsync(pylingual, ['-q', '-o', outDir, pycPath], 600_000, pylingualEnv);
		const files = fs.readdirSync(outDir).filter(f => f.endsWith('.py'));
		if (files.length > 0) {
			return fs.readFileSync(path.join(outDir, files[0]), 'utf8');
		}
		return null;
	} catch {
		// 失败（通常是模型下载/网络问题），继续
		return null;
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
}

/** 尝试 uncompyle6（含 python -m uncompyle6 兼容路径）。注意它对不支持的版本会退出码 0 但输出 "Unsupported" 错误，必须内容校验。 */
async function runUncompyle6(uncompyle6: string, pycPath: string): Promise<string | null> {
	if (uncompyle6) {
		try {
			const stdout = await execFileAsync(uncompyle6, [pycPath]);
			if (stdout.trim() && !/Unsupported/i.test(stdout)) {
				return stdout;
			}
		} catch {
			// 反编译失败，继续回退
		}
	}
	// 老版本兼容 python -m uncompyle6
	try {
		const stdout = await execFileAsync('python', ['-m', 'uncompyle6', pycPath]);
		if (stdout.trim() && !/Unsupported/i.test(stdout)) {
			return stdout;
		}
	} catch {
		// 继续回退
	}
	return null;
}

/** 尝试 pycdc。 */
async function runPycdc(pycdc: string, pycPath: string): Promise<string | null> {
	try {
		const stdout = await execFileAsync(pycdc, [pycPath]);
		if (stdout.trim() && !/^#\s*(Decompilation failed|Python version .*not supported|Unsupported)/im.test(stdout)) {
			return stdout;
		}
	} catch {
		// 未安装或失败，继续回退
	}
	return null;
}

/**
 * 反编译：先按魔数识别 pyc 版本，再用 pickToolChain 选出的最优工具链逐级回退。
 * 全部失败则返回 error，不生成 dis 反汇编。
 */
async function decompile(pycPath: string, tools: ToolStatus, version: PycVersionInfo): Promise<{ text: string | null; tool: string; error: string | null }> {
	const chain = pickToolChain(version, tools);
	for (const tool of chain) {
		let text: string | null = null;
		if (tool === 'pylingual') {
			text = await runPylingual(tools.pylingual!, pycPath);
		} else if (tool === 'uncompyle6') {
			text = await runUncompyle6(tools.uncompyle6!, pycPath);
		} else if (tool === 'pycdc') {
			text = await runPycdc(tools.pycdc!, pycPath);
		}
		if (text) {
			return { text, tool, error: null };
		}
	}
	return {
		text: null,
		tool: '',
		error: chain.length === 0
			? '反编译失败：未找到任何可用的反编译工具，请先安装（见文件头安装说明）。'
			: `反编译失败：${chain.join('、')} 均未能还原该 pyc（识别版本 Python ${version.label}）。`
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

/**
 * 反编译缓存 key：sha1(绝对路径+工具集)_mtimeMs_大小。
 * 缓存命中条件：同一文件（路径+mtime+size 未变）且工具集未变。
 */
function cachePathFor(pycPath: string, cacheDir: string, tools: ToolStatus): string | null {
	try {
		const st = fs.statSync(pycPath);
		const toolset = [tools.pylingual ?? '', tools.uncompyle6 ?? '', tools.pycdc ?? ''].join('|');
		const hash = createHash('sha1').update(path.resolve(pycPath) + '|' + toolset).digest('hex').slice(0, 16);
		return path.join(cacheDir, `${hash}_${st.mtimeMs}_${st.size}.py`);
	} catch {
		return null;
	}
}

/** 反编译 pyc 并写入临时 .py 文件（顶部带魔数版本与工具探测注释），返回其路径。结果按文件特征缓存，命中时零等待。 */
async function decompileToTempFile(pycPath: string, tmpDir: string, cacheDir: string, tools: ToolStatus, version: PycVersionInfo): Promise<{ pyPath: string; tool: string; error: string | null }> {
	fs.mkdirSync(tmpDir, { recursive: true });

	// 1) 命中缓存：直接复制缓存内容到临时文件，跳过反编译
	const cacheFile = cachePathFor(pycPath, cacheDir, tools);
	if (cacheFile && fs.existsSync(cacheFile)) {
		const pyPath = uniqueTempPath(tmpDir);
		fs.copyFileSync(cacheFile, pyPath);
		return { pyPath, tool: 'cache', error: null };
	}

	// 2) 未命中：反编译并写临时文件，同时写入缓存
	const { text, tool, error } = await decompile(pycPath, tools, version);
	if (text === null) {
		return { pyPath: '', tool, error };
	}
	const content = buildHeaderComment(tools, tool, version) + text;
	const pyPath = uniqueTempPath(tmpDir);
	fs.writeFileSync(pyPath, content, 'utf8');
	if (cacheFile) {
		try {
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(cacheFile, content, 'utf8');
		} catch {
			// 缓存写入失败不影响主流程
		}
	}
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
	// 反编译结果缓存：放 VS Code 扩展全局存储目录，跨会话保留（不随扩展停用清空）
	const cacheDir = path.join(context.globalStorageUri.fsPath, 'decompile-cache');

	// 激活时异步探测工具，探测结果写入反编译文件的头部注释
	const toolsPromise = detectTools();

	const provider: vscode.CustomReadonlyEditorProvider<PycDocument> = {
		async openCustomDocument(uri: vscode.Uri): Promise<PycDocument> {
			const tools = await toolsPromise;
			const version = readPycVersion(uri.fsPath);
			const { pyPath, tool, error } = await decompileToTempFile(uri.fsPath, tmpDir, cacheDir, tools, version);
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
		const { pyPath, error } = await decompileToTempFile(target.fsPath, tmpDir, cacheDir, await toolsPromise, readPycVersion(target.fsPath));
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

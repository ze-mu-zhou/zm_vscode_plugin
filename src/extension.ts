import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { createHash } from 'crypto';
import { runVermin, type VerminResult } from './vermin';
import { PythonShell } from 'python-shell';

let vermin_up: boolean = false;
let pyshell_os_path_join: PythonShell;
const diagnostic = vscode.languages.createDiagnosticCollection("python check");

interface Resp {
	answer: ZM_range[]
}

interface ZM_range {
	line: number,
	col: number,
	end_line: number,
	end_col: number,
	error: boolean
}

interface VerminCacheEntry {
	hash: string;
	result: (VerminResult & { exitCode: number }) | null;
	advancedOK: boolean;
}
const verminCache = new Map<string, VerminCacheEntry>();
const MAX_CACHE_ENTRIES = 50;

function cacheGet(uriKey: string): VerminCacheEntry | undefined {
	const entry = verminCache.get(uriKey);
	if (entry) {
		verminCache.delete(uriKey);
		verminCache.set(uriKey, entry);
	}
	return entry;
}

function cacheSet(uriKey: string, entry: VerminCacheEntry) {
	if (verminCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = verminCache.keys().next().value;
		if (oldest !== undefined) {
			verminCache.delete(oldest);
		}
	}
	verminCache.set(uriKey, entry);
}

function hashText(text: string): string {
	return createHash('sha1').update(text, 'utf8').digest('hex');
}

const SAVE_DEBOUNCE_MS = 400;
const saveDebounceTimers = new Map<string, NodeJS.Timeout>();

// ---------- 输入实时分析：停笔后只跑 os.path.join 高级分析（快），vermin 不参与 ----------
const CHANGE_DEBOUNCE_MS = 500;
const changeDebounceTimers = new Map<string, NodeJS.Timeout>();

function scheduleAdvancedOnChange(event: vscode.TextDocumentChangeEvent) {
	// 只实时分析当前正在编辑的文件（与 ESLint/Pylance 的 openFilesOnly 同理）
	const active = vscode.window.activeTextEditor?.document;
	if (!active || active.uri.toString() !== event.document.uri.toString()) {
		return;
	}
	const doc = event.document;
	const key = doc.uri.toString();
	const existing = changeDebounceTimers.get(key);
	if (existing) {
		clearTimeout(existing);
	}
	changeDebounceTimers.set(key, setTimeout(async () => {
		changeDebounceTimers.delete(key);
		if (doc.isClosed) {
			return;
		}
		// silent：输入过程中失败不弹窗打扰，只静默不更新黄线
		await advanced_analyze_file(doc, doc.getText(), true);
	}, CHANGE_DEBOUNCE_MS));
}

const inflightAnalyses = new Map<string, Promise<void>>();
const rerunNeeded = new Set<string>();

function scheduleAnalyzeOnSave(doc: vscode.TextDocument) {
	const key = doc.uri.toString();
	const existing = saveDebounceTimers.get(key);
	if (existing) {
		clearTimeout(existing);
	}
	saveDebounceTimers.set(key, setTimeout(async () => {
		saveDebounceTimers.delete(key);
		await analyzeFile(doc);
	}, SAVE_DEBOUNCE_MS));
}

function analyzeOsPathJoin(code: string, timeoutMs = 10_000): Promise<Resp> {
	return new Promise((resolve, reject) => {
		const handler = (msg: Resp) => {
			clearTimeout(timer);
			pyshell_os_path_join.off('message', handler);
			resolve(msg);
		};
		const timer = setTimeout(() => {
			pyshell_os_path_join.off('message', handler);
			reject(new Error('os.path.join 高级分析超时'));
		}, timeoutMs);
		pyshell_os_path_join.on('message', handler);
		pyshell_os_path_join.send({ code });
	});
}

async function run_command(command: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		exec(command, (error, stdout, stderr) => {
			if (error) {
				reject(`执行命令时出现错误: ${error.message} \nstdout 输出如下: ${stdout} \nstderr 输出如下: ${stderr}`);
				vscode.window.showErrorMessage(`执行命令时出现错误: ${error.message}`);
				vscode.window.showErrorMessage(`stdout 输出如下: ${stdout} \nstderr 输出如下: ${stderr}`);
				return;
			} else {
				resolve({ stdout, stderr });
				return;
			}
		});
	});
}

async function check_vermin() {
	if (vermin_up === false) {
		try {
			const {stdout, stderr} = await run_command("vermin --version");
			const vermin_version = stdout.trim();
			vscode.window.showInformationMessage(`当前主机 vermin 版本为 ${vermin_version}`);
			vermin_up = true;
		} catch (error) {
			vscode.window.showErrorMessage("在主机上未识别到 vermin , 请执行 pip install vermin 进行安装并重启 vscode ");
		}
	}
}

async function runVerminOnce(doc: vscode.TextDocument): Promise<(VerminResult & { exitCode: number }) | null> {
	try {
		const result = await runVermin([doc.fileName]);
		if (result.exitCode === 1) {
			vscode.window.showErrorMessage(`未满足 targets 或没有可分析的文件, 分析 ${doc.fileName} 终止`);
			return null;
		}
		return result;
	} catch (error) {
		vscode.window.showErrorMessage(`${error}`);
		return null;
	}
}

function showVerminMessages(result: VerminResult) {
	if (result.min.py2 === null) {
		vscode.window.showWarningMessage("[!]Python2: 该 python 文件不支持在 python2.x 上运行");
	} else if (result.min.py2 === undefined) {
		vscode.window.showWarningMessage("[!]Python2: 无法确定结论, 需实际运行得知");
	} else {
		vscode.window.showInformationMessage(`[+]Python2: 该 python 文件支持在 ${result.min.py2} 及以上版本上运行`);
	}
	if (result.min.py3 === null) {
		vscode.window.showWarningMessage("[!]Python3: 该 python 文件不支持在 python3.x 上运行");
	} else if (result.min.py3 === undefined) {
		vscode.window.showWarningMessage("[!]Python3: 无法确定结论, 需实际运行得知");
	} else {
		vscode.window.showInformationMessage(`[+]Python3: 该 python 文件支持在 ${result.min.py3} 及以上版本上运行`);
	}
}

async function advanced_analyze_file(doc: vscode.TextDocument, text: string, silent = false): Promise<boolean> {
	let resp: Resp;
	try {
		resp = await analyzeOsPathJoin(text);
	} catch (error) {
		if (!silent) {
			vscode.window.showErrorMessage(`${error}`);
		}
		return false;
	}
	const diags: vscode.Diagnostic[] = [];
	for (const r of resp.answer) {
		if (r.error === true) {
			if (!silent) {
				vscode.window.showErrorMessage("对 python 代码进行高级分析时报错");
			}
			return false;
		}
		const range = new vscode.Range(r.line - 1, r.col, r.end_line - 1, r.end_col);
		diags.push(new vscode.Diagnostic(
			range,
			`检测到 os.path.join() 函数\n该函数在拼接多个绝对路径时只保留最后一个绝对路径\neg: os.path.join("/etc/passwd", "/usr/root") 结果为 "/usr/root"\n如果 os.path.join 内部最后一个参数为用户输入, 可能会引发任意文件读写, 十分危险⚠️`,
			vscode.DiagnosticSeverity.Warning
		));
	}
	diagnostic.set(doc.uri, diags);
	return true;
}

async function analyzeFile(doc: vscode.TextDocument) {
	if (doc.languageId !== "python") {
		return;
	}
	const uriKey = doc.uri.toString();
	if (inflightAnalyses.has(uriKey)) {
		rerunNeeded.add(uriKey);
		return;
	}
	const run = doAnalyzeFile(doc, uriKey);
	inflightAnalyses.set(uriKey, run);
	try {
		await run;
	} finally {
		inflightAnalyses.delete(uriKey);
		if (rerunNeeded.delete(uriKey)) {
			await analyzeFile(doc);
		}
	}
}

async function doAnalyzeFile(doc: vscode.TextDocument, uriKey: string) {
	const text = doc.getText();
	const hash = hashText(text);
	const entry = cacheGet(uriKey);

	if (entry && entry.hash === hash) {
		if (!entry.advancedOK) {
			entry.advancedOK = await advanced_analyze_file(doc, text);
		}
		return;
	}

	const result = await runVerminOnce(doc);
	const newEntry: VerminCacheEntry = { hash, result, advancedOK: false };
	cacheSet(uriKey, newEntry);
	if (result === null) {
		diagnostic.set(doc.uri, []);
		return;
	}
	showVerminMessages(result);
	const ok = await advanced_analyze_file(doc, text);
	if (!ok) {
		diagnostic.set(doc.uri, []);
	}
	newEntry.advancedOK = ok;
}

export async function activate(context: vscode.ExtensionContext) {
	await check_vermin();
	if (vermin_up) {
		pyshell_os_path_join = new PythonShell('ast_os_path_join.py', {
			mode: 'json',
			pythonPath: "python3",
			scriptPath: path.join(context.extensionPath, "python_libraries"),
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
		});
		let disposable_analyze_python_file_when_open = vscode.workspace.onDidOpenTextDocument(doc => {
			analyzeFile(doc);
		});
		let disposable_analyze_python_file_when_change = vscode.workspace.onDidChangeTextDocument(event => {
			scheduleAdvancedOnChange(event);
		});
		let disposable_analyze_python_file_when_save = vscode.workspace.onDidSaveTextDocument(doc => {
			scheduleAnalyzeOnSave(doc);
		});
		let diagnostic_command_basic_python_scan = vscode.commands.registerCommand("basic_python_scan", async (doc?: vscode.TextDocument | vscode.Uri) => {
			if (doc instanceof vscode.Uri) {
				doc = await vscode.workspace.openTextDocument(doc);
			}
			const target = doc ?? vscode.window.activeTextEditor?.document;
			if (target && target.languageId === "python") {
				const result = await runVerminOnce(target);
				if (result) {
					showVerminMessages(result);
				}
				const text = target.getText();
				cacheSet(target.uri.toString(), { hash: hashText(text), result, advancedOK: false });
			}
		});
		context.subscriptions.push(
			diagnostic,
			disposable_analyze_python_file_when_open,
			disposable_analyze_python_file_when_change,
			disposable_analyze_python_file_when_save,
			diagnostic_command_basic_python_scan
		);

		// onLanguage 激活时序：触发激活的那个文件（以及激活前已恢复的标签页）的
		// onDidOpenTextDocument 事件不会在监听器注册后重放，需主动分析一次。
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.languageId === "python") {
				analyzeFile(doc);
			}
		}
	}

}

export function deactivate() {
	for (const timer of saveDebounceTimers.values()) {
		clearTimeout(timer);
	}
	saveDebounceTimers.clear();
	for (const timer of changeDebounceTimers.values()) {
		clearTimeout(timer);
	}
	changeDebounceTimers.clear();
	pyshell_os_path_join?.end(() => {

	});
}

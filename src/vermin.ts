import { execFile } from 'child_process';

/** 一条 vermin 结果。summary 行的 line/col/feature 为空。 */
export interface VerminFinding {
	path: string;
	line?: number;
	col?: number;
	py2: VerminVersion;
	py3: VerminVersion;
	feature: string;
	/** 'error' = 语法错误，'info' = py2 专用语法，'note' = -vvvv 的排除/忽略说明。 */
	kind: 'feature' | 'error' | 'info' | 'note';
}

/** null = 已知不兼容(!2/!3)；undefined = 无结论(~2/~3)或该行未给版本。 */
export type VerminVersion = string | null | undefined;

export interface VerminResult {
	/** 全部明细，不含 summary 行。 */
	findings: VerminFinding[];
	/** 每个文件的最低版本（key 为 vermin 输出的路径原文）。 */
	perFile: Map<string, { py2: VerminVersion; py3: VerminVersion }>;
	/** 最后一行的全局最低版本。 */
	min: { py2: VerminVersion; py3: VerminVersion };
}

// path:line:col:py2:py3:feature
// path 惰性匹配以容忍 Windows 盘符里的 ':'；feature 取到行尾以容忍其中的 ':'。
const LINE_RE =
	/^(.*?):(\d*):(\d*):(!2|~2|2(?:\.\d+)?|):(!3|~3|3(?:\.\d+)?|):([\s\S]*)$/;

function version(tok: string): VerminVersion {
	if (tok === '' || tok[0] === '~') { return undefined; }
	return tok[0] === '!' ? null : tok;
}

function kindOf(feature: string, py2: string, py3: string): VerminFinding['kind'] {
	if (feature.startsWith('error: ')) { return 'error'; }
	if (feature.startsWith('info: ')) { return 'info'; }
	return py2 === '' && py3 === '' ? 'note' : 'feature';
}

/** 解析 `-f parsable` 的 stdout。 */
export function parseVermin(stdout: string): VerminResult {
	const findings: VerminFinding[] = [];
	const perFile = new Map<string, { py2: VerminVersion; py3: VerminVersion }>();
	let min: VerminResult['min'] = { py2: undefined, py3: undefined };

	for (const raw of stdout.split(/\r?\n/)) {
		const m = LINE_RE.exec(raw);
		if (!m) { continue; }  // 空行、traceback、"No files specified to analyze!"
		const [, path, line, col, t2, t3, feature] = m;
		const py2 = version(t2), py3 = version(t3);

		if (feature === '' && line === '') {
			// summary 行：path 为空则是全局最低版本，否则是单文件最低版本。
			if (path === '') {
				min = { py2, py3 };
			} else {
				perFile.set(path, { py2, py3 });
			}
			continue;
		}

		findings.push({
			path,
			line: line ? Number(line) : undefined,
			col: col ? Number(col) : undefined,
			py2, py3, feature,
			kind: kindOf(feature, t2, t3),
		});
	}
	return { findings, perFile, min };
}

export interface VerminOptions {
	/** -vvvv 会额外产生 kind:'note' 的行；默认 -vvv 已含行列号。 */
	verbose?: 3 | 4;
	/** 代码用 typing.get_type_hints/eval(__annotations__) 时开启。 */
	evalAnnotations?: boolean;
	/** 启用不稳定检测：自文档 f-string、`X | Y` 联合类型。 */
	unstableFeatures?: boolean;
	backports?: string[];
	excludes?: string[];
	targets?: string[];
	violationsOnly?: boolean;
	processes?: number;
	cwd?: string;
	timeoutMs?: number;
}

export function buildArgs(paths: string[], o: VerminOptions = {}): string[] {
	const args = ['-f', 'parsable', `-${'v'.repeat(o.verbose ?? 3)}`, '--no-config-file'];
	if (o.evalAnnotations) { args.push('--eval-annotations'); }
	if (o.unstableFeatures) {
		args.push('--feature', 'fstring-self-doc', '--feature', 'union-types');
	}
	for (const b of o.backports ?? []) { args.push('--backport', b); }
	for (const e of o.excludes ?? []) { args.push('--exclude', e); }
	for (const t of o.targets ?? []) { args.push(`-t=${t}`); }
	if (o.violationsOnly) { args.push('--violations'); }
	if (o.processes) { args.push(`-p=${o.processes}`); }
	return args.concat('--', ...paths);
}

/**
 * 运行 vermin 并解析结果。
 * 退出码 1 表示「未满足 --target」或「没有可分析的文件」，两者无法从 stdout 区分，
 * 故原样返回 exitCode 由调用方判断；只有找不到 vermin / 超时才 reject。
 */
export function runVermin(
	paths: string[], o: VerminOptions = {},
): Promise<VerminResult & { exitCode: number }> {
	return new Promise((resolve, reject) => {
		execFile(
			'vermin', buildArgs(paths, o),
			{
				cwd: o.cwd,
				timeout: o.timeoutMs ?? 30_000,
				maxBuffer: 64 * 1024 * 1024,
				// 必需：默认 GBK 控制台下，非 GBK 路径会让 vermin 抛 UnicodeEncodeError 崩溃。
				env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
				encoding: 'utf8',
			},
			(err, stdout) => {
				const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
				if (e && (e.code === 'ENOENT' || e.code === 'ETIMEDOUT' || e.killed)) {
					reject(e.code === 'ENOENT'
						? new Error('未找到 vermin，请执行 pip install vermin')
						: e);
					return;
				}
				resolve({
					...parseVermin(stdout),
					exitCode: typeof e?.code === 'number' ? e.code : 0,
				});
			},
		);
	});
}

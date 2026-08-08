import ast
import json
import sys

def parse_python_code(code: str) -> ast.Module:
    return ast.parse(code)

def check_os_path_join(ast_tree: ast.AST) -> list:
    os_alias = {'os'}
    path_alias = {'path', "os.path"}
    join_alias = {'join'}
    results = []
    for node in ast.walk(ast_tree):
        # 获取 os path join 的所有别名
        if isinstance(node, ast.Import):
            for name in node.names:
                if name.name == 'path' and name.asname:
                    path_alias.add(name.asname)
                if name.name == 'os' and name.asname:
                    os_alias.add(name.asname)
                if name.name == 'os.path' and name.asname:
                    path_alias.add(name.asname)
        if isinstance(node, ast.ImportFrom):
            if node.module is None:
                continue
            if node.module == 'os':
                for name in node.names:
                    if name.name == 'path' and name.asname:
                        path_alias.add(name.asname)
            if node.module == 'os.path':
                for name in node.names:
                    if name.name == 'join' and name.asname:
                        join_alias.add(name.asname)
        
        if isinstance(node, ast.Call):
            # 检测 os.path.join() 或 path.join() attr 型函数调用
            if isinstance(node.func, ast.Attribute):
                if node.func.attr and node.func.attr in join_alias:
                    # os.path.join() 型
                    if isinstance(node.func.value, ast.Attribute):
                        if node.func.value.attr and node.func.value.attr in path_alias:
                            if isinstance(node.func.value.value, ast.Name):
                                if node.func.value.value.id and node.func.value.value.id in os_alias:
                                    results.append({
                                        'line': node.lineno,
                                        'col': node.col_offset,
                                        'end_line': node.end_lineno if node.end_lineno is not None else node.lineno,
                                        'end_col': node.end_col_offset if node.end_col_offset is not None else node.col_offset,
                                        'error': False
                                    })
                    # path.join() 型
                    if isinstance(node.func.value, ast.Name):
                        if node.func.value.id and node.func.value.id in path_alias:
                            results.append({
                                    'line': node.lineno,
                                    'col': node.col_offset,
                                    'end_line': node.end_lineno if node.end_lineno is not None else node.lineno,
                                    'end_col': node.end_col_offset if node.end_col_offset is not None else node.col_offset,
                                    'error': False
                                })
            # 检测 join() name 型函数调用
            if isinstance(node.func, ast.Name):
                if node.func.id and node.func.id in join_alias:
                    results.append({
                        'line': node.lineno,
                        'col': node.col_offset,
                        'end_line': node.end_lineno if node.end_lineno is not None else node.lineno,
                        'end_col': node.end_col_offset if node.end_col_offset is not None else node.col_offset,
                        'error': False
                    })
    return results

def main():
    sys.stdin.reconfigure(encoding='utf-8')  # type: ignore[attr-defined]
    sys.stdout.reconfigure(encoding='utf-8')  # type: ignore[attr-defined]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            results = { "answer": check_os_path_join(parse_python_code(req['code'])) }
        except:
            results = { "answer": [{
                "error": True
            }] }
        sys.stdout.write(json.dumps(results) + '\n')
        sys.stdout.flush()
if __name__ == "__main__":
    main()
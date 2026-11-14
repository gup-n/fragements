#!/usr/bin/env node
/**
 * 回归测试的只读、内存 TypeScript 加载器（Node 22+）。
 *
 * 不写 .tmp-*，不启动 tsc/Metro，不使用 node:sqlite，不修改全局 require.cache。
 * 只执行项目里的真实源码；React Native、数据库、文件系统和网络必须显式给桩。
 * extract() 用 TypeScript AST 取真实声明/初始化表达式，不复制一份业务算法。
 *
 * 这是测试隔离，不是用来运行不可信代码的安全沙箱。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function projectPath(file) {
  const absolute = path.resolve(ROOT, file);
  const relative = path.relative(ROOT, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`测试加载器不能读取项目以外的文件：${file}`);
  }
  return absolute;
}

function readSource(file) {
  return fs.readFileSync(projectPath(file), 'utf8');
}

function parseSource(file, options = {}) {
  const absolute = projectPath(file);
  const raw = fs.readFileSync(absolute, 'utf8');
  const source = options.inlineScripts
    ? [...raw.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
    : raw;
  if (options.inlineScripts && !source.trim()) throw new Error(`${file} 没有可提取的内联脚本`);
  return ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    options.inlineScripts ? ts.ScriptKind.JS : /\.tsx$/i.test(absolute) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function transpile(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
      isolatedModules: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });
  const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(
      `${fileName} 转译失败：\n${ts.formatDiagnostics(errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      })}`,
    );
  }
  return result.outputText;
}

function declarationName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function insideScope(node, scope) {
  if (!scope) return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (declarationName(parent) === scope) return true;
  }
  return false;
}

function findDeclaration(file, name, options = {}) {
  const source = typeof file === 'string' ? parseSource(file, options) : file;
  const found = [];
  const visit = (node) => {
    if (declarationName(node) === name && insideScope(node, options.scope)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1) {
    throw new Error(
      `${path.relative(ROOT, source.fileName)}：真实声明 ${name}${options.scope ? `（${options.scope} 内）` : ''} 匹配 ${found.length} 处；` +
        '源码结构已变，请更新测试接线，不能跳过这个用例。',
    );
  }
  return { source, node: found[0] };
}

function declarationText(source, node) {
  if (ts.isVariableDeclaration(node)) {
    if (!node.initializer) throw new Error(`${node.name.getText(source)} 没有可执行初始化表达式`);
    // 保留 initializer 原文（包括 useCallback 和依赖数组），只去掉外层变量类型。
    return `const ${node.name.getText(source)} = ${node.initializer.getText(source)};`;
  }
  if (!node.body) throw new Error(`${node.name.text} 只有类型声明，没有真实函数体`);
  const printable = ts.factory.updateFunctionDeclaration(
    node,
    node.modifiers?.filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword),
    node.asteriskToken,
    node.name,
    node.typeParameters,
    node.parameters,
    node.type,
    node.body,
  );
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified, printable, source);
}

function resolveSource(request, parentFile) {
  const base = request.startsWith('.')
    ? path.resolve(path.dirname(parentFile), request)
    : projectPath(request);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.cjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    projectPath(candidate);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error(`找不到真实模块 ${request}（从 ${path.relative(ROOT, parentFile)} 加载）`);
}

function createLoader(options = {}) {
  const stubs = options.stubs || {};
  const cache = new Map();
  const denyNetwork = () => { throw new Error('回归断言禁止真实网络请求；必须提供桩'); };
  const context = vm.createContext({
    console,
    Buffer,
    Date,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: denyNetwork,
    process: Object.freeze({ env: Object.freeze({ NODE_ENV: 'test' }) }),
    ...(options.globals || {}),
  });
  context.global = context;

  function requireFrom(parentFile) {
    return (request) => {
      if (own(stubs, request)) return stubs[request];
      if (!request.startsWith('.') && !path.isAbsolute(request)) {
        throw new Error(`未提供测试桩的外部依赖：${request}（${path.relative(ROOT, parentFile)}）`);
      }
      const absolute = resolveSource(request, parentFile);
      const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
      if (own(stubs, absolute)) return stubs[absolute];
      if (own(stubs, relative)) return stubs[relative];
      return load(absolute);
    };
  }

  function load(file) {
    const absolute = resolveSource(file, path.join(ROOT, '__test_entry__.ts'));
    const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
    if (own(stubs, absolute)) return stubs[absolute];
    if (own(stubs, relative)) return stubs[relative];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    try {
      const code = transpile(fs.readFileSync(absolute, 'utf8'), absolute);
      const wrap = new vm.Script(`(function(exports, require, module, __filename, __dirname) {\n${code}\n})`, { filename: absolute });
      const evaluate = wrap.runInContext(context, { timeout: options.evaluationTimeout || 5000 });
      evaluate(module.exports, requireFrom(absolute), module, absolute, path.dirname(absolute));
      return module.exports;
    } catch (error) {
      cache.delete(absolute);
      throw error;
    }
  }

  function extract(file, names, bindings = {}, extractOptions = {}) {
    const source = parseSource(file, extractOptions);
    const selected = names.map((name) => findDeclaration(source, name, extractOptions));
    const bound = Object.keys(bindings);
    for (const name of [...bound, ...names]) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`不是合法的测试绑定名：${name}`);
    }
    if (names.some((name) => own(bindings, name))) throw new Error('不能把待测真实声明替换成同名桩');
    const code = [
      '(function(__bindings, require) {',
      bound.length ? `const { ${bound.join(', ')} } = __bindings;` : '',
      ...selected.map(({ node }) => declarationText(source, node)),
      `return { ${names.join(', ')} };`,
      '})',
    ].join('\n');
    const compiled = transpile(code, extractOptions.inlineScripts ? `${source.fileName}.ts` : source.fileName);
    const factory = new vm.Script(compiled, { filename: `${source.fileName}#real-declarations` }).runInContext(context, {
      timeout: options.evaluationTimeout || 5000,
    });
    return factory(bindings, requireFrom(source.fileName));
  }

  return { load, extract, context };
}

/** 跨 vm realm 的普通 JSON 结果统一成主 realm，再用 deepStrictEqual 比。 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 内存 localStorage；失败注入只影响这个桩，不碰浏览器/磁盘存储。 */
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  let failure = null;
  return {
    values,
    writes,
    failNext(error = new Error('TEST_STORAGE_WRITE_FAILED')) { failure = error; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) {
      if (failure) { const error = failure; failure = null; throw error; }
      values.set(String(key), String(value));
      writes.push({ key: String(key), value: String(value) });
    },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  };
}

function createSuite(title) {
  const cases = [];
  function test(name, run) { cases.push({ name, run }); }
  async function run() {
    let passed = 0;
    let failed = 0;
    console.log(`\n${title}（真实源码 + 内存桩；不是真机/真实 SQLite 验收）`);
    for (const entry of cases) {
      let timeout;
      try {
        await Promise.race([
          Promise.resolve().then(entry.run),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('用例超过 15 秒，可能有未完成的异步分支')), 15000); }),
        ]);
        passed++;
        console.log(`  ok  ${entry.name}`);
      } catch (error) {
        failed++;
        console.error(`  FAIL  ${entry.name}`);
        console.error(error && error.stack ? error.stack : error);
      } finally {
        clearTimeout(timeout);
      }
    }
    console.log(`\n${title}：${passed} 项通过，${failed} 项失败，共 ${cases.length} 项`);
    return { passed, failed, total: cases.length };
  }
  return { test, run };
}

module.exports = {
  ROOT,
  createLoader,
  createSuite,
  deferred,
  findDeclaration,
  memoryStorage,
  parseSource,
  plain,
  readSource,
  ts,
};

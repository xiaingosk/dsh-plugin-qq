/**
 * 验证 npm 包解包后能否被 DSH 正常加载。
 *
 * 关键点：这个目录在 profile 的 node_modules 下面，所以 Node 会逐级向上查找
 * `@deepseek-ai/*`。能 import 成功，就说明**不需要**现在那个 node_modules
 * junction 的 hack，从 npm 装也能跑。
 */
const pkg = process.argv[2]
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/')

let failed = 0
const ok = (m) => console.log('  ✅ ' + m)
const bad = (m) => {
  console.log('  ❌ ' + m)
  failed++
}

console.log('\n[1] 服务端入口能否 import（依赖能否解析）')
try {
  const m = await import(toUrl(pkg + '/lib/index.js'))
  ok('import 成功')
  console.log('     name   =', m.name)
  console.log('     inject =', JSON.stringify(m.inject))
  console.log('     apply  =', typeof m.apply)
  for (const k of ['name', 'inject', 'apply']) {
    if (!(k in m)) bad('缺导出: ' + k)
  }
  if (!failed) ok('DSH 只认这三个字段，齐全')
} catch (e) {
  bad('import 失败: ' + e.message)
  console.log((e.stack ?? '').split('\n').slice(0, 6).join('\n'))
}

console.log('\n[2] 客户端文件')
try {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(pkg + '/client/client.js', 'utf8')
  if (!src.includes('__ModuleLoader__.load')) bad('没有 __ModuleLoader__.load 调用')
  else ok('有 __ModuleLoader__.load 调用')
  if (!src.includes('factory')) bad('没有 factory')
  else ok('有 factory')
  console.log('     大小', src.length, '字符')
} catch (e) {
  bad('读不到: ' + e.message)
}

console.log('\n[3] DSH 加载器要读的元数据')
try {
  const { readFileSync } = await import('node:fs')
  const p = JSON.parse(readFileSync(pkg + '/package.json', 'utf8'))
  const patch = p.dsh?.bundle?.patch
  console.log('     dsh.bundle.patch    =', patch)
  console.log('     dsh.client.platform =', p.dsh?.client?.platform)
  console.log('     exports "."         =', p.exports?.['.'])
  console.log('     exports "./client"  =', p.exports?.['./client'])
  console.log('     private             =', p.private ?? '(未设置 → 可发布)')
  console.log('     version             =', p.version)
  if (!patch) bad('缺 dsh.bundle.patch')
  else {
    const { existsSync } = await import('node:fs')
    if (!existsSync(pkg + '/cordis.patch.yml')) bad('patch 指向的文件不存在')
    else ok('patch 文件存在')
  }
  if (p.private === true) bad('private 还是 true，发不出去')
  else ok('不是 private')
  if (p.version !== '0.1.0') bad('版本号不是 0.1.0：' + p.version)
  else ok('版本号 0.1.0')
} catch (e) {
  bad('元数据读取失败: ' + e.message)
}

console.log('\n[4] 纯函数模块能否单独 import')
for (const f of ['quote.js', 'napcat-config.js', 'napcat-detect.js', 'config.js', 'onebot.js', 'md-to-plain.js', 'rpc.js']) {
  try {
    await import(toUrl(pkg + '/lib/' + f))
    ok(f)
  } catch (e) {
    bad(f + ' → ' + e.message)
  }
}

console.log(failed === 0 ? '\n包验证全部通过\n' : `\n有 ${failed} 项失败\n`)
process.exit(failed === 0 ? 0 : 1)

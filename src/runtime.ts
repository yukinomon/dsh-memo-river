/**
 * src/runtime.ts — 路径解析 + 日志（DESIGN.md §9 数据与存储）。
 *
 * 路径：`~/.dsh/memo-river/<workspace-hash>/knowledge_base.sqlite`
 * **文件名必须是 `knowledge_base.sqlite`**——原生 IR 用 dirname(db.name) 反推目录。
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'

/** DSH_HOME 优先：web 进程 homedir 可能与 DSH_HOME 不一致（部署常见）。 */
export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function memoRiverRoot(): string {
  return join(dshHome(), 'memo-river')
}

/** 工作区哈希：cwd 的 sha256 前 16 位（十进制不可读，故另写 workspace.json 供人看）。 */
export function workspaceHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

export interface WorkspacePaths {
  cwd: string
  hash: string
  root: string
  dbPath: string
  embCachePath: string
  artifactCachePath: string
  healthLogPath: string
  pendingDir: string
  logPath: string
  /** 日记本桶名（diary_name），DESIGN §6.2「本桶=…」。 */
  bucket: string
  /**
   * 日记目录（读侧扫描根：接续锚 `lastDiaryTail`、委托引导 `scanTagAxis`）。
   *
   * 缺省派生 `root/dailynote/<bucket>`（本工作区自己的日记本）；`Config.diaryDir`
   * 非空时**原样**指向外部真源目录（如 VCP 的 `diaries/<bucket>/`）。
   *
   * ⚠ 该目录本插件**只读**：`ensureWorkspaceDirs` 不为它建目录，写侧（tools.ts）
   * 仍落自己的工作区根——外部真源一个字节都不碰。
   */
  diaryDir: string
}

/** 日记目录解析（**唯一实现**）：显式 override 优先，否则沿用派生。
 *
 * 两处调用点（workspacePaths / workspacePathsAtRoot）必须同口径——分散派生
 * 是这类静默 bug 的温床（override 在一条路径生效、另一条不生效＝同配置两种行为）。 */
function resolveDiaryDir(root: string, bucket: string, override?: string): string {
  const o = override?.trim()
  return o ? o : join(root, 'dailynote', bucket)
}

export function workspacePaths(
  cwd: string,
  bucketOverride?: string,
  logFileOverride?: string,
  diaryDirOverride?: string,
): WorkspacePaths {
  const hash = workspaceHash(cwd)
  const root = join(memoRiverRoot(), hash)
  const bucket = (bucketOverride && bucketOverride.trim()) || basename(cwd) || 'workspace'
  return {
    cwd,
    hash,
    root,
    dbPath: join(root, 'knowledge_base.sqlite'),
    embCachePath: join(root, 'emb-cache.json'),
    artifactCachePath: join(root, 'artifact-cache.json'),
    healthLogPath: join(root, 'health.log'),
    pendingDir: join(root, 'pending'),
    logPath: logFileOverride || join(root, 'memo-river.log'),
    bucket,
    diaryDir: resolveDiaryDir(root, bucket, diaryDirOverride),
  }
}

/** 票 01（recall-quality-0916）：按**已存在**的状态目录构造路径（memo_recall folder 真路由用）。
 *
 * 与 workspacePaths 的差别：hash/root 来自解析结果而非从 cwd 推导——跨桶路由只允许
 * 打开注册表里已存在的桶（resolveBucket 保证 hasDb），绝不为陌生桶建目录写 manifest。 */
export function workspacePathsAtRoot(root: string, bucket: string, cwd?: string, diaryDirOverride?: string): WorkspacePaths {
  return {
    cwd: cwd || root,
    hash: basename(root),
    root,
    dbPath: join(root, 'knowledge_base.sqlite'),
    embCachePath: join(root, 'emb-cache.json'),
    artifactCachePath: join(root, 'artifact-cache.json'),
    healthLogPath: join(root, 'health.log'),
    pendingDir: join(root, 'pending'),
    logPath: join(root, 'memo-river.log'),
    bucket,
    diaryDir: resolveDiaryDir(root, bucket, diaryDirOverride),
  }
}

/** 建目录 + 写 workspace.json（人类可读的工作区↔哈希映射）。 */
export function ensureWorkspaceDirs(paths: WorkspacePaths): void {
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.pendingDir, { recursive: true })
  const manifest = join(paths.root, 'workspace.json')
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      JSON.stringify({ cwd: paths.cwd, bucket: paths.bucket, hash: paths.hash, createdAt: new Date().toISOString() }, null, 2),
    )
  }
}

type Level = 'info' | 'warn' | 'error'

/**
 * 逐条 append 的日志器。
 * **永不抛**——日志失败必须静默（DESIGN §6.5「失败降级为不注入 + 记日志，绝不阻塞主流程」）。
 */
export class Logger {
  private readonly sinks: ((line: string) => void)[] = []

  constructor(
    private readonly logPath: string,
    private readonly mirror?: (level: Level, message: string) => void,
  ) {}

  private write(level: Level, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, line + '\n')
    } catch {
      /* 日志落盘失败静默 */
    }
    try {
      this.mirror?.(level, message)
    } catch {
      /* mirror 失败静默 */
    }
    for (const sink of this.sinks) {
      try {
        sink(line)
      } catch {
        /* sink 失败静默 */
      }
    }
  }

  /** 测试/回归可挂一个内存 sink 抓日志（验收 #9「注入跳过 + 日志」取证用）。 */
  onLine(sink: (line: string) => void): () => void {
    this.sinks.push(sink)
    return () => {
      const i = this.sinks.indexOf(sink)
      if (i >= 0) this.sinks.splice(i, 1)
    }
  }

  info(message: string): void {
    this.write('info', message)
  }

  warn(message: string): void {
    this.write('warn', message)
  }

  error(message: string): void {
    this.write('error', message)
  }
}

/** 读 VCP 风格 config.env（`KEY=VALUE` 逐行，不覆盖已有 env）。 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    if (!existsSync(path)) return out
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const value = m[2]!.trim().replace(/^["']|["']$/g, '')
      out[m[1]!] = value
      if (!(m[1]! in env)) env[m[1]!] = value
    }
  } catch {
    /* 读不到就返回已解析的部分 */
  }
  return out
}

/** 读 JSON 文件，坏文件返回 fallback（缓存损坏不得阻塞主流程）。 */
export function readJsonSafe<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJsonSafe(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  } catch {
    /* 缓存写失败静默 */
  }
}

/** token 估算：CJK 按 1 token/字，其余按 4 字符/token（硬预算用，DESIGN §6.3）。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x2e80 && c <= 0x9fff) cjk += 1
    else if (c >= 0xf900 && c <= 0xfaff) cjk += 1
    else if (c >= 0xff00 && c <= 0xffef) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 正文规范化：剥掉 `# 标题` 行与 `Tag:` 行后压平为一段。
 *
 * ⚠ **必须与 `render.excerpt` 共用同一套过滤** —— 两处一旦不一致就出静默 bug：
 * 预算截断（`firstSentence`）产出的「首句」若以 `#` 开头，再经 `excerpt` 就被整行
 * 滤掉，注入块里的正文行凭空消失。实测 4 篇日记 **100% 中招**（首句分别以
 * `# GIA 导出…` / `# Blender 与…` / `# 双记忆系统…` / `# 开工索引…` 开头），
 * 表现为「没被截断的那条有正文、被截断的两条没有」。
 */
export function proseText(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !/^Tag\s*[:：]/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 取首句（`::Truncate` 语义：保 role 与首句，DESIGN §6.3）。
 *
 * `minChars` 是**退化首句防线**：日记正文常以孤立的元信息行开头（实测语料里
 * 两篇的首句就是 `"2026-09-12。"` 共 11 字），截断后等于什么都没给。所以首句
 * 不够长就继续并到下一句，仍不够则退回整段的前 `maxChars`。
 *
 * 这个缺陷此前被 `excerpt` 的空串 bug 掩盖（正文行整个不显示，看不出首句很弱）。
 */
export function firstSentence(text: string, maxChars = 120, minChars = 20): string {
  const flat = proseText(text)
  if (!flat) return ''
  let head = ''
  const re = /[。！？!?]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flat)) !== null) {
    head = flat.slice(0, m.index + 1)
    if (head.length >= minChars) break
  }
  if (!head) head = flat
  return head.length > maxChars ? head.slice(0, maxChars) + '…' : head
}

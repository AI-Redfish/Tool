import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { err } from './errors.js';

/**
 * TaskStore（DESIGN §9.1）：本地事务存储（node:sqlite，Node ≥ 24）。
 * 任务/动作账本/幂等/审批 grant/会话/artifact/预约锁，全部在同一库内原子提交。
 * 单宿主持锁使用；跨宿主通过 API 访问（第二宿主直接打开库会被文件锁/状态锁拒绝）。
 */

export interface TaskRow {
  taskId: string;
  sessionId: string;
  principal: string;
  mode: string;
  status: string;
  pauseReason: string | null;
  revision: number;
  requestJson: string;
  cursor: number;
  varsJson: string;
  resultsJson: string;
  metricsJson: string;
  errorJson: string | null;
  goalJson: string | null;
  planJson: string | null;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number | null;
}

export interface SessionRow {
  sessionId: string;
  principal: string;
  status: string;
  pageId: string | null;
  allowedJson: string;
  modelJson: string;
}

export interface ArtifactRow {
  artifactId: string;
  taskId: string;
  filename: string;
  size: number;
  sha256: string;
  path: string;
  createdAt: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, principal TEXT NOT NULL,
  mode TEXT NOT NULL, status TEXT NOT NULL, pause_reason TEXT, revision INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  vars_json TEXT NOT NULL DEFAULT '{}', results_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT, goal_json TEXT, plan_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deadline_at INTEGER
);
CREATE TABLE IF NOT EXISTS actions (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL,
  action_json TEXT, detail_json TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS idempotency (
  pkey TEXT PRIMARY KEY, body_hash TEXT NOT NULL, task_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action_revision INTEGER NOT NULL,
  token TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY, principal TEXT NOT NULL, status TEXT NOT NULL,
  page_id TEXT, allowed_json TEXT NOT NULL, model_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, filename TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(DDL);
    this.migrate();
  }

  /** 轻量迁移：为早期库补齐后增列（新库由 DDL 直接包含）。 */
  private migrate(): void {
    const cols = (this.db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('plan_json')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN plan_json TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  /** 事务：node:sqlite 为同步 API，进程内串行；BEGIN IMMEDIATE 防止并发写。 */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 已回滚 */
      }
      throw e;
    }
  }

  // ---- sessions ----
  upsertSession(s: SessionRow): void {
    this.db.prepare(
      `INSERT INTO sessions (session_id, principal, status, page_id, allowed_json, model_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET status=excluded.status, page_id=excluded.page_id,
         allowed_json=excluded.allowed_json, model_json=excluded.model_json, updated_at=excluded.updated_at`,
    ).run(s.sessionId, s.principal, s.status, s.pageId, s.allowedJson, s.modelJson, Date.now(), Date.now());
  }

  getSession(sessionId: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : undefined;
  }

  listSessionsByStatus(status: string): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE status = ?').all(status) as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  // ---- tasks ----
  insertTask(t: TaskRow): void {
    this.db.prepare(
      `INSERT INTO tasks (task_id, session_id, principal, mode, status, pause_reason, revision, request_json,
        cursor, vars_json, results_json, metrics_json, error_json, goal_json, plan_json, created_at, updated_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.taskId, t.sessionId, t.principal, t.mode, t.status, t.pauseReason, t.revision, t.requestJson,
      t.cursor, t.varsJson, t.resultsJson, t.metricsJson, t.errorJson, t.goalJson, t.planJson, t.createdAt, t.updatedAt, t.deadlineAt);
  }

  getTask(taskId: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
    return r ? rowToTask(r) : undefined;
  }

  /**
   * 乐观 revision 转移：WHERE revision=? 保证取消/恢复/完成的原子性。
   * 合并语义：patch 中 undefined 的字段保留现值（null 表示清除）——
   * 绝不能因部分更新把 cursor/vars/results 重置，否则恢复时会重放已执行动作。
   */
  transition(taskId: string, expectedRevision: number, patch: {
    status?: string;
    pauseReason?: string | null;
    errorJson?: string | null;
    goalJson?: string | null;
    planJson?: string | null;
    cursor?: number;
    varsJson?: string;
    resultsJson?: string;
    metricsJson?: string;
  }): number {
    return this.tx(() => {
      const cur = this.getTask(taskId);
      if (!cur || cur.revision !== expectedRevision) return 0;
      const next = {
        status: patch.status ?? cur.status,
        pauseReason: patch.pauseReason !== undefined ? patch.pauseReason : cur.pauseReason,
        errorJson: patch.errorJson !== undefined ? patch.errorJson : cur.errorJson,
        goalJson: patch.goalJson !== undefined ? patch.goalJson : cur.goalJson,
        planJson: patch.planJson !== undefined ? patch.planJson : cur.planJson,
        cursor: patch.cursor ?? cur.cursor,
        varsJson: patch.varsJson ?? cur.varsJson,
        resultsJson: patch.resultsJson ?? cur.resultsJson,
        metricsJson: patch.metricsJson ?? cur.metricsJson,
      };
      const res = this.db.prepare(
        `UPDATE tasks SET status=?, pause_reason=?, error_json=?, goal_json=?, plan_json=?, cursor=?, vars_json=?,
          results_json=?, metrics_json=?, revision=revision+1, updated_at=? WHERE task_id=? AND revision=?`,
      ).run(
        next.status, next.pauseReason, next.errorJson, next.goalJson, next.planJson, next.cursor, next.varsJson,
        next.resultsJson, next.metricsJson, Date.now(), taskId, expectedRevision,
      );
      return Number(res.changes);
    });
  }

  listStale(statuses: string[]): TaskRow[] {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders})`).all(...statuses) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  // ---- 动作账本 ----
  setActionState(taskId: string, seq: number, state: string, actionJson?: string, detailJson?: string): void {
    this.db.prepare(
      `INSERT INTO actions (task_id, seq, state, action_json, detail_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, seq) DO UPDATE SET state=excluded.state, detail_json=excluded.detail_json, updated_at=excluded.updated_at`,
    ).run(taskId, seq, state, actionJson ?? null, detailJson ?? null, Date.now());
  }

  maxActionSeq(taskId: string): number {
    const r = this.db.prepare('SELECT MAX(seq) AS m FROM actions WHERE task_id = ?').get(taskId) as { m: number | null };
    return Number(r.m ?? 0);
  }

  /** 崩溃恢复：未收口的 prepared/in_flight 动作（对账而非重放，DESIGN §9.1）。 */
  unresolvedActions(): Array<{ taskId: string; seq: number; state: string }> {
    const rows = this.db.prepare("SELECT task_id, seq, state FROM actions WHERE state IN ('prepared','in_flight')").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({ taskId: String(r.task_id), seq: Number(r.seq), state: String(r.state) }));
  }

  /** 某任务全部 unknown 行（隔离自愈/审计用）。 */
  unresolvedActionsByTask(taskId: string): Array<{ taskId: string; seq: number; state: string }> {
    return this.unresolvedActions().filter((u) => u.taskId === taskId);
  }

  unknownActionsByTask(taskId: string): Array<{ taskId: string; seq: number }> {
    const rows = this.db.prepare("SELECT task_id, seq FROM actions WHERE task_id = ? AND state = 'unknown'").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ taskId: String(r.task_id), seq: Number(r.seq) }));
  }

  // ---- 幂等 ----
  findIdempotent(pkey: string): { bodyHash: string; taskId: string } | undefined {
    const r = this.db.prepare('SELECT body_hash, task_id FROM idempotency WHERE pkey = ?').get(pkey) as { body_hash: string; task_id: string } | undefined;
    return r ? { bodyHash: r.body_hash, taskId: r.task_id } : undefined;
  }

  /** 幂等记录与任务创建在同一事务内原子提交（DESIGN §8.3）。 */
  putIdempotent(pkey: string, bodyHash: string, taskId: string): void {
    try {
      this.db.prepare('INSERT INTO idempotency (pkey, body_hash, task_id, created_at) VALUES (?, ?, ?, ?)').run(pkey, bodyHash, taskId, Date.now());
    } catch {
      const existing = this.findIdempotent(pkey);
      if (existing && existing.bodyHash !== bodyHash) {
        throw err('IDEMPOTENCY_CONFLICT', '相同 Idempotency-Key 但请求体不同');
      }
    }
  }

  /** 幂等记录拟保留 24h（DESIGN §9.1）；过期后不承诺去重。返回删除行数。 */
  pruneIdempotency(olderThanMs: number, now = Date.now()): number {
    const res = this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(now - olderThanMs);
    return Number(res.changes);
  }

  // ---- 审批 grant ----
  putGrant(g: { grantId: string; taskId: string; actionRevision: number; token: string; expiresAt: number }): void {
    // 同一 grant 重复 approve 幂等（不覆盖已消费状态；重放由 grant_id 主键保护）
    this.db.prepare(
      'INSERT OR IGNORE INTO grants (grant_id, task_id, action_revision, token, consumed, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).run(g.grantId, g.taskId, g.actionRevision, g.token, g.expiresAt, Date.now());
  }

  findGrant(taskId: string, actionRevision: number): { grantId: string; token: string } | undefined {
    const r = this.db.prepare(
      'SELECT grant_id, token FROM grants WHERE task_id = ? AND action_revision = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1',
    ).get(taskId, actionRevision) as { grant_id: string; token: string } | undefined;
    return r ? { grantId: r.grant_id, token: r.token } : undefined;
  }

  /** 原子消费：changes=1 才算拿到（DESIGN §8.2 派发前消费）。 */
  consumeGrant(grantId: string): boolean {
    const res = this.db.prepare('UPDATE grants SET consumed = 1 WHERE grant_id = ? AND consumed = 0').run(grantId);
    return Number(res.changes) === 1;
  }

  // ---- artifacts ----
  putArtifact(a: ArtifactRow): void {
    this.db.prepare('INSERT INTO artifacts (artifact_id, task_id, filename, size, sha256, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.artifactId, a.taskId, a.filename, a.size, a.sha256, a.path, a.createdAt);
  }

  getArtifact(artifactId: string): ArtifactRow | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as Record<string, unknown> | undefined;
    return r
      ? {
          artifactId: String(r.artifact_id),
          taskId: String(r.task_id),
          filename: String(r.filename),
          size: Number(r.size),
          sha256: String(r.sha256),
          path: String(r.path),
          createdAt: Number(r.created_at),
        }
      : undefined;
  }

  listArtifactsByTask(taskId: string): ArtifactRow[] {
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToArtifact);
  }

  /** 终态任务的过期 artifact（拟保留 24h，DESIGN §9.1）；调用方负责删文件后调 deleteArtifact。 */
  artifactsOfTerminalTasksOlderThan(cutoff: number): ArtifactRow[] {
    const rows = this.db.prepare(
      `SELECT a.* FROM artifacts a JOIN tasks t ON a.task_id = t.task_id
       WHERE a.created_at < ? AND t.status IN ('done','failed','expired','cancelled')`,
    ).all(cutoff) as Array<Record<string, unknown>>;
    return rows.map(rowToArtifact);
  }

  deleteArtifact(artifactId: string): void {
    this.db.prepare('DELETE FROM artifacts WHERE artifact_id = ?').run(artifactId);
  }

  // ---- kv（预约/隔离/锁） ----
  kvGet(key: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    return r?.v;
  }

  kvSet(key: string, v: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, v);
  }

  kvDel(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE k = ?').run(key);
  }
}

function rowToArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    artifactId: String(r.artifact_id),
    taskId: String(r.task_id),
    filename: String(r.filename),
    size: Number(r.size),
    sha256: String(r.sha256),
    path: String(r.path),
    createdAt: Number(r.created_at),
  };
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    taskId: String(r.task_id),
    sessionId: String(r.session_id),
    principal: String(r.principal),
    mode: String(r.mode),
    status: String(r.status),
    pauseReason: (r.pause_reason as string) ?? null,
    revision: Number(r.revision),
    requestJson: String(r.request_json),
    cursor: Number(r.cursor),
    varsJson: String(r.vars_json),
    resultsJson: String(r.results_json ?? '[]'),
    metricsJson: String(r.metrics_json),
    errorJson: (r.error_json as string) ?? null,
    goalJson: (r.goal_json as string) ?? null,
    planJson: (r.plan_json as string) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    deadlineAt: (r.deadline_at as number) ?? null,
  };
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    sessionId: String(r.session_id),
    principal: String(r.principal),
    status: String(r.status),
    pageId: (r.page_id as string) ?? null,
    allowedJson: String(r.allowed_json),
    modelJson: String(r.model_json),
  };
}

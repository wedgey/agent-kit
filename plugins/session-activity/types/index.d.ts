export type AgentStatusWord = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  type: string
  description: string
  status: AgentStatusWord
  parentId?: string
  name?: string
  firstSeenAt: number
  endedAt?: number
}

export type AgentMetrics = {
  startedAt?: number
  toolUses: number
  tokens: number
  activity: string[]
  prompt?: string
  model?: string
  effort?: string
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'exited'

export type ShellTask = {
  id: string
  kind: 'shell' | 'monitor'
  command: string
  shellCommand?: string
  description?: string
  agentId?: string
  startedAt: number
  endedAt?: number
  status: TaskStatus
  exitCode?: number
  outputPath?: string
  lastLine?: string
  lastOutputAt?: number
  outputSize?: number
  shellPid?: number
  pgid?: number
  pids: number[]
  ports: number[]
  cpu: number
  rssKb: number
  peakRssKb?: number
  isNotified?: boolean
}

export type Orphan = {
  pid: number
  args: string
  ports: number[]
  taskId: string
  command: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'skipped'

export type TodoItem = { content: string; status: TodoStatus; note?: string; ticket?: string; lane?: string; startedAt?: number }

// One entry of `claude agents --json`; `state` is set on background sessions only.
export type LaneEntry = { name: string; sessionId: string; kind?: string; status?: string; state?: string; waitingFor?: string; startedAt?: number }

export type LaneProgress = { done: number; total: number; now: string[]; next?: string }

// A lane as last read: missing when no session has its name; progress only once its list was read.
export type LaneReading = { isMissing: true } | { isMissing?: false; state: string; waitingFor?: string; startedAt?: number; sessionId: string; progress?: LaneProgress }

export type TodoList = { title?: string; link?: string; items: TodoItem[] }

export type Verdict = 'PASS' | 'PASS+NOTES' | 'ISSUES' | 'BLOCKED' | 'FAIL'

export type SpawnInfo = {
  todo?: string
  wantModel?: string
  wantEffort?: string
  isReadOnly?: boolean
  isolation?: string
  verdict?: Verdict
  escalatedFrom?: string
  treeBefore?: string[]
  changedFiles?: number
  isFinished?: boolean
}

// What conductor's `queue.mjs status --json` prints. null is a reading it could not take: an orphan's
// process may be unknown, an "unknown" holder unread, and /proc/meminfo unreadable.
export type QueueHolder = {
  slot: number
  pid: number | null
  cwd: string | null
  command: string | null
  ageMs: number | null
  state: 'busy' | 'idle' | 'unknown' | 'orphan'
  cpuPct: number | null
  memKb: number | null
}

export type QueueWaiter = { ticket: string; pid: number | null; cwd: string | null; command: string | null; priority: 'gate' | 'normal'; rank: number; waitedMs: number }

export type HeavyQueue = { name: string; slots: number; slotsSource: string; holders: QueueHolder[]; waiters: QueueWaiter[] }

export type QueueStatus = {
  protocol?: number
  queues: HeavyQueue[]
  machine: { cores: number; load1: number; memAvailKb: number | null; memTotalKb: number | null }
}

export type BranchHealth = { branch: string; trunk?: string; behind?: number; changed: number; pr?: number; repo?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-activity': {
      agents: AgentRow[]
      metrics: Record<string, AgentMetrics>
      shells: ShellTask[]
      orphans: Orphan[]
      confirm: string
      expanded: string[]
      rootPid: number
      todos: TodoList
      spawns: Record<string, SpawnInfo>
      branch: BranchHealth
      spend: Record<string, number>
      queue: QueueStatus | null
      queueNote: string
      queueOwn: number[]
      lanes: Record<string, LaneReading>
    }
  }
}

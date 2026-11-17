import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvedIssue, GhTransport, type GitHubTransport } from './github.js';
import { paths } from './supervised.js';
import { StateStore, type TaskState } from './state.js';

const home = homedir();
const root = join(home, '.local/state/fair-platform');
const statusPath = join(root, 'queue.json');
const launchPath = join(root, 'supervised.launch');
const lockPath = join(root, 'supervised.lock');
const tokenPath = join(home, '.local/share/fair-platform/github-token');
const owner = 'h-zare-dev';
const repo = 'h-zare-dev/fair-platform';
export type QueueStatus = { status: 'IDLE'|'RUNNING'|'PAUSED_QUOTA'|'BLOCKED_APPROVAL'|'BLOCKED_RECONCILIATION'|'DONE'; issue?: number; phase?: string | undefined; sha?: string | undefined; queueCount: number; pid?: number | undefined; lastError?: string; nextAction: string };
export function eligibleIssues(api: GitHubTransport): number[] {
  const result: number[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = api.get(`/repos/${repo}/issues?state=open&labels=agent%3Aapproved&per_page=100&page=${page}`) as {number?:number;pull_request?:unknown;labels?:{name:string}[]}[];
    if (!Array.isArray(rows)) throw new Error('Invalid issue listing');
    for (const row of rows) if (Number.isSafeInteger(row.number) && !row.pull_request && !row.labels?.some(x => x.name === 'agent:blocked')) result.push(row.number!);
    if (rows.length < 100) return [...new Set(result)].sort((a,b) => a-b);
  }
  throw new Error('Issue listing exceeds verified page bound');
}
export function safeTaskDisposition(state: TaskState | undefined): 'new'|'resume'|'done'|'blocked' {
  if (!state) return 'new';
  if (state.inFlight || state.pendingReport) return 'blocked';
  if (['DONE','READY_FOR_OWNER_REVIEW'].includes(state.phase)) return 'done';
  if (state.phase === 'BLOCKED') return 'blocked';
  return 'resume';
}
function privateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe private file');
  return readFileSync(path, 'utf8');
}
function saveStatus(status: QueueStatus): void {
  mkdirSync(root, {recursive:true,mode:0o700});
  const temp = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(status), {mode:0o600});
  renameSync(temp, statusPath);
}
function reservationIssue(): number | undefined {
  if (!existsSync(launchPath)) return undefined;
  const value = JSON.parse(privateFile(launchPath)) as {issue?:number;session?:string};
  if (!Number.isSafeInteger(value.issue) || value.session !== `fair-task-${value.issue}`) throw new Error('Invalid launch reservation');
  return value.issue;
}
function liveRunner(issue: number): number | undefined {
  const session = `fair-task-${issue}`;
  const result = spawnSync('/usr/bin/tmux', ['display-message','-p','-t',`=${session}:runner`,'#{pane_pid}'], {encoding:'utf8'});
  const pid = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isSafeInteger(pid) || pid < 2) return undefined;
  try { readFileSync(`/proc/${pid}/stat`); return pid; } catch { return undefined; }
}
export function queueStep(api: GitHubTransport, run: (issue:number)=>void, developmentSha: string): QueueStatus {
  const numbers = eligibleIssues(api);
  const reserved = reservationIssue();
  if (reserved !== undefined) {
    const pid = liveRunner(reserved);
    const state = new StateStore(paths(reserved).state).load();
    if (pid) return {status:'RUNNING', issue:reserved, pid, phase:state?.phase, sha:state?.headSha, queueCount:numbers.length, nextAction:'Wait for verified runner'};
    return {status:'BLOCKED_RECONCILIATION',issue:reserved,phase:state?.phase,sha:state?.headSha,queueCount:numbers.length,lastError:'STALE_RESERVATION',nextAction:'Owner must adjudicate reservation and exact receipt before clearing it'};
  }
  const lock = spawnSync('/usr/bin/flock',['-n','-E','75',lockPath,'/usr/bin/true'],{stdio:'ignore'});
  if (lock.status === 75) return {status:'RUNNING',queueCount:numbers.length,nextAction:'Wait for global lock holder'};
  if (lock.status !== 0) return {status:'BLOCKED_RECONCILIATION',queueCount:numbers.length,lastError:'LOCK_PROBE_FAILED',nextAction:'Inspect global lock'};
  let blocked = false;
  let completed = false;
  for (const issue of numbers) {
    let state: TaskState | undefined;
    try { state = new StateStore(paths(issue).state).load(); } catch { blocked = true; continue; }
    const disposition = safeTaskDisposition(state);
    if (disposition === 'done') { completed = true; continue; }
    if (disposition === 'blocked') { blocked = true; continue; }
    try {
      const approved = approvedIssue(api,issue,owner,true);
      if (approved.baseSha !== developmentSha || (state && (state.specSha !== approved.specSha || state.baseSha !== approved.baseSha))) { blocked = true; continue; }
      run(issue);
      return {status:'RUNNING',issue,phase:state?.phase ?? 'QUEUED',sha:state?.headSha,queueCount:numbers.length,nextAction:'Observe reserved tmux runner'};
    } catch { blocked = true; }
  }
  return {status:blocked?'BLOCKED_APPROVAL':completed?'DONE':'IDLE',queueCount:numbers.length,nextAction:blocked?'Inspect pinned approvals and task state':'Wait for new approved issue'};
}
function gh(): GhTransport {
  const token = privateFile(tokenPath).trim();
  const which = spawnSync('/usr/bin/which',['gh'],{encoding:'utf8'});
  if (which.status !== 0) throw new Error('GitHub CLI unavailable');
  return new GhTransport(token,which.stdout.trim());
}
function development(api: GitHubTransport): string {
  const ref = api.get(`/repos/${repo}/git/ref/heads/development`) as {object?:{sha?:string}};
  if (!/^[a-f0-9]{40}$/.test(ref.object?.sha ?? '')) throw new Error('Invalid development ref');
  return ref.object!.sha!;
}
function main(): void {
  const command = process.argv[2];
  if (command === 'status') {
    const status: QueueStatus = existsSync(statusPath) ? JSON.parse(privateFile(statusPath)) as QueueStatus : {status:'IDLE',queueCount:0,nextAction:'Enable queue service'};
    if (status.issue) {
      const pid = liveRunner(status.issue);
      if (!pid && status.status === 'RUNNING') { status.status = 'BLOCKED_RECONCILIATION'; status.nextAction = 'Inspect saved task and reservation'; delete status.pid; }
      else status.pid = pid;
    }
    process.stdout.write(`${JSON.stringify(status)}\n`); return;
  }
  if (command !== 'worker') throw new Error('Usage: queue.js worker|status');
  let stopping = false;
  process.on('SIGTERM',()=>{stopping=true;});
  const tick = () => {
    try {
      const api = gh();
      const status = queueStep(api, issue => {
        const child = spawnSync(process.execPath,[resolve('scripts/orchestrator/dist/supervised.js'),'start',String(issue)],{stdio:'ignore'});
        if (child.status !== 0) throw new Error('Supervised launch refused');
      },development(api));
      saveStatus(status);
    } catch { saveStatus({status:'BLOCKED_RECONCILIATION',queueCount:0,lastError:'QUEUE_POLL_FAILED',nextAction:'Inspect private service journal and GitHub connectivity'}); }
    if (!stopping) setTimeout(tick,30_000);
  };
  tick();
}
if (process.argv[1]?.endsWith('/queue.js')) main();

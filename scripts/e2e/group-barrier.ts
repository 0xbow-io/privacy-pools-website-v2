// @ts-nocheck - Bun runtime APIs; see ci.ts.
//
// Holds the parallel e2e-sepolia groups to one phase order across runners
// (why: the phase comment in scripts/e2e/ci.ts). ci.ts runs in the background
// and writes flags into E2E_PHASE_DIR; the workflow steps use this script to
//   follow <flag>          stream ci.ts's log until it writes <flag>, failing
//                          with its exit code if it exits first
//   wait <step> <flag>     wait until the step named <step> has finished in
//                          every group job of this run, then write <flag> so
//                          ci.ts goes on. With --success, every one of those
//                          steps must have succeeded, otherwise this writes
//                          `abort` and fails, and ci.ts stops without spending.
// The step state comes from the run's jobs API (needs `actions: read`).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const DIR = process.env.E2E_PHASE_DIR;
const LOG = process.env.E2E_LOG ?? '/tmp/ci.log';
const GROUP_JOB = /^group \(/;
const MINUTES = Number(process.env.E2E_BARRIER_MINUTES ?? 75);
if (!DIR) throw new Error('E2E_PHASE_DIR is not set');
const [mode, ...rest] = process.argv.slice(2);

function exitCode(): number | null {
  const p = `${DIR}/exit`;
  return existsSync(p) ? Number(readFileSync(p, 'utf8').trim() || 1) : null;
}

/** Print what ci.ts logged since the last call, so each step shows its own part. */
async function flush() {
  if (!existsSync(LOG)) return;
  const offsetFile = `${DIR}/offset`;
  const from = existsSync(offsetFile) ? Number(readFileSync(offsetFile, 'utf8')) : 0;
  const size = statSync(LOG).size;
  if (size <= from) return;
  process.stdout.write(await Bun.file(LOG).slice(from, size).text());
  writeFileSync(offsetFile, String(size));
}

async function follow(flag: string) {
  for (;;) {
    await flush();
    if (flag !== 'exit' && existsSync(`${DIR}/${flag}`)) return 0;
    const code = exitCode();
    if (code !== null) {
      await flush();
      if (flag === 'exit') return code;
      console.log(`ci.ts exited (${code}) before ${flag}`);
      return code || 1;
    }
    await Bun.sleep(2000);
  }
}

async function groupJobs() {
  const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT = '1', GITHUB_TOKEN } = process.env;
  const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`jobs API ${res.status}`);
  return (await res.json()).jobs.filter(j => GROUP_JOB.test(j.name));
}

async function wait(stepName: string, flag: string, needSuccess: boolean) {
  const expected = Number(process.env.E2E_GROUP_COUNT ?? 3);
  const until = Date.now() + MINUTES * 60_000;
  const abort = (why: string) => { writeFileSync(`${DIR}/abort`, why); console.log(`barrier ${flag}: ${why}`); return 1; };
  let last = '';
  while (Date.now() < until) {
    await flush();
    if (exitCode() !== null) return abort('ci.ts on this runner already exited');
    let jobs;
    try { jobs = await groupJobs(); } catch (e) { console.log(String(e)); await Bun.sleep(10_000); continue; }
    const states = jobs.map(j => {
      const step = (j.steps ?? []).find(s => s.name === stepName);
      return { name: j.name, job: j, step };
    });
    const line = states.map(s => `${s.name}: ${s.step ? `${s.step.status}/${s.step.conclusion ?? '-'}` : (s.job.status === 'completed' ? `job ${s.job.conclusion}` : 'not there yet')}`).join(', ');
    if (line !== last) { console.log(`barrier ${flag}: ${line}`); last = line; }
    // A group whose job already ended without finishing the step never will.
    const dead = states.find(s => (s.step && s.step.status === 'completed' && needSuccess && s.step.conclusion !== 'success')
      || (s.job.status === 'completed' && !(s.step?.status === 'completed')));
    if (dead) {
      // Without --success a job that ended has stopped proving, which is all phase 3 needs.
      if (needSuccess) return abort(`${dead.name} did not pass "${stepName}"`);
    }
    const finished = states.filter(s => s.step?.status === 'completed' || (!needSuccess && s.job.status === 'completed'));
    if (jobs.length >= expected && finished.length === jobs.length) {
      writeFileSync(`${DIR}/${flag}`, '');
      console.log(`barrier ${flag}: every group is past "${stepName}"`);
      return 0;
    }
    await Bun.sleep(10_000);
  }
  return abort(`timed out after ${MINUTES} min`);
}

if (mode === 'follow') process.exit(await follow(rest[0]));
if (mode === 'wait') process.exit(await wait(rest[0], rest[1], rest.includes('--success')));
if (mode === 'abort') { writeFileSync(`${DIR}/abort`, 'this runner failed'); process.exit(0); }
throw new Error('usage: group-barrier.ts follow <flag> | wait <step> <flag> [--success] | abort');

#!/usr/bin/env node
/**
 * Collect process data from monitored hosts via SSH.
 * Writes JSON to daemon/public/processes/ for status page drill-down.
 */
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'daemon', 'public', 'processes');
mkdirSync(OUT, { recursive: true });

const HOSTS = [
  { name: 'hillkali01', ip: '10.0.2.7', user: 'kali' },
  { name: 'hillkali02p400', ip: '10.0.2.8', user: 'kali' },
  { name: 'hilldrlx01', ip: '10.0.2.2', user: 'marvho' },
  { name: 'system76-popos', ip: '10.0.2.5', user: 'marvho' },
  { name: 'gx10-hilldr', ip: '100.116.148.95', user: 'wloving' },
];

function exec(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, stdout: '', stderr: stderr || err.message });
      else resolve({ ok: true, stdout, stderr });
    });
  });
}

function parseProcessLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 11) return null;
  return {
    user: parts[0],
    pid: parseInt(parts[1]) || 0,
    cpu: parseFloat(parts[2]) || 0,
    mem: parseFloat(parts[3]) || 0,
    vsz_kb: parseInt(parts[4]) || 0,
    rss_kb: parseInt(parts[5]) || 0,
    stat: parts[7] || '',
    command: parts.slice(10).join(' '),
  };
}

async function collectRemote(host) {
  const sshCmd = `
hostname
echo "---UPTIME---"
uptime
echo "---LOAD---"
cat /proc/loadavg 2>/dev/null || echo "0 0 0"
echo "---MEM---"
free -m 2>/dev/null | grep Mem
echo "---DISK---"
df -h / | tail -1
echo "---PS---"
ps aux --sort=-%cpu 2>/dev/null | head -26
`.trim();

  const result = await exec('ssh', [
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'BatchMode=yes',
    `${host.user}@${host.ip}`,
    sshCmd,
  ], 15000);

  if (!result.ok) {
    return { online: false, error: result.stderr, collected_at: new Date().toISOString() };
  }

  const output = result.stdout;
  const hostname = output.split('\n')[0]?.trim() || host.name;

  function getSection(marker) {
    const start = output.indexOf(`---${marker}---`);
    if (start === -1) return '';
    const after = output.substring(start + marker.length + 6); // skip ---MARKER---\n
    const end = after.indexOf('---');
    return (end === -1 ? after : after.substring(0, end)).trim();
  }

  // Parse uptime
  const uptimeLine = getSection('UPTIME');

  // Parse load
  const loadLine = getSection('LOAD');
  const loadParts = loadLine.split(/\s+/);

  // Parse memory
  const memLine = getSection('MEM');
  const memParts = memLine.split(/\s+/);
  const memTotal = parseInt(memParts[1]) || 0;
  const memUsed = parseInt(memParts[2]) || 0;

  // Parse disk
  const diskLine = getSection('DISK');
  const diskParts = diskLine.split(/\s+/);

  // Parse processes
  const psSection = getSection('PS');
  const psLines = psSection.split('\n');
  const processes = psLines.slice(1) // skip header
    .map(parseProcessLine)
    .filter(p => p !== null);

  return {
    hostname,
    online: true,
    uptime: uptimeLine,
    load: [parseFloat(loadParts[0]) || 0, parseFloat(loadParts[1]) || 0, parseFloat(loadParts[2]) || 0],
    mem_total_mb: memTotal,
    mem_used_mb: memUsed,
    mem_pct: memTotal > 0 ? Math.round(memUsed * 100 / memTotal) : 0,
    disk_used: diskParts[2] || '?',
    disk_total: diskParts[1] || '?',
    disk_pct: parseInt(diskParts[4]) || 0,
    processes,
    collected_at: new Date().toISOString(),
  };
}

async function collectLocal() {
  // Uptime
  const bootResult = await exec('sysctl', ['-n', 'kern.boottime']);
  let uptimeSecs = 0;
  if (bootResult.ok) {
    const match = bootResult.stdout.match(/sec = (\d+)/);
    if (match) uptimeSecs = Math.floor(Date.now() / 1000) - parseInt(match[1]);
  }

  // CPU
  const cpuResult = await exec('sysctl', ['-n', 'hw.ncpu']);
  const ncpu = parseInt(cpuResult.stdout) || 1;

  const loadResult = await exec('sysctl', ['-n', 'vm.loadavg']);
  const loadMatch = loadResult.stdout.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const load = loadMatch ? [parseFloat(loadMatch[1]), parseFloat(loadMatch[2]), parseFloat(loadMatch[3])] : [0, 0, 0];

  // Memory
  const memResult = await exec('sysctl', ['-n', 'hw.memsize']);
  const memTotal = Math.round(parseInt(memResult.stdout) / 1048576);

  // Memory pressure (approximate used)
  const vmResult = await exec('vm_stat', []);
  let memUsed = 0;
  if (vmResult.ok) {
    const pageSize = 16384; // Apple Silicon default
    const active = parseInt(vmResult.stdout.match(/Pages active:\s+(\d+)/)?.[1] || '0');
    const wired = parseInt(vmResult.stdout.match(/Pages wired down:\s+(\d+)/)?.[1] || '0');
    const compressed = parseInt(vmResult.stdout.match(/Pages occupied by compressor:\s+(\d+)/)?.[1] || '0');
    memUsed = Math.round((active + wired + compressed) * pageSize / 1048576);
  }

  // Disk
  const diskResult = await exec('df', ['-h', '/']);
  const diskLine = diskResult.stdout.split('\n')[1] || '';
  const diskParts = diskLine.split(/\s+/);

  // Processes
  const psResult = await exec('ps', ['aux', '-r']);
  const psLines = psResult.stdout.split('\n');
  const processes = psLines.slice(1, 26)
    .map(parseProcessLine)
    .filter(p => p !== null);

  return {
    hostname: 'Marvho-MacMini01',
    online: true,
    uptime_secs: uptimeSecs,
    load,
    ncpu,
    mem_total_mb: memTotal,
    mem_used_mb: memUsed,
    mem_pct: memTotal > 0 ? Math.round(memUsed * 100 / memTotal) : 0,
    disk_used: diskParts[2] || '?',
    disk_total: diskParts[1] || '?',
    disk_pct: parseInt(diskParts[4]) || 0,
    processes,
    collected_at: new Date().toISOString(),
  };
}

// Run all collections in parallel
const results = await Promise.all([
  collectLocal().then(d => { writeFileSync(join(OUT, 'Marvho-MacMini01.json'), JSON.stringify(d, null, 2)); return d; }),
  ...HOSTS.map(h => collectRemote(h).then(d => { writeFileSync(join(OUT, `${h.name}.json`), JSON.stringify(d, null, 2)); return { name: h.name, ...d }; })),
]);

for (const r of results) {
  const name = r.hostname || r.name || '?';
  const status = r.online ? `online (${r.processes?.length || 0} procs)` : 'offline';
  console.log(`  ${name}: ${status}`);
}
console.log(`Collected at ${new Date().toISOString()}`);

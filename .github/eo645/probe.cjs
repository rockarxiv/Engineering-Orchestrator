// Temporary (EO-645): times a process-table look in turbo's environment, then with each variable turbo dropped put back.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const full = JSON.parse(fs.readFileSync(process.env.EO_FULL_ENV_FILE ?? process.argv[2], "utf8"));
const base = { ...process.env };
const have = new Set(Object.keys(base).map((k) => k.toUpperCase()));
const missing = Object.keys(full).filter((k) => !have.has(k.toUpperCase()));
console.log("turbo env:", Object.keys(base).sort().join(" "));
console.log("dropped:", missing.join(" "));
const ps = (base.SystemRoot ?? base.SYSTEMROOT ?? "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const q = "[Console]::Error.WriteLine('started ' + [DateTime]::Now.ToString('HH:mm:ss.fff')); Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";
const look = (env) => new Promise((r) => { const t = Date.now(); execFile(ps, ["-NoProfile", "-NonInteractive", "-Command", q], { env, timeout: 60000, windowsHide: true, maxBuffer: 1 << 26 }, (e, out, err) => r(`${Date.now() - t} ms, ${e ? "ERR" : out.split("\n").length + " lines"}, ${String(err).trim().slice(0, 200)}`)); });
(async () => {
  console.log("full env:", await look(full));
  console.log("turbo env:", await look(base));
  console.log("turbo env again:", await look(base));
  for (const k of missing) console.log(`turbo env + ${k}:`, await look({ ...base, [k]: full[k] }));
})();

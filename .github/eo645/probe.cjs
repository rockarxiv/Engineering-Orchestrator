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
const body = "Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";
const variants = {
  joinPath: "Import-Module -Name (Join-Path $PSHOME 'Modules\\CimCmdlets'); " + body,
  concat: "Import-Module -Name ($PSHOME + '\\Modules\\CimCmdlets'); " + body,
  noAutoload: "$PSModuleAutoLoadingPreference = 'None'; Import-Module -Name ($PSHOME + '\\Modules\\CimCmdlets'); " + body,
};
const run = (env, command) => new Promise((r) => { const t = Date.now(); execFile(ps, ["-NoProfile", "-NonInteractive", "-Command", command], { env, timeout: 60000, windowsHide: true, maxBuffer: 1 << 26 }, (e, out, err) => r(`${Date.now() - t} ms, ${e ? "ERR" : out.split("\n").filter((l) => /^\s*\d+ \d+ \d+\s*$/.test(l)).length + " rows"}, ${String(err).trim().slice(0, 300)}`)); });
(async () => {
  for (const [name, command] of Object.entries(variants)) for (let i = 0; i < 2; i++) console.log(`turbo env, ${name}:`, await run(base, command));
  const { PSModulePath, ...noModulePath } = full;
  for (const k of Object.keys(noModulePath)) if (/^psmodule/i.test(k)) delete noModulePath[k];
  console.log("full env without PSModule*, noAutoload:", await run(noModulePath, variants.noAutoload));
  console.log("full env, noAutoload:", await run(full, variants.noAutoload));
})();

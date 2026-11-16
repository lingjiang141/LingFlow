param(
  [Parameter(Mandatory=$true)][string]$Destination,
  [string]$Source = (Join-Path $env:LOCALAPPDATA 'LingFlow')
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This migration uses a Windows directory junction.' }
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if ($sourcePath -eq $destinationPath -or $destinationPath.StartsWith($sourcePath+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be separate from source.' }
if ($sourcePath -notmatch '^[A-Za-z]:\\.+' -or $destinationPath -notmatch '^[A-Za-z]:\\.+') { throw 'Explicit non-root local directories are required.' }
$sourceItem = Get-Item -LiteralPath $sourcePath -Force
if ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
  $currentTarget = [IO.Path]::GetFullPath([string]@($sourceItem.Target)[0]).TrimEnd('\')
  if ($currentTarget -eq $destinationPath) { @{state='already-migrated';source=$sourcePath;destination=$destinationPath}|ConvertTo-Json;exit 0 }
  throw 'Source is already a junction to another location. Nothing changed.'
}
if (!(Test-Path -LiteralPath (Join-Path $sourcePath 'workflow.sqlite')) -or (Test-Path -LiteralPath (Join-Path $sourcePath '.git'))) { throw 'Source is not a LingFlow data directory.' }
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination already exists; it will not be overwritten.' }
if (Get-ChildItem -LiteralPath $sourcePath -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Nested links require manual inspection. Nothing changed.' }
$config = Get-Content -LiteralPath (Join-Path $sourcePath 'config.json') -Raw | ConvertFrom-Json
if (Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction SilentlyContinue) { throw 'Exit LingFlow and its local service before migration. No process was stopped.' }
$probe = @'
import {DatabaseSync} from 'node:sqlite';import path from 'node:path';import{createHash}from'node:crypto';
const db=new DatabaseSync(path.join(process.argv[1],'workflow.sqlite'),{readOnly:true});
try{const row=db.prepare('SELECT data FROM state WHERE id=1').get().data,s=JSON.parse(row);
if(s.roles.some(r=>r.enabled)||s.checkJobs.some(j=>['queued','launching','uncertain'].includes(j.state)))throw Error('Disable roles and finish/reconcile checks first.');
const integrity=db.prepare('PRAGMA quick_check').get().quick_check;if(integrity!=='ok')throw Error(integrity);
console.log(JSON.stringify({integrity,stateHash:createHash('sha256').update(row).digest('hex'),tasks:s.tasks.length,roles:s.roles.length,checks:s.checkJobs.length,events:db.prepare('SELECT count(*) AS n FROM events').get().n,operations:db.prepare('SELECT count(*) AS n FROM operations').get().n}));
}finally{db.close()}
'@
$beforeState = & node --input-type=module -e $probe -- $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Database preflight failed. Nothing changed.' }
function Inventory([string]$Root) {
  @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    [pscustomobject]@{file=$_.FullName.Substring($Root.Length+1);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
  } | Sort-Object file)
}
function Assert-Same($Left,$Right,[string]$Label) {
  if (($Left|ConvertTo-Json -Depth 4 -Compress) -ne ($Right|ConvertTo-Json -Depth 4 -Compress)) { throw "File verification failed: $Label. All copies retained." }
}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot=Join-Path (Split-Path $destinationPath -Parent) 'LingFlowData-backups'
$backupPath=Join-Path $backupRoot $stamp
$handoffPath=Join-Path (Split-Path $sourcePath -Parent) ((Split-Path $sourcePath -Leaf)+'.moving-'+$stamp)
if ((Test-Path -LiteralPath $backupPath) -or (Test-Path -LiteralPath $handoffPath)) { throw 'Migration paths already exist.' }
$files=Inventory $sourcePath
New-Item -ItemType Directory -Path $destinationPath | Out-Null
Get-ChildItem -LiteralPath $sourcePath -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Recurse -Force }
Assert-Same $files (Inventory $destinationPath) 'destination'
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
Get-ChildItem -LiteralPath $sourcePath -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $backupPath -Recurse -Force }
Assert-Same $files (Inventory $backupPath) 'backup'
Assert-Same $files (Inventory $sourcePath) 'source changed during copy'
if (Get-NetTCPConnection -State Listen -LocalPort $config.port -ErrorAction SilentlyContinue) { throw 'Service restarted during copy; no path switch performed.' }
Move-Item -LiteralPath $sourcePath -Destination $handoffPath
try { New-Item -ItemType Junction -Path $sourcePath -Target $destinationPath | Out-Null }
catch { if (!(Test-Path -LiteralPath $sourcePath)) { Move-Item -LiteralPath $handoffPath -Destination $sourcePath };throw }
Assert-Same $files (Inventory $sourcePath) 'junction'
$afterState = & node --input-type=module -e $probe -- $sourcePath
if ($LASTEXITCODE -ne 0 -or $beforeState -ne $afterState) { throw 'Database verification failed after switch; all backups retained.' }
Assert-Same $files (Inventory $handoffPath) 'handoff changed after switch'
$verifiedHandoff=Get-Item -LiteralPath $handoffPath -Force
if ($verifiedHandoff.FullName -ne $handoffPath -or ($verifiedHandoff.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Split-Path $handoffPath -Parent) -ne (Split-Path $sourcePath -Parent)) { throw 'Refusing unexpected cleanup path.' }
# Only the verified original copy is removed, after two E-drive copies and the junction pass verification.
Remove-Item -LiteralPath $verifiedHandoff.FullName -Recurse -Force
$receipt=@{state='migrated';source=$sourcePath;destination=$destinationPath;backup=$backupPath;files=$files.Count;bytes=($files|Measure-Object bytes -Sum).Sum;database=($afterState|ConvertFrom-Json);junction=$true;originalCopyRemoved=$true}
$receipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $backupRoot ($stamp+'-receipt.json')) -Encoding utf8
$receipt|ConvertTo-Json -Depth 6

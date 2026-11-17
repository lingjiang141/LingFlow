param([Parameter(Mandatory=$true)][string]$CodexRoot,[Parameter(Mandatory=$true)][string]$DshRoot,[Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath=[IO.Path]::GetFullPath($Archive)
if (Test-Path -LiteralPath $archivePath) { throw 'Backup already exists; nothing overwritten.' }
$inventory=@()
foreach ($source in @(@{name='codex';path=$CodexRoot},@{name='dsh';path=$DshRoot})) {
  $root=[IO.Path]::GetFullPath($source.path).TrimEnd('\')
  if (!(Test-Path -LiteralPath $root -PathType Container)) { throw ('Missing skills root: '+$root) }
  $items=@(Get-Item -LiteralPath $root -Force)+@(Get-ChildItem -LiteralPath $root -Recurse -Force)
  if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Inspect linked skills before backing up.' }
  foreach ($file in $items | Where-Object { !$_.PSIsContainer -and $_.FullName -notmatch '\\\.git(\\|$)' }) {
    $inventory+=@{file=$source.name+'/'+$file.FullName.Substring($root.Length+1).Replace('\','/');source=$file.FullName;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
}
$zip=[IO.Compression.ZipFile]::Open($archivePath,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in $inventory) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.source,$file.file,[IO.Compression.CompressionLevel]::Optimal)|Out-Null }
  $entry=$zip.CreateEntry('BACKUP-MANIFEST.json');$writer=New-Object IO.StreamWriter($entry.Open())
  try { $writer.Write((@{files=@($inventory|ForEach-Object{@{file=$_.file;bytes=$_.bytes;sha256=$_.sha256}})}|ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
$zip=[IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($file in $inventory) {
    $entry=$zip.GetEntry($file.file);if (!$entry -or $entry.Length -ne $file.bytes) { throw 'Backup length mismatch.' }
    $stream=$entry.Open();$hash=[Security.Cryptography.SHA256]::Create()
    try { $actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose();$hash.Dispose() }
    if ($actual -ne $file.sha256 -or (Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Backup or concurrent source mismatch: '+$file.file) }
  }
} finally { $zip.Dispose() }
@{archive=$archivePath;files=$inventory.Count;verified=$true}|ConvertTo-Json -Compress

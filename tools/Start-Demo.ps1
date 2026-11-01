param(
    [ValidateSet('Server','Car','Phone','Verify')]
    [string]$Component = 'Server'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSdkCandidates = @(
    'C:\Users\jeff4\AppData\Local\Android\Sdk',
    'C:\Users\jeff4\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Android\Sdk'
)
$taskSdk = $taskSdkCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'emulator\emulator.exe') } | Select-Object -First 1
$taskNode = 'C:\Users\jeff4\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$taskPython = 'C:\Users\jeff4\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
switch ($Component) {
    'Server' { & $taskNode (Join-Path $taskRoot 'server\server.mjs') }
    'Car' { if (-not $taskSdk) { throw 'Android SDK not found.' }; & (Join-Path $taskSdk 'emulator\emulator.exe') -avd ZRide_Pleos_34 -port 5554 -no-window -no-snapshot -gpu host -memory 4096 -no-boot-anim -no-audio -feature '-Vulkan' }
    'Phone' { if (-not $taskSdk) { throw 'Android SDK not found.' }; & (Join-Path $taskSdk 'emulator\emulator.exe') -avd ZRide_Phone_34 -port 5556 -no-window -no-snapshot -gpu host -memory 2048 -no-boot-anim -no-audio -feature '-Vulkan' }
    'Verify' { & $taskPython (Join-Path $PSScriptRoot 'verify-demo.py') }
}

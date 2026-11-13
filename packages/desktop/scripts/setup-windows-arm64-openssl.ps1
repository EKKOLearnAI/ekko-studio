$ErrorActionPreference = 'Stop'
# cryptography's pinned dependency has no Windows ARM64 wheel. Build its native
# OpenSSL dependency without changing Hermes' locked Python requirements.
$root = Join-Path $env:RUNNER_TEMP 'hermes-vcpkg-arm64'
$commit = 'bf19794383e8fb95eba5aa553235bc8ec2271688'
git init $root
if ($LASTEXITCODE -ne 0) { throw 'vcpkg git init failed' }
git -C $root remote add origin https://github.com/microsoft/vcpkg.git
git -C $root fetch --depth 1 origin $commit
if ($LASTEXITCODE -ne 0) { throw 'vcpkg fetch failed' }
git -C $root checkout --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'vcpkg checkout failed' }
& (Join-Path $root 'bootstrap-vcpkg.bat') -disableMetrics
if ($LASTEXITCODE -ne 0) { throw 'vcpkg bootstrap failed' }
& (Join-Path $root 'vcpkg.exe') install openssl:arm64-windows-static-md --disable-metrics
if ($LASTEXITCODE -ne 0) { throw 'ARM64 OpenSSL build failed' }
$openssl = Join-Path $root 'installed/arm64-windows-static-md'
"OPENSSL_DIR=$openssl" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
'OPENSSL_STATIC=1' | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8

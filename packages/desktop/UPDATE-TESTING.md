# 桌面端真机更新测试

使用独立的公开 GitHub 测试仓库和两份测试安装包，完整验证 A → B 的下载、取消、校验、安装和重启。测试工作流自动上传到 `EKKOLearnAI/ekko-studio-update-test` 的预发布 Release，同时保留 Actions 附件。正式打包工作流、正式 Release 和正式更新源均不变。

## 1. 一次性配置上传权限

测试仓库已经提供 HTTPS 文件下载，无需搭建服务器或填写更新链接。GitHub 默认 `GITHUB_TOKEN` 只授权当前仓库，因此跨仓库上传需在**源仓库** `EKKOLearnAI/ekko-studio` 配置专用 Actions secret：

1. 在 [GitHub fine-grained tokens](https://github.com/settings/personal-access-tokens/new) 创建 token，设置合适的过期时间。
2. Resource owner 选择 `EKKOLearnAI`，Repository access 选择 **Only select repositories**，只勾选 `ekko-studio-update-test`。
3. Repository permissions 中设置 **Contents: Read and write**；Metadata 自动为只读。不需要给源仓库写权限。
4. 打开 [源仓库 Actions secrets](https://github.com/EKKOLearnAI/ekko-studio/settings/secrets/actions/new)，Name 填 `DESKTOP_UPDATE_TEST_TOKEN`，Secret 填新 token。不要把 token 写进代码、日志或聊天。

工作流只在上传预检和上传步骤注入此 token，内置 token 保持 `contents: read`。缺少 secret 会在构建 Web UI/签名安装包之前失败。预检验证认证和仓库可访问性，真正的写权限由上传操作验证；过期或权限不足时修复 secret 后重试。

固定更新目录（第一次成功发布后才会有文件）：

| 目标 | 更新目录 | 清单 |
| --- | --- | --- |
| macOS Apple Silicon | `https://github.com/EKKOLearnAI/ekko-studio-update-test/releases/download/update-test-darwin-arm64/` | `latest-mac.yml` |
| macOS Intel | `https://github.com/EKKOLearnAI/ekko-studio-update-test/releases/download/update-test-darwin-x64/` | `latest-mac.yml` |
| Windows x64 | `https://github.com/EKKOLearnAI/ekko-studio-update-test/releases/download/update-test-win32-x64/` | `latest.yml` |

目录地址由工作流写进测试包。浏览下载页请打开[测试仓库 Releases](https://github.com/EKKOLearnAI/ekko-studio-update-test/releases)，目录地址本身不是网页。三个目标独立发布，避免 macOS 清单互相覆盖；不要把这些测试 Release 改为正式版、latest 或 immutable。默认 token 的权限范围见 [GitHub 认证文档](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)。

## 2. 构建 A 和 B

在 GitHub Actions 运行 **Desktop Update Test Build**（`desktop-update-test.yml`），选择包含新更新逻辑的分支，填写：

- `target`：测试机器的系统和架构。
- `version`：纯数字 `X.Y.Z`，例如 A=`0.7.900`、B=`0.7.901`。必须 B > A，不使用 `-beta` 等预发布后缀。
- `runtime_release_tag`：可选的现有运行时版本，A 和 B 保持一致，以便只测试桌面更新。

分别运行两次。版本会通过打包配置写进应用和安装器，不修改仓库的 package.json / lockfile。应用名称、appId 和安装身份保持一致，A 和 B 均固定使用测试源；不会提供用户切换正式/测试源的设置。

macOS 必须配置现有的 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`（证书需要密码时）、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` secrets，并使用相同签名身份构建 A/B。缺少签名或公证配置会失败，不会退成 unsigned 测试包。Windows 延用现有 NSIS 签名配置，需在目标机器实际验证安装权限和安全软件行为。

构建会检查包内 package.json 与 app-update.yml 的测试地址、清单版本、安装文件的 SHA-512/大小和 blockmap 是否齐全。验证后自动上传到对应平台 Release；Actions 运行摘要提供下载链接。`update-test-<target>-<version>` Actions 附件仍保留 14 天，包含相同的 `feed` 文件及记录版本、地址和文件列表的 `update-test-build.json`。

同一目标的构建跨分支串行执行（GitHub concurrency 可能替换尚未开始的待运行任务，A 成功后再运行 B）。上传脚本固定目标仓库，先上传版本化安装器/blockmap 并比对 GitHub 的大小和 SHA-256，最后切换清单。旧文件保留供差分下载使用；同版本不同内容、同名文件不同哈希、版本倒退均拒绝发布，需要使用更高版本。

清单先用临时名称上传，再通过重命名切换，保留 `previous-<asset-id>-latest*.yml` 作为备份。GitHub 不提供原子替换接口，切换瞬间可能短暂返回 404，客户端稍后重试即可。切换失败会尝试恢复旧清单；若 runner 在中间被终止，下次发布会先恢复备份。若网络导致自动恢复也失败，按错误中给出的 asset ID 在测试 Release 把备份改回原清单名后重试。首次发布失败的 Release 保持草稿。不同内容的同版本重建请直接升版本，不要覆盖已发布安装器。

## 3. 在测试机器完成 A → B

测试包保留正式应用身份，可能覆盖同机正式安装、共用本地数据和命令入口。使用专用测试机、虚拟机快照或独立系统用户，不要在日常工作的正式安装上试升级。

1. 构建 A，确认工作流上传成功；从测试 Release 下载 A 的 DMG/EXE 并正常安装应用。
2. 启动 A，确认“检查更新”显示当前版本，并建立一条测试会话，作为升级后的数据检查。
3. 构建更高版本 B，确认自动上传成功，无需手动复制文件或调整地址。
4. 在 A 中“检查更新”并同意下载。核对新建会话上方的版本、百分比和速度。
5. 下载中停止：网络传输应结束，不进入安装状态；退出再打开后仍是 A。再次检查/下载应成功。
6. 下载完成选“稍后”：应用继续可用。单独验证“重启更新”和下载完成后普通退出这两条安装路径。
7. 安装后确认已启动 B，测试会话和设置仍在，B 再次检查更新显示最新版本。macOS 要验证 Finder 正常打开、公证和系统签名校验均通过。

失败用例分别从 A 快照重新开始：限速/断网后重试、测试源返回 404/503、篡改测试文件造成哈希失败、安装目录权限不足。GitHub 不提供故障注入，404/503/损坏文件场景使用测试机的网络代理或本地构建的独立故障测试源，不修改共享测试 Release 中已校验的文件。测试源失败应报错且不访问正式源；失败下载不能显示“重启更新”；取消后不能悄悄安装。保留应用更新日志、Actions 日志和最终版本作为结果证据。

测试结束后，安装过测试包的应用仍绑定该测试源。恢复正式版需要手动安装正式安装器，不会自动切回正式更新源。需要重复 A → B 时使用递增的新版本对；不要删掉其他测试机仍需读取的旧文件。

## 本地构建和自动验证

完成桌面 README / CI 中的 Web UI 构建、生产依赖裁剪、运行时元数据准备后，在目标 OS 上运行（macOS 还需签名身份和公证环境）：

```sh
DESKTOP_UPDATE_TEST_TARGET=darwin-arm64 \
DESKTOP_UPDATE_TEST_VERSION=0.7.900 \
DESKTOP_UPDATE_TEST_URL=https://github.com/EKKOLearnAI/ekko-studio-update-test/releases/download/update-test-darwin-arm64/ \
npm --prefix packages/desktop run dist:update-test
```

输出位于 `packages/desktop/release-update-test/<target>/<version>/feed/`。已存在的非空版本目录会拒绝覆盖，避免混入旧清单；需要重建时先移走该目录。命令固定 `--publish never`，不接受额外打包/发布参数。

本地构建不会自动上传。需要上传时，先用 `gh auth login` 登录具有测试仓库写权限的账号，再设置相同 target/version 运行 `node packages/desktop/scripts/publish-update-test.mjs`；`--check` 只检查配置和仓库访问。本地构建仍可指定其他独立 HTTPS 目录，但 GitHub 上传命令只接受上表的固定地址。

```sh
npm ci --prefix packages/desktop --include=dev
npm --prefix packages/desktop run test:updater
npm run test -- tests/desktop/updater-source.test.ts tests/desktop/updater-download.test.ts
```

自动化验证覆盖配置隔离、真实 HTTP 下载/取消/重试、包内容校验、跨仓库上传顺序和失败恢复；不能代替签名安装包在 macOS/Windows 上的实际覆盖安装和重启。

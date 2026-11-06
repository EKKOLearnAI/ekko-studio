#!/usr/bin/env bash
# 编译三个型号的固件，并合并成可以直接从 0x0 烧录的单个 .bin（放在 bin/ 目录）
# 用法：在项目根目录运行  bash tools/build_bins.sh（需要 PlatformIO；python3 需要装 pyserial，或用 PYTHON=... 指定 PlatformIO 自带的 python）
# 设置了 PLATFORMIO_WORKSPACE_DIR 时，从该目录的 build/ 读取编译结果
set -e
cd "$(dirname "$0")/.."
PIO=${PIO:-pio}
PKG=${PLATFORMIO_CORE_DIR:-$HOME/.platformio}/packages
ESPTOOL="${PYTHON:-python3} $PKG/tool-esptoolpy/esptool.py"
BOOT_APP0=$PKG/framework-arduinoespressif32/tools/partitions/boot_app0.bin
mkdir -p bin
build() {  # 环境名 芯片 bootloader 地址 Flash 大小 输出名
  local env=$1 chip=$2 bl=$3 size=$4 out=$5
  $PIO run -e "$env"
  local b=${PLATFORMIO_WORKSPACE_DIR:-.pio}/build/$env
  $ESPTOOL --chip "$chip" merge_bin -o "bin/PulseStackChan-$out.bin" --flash_mode dio --flash_freq 80m --flash_size "$size" \
    "$bl" "$b/bootloader.bin" 0x8000 "$b/partitions.bin" 0xe000 "$BOOT_APP0" 0x10000 "$b/firmware.bin"
}
build m5stack-cores3     esp32s3 0x0    16MB CoreS3
build m5stack-core2      esp32   0x1000 16MB Core2
build m5stack-core-esp32 esp32   0x1000 4MB  Basic
ls -l bin

#!/usr/bin/env bash
# 在电脑上编译并运行全部 C++ 主机测试（g++/clang++ + ASan/UBSan），不需要设备。
# 用法：在项目根目录运行  bash tools/run_host_tests.sh [测试名…]
#   CXX=clang++ 可换编译器；ARDUINOJSON=… 指定 ArduinoJson 的 src 目录（默认用 PlatformIO 下载的那份）
#   单个测试文件第一行可写  // HOST_FLAGS: …  追加编译参数（例如 test_brain_life 需要 -I tests/host_stubs）
set -u
cd "$(dirname "$0")/.."
CXX=${CXX:-g++}
SRC=PulseStackChan
AJ=${ARDUINOJSON:-.pio/libdeps/m5stack-cores3/ArduinoJson/src}
[ -d "$AJ" ] || echo "提示：没找到 ArduinoJson（$AJ），先运行一次 pio run -e m5stack-cores3，或用 ARDUINOJSON=… 指定"
COMMON="$SRC/beat.cpp $SRC/care.cpp $SRC/companion.cpp $SRC/conversation.cpp $SRC/conversation_identity.cpp $SRC/expression_protocol.cpp $SRC/face_camera.cpp $SRC/face_tracker.cpp $SRC/motion.cpp $SRC/play.cpp $SRC/scene_capture.cpp $SRC/scene_wire.cpp $SRC/sfx_mixer.cpp $SRC/sfx_synth.cpp $SRC/touch_dispatch.cpp $SRC/touch_interaction.cpp $SRC/voice_codec.cpp"
SAN="-fsanitize=address,undefined -fno-omit-frame-pointer"
OUT=${OUT:-/tmp/pulse-host-tests}; mkdir -p "$OUT"
# 素材库很大，只编译一次
if [ ! -f "$OUT/sfx_bank.o" ] || [ "$SRC/sfx_bank.cpp" -nt "$OUT/sfx_bank.o" ]; then
  $CXX -std=c++11 -O0 -c -I $SRC $SRC/sfx_bank.cpp -o "$OUT/sfx_bank.o" $SAN || exit 1
fi
tests=("$@"); [ ${#tests[@]} -eq 0 ] && tests=(tests/test_*.cpp)
pass=0; fail=0; failed=""
for t in "${tests[@]}"; do
  [ -f "$t" ] || t=tests/$t.cpp
  n=$(basename "$t" .cpp)
  extra=$(grep -m1 '^// HOST_FLAGS:' "$t" | sed 's#^// HOST_FLAGS:##')
  if $CXX -std=c++11 $extra -O1 -g -Wall -Wextra -Werror -Wno-error=extra -Wno-missing-field-initializers -Wno-class-memaccess \
      -Wno-misleading-indentation -Wno-comment $SAN -I $SRC -I "$AJ" "$t" $COMMON "$OUT/sfx_bank.o" -o "$OUT/$n" > "$OUT/$n.build.log" 2>&1; then
    if (cd "$OUT" && ASAN_OPTIONS=${ASAN_OPTIONS:-detect_leaks=0} timeout 600 "./$n" > "$OUT/$n.run.log" 2>&1); then
      pass=$((pass + 1)); echo "PASS $n"
    else
      fail=$((fail + 1)); failed="$failed $n(run)"; echo "FAIL(run) $n"; tail -5 "$OUT/$n.run.log"
    fi
  else
    fail=$((fail + 1)); failed="$failed $n(build)"; echo "FAIL(build) $n"; grep -m5 "error" "$OUT/$n.build.log"
  fi
done
echo "== host tests: pass=$pass fail=$fail $failed"
[ $fail -eq 0 ]

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
脉冲 Pulse · 音效打包工具
把 sfx/ 目录里的 wav 音效转成固件里用的 PulseStackChan/sfx_bank.h / sfx_bank.cpp。

  python3 tools/make_sfx_bank.py            # 在工程根目录运行
  python3 tools/make_sfx_bank.py --check    # 另外把解码结果写到 sfx_check/ 里，方便试听对比

处理过程：任意采样率 / 声道的 16 位 wav → 单声道 → 低通 + 重采样到 24 kHz → 8 位 μ-law（G.711，信噪比约 37 dB）。
原 36 个音效和新增本地互动语音放在程序 Flash 里，不占常驻内存。
想换声音：直接替换 sfx/ 里的同名 wav（时长随意），重新运行本脚本，再编译固件即可。
新加的 wav 也会被打包（名字只用小写字母、数字和下划线），固件里可以用串口命令 play <名字> 试听。
"""
import os, sys, glob, wave, re
import numpy as np

RATE = 24000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "sfx")
OUT = os.path.join(ROOT, "PulseStackChan")

# 固件代码里引用的音效（顺序 = 枚举顺序，和音效包 README 一致）
KNOWN = [
    # 《StackChan × Ekko Studio》
    "ekko_boot", "ekko_eyes_open", "ekko_happy", "ekko_ack", "ekko_talk",
    # 《摄像头跟随 + 语音执行》
    "track_snore", "track_face_found", "track_eyes_open", "track_surprise", "track_heart", "track_its_you",
    "track_dizzy", "track_listen", "track_hm", "track_recognized", "track_ok", "track_lalala", "track_giggle",
    # 《回家，有它在等你》
    "home_sleep_z", "home_wake", "home_detect", "home_surprise", "home_joy", "home_nod", "home_nod_x3",
    "home_giggle", "home_hm", "home_send", "home_wow", "home_pop", "home_hey", "home_tada", "home_broadcast",
    "home_lights_on", "home_final_nod", "home_sigh",
]

def read_wav(path):
    with wave.open(path, "rb") as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"{path}: 只支持 16 位 wav")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def lowpass(x, cutoff, sr, taps=127):
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff / sr * n) * np.blackman(taps)
    h /= h.sum()
    return np.convolve(x, h, mode="same")


def resample(x, sr):
    if sr == RATE:
        return x
    if sr > RATE:
        x = lowpass(x, RATE * 0.46, sr)
    if sr == 2 * RATE:
        return x[::2].copy()
    t = np.arange(int(len(x) * RATE / sr)) * (sr / RATE)
    return np.interp(t, np.arange(len(x)), x)


def mulaw_encode(pcm):
    """G.711 μ-law：16 位 → 8 位（固件里查表解码）"""
    x = np.asarray(pcm, dtype=np.int32)
    sign = np.where(x < 0, 0x80, 0)
    m = np.minimum(np.abs(x), 32635) + 0x84
    exp = np.zeros_like(m)
    for e in range(7, 0, -1):
        exp = np.where((exp == 0) & ((m >> (e + 7)) & 1).astype(bool), e, exp)
    man = (m >> (exp + 3)) & 0x0F
    u = (~(sign | (exp << 4) | man)) & 0xFF
    return u.astype(np.uint8)


def mulaw_decode(u):
    u = (~u.astype(np.int32)) & 0xFF
    sign, exp, man = u & 0x80, (u >> 4) & 7, u & 0x0F
    s = (((man << 3) + 0x84) << exp) - 0x84
    return np.where(sign != 0, -s, s).astype(np.int16)


def main():
    check = "--check" in sys.argv
    files = {os.path.splitext(os.path.basename(p))[0]: p for p in glob.glob(os.path.join(SRC, "*.wav"))}
    names = list(KNOWN) + sorted(k for k in files if k not in KNOWN and re.fullmatch(r"[a-z0-9_]+", k))
    clips = []
    total = 0
    if check:
        os.makedirs(os.path.join(ROOT, "sfx_check"), exist_ok=True)
    for name in names:
        if name not in files:
            print(f"  ! 缺少 {name}.wav（会打包成空音效）")
            clips.append((name, b"", 0, 0.0))
            continue
        x, sr = read_wav(files[name])
        y = resample(x, sr)
        y = np.clip(np.round(y * 32767.0), -32768, 32767).astype(np.int32)
        u = mulaw_encode(y)
        dec = mulaw_decode(u)
        data = u.tobytes()
        err = dec.astype(np.float64) - y
        snr = 10 * np.log10((y.astype(np.float64) ** 2).sum() / max(1e-9, (err ** 2).sum()))
        clips.append((name, data, len(y), snr))
        total += len(data)
        if check:
            with wave.open(os.path.join(ROOT, "sfx_check", name + ".wav"), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
                w.writeframes(dec.astype("<i2").tobytes())
        print(f"  {name:20s} {len(y) / RATE:5.2f}s  {len(data):6d} B  SNR {snr:5.1f} dB")

    h = ["#pragma once",
         "// 脉冲 Pulse · 音效数据（由 tools/make_sfx_bank.py 自动生成，不要手改）",
         f"// {len(clips)} 个音效，μ-law 8 位 {RATE} Hz，合计 {total} 字节",
         "#include <stdint.h>", "", "namespace sfx {", "",
         f"constexpr int kClipRate = {RATE};", "",
         "enum Clip : uint8_t {", "  C_NONE = 0,"]
    for name, *_ in clips:
        h.append(f"  C_{name.upper()},")
    h += ["  C_COUNT", "};", "",
          "struct ClipDef {",
          "  const char* name;",
          "  const uint8_t* data;  // G.711 μ-law，每个采样 1 字节",
          "  uint32_t samples;",
          "};", "",
          "extern const ClipDef kClips[C_COUNT];  // kClips[0] = 空",
          "int findClip(const char* name);        // 按名字找（例如 \"home_nod\"），找不到返回 0",
          "", "}  // namespace sfx", ""]
    c = ["// 脉冲 Pulse · 音效数据（由 tools/make_sfx_bank.py 自动生成，不要手改）",
         "// 声音素材：原 StackChan 程序合成音效；touch_dirty_hands 为获授权的火山 TTS（见交付 provenance）",
         "#include <string.h>", '#include "sfx_bank.h"', "", "namespace sfx {", ""]
    for name, data, n, _ in clips:
        if not data:
            continue
        c.append(f"static const uint8_t k_{name}[{len(data)}] = {{")
        for i in range(0, len(data), 24):
            c.append("  " + ",".join(str(b) for b in data[i:i + 24]) + ",")
        c.append("};")
    c += ["", "const ClipDef kClips[C_COUNT] = {", '  {"", nullptr, 0},']
    for name, data, n, _ in clips:
        if data:
            c.append(f'  {{"{name}", k_{name}, {n}}},')
        else:
            c.append(f'  {{"{name}", nullptr, 0}},')
    c += ["};", "",
          "int findClip(const char* name) {",
          "  if (!name || !*name) return 0;",
          "  for (int i = 1; i < C_COUNT; i++)",
          "    if (!strcmp(kClips[i].name, name)) return i;",
          "  return 0;",
          "}", "", "}  // namespace sfx", ""]
    with open(os.path.join(OUT, "sfx_bank.h"), "w", encoding="utf-8") as f:
        f.write("\n".join(h))
    with open(os.path.join(OUT, "sfx_bank.cpp"), "w", encoding="utf-8") as f:
        f.write("\n".join(c))
    print(f"完成：{len(clips)} 个音效，{total / 1024:.0f} KB → PulseStackChan/sfx_bank.h / sfx_bank.cpp")


if __name__ == "__main__":
    main()

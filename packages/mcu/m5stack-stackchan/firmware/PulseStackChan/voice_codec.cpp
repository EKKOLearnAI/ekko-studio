#include "voice_codec.h"
#include <math.h>
#include <string.h>

namespace voice_audio { namespace detail {
namespace {
const int kStep[89] = {
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,
  66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,
  371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,
  1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,
  5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,
  18500,20350,22385,24623,27086,29794,32767
};
const int kIndex[16] = {-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8};
uint32_t read32(const uint8_t* b) {
  return (uint32_t)b[0] | ((uint32_t)b[1]<<8) | ((uint32_t)b[2]<<16) | ((uint32_t)b[3]<<24);
}
int clamp(int x,int a,int b) { return x<a?a:(x>b?b:x); }
}
bool inspectHadp(const uint8_t* b,size_t n,HadpInfo& info,const char*& error) {
  info=HadpInfo(); error=nullptr;
  if (!b || n<20) {error="hadp_header_missing";return false;}
  if (memcmp(b,"HADP",4) || b[4]!=1 || b[5]!=1) {error="hadp_format_unsupported";return false;}
  const uint32_t rate=read32(b+8), count=read32(b+12);
  if (rate<8000 || rate>48000 || count==0 || count>rate*30u) {error="hadp_duration_or_rate_invalid";return false;}
  if (b[18]>88) {error="hadp_step_index_invalid";return false;}
  const size_t payload=((size_t)count-1+1)/2;
  if (n!=20+payload) {error="hadp_length_mismatch";return false;}
  info.sample_rate=rate;info.sample_count=count;return true;
}
bool decodeHadp(const uint8_t* b,size_t n,int16_t* out,size_t capacity,HadpInfo& info,const char*& error) {
  if (!inspectHadp(b,n,info,error)) return false;
  if (!out || capacity<info.sample_count) {error="pcm_capacity_insufficient";return false;}
  int predictor=(int16_t)((unsigned)b[16]|((unsigned)b[17]<<8)), index=b[18];
  out[0]=(int16_t)predictor;
  for (size_t i=1;i<info.sample_count;++i) {
    const size_t offset=i-1;const int code=(offset&1)?b[20+offset/2]>>4:b[20+offset/2]&15;
    const int step=kStep[index];int delta=step>>3;
    if (code&1)delta+=step>>2;if (code&2)delta+=step>>1;if (code&4)delta+=step;
    predictor=clamp(predictor+((code&8)?-delta:delta),-32768,32767);
    index=clamp(index+kIndex[code],0,88);out[i]=(int16_t)predictor;
  }
  return true;
}
void EnergyGate::reset() { _noise=100;next(); }
// 一段结束后接着听：保留学到的底噪，只清本段状态（原来每段都把底噪重置为 100，
// 持续的背景声会在每次重新开听时立刻再次触发，录满 20 秒上传）
void EnergyGate::next() { _start=_quiet=_voiced=_length=_tonal=_startTonal=0;_rmsSum=0;_recording=false; }
GateResult EnergyGate::consume(const int16_t* samples,size_t count) {
  GateResult r;
  if (!samples || count==0 || count>16000) return r;
  double sum=0,mean=0;
  for(size_t i=0;i<count;++i)mean+=samples[i];mean/=count;
  size_t crossings=0;bool prevNeg=(samples[0]-mean)<0;
  for(size_t i=0;i<count;++i){const double x=samples[i]-mean;sum+=x*x;const bool neg=x<0;if(neg!=prevNeg){++crossings;prevNeg=neg;}}
  r.rms=(float)sqrt(sum/count);
  // 过零率低（< 0.15 次/采样，约 2400 次/秒）的有声块 = 浊音（元音、鼻音）。
  // 实测：键盘、摩擦、风扇、碰撞这类误触发几乎没有这种块，真人说话至少有 100ms。
  const bool tonal=crossings*100<count*15;
  const float begin=fmaxf(280.f,_noise*2.8f+70.f), remain=fmaxf(180.f,_noise*1.8f+50.f);
  if (!_recording) {
    if (r.rms>=begin) { _start+=count; if (tonal) _startTonal+=count; }
    else { _start=0;_startTonal=0; const float a=1.f-expf(-(float)count/(16000.f*.8f)); _noise+=(r.rms-_noise)*a; }
    if (_start>=1280) { _recording=true;_voiced=_start;_tonal=_startTonal;_length=_quiet=0;r.started=true; }
  } else {
    _length+=count;_rmsSum+=r.rms*count;
    if (r.rms>=remain) {_voiced+=count;_quiet=0;if(tonal)_tonal+=count;}else _quiet+=count;
    if (_quiet>=12800 || _length>=320000) {
      r.limited=_length>=320000;r.finished=true;
      // 有效发声不足 300ms 的（碰撞、舵机、咔哒声）在本地丢弃，不上传、也不算一轮"没听清"
      r.too_short=_voiced<kMinVoicedSamples;
      if (!r.too_short && _tonal<kMinTonalSamples) { r.too_short=true;r.not_voiced=true; }
      // 录满上限且几乎没有停顿（>95% 时间都在门限以上）的是持续背景声，不是说话：
      // 丢弃并把底噪抬到这段的平均能量附近，避免同样的声音反复触发
      if (r.limited && _voiced*20>=_length*19) {
        r.too_short=true;r.noise_like=true;
        const float mean=(float)(_rmsSum/(double)_length);
        if (mean*.9f>_noise) _noise=mean*.9f;
      }
      next();
    }
  }
  r.recording=_recording;r.noise_rms=_noise;return r;
}
} }

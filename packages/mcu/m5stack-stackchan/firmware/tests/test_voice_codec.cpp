#include "../PulseStackChan/voice_codec.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <vector>
using namespace voice_audio::detail;
static void put32(uint8_t* b,uint32_t v){for(int i=0;i<4;++i)b[i]=(uint8_t)(v>>(8*i));}
static std::vector<uint8_t> header(uint32_t n,uint32_t rate=24000){
 std::vector<uint8_t>b(20+(n?n/2:0),0);memcpy(b.data(),"HADP",4);b[4]=b[5]=1;put32(b.data()+8,rate);put32(b.data()+12,n);return b;
}
static void testDecode(){
 auto b=header(3);b[20]=0x17;HadpInfo info;const char*error=nullptr;int16_t out[8]={};
 assert(decodeHadp(b.data(),b.size(),out,8,info,error));
 assert(info.sample_rate==24000 && info.sample_count==3 && !error);
 assert(out[0]==0 && out[1]==11 && out[2]==17);
 b[20]=0x9f;assert(decodeHadp(b.data(),b.size(),out,8,info,error));
 assert(out[1]==-11 && out[2]==-17);
 b=header(1);b[16]=0x00;b[17]=0x80;
 assert(decodeHadp(b.data(),b.size(),out,8,info,error) && out[0]==-32768);
 b=header(6);b[16]=0x00;b[17]=0x7d;b[18]=88;b[20]=0xf7;b[21]=0xff;b[22]=0xf7;
 assert(decodeHadp(b.data(),b.size(),out,8,info,error));
 assert(out[1]==32767 && out[3]==-32768);
}
static void testInvalid(){
 HadpInfo info;const char*error=nullptr;int16_t out[4];auto b=header(3);
 assert(!inspectHadp(nullptr,20,info,error));
 assert(!inspectHadp(b.data(),19,info,error));
 b[0]='x';assert(!inspectHadp(b.data(),b.size(),info,error));b[0]='H';
 b[4]=2;assert(!inspectHadp(b.data(),b.size(),info,error));b[4]=1;
 b[5]=2;assert(!inspectHadp(b.data(),b.size(),info,error));b[5]=1;
 b[18]=89;assert(!inspectHadp(b.data(),b.size(),info,error));b[18]=0;
 put32(b.data()+12,UINT32_MAX);assert(!inspectHadp(b.data(),b.size(),info,error));put32(b.data()+12,3);
 put32(b.data()+8,0);assert(!inspectHadp(b.data(),b.size(),info,error));put32(b.data()+8,24000);
 assert(!inspectHadp(b.data(),b.size()+1,info,error));
 assert(!decodeHadp(b.data(),b.size(),out,2,info,error));
 b=header(0);assert(!inspectHadp(b.data(),b.size(),info,error));
 uint32_t seed=9;
 for(int iteration=0;iteration<10000;++iteration){
  seed=seed*1664525u+1013904223u;size_t n=seed%512;std::vector<uint8_t>input(n);
  for(size_t i=0;i<n;++i){seed=seed*1664525u+1013904223u;input[i]=(uint8_t)(seed>>24);}
  inspectHadp(input.data(),input.size(),info,error);
 }
}
static GateResult block(EnergyGate&gate,float amplitude){
 int16_t samples[320];for(int i=0;i<320;++i)samples[i]=(int16_t)(amplitude*sinf(i*2*3.14159265f/32));
 return gate.consume(samples,320);
}
static void testEndpoint(){
 EnergyGate g;GateResult r;
 for(int i=0;i<60;++i){r=block(g,50);assert(!r.started && !r.recording);}
 for(int i=0;i<3;++i){r=block(g,2000);assert(!r.started);}
 r=block(g,2000);assert(r.started && r.recording);
 for(int i=0;i<12;++i)r=block(g,2000);  // 共 16 块 = 320ms 有效发声 ≥ 300ms
 for(int i=0;i<39;++i){r=block(g,0);assert(!r.finished && r.recording);}
 r=block(g,0);assert(r.finished && !r.recording && !r.too_short && !r.limited);
 g.reset();for(int i=0;i<3;++i)block(g,3000);r=block(g,0);assert(!r.started && !r.recording);
 g.reset();for(int i=0;i<4;++i)r=block(g,2000);assert(r.started);
 for(int i=0;i<40;++i)r=block(g,0);assert(r.finished && r.too_short);
 // 160ms 的短促声（原来会上传）现在本地丢弃
 g.reset();for(int i=0;i<4;++i)r=block(g,2000);
 for(int i=0;i<4;++i)r=block(g,2000);
 for(int i=0;i<40;++i)r=block(g,0);assert(r.finished && r.too_short && !r.noise_like);
 // 录满 20 秒但一直不停顿的持续声音 = 背景噪声：丢弃，并抬高底噪
 g.reset();for(int i=0;i<4;++i)r=block(g,2000);
 int blocks=0;while(!r.finished && blocks<1001){r=block(g,2000);++blocks;}
 assert(r.finished && r.limited && r.too_short && r.noise_like && blocks==1000);
 assert(g.noise()>1000.f);
 // 同样的背景声不会再立刻触发（底噪已保留，不像原来那样每段重置为 100）
 for(int i=0;i<50;++i){r=block(g,2000);assert(!r.started);}
 // 有停顿的长段说话录满上限时照常上传
 g.reset();for(int i=0;i<4;++i)r=block(g,2000);
 blocks=0;while(!r.finished && blocks<1001){r=block(g,(blocks%15)<10?2000:0);++blocks;}
 assert(r.finished && r.limited && !r.too_short && !r.noise_like);
 // 能量足够、但全是高过零率的噪声（键盘/摩擦/风扇）：丢弃，不上传
 {g.reset();uint32_t seed=7;GateResult q;
  auto noiseBlock=[&](float amp){int16_t s[320];for(int i=0;i<320;++i){seed=seed*1664525u+1013904223u;s[i]=(int16_t)(((int)(seed>>16)%2001-1000)*amp/1000.f);}return g.consume(s,320);};
  for(int i=0;i<30;++i)q=noiseBlock(3000);
  for(int i=0;i<40&&!q.finished;++i)q=block(g,0);
  assert(q.finished && q.too_short && q.not_voiced);}
 // 同样长度但是浊音（低过零率）：照常上传
 g.reset();for(int i=0;i<30;++i)r=block(g,2000);
 for(int i=0;i<40&&!r.finished;++i)r=block(g,0);
 assert(r.finished && !r.too_short && !r.not_voiced);
 r=g.consume(nullptr,0);assert(!r.finished && !r.started);
}
int main(){testDecode();testInvalid();testEndpoint();puts("PASS HADP low-first IMA decode, header bounds, saturation, 10000 malformed inputs, energy onset/endpoint/minimum/maximum durations");}

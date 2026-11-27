#include "scene_capture.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <vector>

using namespace facecam;
static void encodingTakeTimeout() {
  scene::Slot slot; SceneFrame result;
  const uint8_t bytes[]={0xff,0xd8,0xff,0xd9};
  assert(slot.request(result,100,true,false)==SceneState::Pending);
  const uint32_t id=result.request_id;
  assert(slot.beginFrame(110,320,240,120));
  assert(slot.take(id,result,bytes,2099)==SceneState::Pending);
  assert(slot.take(id,result,bytes,2100)==SceneState::Unavailable);
  assert(!result.valid&&!result.pixels&&!strcmp(result.reason,"request_timeout"));
  assert(slot.blocksOther()&&!slot.maintain(2100)); // Writer still owns all image bytes.
  assert(!slot.release()&&slot.blocksOther()); // Release requests cancellation, never erases a writer.
  assert(!slot.maintain(2101));
  assert(slot.finish(4,nullptr,1982,2102)&&!slot.erasingFailure());
  slot.erased(); assert(!slot.blocksOther());
  assert(slot.take(id,result,bytes,2103)==SceneState::Missing);
}
static void encodingFinishTimeout() {
  scene::Slot slot; SceneFrame result;
  const uint8_t bytes[]={0xff,0xd8,0xff,0xd9};
  assert(slot.request(result,100,true,false)==SceneState::Pending);
  const uint32_t id=result.request_id;
  assert(slot.beginFrame(110,320,240,120));
  assert(slot.finish(4,nullptr,1980,2100)); // Deadline equality must not publish a valid JPEG.
  assert(slot.erasingFailure()); slot.erased();
  assert(slot.take(id,result,bytes,2100)==SceneState::Ready);
  assert(!result.valid&&!result.pixels&&!strcmp(result.reason,"request_timeout"));
  assert(slot.release()); slot.erased();
  assert(slot.request(result,3000,true,false)==SceneState::Pending);
  assert(slot.beginFrame(3010,320,240,3020));
  assert(!slot.finish(4,nullptr,1979,4999)); // One millisecond before deadline remains valid.
  assert(slot.release()); slot.erased();
  const uint32_t wrap=UINT32_MAX-100;
  assert(slot.request(result,wrap,true,false)==SceneState::Pending);
  assert(slot.beginFrame(wrap+1,320,240,wrap+2));
  assert(slot.finish(4,nullptr,1998,wrap+2000)&&slot.erasingFailure());
  slot.erased(); assert(slot.release()); slot.erased();
}
int main(int argc,char** argv) {
  if(argc>1) {
    if(!strcmp(argv[1],"encoding-take-timeout")) encodingTakeTimeout();
    else if(!strcmp(argv[1],"encoding-finish-timeout")) encodingFinishTimeout();
    else return 2;
    return 0;
  }
  encodingTakeTimeout();
  encodingFinishTimeout();
  scene::Slot slot;SceneFrame result;
  assert(slot.request(result,100,false,false)==SceneState::Unavailable);
  assert(slot.request(result,100,true,true)==SceneState::Busy);
  assert(slot.request(result,100,true,false)==SceneState::Pending);
  const uint32_t id=result.request_id;
  assert(id&&slot.blocksOther()&&slot.wantsFrame());
  assert(slot.request(result,101,true,false)==SceneState::Busy);
  assert(!slot.beginFrame(99,320,240,110)); // Never return a pre-request exposure.
  assert(!slot.beginFrame(100,320,240,551)); // Original450ms raw frame admission is unchanged.
  assert(!slot.beginFrame(110,640,480,120));
  assert(slot.beginFrame(110,320,240,120)&&!slot.wantsFrame());
  assert(!slot.maintain(6000)); // Worker owns the encoding buffer; main cannot erase it.
  assert(slot.finish(4096,nullptr,25,140)==false);
  const uint8_t bytes[]={0xff,0xd8,0xff,0xd9};
  assert(slot.take(id,result,bytes,150)==SceneState::Ready&&result.valid&&result.pixels==bytes);
  assert(result.width==320&&result.height==240&&result.frame_id&&result.encode_ms==25);
  assert(!slot.maintain(6000)); // Borrower must release before erasure.
  assert(!slot.cancel());assert(result.pixels==bytes); // Cancellation cannot invalidate an existing borrower.
  assert(slot.release());slot.erased();assert(!slot.blocksOther());
  assert(slot.take(id,result,bytes,200)==SceneState::Missing);

  assert(slot.request(result,1000,true,false)==SceneState::Pending);const auto timeoutId=result.request_id;
  assert(!slot.maintain(2999)&&slot.maintain(3000)&&slot.erasingFailure());slot.erased();
  assert(slot.take(timeoutId,result,bytes,3000)==SceneState::Ready&&!result.valid&&!result.pixels);
  assert(!strcmp(result.reason,"request_timeout"));assert(slot.release());slot.erased();
  assert(slot.request(result,4000,true,false)==SceneState::Pending);
  assert(slot.beginFrame(4001,320,240,4010));assert(!slot.cancel());
  assert(slot.finish(100,nullptr,20,4030)&&!slot.erasingFailure());slot.erased();assert(!slot.blocksOther());
  assert(slot.request(result,5000,true,false)==SceneState::Pending);const auto failedId=result.request_id;
  assert(slot.beginFrame(5001,320,240,5010));assert(slot.finish(0,"jpeg_encode_failed",10,5020));slot.erased();
  assert(slot.take(failedId,result,bytes,5030)==SceneState::Ready&&!result.valid&&!strcmp(result.reason,"jpeg_encode_failed"));
  assert(slot.release());slot.erased();
  assert(slot.request(result,6000,true,false)==SceneState::Pending);
  assert(slot.beginFrame(6001,320,240,6010));assert(slot.finish(kSceneJpegCapacity+1,nullptr,10,6020));slot.erased();
  assert(slot.maintain(11000));slot.erased();assert(!slot.blocksOther());
  assert(slot.request(result,12000,true,false)==SceneState::Pending);const auto staleId=result.request_id;
  assert(slot.beginFrame(12001,320,240,12010));assert(!slot.finish(1234,nullptr,10,12020));
  assert(slot.maintain(17001));slot.erased();
  assert(slot.take(staleId,result,bytes,17001)==SceneState::Ready&&!result.valid&&!strcmp(result.reason,"stale"));
  assert(slot.release());slot.erased();

  std::vector<uint8_t> output(kSceneJpegCapacity,0xa5);
  scene::JpegSink sink{output.data(),output.size(),0,false};
  assert(scene::appendJpeg(&sink,0,bytes,4)==4&&scene::validJpeg(output.data(),sink.used));
  assert(scene::appendJpeg(&sink,4,nullptr,0)==0&&!sink.failed);
  assert(scene::appendJpeg(&sink,3,bytes,4)==0&&sink.failed);
  sink=scene::JpegSink{output.data(),output.size(),0,false};
  std::vector<uint8_t> chunk(output.size(),0x7f);
  assert(scene::appendJpeg(&sink,0,chunk.data(),chunk.size())==output.size());
  assert(scene::appendJpeg(&sink,output.size(),bytes,1)==0&&sink.failed);
  assert(!scene::validJpeg(bytes,0)&&!scene::validJpeg(bytes,kSceneJpegCapacity+1));
  const uint32_t wrap=UINT32_MAX-100;
  assert(slot.request(result,wrap,true,false)==SceneState::Pending);
  assert(slot.beginFrame(wrap+1,320,240,wrap+2));assert(!slot.finish(4,nullptr,3,wrap+3));
  assert(slot.maintain(wrap+5001));slot.erased();
  assert(slot.release());slot.erased();
  puts("scene_capture: sole-slot/fresh exposure/450ms raw gate, worker/borrow ownership, encoding2s timeout, cancel/timeout/stale erasure, bounded JPEG sink and clock wrap passed");
}

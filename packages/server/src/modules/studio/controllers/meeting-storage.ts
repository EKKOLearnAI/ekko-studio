import type { Context } from 'koa'
import { meetingStorageService } from '../services/meeting-storage/index'
import fs from 'fs/promises'

// Meeting metadata
export async function getMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = await meetingStorageService.getMeetingMetadata(meetingId)
  if (!data) {
    ctx.status = 404
    ctx.body = { error: 'Meeting not found' }
    return
  }
  // 触摸屏设备端 (keli) 把句子单独写到 transcript.json (metadata.sentences 为空),
  // 读取时合并 transcript, 让 Web UI 侧边栏/详情能直接看到设备端会议内容。
  if (!Array.isArray(data.sentences) || data.sentences.length === 0) {
    const transcript = await meetingStorageService.getTranscript(meetingId)
    if (transcript.length > 0) {
      data.sentences = transcript
    }
  }
  ctx.body = data
}

export async function saveMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = ctx.request.body
  await meetingStorageService.saveMeetingMetadata(meetingId, data)
  ctx.body = { status: 'ok', message: 'Meeting saved' }
}

export async function deleteMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await meetingStorageService.deleteMeeting(meetingId)
  ctx.body = { status: 'ok', message: 'Meeting deleted' }
}

export async function listMeetings(ctx: Context): Promise<void> {
  const meetings = await meetingStorageService.listMeetings()
  ctx.body = { meetings }
}

// Audio upload limit. A 2-hour meeting at opus 32kbps is ~28 MB; we cap at
// 200 MB to leave headroom for higher bitrate captures while keeping the
// server safe from runaway uploads.
const AUDIO_UPLOAD_MAX_BYTES = Number(process.env.MEETING_AUDIO_MAX_BYTES) || 200 * 1024 * 1024

export async function uploadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params

  // Reject early when the client declared an oversize Content-Length, before
  // streaming any bytes.
  const declared = Number(ctx.request.length ?? ctx.req.headers['content-length'] ?? 0)
  if (declared && declared > AUDIO_UPLOAD_MAX_BYTES) {
    ctx.status = 413
    ctx.body = { error: `Audio too large: ${declared} > ${AUDIO_UPLOAD_MAX_BYTES} bytes` }
    return
  }

  try {
    const result = await meetingStorageService.saveAudioStream(
      meetingId,
      ctx.req as AsyncIterable<Buffer>,
      AUDIO_UPLOAD_MAX_BYTES,
    )
    ctx.body = { status: 'ok', path: result.path, bytes: result.bytes }
  } catch (err: any) {
    if (/max size/.test(String(err?.message || ''))) {
      ctx.status = 413
      ctx.body = { error: err.message }
      return
    }
    ctx.status = 500
    ctx.body = { error: `Failed to upload audio: ${err}` }
  }
}

export async function downloadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const audioPath = await meetingStorageService.getAudioPath(meetingId)

  if (!audioPath) {
    ctx.status = 404
    ctx.body = { error: 'Audio not found' }
    return
  }

  try {
    const buffer = await fs.readFile(audioPath)
    const fileName = audioPath.split('/').pop() || 'recording.webm'

    ctx.type = 'audio/webm'
    ctx.set('Content-Disposition', `attachment; filename="${fileName}"`)
    ctx.body = buffer
  } catch (err) {
    ctx.status = 500
    ctx.body = { error: `Failed to read audio: ${err}` }
  }
}

// Transcript
export async function saveTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const sentences = ctx.request.body
  await meetingStorageService.saveTranscript(meetingId, sentences)
  ctx.body = { status: 'ok', message: 'Transcript saved' }
}

export async function getTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const sentences = await meetingStorageService.getTranscript(meetingId)
  ctx.body = { sentences }
}

// JSON report
export async function saveJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = ctx.request.body
  await meetingStorageService.saveJsonReport(meetingId, data)
  ctx.body = { status: 'ok', message: 'JSON report saved' }
}

export async function downloadJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const data = await meetingStorageService.getJsonReport(meetingId)

  if (!data) {
    ctx.status = 404
    ctx.body = { error: 'JSON report not found' }
    return
  }

  ctx.type = 'application/json'
  ctx.set('Content-Disposition', `attachment; filename="${meetingId}.json"`)
  ctx.body = data
}

// HTML report
export async function saveHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const { html } = ctx.request.body
  await meetingStorageService.saveHtmlReport(meetingId, html)
  ctx.body = { status: 'ok', message: 'HTML report saved' }
}

export async function downloadHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const html = await meetingStorageService.getHtmlReport(meetingId)

  if (!html) {
    ctx.status = 404
    ctx.body = { error: 'HTML report not found' }
    return
  }

  ctx.type = 'text/html'
  ctx.set('Content-Disposition', `attachment; filename="${meetingId}_report.html"`)
  ctx.body = html
}

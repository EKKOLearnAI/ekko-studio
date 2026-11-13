import { deflateSync } from 'node:zlib'
import { logger } from '../../public/logging'

/**
 * 扫描件 PDF 生成器（无第三方 PDF 依赖）。
 *
 * 目标是「看起来就是电子版」而不是「一张照片被贴到 A4 中间」：
 *   - 页面尺寸 = 图片尺寸 / DPI（默认 200dpi），满版铺满，不留白边；
 *   - 纯黑白扫描件（客户端 bw 预设输出 PNG）识别为 bilevel 后按 1bpp +
 *     FlateDecode 无损嵌入 —— 文字边缘不会有 JPEG 振铃，体积也最小；
 *   - 彩色/灰度页 JPEG 直通 DCTDecode（不二次压缩）；
 *   - 其他格式（PNG 灰度照片 / WebP）用 sharp 转 JPEG 后嵌入。
 *
 * 可搜索 PDF（searchable）：把每页 OCR 文本作为隐藏文字层（渲染模式 3 Tr，
 * 不可见但可选中/搜索/复制）叠在图像上。CJK 用非嵌入 Type0 字体方案
 * （/BaseFont /STSong-Light + /Encoding /UniGB-UCS2-H，Adobe/Chrome(PDFium)/
 * macOS 预览都会用系统字体替换），不需要打包几 MB 的中文字体；选区按 OCR
 * 行数均分页面高度，是近似行位置而非逐字对齐 —— 对搜索/复制完全够用。
 *
 * OCR 文本仍单独以 Markdown / TXT 保存。
 */

const A4_WIDTH_PT = 595
const A4_HEIGHT_PT = 842
const A4_MARGIN_PT = 36
const DEFAULT_DPI = 200
/** 单页最大边长（pt）：防止异常大图撑出离谱的页面尺寸。 */
const MAX_PAGE_PT = 5000

/** 隐藏文字层行边距（pt）。 */
const TEXT_MARGIN_PT = 12

export interface ScannerPdfImagePage {
  buffer: Buffer
  mime: string
}

export interface ScannerPdfOptions {
  /**
   * 页面布局：
   *   'image'（默认）页面尺寸跟随图片，满版无留白，最接近真实电子版；
   *   'a4' 固定 A4 + 留白，适合要打印的场合。
   */
  layout?: 'image' | 'a4'
  /** layout='image' 时的输出 DPI，默认 200。 */
  dpi?: number
  /**
   * 可搜索 PDF：把 texts 里的 OCR 文本作为隐藏文字层叠在对应页上。
   * 需要传 texts（与 images 平行）；无文本的页自动跳过。
   */
  searchable?: boolean
  /** 每页 OCR 文本（与 images 平行，可含空串），searchable 时使用。 */
  texts?: string[]
}

interface CompiledImage {
  /** 已按 filter 准备好的流数据。 */
  stream: Buffer
  width: number
  height: number
  filter: 'DCTDecode' | 'FlateDecode'
  colorSpace: 'DeviceRGB' | 'DeviceGray'
  bitsPerComponent: 1 | 8
}

const importSharp = () => import('sharp')
let sharpModulePromise: ReturnType<typeof importSharp> | undefined
async function loadSharp() {
  sharpModulePromise ??= importSharp()
  return sharpModulePromise
}

interface ImageDims { width: number; height: number }

function readJpegDimensions(buf: Buffer): ImageDims | null {
  let offset = 2
  while (offset < buf.length - 9) {
    if (buf[offset] !== 0xff) break
    const marker = buf[offset + 1]
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = buf.readUInt16BE(offset + 5)
      const width = buf.readUInt16BE(offset + 7)
      if (width > 0 && height > 0) return { width, height }
      return null
    }
    const len = buf.readUInt16BE(offset + 2)
    offset += 2 + len
  }
  return null
}

/**
 * 把灰度像素打包成 1bpp（bit=1 表示白），行首字节对齐。
 * PDF /DeviceGray + /BitsPerComponent 1 直接吃这个布局。
 */
export function packBilevel(gray: Buffer | Uint8Array, width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width / 8)
  const out = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes
    const srcRow = y * width
    for (let x = 0; x < width; x++) {
      if (gray[srcRow + x]! >= 128) {
        out[rowStart + (x >> 3)]! |= 0x80 >> (x & 7)
      }
    }
  }
  return out
}

/**
 * 判断灰度数据是否「几乎只有黑白两级」（扫描件二值化输出）。
 * 允许少量中间值（抗锯齿边缘），阈值 3%。
 */
export function isBilevelGray(gray: Buffer | Uint8Array, tolerance = 0.03): boolean {
  const n = gray.length
  if (n === 0) return false
  let mid = 0
  const budget = Math.max(1, Math.floor(n * tolerance))
  for (let i = 0; i < n; i++) {
    const v = gray[i]!
    if (v > 24 && v < 231) {
      mid++
      if (mid > budget) return false
    }
  }
  return true
}

async function compileImage(page: ScannerPdfImagePage): Promise<CompiledImage> {
  const mime = (page.mime || '').toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    const dims = readJpegDimensions(page.buffer)
    if (dims) {
      return {
        stream: page.buffer,
        width: dims.width,
        height: dims.height,
        filter: 'DCTDecode',
        colorSpace: 'DeviceRGB',
        bitsPerComponent: 8,
      }
    }
  }

  // 非 JPEG（客户端二值预设输出 PNG）或 JPEG 头损坏：走 sharp 解码
  let sharp: Awaited<ReturnType<typeof importSharp>>['default']
  try {
    sharp = (await loadSharp()).default
  } catch (error) {
    logger.warn({ err: (error as Error)?.message }, '[scanner] sharp unavailable for pdf image decode')
    const err: any = new Error('scanner: image decoder unavailable for this page format')
    err.status = 500
    err.code = 'scanner_pdf_decode_unavailable'
    throw err
  }

  const raw = await sharp(page.buffer).greyscale().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = raw.info
  if (!width || !height) {
    const err: any = new Error('scanner: unreadable page image')
    err.status = 400
    err.code = 'scanner_pdf_bad_image'
    throw err
  }
  if (isBilevelGray(raw.data)) {
    // 纯黑白：1bpp + Flate 无损，文字最锐、体积最小
    const packed = packBilevel(raw.data, width, height)
    return {
      stream: deflateSync(packed, { level: 9 }),
      width,
      height,
      filter: 'FlateDecode',
      colorSpace: 'DeviceGray',
      bitsPerComponent: 1,
    }
  }
  // 灰度/彩色 PNG：转 JPEG 嵌入（不做色度二次采样，保住细笔画）
  const jpeg = await sharp(page.buffer).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
  const dims = readJpegDimensions(jpeg) ?? { width, height }
  return {
    stream: jpeg,
    width: dims.width,
    height: dims.height,
    filter: 'DCTDecode',
    colorSpace: 'DeviceRGB',
    bitsPerComponent: 8,
  }
}

/** 页面尺寸（pt）与图片绘制矩形。 */
export function computePageBox(
  image: ImageDims,
  options: ScannerPdfOptions = {},
): { pageWidth: number; pageHeight: number; drawWidth: number; drawHeight: number; x: number; y: number } {
  const layout = options.layout ?? 'image'
  if (layout === 'a4') {
    const innerW = A4_WIDTH_PT - A4_MARGIN_PT * 2
    const innerH = A4_HEIGHT_PT - A4_MARGIN_PT * 2
    const ratio = Math.min(innerW / image.width, innerH / image.height)
    const drawWidth = Math.max(1, image.width * ratio)
    const drawHeight = Math.max(1, image.height * ratio)
    return {
      pageWidth: A4_WIDTH_PT,
      pageHeight: A4_HEIGHT_PT,
      drawWidth,
      drawHeight,
      x: A4_MARGIN_PT + (innerW - drawWidth) / 2,
      y: A4_MARGIN_PT + (innerH - drawHeight) / 2,
    }
  }
  const dpi = options.dpi && options.dpi > 0 ? options.dpi : DEFAULT_DPI
  let pageWidth = (image.width / dpi) * 72
  let pageHeight = (image.height / dpi) * 72
  const longest = Math.max(pageWidth, pageHeight)
  if (longest > MAX_PAGE_PT) {
    const shrink = MAX_PAGE_PT / longest
    pageWidth *= shrink
    pageHeight *= shrink
  }
  pageWidth = Math.max(1, pageWidth)
  pageHeight = Math.max(1, pageHeight)
  // 满版：图片铺满整页，没有白边
  return { pageWidth, pageHeight, drawWidth: pageWidth, drawHeight: pageHeight, x: 0, y: 0 }
}

function buildContentStream(box: ReturnType<typeof computePageBox>, name: string): string {
  return [
    'q',
    `${box.drawWidth.toFixed(2)} 0 0 ${box.drawHeight.toFixed(2)} ${box.x.toFixed(2)} ${box.y.toFixed(2)} cm`,
    `/${name} Do`,
    'Q',
  ].join('\n')
}

/**
 * 把字符串编码为 PDF hex string（UTF-16BE）。配合 /Encoding /UniGB-UCS2-H，
 * 2 字节 UTF-16 码元即 CMap 的 CID，覆盖 GB1 全部中日韩字符；非 BMP 字符
 * 走标准代理对。控制字符（除换行外）会被剥掉。
 */
export function encodeUtf16BeHex(input: string): string {
  let out = ''
  for (const ch of String(input || '')) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 && code !== 0x09) continue
    if (code > 0xffff) {
      const hi = 0xd800 + ((code - 0x10000) >> 10)
      const lo = 0xdc00 + ((code - 0x10000) & 0x3ff)
      out += hi.toString(16).padStart(4, '0').toUpperCase()
      out += lo.toString(16).padStart(4, '0').toUpperCase()
    } else {
      out += code.toString(16).padStart(4, '0').toUpperCase()
    }
  }
  return out
}

/**
 * 生成一页的隐藏文字层内容流（渲染模式 `3 Tr`：不可见、可选中/搜索）。
 *
 * 布局策略：OCR 文本按行拆分后均分页面可用高度（选区是近似行位置）；
 * 空行跳过但占一行高度，保持行序与 OCR 输出一致。没有可用文本返回 null。
 */
export function buildInvisibleTextStream(
  text: string,
  box: { pageWidth: number; pageHeight: number },
  fontResName = 'F0',
): string | null {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trimEnd())
    .filter(line => line.trim().length > 0)
  if (lines.length === 0) return null
  const availH = Math.max(12, box.pageHeight - TEXT_MARGIN_PT * 2)
  const step = availH / lines.length
  const fontSize = Math.min(14, Math.max(2, step * 0.72))
  const ops: string[] = [
    'BT',
    '3 Tr',
    `/${fontResName} ${fontSize.toFixed(2)} Tf`,
    `${TEXT_MARGIN_PT} ${(box.pageHeight - TEXT_MARGIN_PT - fontSize).toFixed(2)} Td`,
  ]
  for (const [index, line] of lines.entries()) {
    if (index > 0) ops.push(`0 ${(-step).toFixed(2)} Td`)
    ops.push(`<${encodeUtf16BeHex(line)}> Tj`)
  }
  ops.push('ET')
  return ops.join('\n')
}

/** 非嵌入 CJK Type0 字体三件套（Type0 / CIDFontType0 / FontDescriptor）。 */
function fontObjects(): [string, string, string] {
  const type0 = '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [{{CID}} 0 R] >>'
  const cid = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor {{FD}} 0 R /DW 1000 >>'
  const descriptor = '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 93 >>'
  return [type0, cid, descriptor]
}

export async function buildScannerImagePdf(
  images: ScannerPdfImagePage[],
  options: ScannerPdfOptions = {},
): Promise<Buffer> {
  if (!images || images.length === 0) {
    const err: any = new Error('scanner: no images to build PDF')
    err.status = 400
    err.code = 'scanner_pdf_no_images'
    throw err
  }
  const compiled: CompiledImage[] = []
  for (const image of images) {
    compiled.push(await compileImage(image))
  }

  // 可搜索文字层：仅当开启且至少一页有文本时才注入字体对象
  const pageTexts = options.searchable && Array.isArray(options.texts)
    ? compiled.map((_, i) => String(options.texts![i] ?? ''))
    : []
  const useTextLayer = pageTexts.some(t => t.trim().length > 0)

  // Object index layout:
  //   1: Catalog
  //   2: Pages
  //   3..3+N-1: Image XObjects (one per page)
  //   3+N..3+2N-1: Page objects
  //   3+2N..3+3N-1: Content streams (one per page)
  //   [useTextLayer] 3+3N..3+3N+2: Type0 / CIDFontType0 / FontDescriptor
  const N = compiled.length
  const fontBase = 3 + N * 3
  const totalObjects = fontBase + (useTextLayer ? 3 : 0)

  const offsets: number[] = new Array(totalObjects).fill(0)
  let body = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')

  function append(chunk: Buffer) { body = Buffer.concat([body, chunk]) }
  function recordObject(index: number, content: Buffer) {
    offsets[index] = body.length
    append(Buffer.from(`${index} 0 obj\n`, 'binary'))
    append(content)
    append(Buffer.from('\nendobj\n', 'binary'))
  }

  recordObject(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'binary'))
  const kids = Array.from({ length: N }, (_, i) => `${3 + N + i} 0 R`).join(' ')
  recordObject(2, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${N} >>`, 'binary'))

  // Image XObjects
  for (let i = 0; i < N; i += 1) {
    const img = compiled[i]!
    const idx = 3 + i
    const dict = `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent ${img.bitsPerComponent} /Filter /${img.filter} /Length ${img.stream.length} >>`
    offsets[idx] = body.length
    append(Buffer.from(`${idx} 0 obj\n${dict}\nstream\n`, 'binary'))
    append(img.stream)
    append(Buffer.from('\nendstream\nendobj\n', 'binary'))
  }

  const boxes = compiled.map(img => computePageBox({ width: img.width, height: img.height }, options))

  // Page objects（useTextLayer 时每页 Resources 都带 /Font 引用，无文本的页只是不写文字）
  for (let i = 0; i < N; i += 1) {
    const pageIndex = 3 + N + i
    const contentIndex = 3 + 2 * N + i
    const imgObjIndex = 3 + i
    const box = boxes[i]!
    const fontRes = useTextLayer ? ` /Font << /F0 ${fontBase} 0 R >>` : ''
    const pageDict = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box.pageWidth.toFixed(2)} ${box.pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imgObjIndex} 0 R >>${fontRes} >> /Contents ${contentIndex} 0 R >>`
    recordObject(pageIndex, Buffer.from(pageDict, 'binary'))
  }

  // Content streams（图像 + 可选隐藏文字层）
  for (let i = 0; i < N; i += 1) {
    const contentIndex = 3 + 2 * N + i
    const box = boxes[i]!
    let content = buildContentStream(box, 'Im0')
    if (useTextLayer) {
      const textStream = buildInvisibleTextStream(pageTexts[i] ?? '', box)
      if (textStream) content = `${content}\n${textStream}`
    }
    const stream = Buffer.from(`${content}\n`, 'binary')
    const dict = `<< /Length ${stream.length} >>`
    offsets[contentIndex] = body.length
    append(Buffer.from(`${contentIndex} 0 obj\n${dict}\nstream\n`, 'binary'))
    append(stream)
    append(Buffer.from('\nendstream\nendobj\n', 'binary'))
  }

  // 非嵌入 CJK 字体三件套（对象里的引用占位先替换成真实对象号）
  if (useTextLayer) {
    const [type0Tpl, cidTpl, fdTpl] = fontObjects()
    const type0 = type0Tpl.replace('{{CID}}', String(fontBase + 1))
    const cid = cidTpl.replace('{{FD}}', String(fontBase + 2))
    recordObject(fontBase, Buffer.from(type0, 'binary'))
    recordObject(fontBase + 1, Buffer.from(cid, 'binary'))
    recordObject(fontBase + 2, Buffer.from(fdTpl, 'binary'))
  }

  // xref
  const xrefOffset = body.length
  const xrefLines: string[] = ['xref', `0 ${totalObjects}`, '0000000000 65535 f ']
  for (let i = 1; i < totalObjects; i += 1) {
    xrefLines.push(`${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n `)
  }
  const trailer = `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  append(Buffer.from(`${xrefLines.join('\n')}\n${trailer}`, 'binary'))

  return body
}

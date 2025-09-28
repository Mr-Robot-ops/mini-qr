import { IS_COPY_IMAGE_TO_CLIPBOARD_SUPPORTED } from '@/utils/clipboard'
import domtoimage, { type Options } from 'dom-to-image'
import { elementToSVG, inlineResources } from 'dom-to-svg'

/**
 * NOTE:
 * Default export dimensions used as fallback when element metrics are unavailable.
 */
const defaultOptions: Options = {
  width: 400,
  height: 400
}

/**
 * NOTE:
 * Corner radii structure used across PNG/JPG/SVG pipelines.
 */
type CornerRadii = {
  topLeft: number
  topRight: number
  bottomRight: number
  bottomLeft: number
}

const DEFAULT_RADIUS = 48

/**
 * NOTE:
 * Radius helpers for parsing, equality checks and CSS clip-path value building.
 * Keeps values normalized to avoid malformed corners at larger sizes (≥202px).
 */
const areRadiiEqual = (radii: CornerRadii): boolean => {
  const { topLeft, topRight, bottomRight, bottomLeft } = radii
  return topLeft === topRight && topLeft === bottomRight && topLeft === bottomLeft
}

const buildClipPathValue = (radii: CornerRadii): string => {
  const formatted = [radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft].map(
    (value) => formatRadiusValue(value)
  )
  return areRadiiEqual(radii)
    ? `inset(0 round ${formatted[0]})`
    : `inset(0 round ${formatted.join(' ')})`
}

const parseRadiusValue = (value?: string | null): number | null => {
  if (!value) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * NOTE:
 * Reads computed border radii from the element, falling back to a default.
 */
const getCornerRadii = (element: HTMLElement, fallbackRadius?: string): CornerRadii => {
  const computedStyle = typeof window !== 'undefined' ? window.getComputedStyle(element) : null
  const fallbackValue = parseRadiusValue(fallbackRadius) ?? DEFAULT_RADIUS

  const topLeft = parseRadiusValue(computedStyle?.borderTopLeftRadius) ?? fallbackValue
  const topRight = parseRadiusValue(computedStyle?.borderTopRightRadius) ?? fallbackValue
  const bottomRight = parseRadiusValue(computedStyle?.borderBottomRightRadius) ?? fallbackValue
  const bottomLeft = parseRadiusValue(computedStyle?.borderBottomLeftRadius) ?? fallbackValue

  return { topLeft, topRight, bottomRight, bottomLeft }
}

/**
 * NOTE:
 * Formats numeric radius into a px string with sane clamping and rounding.
 */
const formatRadiusValue = (value: number): string => {
  const clamped = Number.isFinite(value) ? Math.max(value, 0) : 0
  const rounded = Math.round(clamped * 1000) / 1000
  return `${rounded}px`
}

/**
 * NOTE:
 * The "ExportPreparation" bundle collects all computed values needed by
 * PNG/JPG/SVG export steps: dimensions, scale, and final corner radii.
 */
type ExportPreparation = {
  options: Options
  radii: CornerRadii
  outputRadii: CornerRadii
  clipRadii: CornerRadii
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
  sourceX: number
  sourceY: number
  scale: number
}

/**
 * NOTE:
 * Parses width/height whether number or string. Returns null for invalid inputs.
 */
const parseDimension = (value: Options['width'] | Options['height']): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value === 'string') {
    const parsed = parseFloat(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/**
 * NOTE:
 * CSS corner radii must obey a 2D constraint: sums of adjacent radii cannot
 * exceed box width/height. This function enforces that constraint by scaling
 * all corners uniformly when needed.
 */
const clampRadiiCss = (r: CornerRadii, width: number, height: number): CornerRadii => {
  const tl = Math.max(0, r.topLeft || 0)
  const tr = Math.max(0, r.topRight || 0)
  const br = Math.max(0, r.bottomRight || 0)
  const bl = Math.max(0, r.bottomLeft || 0)

  const topSum = tl + tr
  const bottomSum = bl + br
  const leftSum = tl + bl
  const rightSum = tr + br

  const sTop = topSum > 0 ? width / topSum : Infinity
  const sBottom = bottomSum > 0 ? width / bottomSum : Infinity
  const sLeft = leftSum > 0 ? height / leftSum : Infinity
  const sRight = rightSum > 0 ? height / rightSum : Infinity

  const f = Math.min(1, sTop, sBottom, sLeft, sRight)

  return {
    topLeft: tl * f,
    topRight: tr * f,
    bottomRight: br * f,
    bottomLeft: bl * f
  }
}

/**
 * NOTE:
 * Export preparation:
 * - Determine final target size (requested or element fallback)
 * - Compute safe scale factor
 * - Clamp radii both for preview (scaled) and output (target dimensions)
 * - Build style overrides (transform, borderRadius, clip-path) for dom-to-image
 */
const getExportPreparation = (
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): ExportPreparation => {
  const requestedWidth = parseDimension(options.width)
  const requestedHeight = parseDimension(options.height)
  const fallbackWidth = element.offsetWidth || defaultOptions.width || 1
  const fallbackHeight = element.offsetHeight || defaultOptions.height || 1
  const targetWidth = requestedWidth ?? fallbackWidth
  const targetHeight = requestedHeight ?? fallbackHeight

  const radii = getCornerRadii(element, borderRadius)
  const bounds =
    typeof element.getBoundingClientRect === 'function'
      ? element.getBoundingClientRect()
      : ({ x: 0, y: 0, width: targetWidth, height: targetHeight } as DOMRect)
  const sourceWidth = bounds?.width || targetWidth
  const sourceHeight = bounds?.height || targetHeight
  const sourceX = (bounds?.x ?? (bounds as DOMRect).left ?? 0) || 0
  const sourceY = (bounds?.y ?? (bounds as DOMRect).top ?? 0) || 0

  if (requestedWidth && requestedHeight) {
    const scale = getResizeScaleToFit(element, requestedWidth, requestedHeight)
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1

    const scaledRadii: CornerRadii = {
      topLeft: radii.topLeft / safeScale,
      topRight: radii.topRight / safeScale,
      bottomRight: radii.bottomRight / safeScale,
      bottomLeft: radii.bottomLeft / safeScale
    }

    const previewWidth = requestedWidth / safeScale
    const previewHeight = requestedHeight / safeScale
    const scaledClamped = clampRadiiCss(scaledRadii, previewWidth, previewHeight)

    const outputRadii: CornerRadii = clampRadiiCss(
      {
        topLeft: radii.topLeft * safeScale,
        topRight: radii.topRight * safeScale,
        bottomRight: radii.bottomRight * safeScale,
        bottomLeft: radii.bottomLeft * safeScale
      },
      requestedWidth,
      requestedHeight
    )

    const style: Record<string, string> = {
      ...(options.style ? (options.style as Record<string, string>) : {}),
      transform: `scale(${safeScale})`,
      transformOrigin: 'left top',
      overflow: 'hidden'
    }

    style.borderTopLeftRadius = formatRadiusValue(scaledClamped.topLeft)
    style.borderTopRightRadius = formatRadiusValue(scaledClamped.topRight)
    style.borderBottomRightRadius = formatRadiusValue(scaledClamped.bottomRight)
    style.borderBottomLeftRadius = formatRadiusValue(scaledClamped.bottomLeft)

    const radiiValues = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius
    ]

    const allEqual = radiiValues.every((value) => value === radiiValues[0])
    style.borderRadius = allEqual ? radiiValues[0] : radiiValues.join(' ')
    const clipPathValue = buildClipPathValue(scaledClamped)
    style.clipPath = clipPathValue
    style.webkitClipPath = clipPathValue

    return {
      radii,
      outputRadii,
      clipRadii: scaledClamped,
      width: requestedWidth,
      height: requestedHeight,
      sourceWidth,
      sourceHeight,
      sourceX,
      sourceY,
      scale: safeScale,
      options: {
        quality: 100,
        ...options,
        width: requestedWidth,
        height: requestedHeight,
        style
      }
    }
  }

  const style: Record<string, string> = {
    ...(options.style ? (options.style as Record<string, string>) : {}),
    overflow: 'hidden'
  }

  const radiiClamped = clampRadiiCss(radii, targetWidth, targetHeight)

  style.borderTopLeftRadius = formatRadiusValue(radiiClamped.topLeft)
  style.borderTopRightRadius = formatRadiusValue(radiiClamped.topRight)
  style.borderBottomRightRadius = formatRadiusValue(radiiClamped.bottomRight)
  style.borderBottomLeftRadius = formatRadiusValue(radiiClamped.bottomLeft)

  const radiiValues = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius
  ]

  const allEqual = radiiValues.every((value) => value === radiiValues[0])
  style.borderRadius = allEqual ? radiiValues[0] : radiiValues.join(' ')
  const clipPathValue = buildClipPathValue(radiiClamped)
  style.clipPath = clipPathValue
  style.webkitClipPath = clipPathValue

  return {
    radii,
    outputRadii: radiiClamped,
    clipRadii: radiiClamped,
    width: targetWidth,
    height: targetHeight,
    sourceWidth,
    sourceHeight,
    sourceX,
    sourceY,
    scale: 1,
    options: {
      quality: 100,
      ...defaultOptions,
      ...options,
      width: targetWidth,
      height: targetHeight,
      style
    }
  }
}

/**
 * NOTE:
 * Computes a scale factor that fits the element into the requested box.
 * Protects against zero sizes and negative/NaN results.
 */
const getResizeScaleToFit = (child: HTMLElement, width: number, height: number): number => {
  const prevOrigin = child.style.transformOrigin
  child.style.transformOrigin = 'center'

  const childWidth = child.offsetWidth
  const childHeight = child.offsetHeight

  child.style.transformOrigin = prevOrigin

  if (childWidth === 0 || childHeight === 0) {
    return 1
  }

  const scaleX = width / childWidth
  const scaleY = height / childHeight

  const maxScale = Math.min(scaleX, scaleY)
  return Number.isFinite(maxScale) && maxScale > 0 ? maxScale : 1
}

/**
 * NOTE:
 * Canvas path builder for a rounded rectangle.
 * Used to clip PNG exports to real rounded corners after rasterization.
 */
const drawRoundedRectPath = (
  context: CanvasRenderingContext2D,
  radii: CornerRadii,
  width: number,
  height: number
) => {
  const { topLeft, topRight, bottomRight, bottomLeft } = clampRadiiCss(radii, width, height)

  const tl = topLeft
  const tr = topRight
  const br = bottomRight
  const bl = bottomLeft

  context.beginPath()
  context.moveTo(tl, 0)
  context.lineTo(width - tr, 0)
  if (tr > 0) {
    context.arcTo(width, 0, width, tr, tr)
  } else {
    context.lineTo(width, 0)
  }
  context.lineTo(width, height - br)
  if (br > 0) {
    context.arcTo(width, height, width - br, height, br)
  } else {
    context.lineTo(width, height)
  }
  context.lineTo(bl, height)
  if (bl > 0) {
    context.arcTo(0, height, 0, height - bl, bl)
  } else {
    context.lineTo(0, height)
  }
  context.lineTo(0, tl)
  if (tl > 0) {
    context.arcTo(0, 0, tl, 0, tl)
  } else {
    context.lineTo(0, 0)
  }
  context.closePath()
}

/**
 * NOTE:
 * Numeric formatter for concise SVG path values (≤3 decimals, stripped zeros).
 */
const formatSvgNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0'
  }
  const rounded = Math.round(value * 1000) / 1000
  if (Number.isInteger(rounded)) {
    return rounded.toString()
  }
  return rounded
    .toFixed(3)
    .replace(/\.0+$/, '')
    .replace(/\.([0-9]*[1-9])0+$/, '.$1')
}

/**
 * NOTE:
 * Generates a rounded-rectangle path for <clipPath> in userSpaceOnUse units.
 * Offsets allow mapping to an existing viewBox.
 */
const createRoundedRectPathData = (
  radii: CornerRadii,
  width: number,
  height: number,
  offsetX = 0,
  offsetY = 0
): string => {
  const { topLeft, topRight, bottomRight, bottomLeft } = clampRadiiCss(radii, width, height)
  const tl = Math.max(0, topLeft)
  const tr = Math.max(0, topRight)
  const br = Math.max(0, bottomRight)
  const bl = Math.max(0, bottomLeft)

  const commands: string[] = []

  const startX = offsetX + tl
  const startY = offsetY

  commands.push(`M ${formatSvgNumber(startX)} ${formatSvgNumber(startY)}`)
  commands.push(`H ${formatSvgNumber(offsetX + width - tr)}`)
  if (tr > 0) {
    commands.push(
      `A ${formatSvgNumber(tr)} ${formatSvgNumber(tr)} 0 0 1 ${formatSvgNumber(offsetX + width)} ${formatSvgNumber(
        offsetY + tr
      )}`
    )
  }
  commands.push(`V ${formatSvgNumber(offsetY + height - br)}`)
  if (br > 0) {
    commands.push(
      `A ${formatSvgNumber(br)} ${formatSvgNumber(br)} 0 0 1 ${formatSvgNumber(offsetX + width - br)} ${formatSvgNumber(
        offsetY + height
      )}`
    )
  }
  commands.push(`H ${formatSvgNumber(offsetX + bl)}`)
  if (bl > 0) {
    commands.push(
      `A ${formatSvgNumber(bl)} ${formatSvgNumber(bl)} 0 0 1 ${formatSvgNumber(offsetX)} ${formatSvgNumber(
        offsetY + height - bl
      )}`
    )
  }
  commands.push(`V ${formatSvgNumber(offsetY + tl)}`)
  if (tl > 0) {
    commands.push(
      `A ${formatSvgNumber(tl)} ${formatSvgNumber(tl)} 0 0 1 ${formatSvgNumber(offsetX + tl)} ${formatSvgNumber(startY)}`
    )
  }
  commands.push('Z')

  return commands.join(' ')
}

/**
 * NOTE:
 * Blob → data URL helper used by PNG pipeline.
 */
const blobToDataURL = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to convert blob to data URL'))
      }
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

/**
 * NOTE:
 * PNG pipeline: repaint base raster with real rounded corners on Canvas.
 * Decouples us from dom-to-image corner limitations at larger sizes.
 */
const paintBlobWithRoundedCorners = async (
  blob: Blob,
  radii: CornerRadii,
  width: number,
  height: number,
  mimeType?: string
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const image = new Image()

    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width || image.naturalWidth || image.width
      canvas.height = height || image.naturalHeight || image.height

      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('Failed to get canvas context'))
        URL.revokeObjectURL(image.src)
        return
      }

      context.clearRect(0, 0, canvas.width, canvas.height)
      drawRoundedRectPath(context, radii, canvas.width, canvas.height)
      context.save()
      context.clip()
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      context.restore()

      const targetMime = mimeType ?? blob.type ?? 'image/png'
      const quality = targetMime === 'image/jpeg' ? 1 : undefined

      canvas.toBlob(
        (roundedBlob) => {
          URL.revokeObjectURL(image.src)
          if (roundedBlob) {
            resolve(roundedBlob)
          } else {
            reject(new Error('Failed to create rounded image blob'))
          }
        },
        targetMime,
        quality
      )
    } // end onload

    image.onerror = () => {
      URL.revokeObjectURL(image.src)
      reject(new Error('Failed to load image for rounding'))
    }

    image.src = URL.createObjectURL(blob)
  })

/**
 * NOTE:
 * Orchestrates PNG rendering:
 * - Produce base blob via domtoimage
 * - Attempt rounded repaint; fall back to base blob if anything fails
 */
const renderRoundedImageBlob = async (
  element: HTMLElement,
  options: Options,
  borderRadius: string | undefined,
  outputMimeType?: string
) => {
  const preparation = getExportPreparation(element, options, borderRadius)
  const baseBlob: Blob = await domtoimage.toBlob(element, preparation.options)

  try {
    const roundedBlob = await paintBlobWithRoundedCorners(
      baseBlob,
      preparation.outputRadii,
      preparation.width,
      preparation.height,
      outputMimeType ?? baseBlob.type
    )

    return {
      blob: roundedBlob,
      width: preparation.width,
      height: preparation.height
    }
  } catch (error) {
    console.error('Failed to apply rounded corners, falling back to original image.', error)
    return {
      blob: baseBlob,
      width: preparation.width,
      height: preparation.height
    }
  }
}

/**
 * NOTE:
 * Copy a DOM element as an image to the clipboard.
 * Falls back to copying a data URL string in browsers that lack Blob support (e.g., Safari).
 * injects a scaled borderRadius
 * to preserve the rounded look across resolutions. Quality fixed to 100%.
 */
const getFormattedJpegOptions = (
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Options => {
  if (options.width && options.height) {
    const scale = getResizeScaleToFit(element, Number(options.width), Number(options.height)) || 1
    const radiusValue = borderRadius ? parseInt(borderRadius.replace('px', ''), 10) : DEFAULT_RADIUS
    const scaledRadius = `${radiusValue / scale}px`

    return {
      style: {
        transform: `scale(${scale})`,
        transformOrigin: 'left top',
        borderRadius: scaledRadius,
        overflow: 'hidden'
      },
      quality: 100,
      ...options
    }
  }
  return {
    quality: 100,
    ...defaultOptions,
    ...options
  }
}

/**
 * NOTE:
 * Clipboard + PNG/JPG helpers (public API):
 * - copyImageToClipboard
 * - getPngElement / downloadPngElement
 * - getJpgElement / downloadJpgElement
 */
export async function copyImageToClipboard(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
) {
  if (!IS_COPY_IMAGE_TO_CLIPBOARD_SUPPORTED) {
    console.error('Clipboard.write is not supported in this browser')
    return
  }
  try {
    const { blob } = await renderRoundedImageBlob(element, options, borderRadius)
    const item = new ClipboardItem({ [blob.type]: blob })
    await navigator.clipboard.write([item])
    console.log('Image blob copied to clipboard')
  } catch (error: any) {
    console.error('Error copying image to clipboard:', error)
  }
}

export async function getPngElement(element: HTMLElement, options: Options, borderRadius?: string) {
  return new Promise<string>((resolve, reject) => {
    renderRoundedImageBlob(element, options, borderRadius)
      .then(({ blob }) => blobToDataURL(blob))
      .then(resolve)
      .catch(reject)
  })
}

export function downloadPngElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  renderRoundedImageBlob(element, options, borderRadius)
    .then(({ blob }) => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = filename
      link.click()
      requestAnimationFrame(() => URL.revokeObjectURL(link.href))
    })
    .catch((error: Error) => {
      console.error('Error converting element to PNG:', error)
    })
}

export async function getJpgElement(element: HTMLElement, options: Options, borderRadius?: string) {
  const formatted = getFormattedJpegOptions(element, options, borderRadius)
  return domtoimage.toJpeg(element, formatted)
}

export function downloadJpgElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  const formatted = getFormattedJpegOptions(element, options, borderRadius)
  domtoimage
    .toJpeg(element, formatted)
    .then((dataUrl: string) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error: Error) => {
      console.error('Error converting element to JPG:', error)
    })
}

/**
 * NOTE:
 * SVG pipeline with real clip path:
 * - Ensure a stable viewBox/size
 * - Strip raster-only style overrides
 * - Create <defs><clipPath><path d="rounded rect"/></clipPath></defs>
 * - Wrap content in a group with the clip applied
 */
let clipPathIdCounter = 0

function getClipPathId() {
  clipPathIdCounter += 1
  return `export-rounded-clip-${clipPathIdCounter}`
}

function applySvgOptions(svgDocument: Document, preparation: ExportPreparation) {
  const svgElement = svgDocument.documentElement
  const { width, height, sourceWidth, sourceHeight, sourceX, sourceY, options, clipRadii } =
    preparation

  const viewBoxAttr = svgElement.getAttribute('viewBox')
  const parsedViewBox = viewBoxAttr
    ? viewBoxAttr.split(/\s+/).map((value) => Number.parseFloat(value))
    : []
  let viewBoxX = Number.isFinite(parsedViewBox[0]) ? parsedViewBox[0] : sourceX
  let viewBoxY = Number.isFinite(parsedViewBox[1]) ? parsedViewBox[1] : sourceY
  let viewBoxWidth = Number.isFinite(parsedViewBox[2]) ? parsedViewBox[2] : sourceWidth
  let viewBoxHeight = Number.isFinite(parsedViewBox[3]) ? parsedViewBox[3] : sourceHeight

  if (!Number.isFinite(viewBoxWidth) || viewBoxWidth <= 0) {
    viewBoxWidth = sourceWidth
  }
  if (!Number.isFinite(viewBoxHeight) || viewBoxHeight <= 0) {
    viewBoxHeight = sourceHeight
  }
  if (!Number.isFinite(viewBoxX)) {
    viewBoxX = sourceX
  }
  if (!Number.isFinite(viewBoxY)) {
    viewBoxY = sourceY
  }

  svgElement.setAttribute('width', width.toString())
  svgElement.setAttribute('height', height.toString())
  svgElement.setAttribute(
    'viewBox',
    `${formatSvgNumber(viewBoxX)} ${formatSvgNumber(viewBoxY)} ${formatSvgNumber(
      viewBoxWidth
    )} ${formatSvgNumber(viewBoxHeight)}`
  )
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  if (options.style) {
    const style = { ...(options.style as Record<string, string>) }
    delete style.transform
    delete style.transformOrigin
    delete style.borderRadius
    delete style.borderTopLeftRadius
    delete style.borderTopRightRadius
    delete style.borderBottomRightRadius
    delete style.borderBottomLeftRadius
    delete style.clipPath
    delete style.webkitClipPath
    for (const [key, value] of Object.entries(style)) {
      ;(svgElement.style as unknown as Record<string, string>)[key] = value
    }
  }

  ;(svgElement.style as unknown as Record<string, string>).clipPath = ''
  ;(svgElement.style as unknown as Record<string, string>).webkitClipPath = ''

  const hasRoundedCorner =
    clipRadii.topLeft > 0 ||
    clipRadii.topRight > 0 ||
    clipRadii.bottomRight > 0 ||
    clipRadii.bottomLeft > 0

  if (!hasRoundedCorner) {
    svgElement.removeAttribute('clip-path')
    return
  }

  const clipPathId = getClipPathId()
  const svgNS = 'http://www.w3.org/2000/svg'
  let defs = Array.from(svgElement.children).find(
    (child) => child.tagName.toLowerCase() === 'defs'
  ) as SVGDefsElement | undefined

  if (!defs) {
    defs = svgDocument.createElementNS(svgNS, 'defs')
    svgElement.insertBefore(defs, svgElement.firstChild)
  }

  const clipPath = svgDocument.createElementNS(svgNS, 'clipPath')
  clipPath.setAttribute('id', clipPathId)
  clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse')

  const path = svgDocument.createElementNS(svgNS, 'path')
  path.setAttribute(
    'd',
    createRoundedRectPathData(clipRadii, viewBoxWidth, viewBoxHeight, viewBoxX, viewBoxY)
  )
  clipPath.appendChild(path)

  defs.appendChild(clipPath)

  const nodesToWrap = Array.from(svgElement.childNodes).filter((node) => node !== defs)

  if (nodesToWrap.length === 0) {
    svgElement.setAttribute('clip-path', `url(#${clipPathId})`)
    return
  }

  const wrapper = svgDocument.createElementNS(svgNS, 'g')
  for (const node of nodesToWrap) {
    wrapper.appendChild(node)
  }

  wrapper.setAttribute('clip-path', `url(#${clipPathId})`)
  svgElement.appendChild(wrapper)
}

/**
 * NOTE:
 * Public SVG helpers:
 * - getSvgString: returns raw SVG markup after applying clip path
 * - getSvgElement: returns data URL for downloads
 * - downloadSvgElement: triggers a file download
 */
export async function getSvgString(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Promise<string> {
  const preparation = getExportPreparation(element, options, borderRadius)
  const svgDocument = elementToSVG(element)
  await inlineResources(svgDocument.documentElement)
  applySvgOptions(svgDocument, preparation)
  return new XMLSerializer().serializeToString(svgDocument)
}

export async function getSvgElement(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Promise<string> {
  const svgString = await getSvgString(element, options, borderRadius)
  // Convert SVG string to data URL
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`
}

export function downloadSvgElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  getSvgElement(element, options, borderRadius)
    .then((dataUrl: string) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error: Error) => {
      console.error('Error converting element to SVG:', error)
    })
}

/**
 * NOTE:
 * Legacy SVG sanitisation helpers remove advanced features that minimal
 * renderers (e.g., IrfanView plug-ins) do not understand.
 */
const LEGACY_STYLE_ATTRIBUTES = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke-opacity',
  'opacity',
  'transform',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'shape-rendering',
  'vector-effect',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'word-spacing'
])

const PRESENTATION_ATTRIBUTES = Array.from(LEGACY_STYLE_ATTRIBUTES)

const CSS_VARIABLE_PREFIX = '--'

const VAR_FUNCTION_PATTERN = /var\((--[\w-]+)(?:,\s*([^)]+))?\)/g

const MAX_CSS_VAR_DEPTH = 10

function parseStyleDeclarations(styleValue: string): Array<[string, string]> {
  return styleValue
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const separatorIndex = declaration.indexOf(':')
      if (separatorIndex === -1) {
        return null
      }
      const property = declaration.slice(0, separatorIndex).trim().toLowerCase()
      const value = declaration.slice(separatorIndex + 1).trim()
      if (!property || !value) {
        return null
      }
      return [property, value] as [string, string]
    })
    .filter((entry): entry is [string, string] => Boolean(entry))
}

function resolveCssVariables(value: string, variables: Map<string, string>, depth = 0): string {
  if (!value) {
    return value
  }
  if (!value.includes('var(') || depth > MAX_CSS_VAR_DEPTH) {
    return value
  }

  let replaced = value
  let didReplace = false

  const matcher = new RegExp(VAR_FUNCTION_PATTERN.source, 'g')

  replaced = replaced.replace(matcher, (_match, name: string, fallback?: string) => {
    didReplace = true
    const trimmedName = name.trim()
    const resolved = variables.get(trimmedName)
    if (resolved && resolved !== trimmedName) {
      return resolveCssVariables(resolved, variables, depth + 1)
    }
    if (fallback) {
      const cleanedFallback = fallback.trim()
      if (cleanedFallback) {
        return resolveCssVariables(cleanedFallback, variables, depth + 1)
      }
    }
    return ''
  })

  if (!didReplace) {
    return replaced
  }

  if (replaced.includes('var(') && depth < MAX_CSS_VAR_DEPTH) {
    return resolveCssVariables(replaced, variables, depth + 1)
  }

  return replaced
}

function stripUnsupportedForLegacy(svgDocument: Document) {
  const svgElement = svgDocument.documentElement
  if (!svgElement) {
    return
  }

  const disallowedTags = [
    'defs',
    'style',
    'mask',
    'clipPath',
    'filter',
    'foreignObject',
    'image',
    'symbol',
    'use'
  ]

  for (const tagName of disallowedTags) {
    const elements = Array.from(svgDocument.getElementsByTagName(tagName))
    for (const element of elements) {
      element.parentNode?.removeChild(element)
    }
  }

  const attributesToRemove = ['clip-path', 'mask', 'filter']

  const walk = (element: Element, inheritedVariables: Map<string, string>) => {
    for (const attribute of attributesToRemove) {
      if (element.hasAttribute(attribute)) {
        element.removeAttribute(attribute)
      }
    }

    let activeVariables = inheritedVariables
    const styleValue = element.getAttribute('style')
    if (styleValue) {
      const declarations = parseStyleDeclarations(styleValue)
      const localVariables = new Map(inheritedVariables)

      for (const [property, value] of declarations) {
        if (!property.startsWith(CSS_VARIABLE_PREFIX)) {
          continue
        }
        const resolved = resolveCssVariables(value, localVariables)
        localVariables.set(property, resolved)
      }

      for (const [property, value] of declarations) {
        if (property.startsWith(CSS_VARIABLE_PREFIX)) {
          continue
        }
        if (!LEGACY_STYLE_ATTRIBUTES.has(property)) {
          continue
        }
        if (element.hasAttribute(property)) {
          continue
        }
        const resolved = resolveCssVariables(value, localVariables)
        if (resolved) {
          element.setAttribute(property, resolved)
        }
      }

      element.removeAttribute('style')
      activeVariables = localVariables
    }

    for (const attributeName of PRESENTATION_ATTRIBUTES) {
      const attributeValue = element.getAttribute(attributeName)
      if (attributeValue && attributeValue.includes('var(')) {
        const resolved = resolveCssVariables(attributeValue, activeVariables)
        element.setAttribute(attributeName, resolved)
      }
    }

    const nextVariables = styleValue ? new Map(activeVariables) : activeVariables
    for (const child of Array.from(element.children)) {
      walk(child, nextVariables)
    }
  }

  walk(svgElement, new Map())
}

function applyStrictRootSize(svgDocument: Document, width: number, height: number) {
  const svgElement = svgDocument.documentElement
  if (!svgElement) {
    return
  }

  const fallbackWidth = parseDimension(svgElement.getAttribute('width')) ?? defaultOptions.width
  const fallbackHeight = parseDimension(svgElement.getAttribute('height')) ?? defaultOptions.height

  const resolvedWidth = Number.isFinite(width) && width > 0 ? width : fallbackWidth
  const resolvedHeight = Number.isFinite(height) && height > 0 ? height : fallbackHeight

  const widthPx = Math.max(1, Math.round(resolvedWidth))
  const heightPx = Math.max(1, Math.round(resolvedHeight))

  svgElement.setAttribute('width', `${widthPx}px`)
  svgElement.setAttribute('height', `${heightPx}px`)

  svgElement.setAttribute('viewBox', `0 0 ${formatSvgNumber(widthPx)} ${formatSvgNumber(heightPx)}`)
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet')
}

function removeRoundedCornersLegacy(svgDocument: Document) {
  // Intentionally left blank: rounded corners are ignored for legacy output.
  void svgDocument
}

type LegacyAdjustment = (offsetX: number, offsetY: number) => void

const parseNumericAttribute = (value: string | null): number | null => {
  if (!value) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

type TranslationExtraction = {
  tx: number
  ty: number
  consumed: boolean
}

const TRANSLATE_REGEX =
  /translate\(\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)?(?:[\s,]+([+-]?\d*\.?\d+(?:e[+-]?\d+)?))?\s*\)/i
const MATRIX_REGEX = /matrix\(([^)]+)\)/i

function extractTranslation(transformValue: string | null): TranslationExtraction {
  if (!transformValue) {
    return { tx: 0, ty: 0, consumed: false }
  }

  const translateMatch = transformValue.match(TRANSLATE_REGEX)
  if (translateMatch) {
    const tx = parseFloat(translateMatch[1] ?? '0')
    const ty = parseFloat(translateMatch[2] ?? '0')
    return {
      tx: Number.isFinite(tx) ? tx : 0,
      ty: Number.isFinite(ty) ? ty : 0,
      consumed: true
    }
  }

  const matrixMatch = transformValue.match(MATRIX_REGEX)
  if (matrixMatch) {
    const components = matrixMatch[1]
      .split(/[\s,]+/)
      .map((component) => parseFloat(component))
      .filter((component) => Number.isFinite(component))

    if (components.length === 6) {
      const [a, b, c, d, e, f] = components
      const isIdentityScale = Math.abs(a - 1) < 1e-6 && Math.abs(d - 1) < 1e-6
      const isZeroSkew = Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6
      if (isIdentityScale && isZeroSkew) {
        return { tx: e, ty: f, consumed: true }
      }
    }
  }

  return { tx: 0, ty: 0, consumed: false }
}

function normalizeLegacyCoordinates(svgDocument: Document) {
  const svgElement = svgDocument.documentElement
  if (!svgElement) {
    return
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const adjustments: LegacyAdjustment[] = []

  const recordBounds = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return
    }
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const recordRect = (x: number, y: number, width: number, height: number, element: Element) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return
    }
    recordBounds(x, y)
    recordBounds(x + width, y + height)
    adjustments.push((offsetX, offsetY) => {
      element.setAttribute('x', formatSvgNumber(x - offsetX))
      element.setAttribute('y', formatSvgNumber(y - offsetY))
    })
  }

  const recordCircle = (cx: number, cy: number, r: number, element: Element) => {
    if (!Number.isFinite(r)) {
      return
    }
    recordBounds(cx - r, cy - r)
    recordBounds(cx + r, cy + r)
    adjustments.push((offsetX, offsetY) => {
      element.setAttribute('cx', formatSvgNumber(cx - offsetX))
      element.setAttribute('cy', formatSvgNumber(cy - offsetY))
    })
  }

  const recordLine = (x1: number, y1: number, x2: number, y2: number, element: Element) => {
    recordBounds(x1, y1)
    recordBounds(x2, y2)
    adjustments.push((offsetX, offsetY) => {
      element.setAttribute('x1', formatSvgNumber(x1 - offsetX))
      element.setAttribute('y1', formatSvgNumber(y1 - offsetY))
      element.setAttribute('x2', formatSvgNumber(x2 - offsetX))
      element.setAttribute('y2', formatSvgNumber(y2 - offsetY))
    })
  }

  const recordPoints = (points: Array<[number, number]>, element: Element) => {
    for (const [x, y] of points) {
      recordBounds(x, y)
    }
    adjustments.push((offsetX, offsetY) => {
      const adjusted = points
        .map(([x, y]) => `${formatSvgNumber(x - offsetX)},${formatSvgNumber(y - offsetY)}`)
        .join(' ')
      element.setAttribute('points', adjusted)
    })
  }

  const parsePoints = (value: string | null): Array<[number, number]> => {
    if (!value) {
      return []
    }
    const entries = value.trim().split(/\s+/)
    const result: Array<[number, number]> = []
    for (const entry of entries) {
      const [xRaw, yRaw] = entry.split(',')
      const x = parseFloat(xRaw ?? '')
      const y = parseFloat(yRaw ?? '')
      if (Number.isFinite(x) && Number.isFinite(y)) {
        result.push([x, y])
      }
    }
    return result
  }

  const walk = (element: Element, parentTx: number, parentTy: number) => {
    const { tx, ty, consumed } = extractTranslation(element.getAttribute('transform'))
    const totalTx = parentTx + tx
    const totalTy = parentTy + ty

    if (consumed) {
      element.removeAttribute('transform')
    }

    const tag = element.tagName.toLowerCase()

    switch (tag) {
      case 'rect': {
        const rawX = parseNumericAttribute(element.getAttribute('x')) ?? 0
        const rawY = parseNumericAttribute(element.getAttribute('y')) ?? 0
        const width = parseNumericAttribute(element.getAttribute('width')) ?? 0
        const height = parseNumericAttribute(element.getAttribute('height')) ?? 0
        const x = rawX + totalTx
        const y = rawY + totalTy
        recordRect(x, y, width, height, element)
        break
      }
      case 'circle': {
        const rawCx = parseNumericAttribute(element.getAttribute('cx')) ?? 0
        const rawCy = parseNumericAttribute(element.getAttribute('cy')) ?? 0
        const r = parseNumericAttribute(element.getAttribute('r')) ?? 0
        const cx = rawCx + totalTx
        const cy = rawCy + totalTy
        recordCircle(cx, cy, r, element)
        break
      }
      case 'ellipse': {
        const rawCx = parseNumericAttribute(element.getAttribute('cx')) ?? 0
        const rawCy = parseNumericAttribute(element.getAttribute('cy')) ?? 0
        const rx = parseNumericAttribute(element.getAttribute('rx')) ?? 0
        const ry = parseNumericAttribute(element.getAttribute('ry')) ?? 0
        const cx = rawCx + totalTx
        const cy = rawCy + totalTy
        recordBounds(cx - rx, cy - ry)
        recordBounds(cx + rx, cy + ry)
        adjustments.push((offsetX, offsetY) => {
          element.setAttribute('cx', formatSvgNumber(cx - offsetX))
          element.setAttribute('cy', formatSvgNumber(cy - offsetY))
        })
        break
      }
      case 'line': {
        const x1 = (parseNumericAttribute(element.getAttribute('x1')) ?? 0) + totalTx
        const y1 = (parseNumericAttribute(element.getAttribute('y1')) ?? 0) + totalTy
        const x2 = (parseNumericAttribute(element.getAttribute('x2')) ?? 0) + totalTx
        const y2 = (parseNumericAttribute(element.getAttribute('y2')) ?? 0) + totalTy
        recordLine(x1, y1, x2, y2, element)
        break
      }
      case 'polyline':
      case 'polygon': {
        const points = parsePoints(element.getAttribute('points')).map(([x, y]) => [
          x + totalTx,
          y + totalTy
        ])
        if (points.length > 0) {
          recordPoints(points, element)
        }
        break
      }
      case 'text':
      case 'tspan': {
        const rawX = parseNumericAttribute(element.getAttribute('x')) ?? 0
        const rawY = parseNumericAttribute(element.getAttribute('y')) ?? 0
        const x = rawX + totalTx
        const y = rawY + totalTy
        recordBounds(x, y)
        adjustments.push((offsetX, offsetY) => {
          element.setAttribute('x', formatSvgNumber(x - offsetX))
          element.setAttribute('y', formatSvgNumber(y - offsetY))
        })
        break
      }
      default:
        break
    }

    for (const child of Array.from(element.children)) {
      walk(child, totalTx, totalTy)
    }
  }

  walk(svgElement, 0, 0)

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return
  }

  const offsetX = minX
  const offsetY = minY
  for (const apply of adjustments) {
    apply(offsetX, offsetY)
  }

  const viewBoxWidth = Math.max(1, maxX - minX)
  const viewBoxHeight = Math.max(1, maxY - minY)
  svgElement.setAttribute(
    'viewBox',
    `0 0 ${formatSvgNumber(viewBoxWidth)} ${formatSvgNumber(viewBoxHeight)}`
  )
}

export async function getLegacySvgString(
  element: HTMLElement,
  options: Options,
  _borderRadius?: string
): Promise<string> {
  void _borderRadius
  const preparation = getExportPreparation(element, options)
  const svgDocument = elementToSVG(element)

  stripUnsupportedForLegacy(svgDocument)
  normalizeLegacyCoordinates(svgDocument)
  applyStrictRootSize(svgDocument, preparation.width, preparation.height)
  removeRoundedCornersLegacy(svgDocument)

  return new XMLSerializer().serializeToString(svgDocument)
}

export async function getLegacySvgElement(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Promise<string> {
  const svgString = await getLegacySvgString(element, options, borderRadius)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`
}

export function downloadLegacySvgElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  getLegacySvgElement(element, options, borderRadius)
    .then((dataUrl: string) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error: Error) => {
      console.error('Error converting element to legacy SVG:', error)
    })
}

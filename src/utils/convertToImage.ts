import { IS_COPY_IMAGE_TO_CLIPBOARD_SUPPORTED } from '@/utils/clipboard'
import domtoimage, { type Options } from 'dom-to-image'
import { elementToSVG, inlineResources } from 'dom-to-svg'

const defaultOptions: Options = {
  width: 400,
  height: 400
}

const getFormattedOptions = (
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Options => {
  if (options.width && options.height) {
    const scale = Math.min(
      options.width / element.offsetWidth,
      options.height / element.offsetHeight
    )
    const radiusValue = borderRadius ? parseInt(borderRadius.replace('px', '')) : 48
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
  return { quality: 100, ...defaultOptions, ...options }
}

// Canvas repaint with rounded corners for PNG/JPG
const applyRoundedCornersToCanvas = async (
  blob: Blob,
  width: number,
  height: number,
  borderRadius?: string
): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const naturalWidth = image.naturalWidth || image.width
      const naturalHeight = image.naturalHeight || image.height
      const canvasWidthCandidate = Number.isFinite(width) && width > 0 ? width : naturalWidth
      const canvasHeightCandidate = Number.isFinite(height) && height > 0 ? height : naturalHeight
      const canvasWidth =
        canvasWidthCandidate && canvasWidthCandidate > 0 ? canvasWidthCandidate : naturalWidth || 1
      const canvasHeight =
        canvasHeightCandidate && canvasHeightCandidate > 0
          ? canvasHeightCandidate
          : naturalHeight || 1

      const canvas = document.createElement('canvas')
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('Failed to get canvas context'))
        return
      }

      context.imageSmoothingEnabled = false
      context.clearRect(0, 0, canvasWidth, canvasHeight)

      const radius = borderRadius ? parseInt(borderRadius.replace('px', '')) : 48
      const baseWidthCandidate = Number.isFinite(width) && width > 0 ? width : canvasWidth
      const baseHeightCandidate = Number.isFinite(height) && height > 0 ? height : canvasHeight
      const baseWidth = baseWidthCandidate > 0 ? baseWidthCandidate : canvasWidth
      const baseHeight = baseHeightCandidate > 0 ? baseHeightCandidate : canvasHeight
      const radiusScaleX = baseWidth > 0 ? canvasWidth / baseWidth : 1
      const radiusScaleY = baseHeight > 0 ? canvasHeight / baseHeight : 1
      const radiusScale = Math.min(radiusScaleX, radiusScaleY)
      const scaledRadius =
        Number.isFinite(radiusScale) && radiusScale > 0 ? radius * radiusScale : radius
      // Draw rounded rectangle path
      context.beginPath()
      context.moveTo(scaledRadius, 0)
      context.lineTo(canvasWidth - scaledRadius, 0)
      context.arcTo(canvasWidth, 0, canvasWidth, scaledRadius, scaledRadius)
      context.lineTo(canvasWidth, canvasHeight - scaledRadius)
      context.arcTo(
        canvasWidth,
        canvasHeight,
        canvasWidth - scaledRadius,
        canvasHeight,
        scaledRadius
      )
      context.lineTo(scaledRadius, canvasHeight)
      context.arcTo(0, canvasHeight, 0, canvasHeight - scaledRadius, scaledRadius)
      context.lineTo(0, scaledRadius)
      context.arcTo(0, 0, scaledRadius, 0, scaledRadius)
      context.closePath()
      context.clip()
      context.drawImage(image, 0, 0, canvasWidth, canvasHeight)

      canvas.toBlob((roundedBlob) => {
        if (roundedBlob) {
          resolve(roundedBlob)
        } else {
          reject(new Error('Failed to create rounded blob'))
        }
      }, blob.type)
      URL.revokeObjectURL(image.src)
    }
    image.onerror = () => {
      URL.revokeObjectURL(image.src)
      reject(new Error('Failed to load image'))
    }
    image.src = URL.createObjectURL(blob)
  })
}

// SVG clipPath for rounded corners
const applySvgRoundedCorners = (svgDocument: Document, options: Options, borderRadius?: string) => {
  const svgElement = svgDocument.documentElement
  const radius = borderRadius ? parseInt(borderRadius.replace('px', '')) : 48

  if (options.width) svgElement.setAttribute('width', options.width.toString())
  if (options.height) svgElement.setAttribute('height', options.height.toString())

  const svgNS = 'http://www.w3.org/2000/svg'
  const defs = svgDocument.createElementNS(svgNS, 'defs')
  const clipPath = svgDocument.createElementNS(svgNS, 'clipPath')
  clipPath.setAttribute('id', 'rounded-clip')

  const rect = svgDocument.createElementNS(svgNS, 'rect')
  rect.setAttribute('width', (options.width || 400).toString())
  rect.setAttribute('height', (options.height || 400).toString())
  rect.setAttribute('rx', radius.toString())

  clipPath.appendChild(rect)
  defs.appendChild(clipPath)
  svgElement.insertBefore(defs, svgElement.firstChild)

  const wrapper = svgDocument.createElementNS(svgNS, 'g')
  wrapper.setAttribute('clip-path', 'url(#rounded-clip)')
  while (svgElement.children.length > 1) {
    wrapper.appendChild(svgElement.children[1])
  }
  svgElement.appendChild(wrapper)
}

export async function copyImageToClipboard(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
) {
  if (!IS_COPY_IMAGE_TO_CLIPBOARD_SUPPORTED) {
    console.error('Clipboard.write is not supported')
    return
  }
  try {
    const blob: Blob = await domtoimage.toBlob(
      element,
      getFormattedOptions(element, options, borderRadius)
    )
    const finalBlob =
      options.width && options.height
        ? await applyRoundedCornersToCanvas(
            blob,
            Number(options.width),
            Number(options.height),
            borderRadius
          )
        : blob
    await navigator.clipboard.write([new ClipboardItem({ [finalBlob.type]: finalBlob })])
  } catch (error: any) {
    console.error('Error copying image to clipboard:', error)
  }
}

export async function getPngElement(element: HTMLElement, options: Options, borderRadius?: string) {
  const blob: Blob = await domtoimage.toBlob(
    element,
    getFormattedOptions(element, options, borderRadius)
  )
  const finalBlob =
    options.width && options.height
      ? await applyRoundedCornersToCanvas(
          blob,
          Number(options.width),
          Number(options.height),
          borderRadius
        )
      : blob

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(finalBlob)
  })
}

export function downloadPngElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  getPngElement(element, options, borderRadius)
    .then((dataUrl) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error) => console.error('Error converting element to PNG:', error))
}

export async function getJpgElement(element: HTMLElement, options: Options, borderRadius?: string) {
  return domtoimage.toJpeg(element, getFormattedOptions(element, options, borderRadius))
}

export function downloadJpgElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  getJpgElement(element, options, borderRadius)
    .then((dataUrl) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error) => console.error('Error converting element to JPG:', error))
}

export async function getSvgString(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Promise<string> {
  const svgDocument = elementToSVG(element)
  await inlineResources(svgDocument.documentElement)
  applySvgRoundedCorners(svgDocument, options, borderRadius)
  return new XMLSerializer().serializeToString(svgDocument)
}

export async function getSvgElement(
  element: HTMLElement,
  options: Options,
  borderRadius?: string
): Promise<string> {
  const svgString = await getSvgString(element, options, borderRadius)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`
}

export function downloadSvgElement(
  element: HTMLElement,
  filename: string,
  options: Options,
  borderRadius?: string
) {
  getSvgElement(element, options, borderRadius)
    .then((dataUrl) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = filename
      link.click()
    })
    .catch((error) => console.error('Error converting element to SVG:', error))
}

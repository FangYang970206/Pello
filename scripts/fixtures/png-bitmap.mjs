import zlib from 'node:zlib'

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonal = Math.abs(estimate - upperLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left
  if (upDistance <= diagonal) return up
  return upperLeft
}

/** Decode an 8-bit RGB or RGBA PNG and report the same left-edge blue run the Electron bitmap check uses. */
export function glyphRows(png) {
  const buffer = Buffer.isBuffer(png) ? png : Buffer.from(png)
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('screenshot is not a PNG')
  let width = 0
  let height = 0
  let colorType = 6
  const chunks = []
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error(`PNG bit depth ${data[8]} is not 8`)
      colorType = data[9]
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`PNG color type ${colorType} is not RGB`)
  const channels = colorType === 6 ? 4 : 3
  const inflated = zlib.inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  let position = 0
  let previous = Buffer.alloc(stride)
  const rows = []
  for (let y = 0; y < height; y++) {
    const filter = inflated[position++]
    const row = Buffer.from(inflated.subarray(position, position + stride))
    position += stride
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels] : 0
      const up = previous[index]
      const upperLeft = index >= channels ? previous[index - channels] : 0
      if (filter === 1) row[index] = (row[index] + left) & 255
      else if (filter === 2) row[index] = (row[index] + up) & 255
      else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) row[index] = (row[index] + paeth(left, up, upperLeft)) & 255
    }
    previous = row
    if (y < 400) {
      let blue = false
      for (let x = 0; x < Math.min(width, 8); x++) {
        const at = x * channels
        const red = row[at]
        const green = row[at + 1]
        const blueChannel = row[at + 2]
        if (blueChannel > 180 && green > 130 && red < 130) blue = true
      }
      rows.push(blue)
    }
  }
  const first = rows.indexOf(true)
  let end = first
  while (rows[end]) end++
  return { first, uninterrupted: end - first, rendererWidth: width }
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Copy to a new name, publishing only after the entire copy has completed. */
export async function copyToNewFile(source: string, destination: string): Promise<void> {
  const temp = path.join(path.dirname(destination), `.awb-copy-${randomUUID()}.tmp`)
  let created = false
  try {
    const handle = await fs.open(temp, 'wx')
    created = true
    await handle.close()
    await fs.copyFile(source, temp)
    // A hard link publishes atomically and fails if the destination appeared meanwhile.
    await fs.link(temp, destination)
  } finally {
    if (created) await fs.unlink(temp).catch(() => undefined)
  }
}

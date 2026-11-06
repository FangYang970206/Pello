import { useEffect, useState } from 'react'
import type { LocalShell } from '../shared/types'

export function useLocalShells(enabled = true) {
  const [shells, setShells] = useState<LocalShell[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let current = true
    setLoading(true); setError('')
    void window.awb.localShells().then((items) => { if (current) setShells(items) }).catch((reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [enabled, revision])
  return { shells, loading, error, refresh: () => setRevision((value) => value + 1) }
}

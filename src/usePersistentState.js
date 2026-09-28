import { useEffect, useState } from 'react'

// localStorage-backed state that also follows writes from the app's other
// window (main window ⇄ menu-bar side panel) via the `storage` event.
export function usePersistentState(key, initial, { raw = false } = {}) {
  const decode = s => (raw ? s : JSON.parse(s))

  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored !== null) return decode(stored)
    } catch {}
    return typeof initial === 'function' ? initial() : initial
  })

  useEffect(() => {
    localStorage.setItem(key, raw ? value : JSON.stringify(value))
  }, [key, value, raw])

  useEffect(() => {
    const onStorage = e => {
      if (e.key !== key || e.newValue === null) return
      try { setValue(decode(e.newValue)) } catch {}
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, raw])

  return [value, setValue]
}

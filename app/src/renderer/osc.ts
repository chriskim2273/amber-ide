// OSC 52 payload decoding, split out of Pane.tsx so it's unit-testable (Pane
// pulls xterm + CSS, which the node test env can't import).

// Parse an OSC 52 data string "<selection>;<base64|?>" into the text to place on
// the clipboard, or null to ignore. Null covers: a malformed payload (no
// selection separator, bad base64) AND a "?" clipboard-READ request, which we
// deliberately deny so a program can't exfiltrate the user's clipboard. The
// base64 decodes to UTF-8 bytes (so accents/emoji round-trip).
export function decodeOsc52Payload(data: string): string | null {
  const semi = data.indexOf(';')
  if (semi === -1) return null
  const payload = data.slice(semi + 1)
  if (payload === '?' || payload === '') return null // read request / empty
  try {
    const bin = atob(payload)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    const text = new TextDecoder().decode(bytes)
    return text || null
  } catch {
    return null // not valid base64
  }
}

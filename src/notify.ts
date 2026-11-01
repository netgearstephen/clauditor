/** Best-effort desktop notification; never throws. */
export async function notifyDesktop(title: string, message: string): Promise<void> {
  try {
    const notifier = await import('node-notifier')
    notifier.default.notify({ title: `clauditor: ${title}`, message, sound: true })
  } catch {
    // node-notifier may not be available on all platforms
  }
}

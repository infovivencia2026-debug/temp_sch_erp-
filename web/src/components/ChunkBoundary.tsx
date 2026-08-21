import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui'

/* The spinner that never stopped.

   Every screen is a lazy import, so opening one fetches a JavaScript chunk
   named after its content hash. A deploy gives every chunk a new hash and
   removes the old ones — and a tab that was open across that deploy is still
   holding the old index, so the moment somebody clicks through to a screen
   they have not visited yet, the browser asks for a file that no longer
   exists.

   React's Suspense has nothing to say about that. The import promise rejects,
   the fallback stays on screen, and the person sees a loading spinner
   for ever: no error, no clue, and nothing to click. It reads as the product
   being broken when the fix is a refresh.

   So: catch it, and refresh once. Once, because a chunk that fails for any
   other reason — a proxy eating the request, an offline browser — would
   otherwise put the tab in a reload loop, which is worse than the spinner. A
   flag in sessionStorage marks that we have already tried, and the second
   failure shows the person what happened and lets them decide.
*/

/** Whether an error is the browser failing to fetch a lazy chunk. */
function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return (
    msg.includes('ChunkLoadError') ||
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    // Safari's wording for the same thing.
    msg.includes('Unable to preload') ||
    msg.includes('error loading dynamically imported module') ||
    /* A dynamic import that fails at the network layer sometimes surfaces as a
       bare "TypeError: Failed to fetch", with nothing in the message about
       modules at all — which is what a tab held open across a deploy sees when
       the chunk it is asking for has been replaced.

       Treating that as stale risks calling a genuine network fault stale. The
       remedy is the same either way: reload once, and if it fails again say
       so rather than looping. A page that reloads itself and works is better
       than one that shows a stack trace nobody can act on. */
    msg === 'TypeError: Failed to fetch' ||
    msg.includes('Load failed')
  )
}

const RELOAD_FLAG = 'chunk-reloaded'

interface Props {
  children: ReactNode
}
interface State {
  failed: boolean
  stale: boolean
  /** The error itself, shown for a genuine fault — see render(). */
  detail: string
  /** The first frames of the component stack: which screen, which part. */
  where?: string
}

export default class ChunkBoundary extends Component<Props, State> {
  state: State = { failed: false, stale: false, detail: '' }

  static getDerivedStateFromError(error: unknown): State {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { failed: true, stale: isChunkError(error), detail }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    /* The component stack, on screen as well as in the console.
     *
     * The message alone says what went wrong and not where — "cannot read
     * properties of undefined" is the same sentence in every file in the
     * product. The first few frames of the stack name the component, which is
     * the difference between a bug report and a hunt. */
    const frames = (info.componentStack ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join('  ←  ')
    if (frames) this.setState((st) => ({ ...st, where: frames }))

    // Logged either way: a chunk failure is worth knowing about even when the
    // reload hides it from the person who hit it.
    console.error('screen failed to render', error, info.componentStack)

    if (!isChunkError(error)) return
    let already = false
    try {
      already = sessionStorage.getItem(RELOAD_FLAG) === '1'
      sessionStorage.setItem(RELOAD_FLAG, '1')
    } catch {
      // Private mode: no memory of a previous attempt, so do not reload at
      // all rather than risk looping.
      already = true
    }
    if (!already) window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="text-[15px] font-medium">
          {this.state.stale ? 'This tab is out of date' : 'This screen did not load'}
        </p>
        <p className="mt-1 text-[13.5px] text-muted-foreground">
          {this.state.stale
            ? 'The site was updated while this tab was open, so part of it is no longer on the server. Reloading picks up the new version — nothing you have saved is affected.'
            : 'Something in this screen failed. Reloading usually clears it; if it does not, this is the fault worth reporting:'}
        </p>
        {/* The error itself, on screen.
         *
         * "Something failed" is true and useless: the person looking at it
         * cannot act on it and cannot report it either, and the one line that
         * would identify the bug sits in a console nobody has open. Shown for
         * a real fault only — a stale tab needs a reload, not a stack. */}
        {!this.state.stale && this.state.detail && (
          <p className="mt-2 break-words rounded border bg-muted/40 px-3 py-2 text-left font-mono text-[12px] text-muted-foreground">
            {this.state.detail}
            {this.state.where && (
              <>
                <br />
                <span className="opacity-70">in {this.state.where}</span>
              </>
            )}
          </p>
        )}
        <Button
          className="mt-4"
          onClick={() => {
            try {
              sessionStorage.removeItem(RELOAD_FLAG)
            } catch {
              // Nothing to clear, and nothing that stops the reload.
            }
            window.location.reload()
          }}
        >
          Reload the page
        </Button>
      </div>
    )
  }
}

/** Clears the guard once a screen has rendered, so a later deploy can reload again. */
export function clearChunkReloadGuard() {
  try {
    sessionStorage.removeItem(RELOAD_FLAG)
  } catch {
    // Private mode; the guard was never set.
  }
}

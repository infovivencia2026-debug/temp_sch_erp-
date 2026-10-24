import { createContext, useContext } from 'react'
import type { ImageAsset } from '../lib/images'

/* What every text box on the sheet needs from the screen around it: the
   pictures the paper already uses (to draw them), and a way to add one (an
   upload, or a pick from the image store) so the paper remembers its size. */
export interface MakerContext {
  images: Record<string, ImageAsset>
  /** Uploads a picture, adds it to the paper, and returns it to insert. */
  addImage: (blob: Blob) => Promise<ImageAsset | null>
  /** Adds an already-uploaded picture (from the image store) to the paper. */
  remember: (assets: ImageAsset[]) => void
}

export const Maker = createContext<MakerContext | null>(null)

export function useMaker(): MakerContext {
  const m = useContext(Maker)
  if (!m) throw new Error('useMaker outside the Question maker')
  return m
}

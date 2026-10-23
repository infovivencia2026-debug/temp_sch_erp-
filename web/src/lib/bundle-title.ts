import { createContext, useContext } from 'react'

/* THE TAB SOMEBODY PRESSED IS THE NAME OF THE PAGE THEY ARE ON.
 *
 * A bundled screen named the place three times and agreed with itself none of
 * them: the menu said "Approve & pay salaries", the tab said "Release the
 * money", and the heading under both said "Banking payouts". All three are
 * reasonable names; seeing all three at once is how somebody decides they have
 * ended up somewhere other than where they clicked.
 *
 * The screens are shared on purpose -- Banking payouts is a page in its own
 * right and a tab inside the salary job -- so the title cannot simply be
 * rewritten in the screen. It is passed down instead: inside a bundle the tab
 * label wins, and opened on its own the screen keeps the name it was given.
 *
 * A context rather than a prop because the heading is drawn by PageHead, deep
 * inside whatever the screen renders, and threading a prop through every
 * bundled screen would mean editing each one to pass something it does not
 * use itself.
 *
 * Kept in its own module so ui.tsx does not have to import the component that
 * imports ui.tsx.
 */
export const BundleTitle = createContext<string | null>(null)

/** The tab label to show as this page's heading, or null when not in a bundle. */
export function useBundleTitle(): string | null {
  return useContext(BundleTitle)
}

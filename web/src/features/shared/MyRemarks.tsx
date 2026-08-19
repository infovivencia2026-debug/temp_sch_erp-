import StaffRemarks from './StaffRemarks'

/* A teacher's own copy: the same screen with the form withheld.
 *
 * Not a second component. Writing about staff and reading what was written
 * about you are the same list under two narrowings, and a separate screen for
 * the read-only case is how the two slowly stop agreeing about what a remark
 * looks like.
 */
export default function MyRemarks() {
  return <StaffRemarks canWrite={false} />
}

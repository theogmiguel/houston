// The renderer's in-memory view of a directory's checkout, as the `git_branch`
// reply carries it. Nothing is persisted: a fact lives for the connection that
// received it, and `null` means git had no answer, never "unknown value".

export interface CheckoutFacts {
  branch: string | null
  toplevel: string | null
  common_dir: string | null
}

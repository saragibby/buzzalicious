import { useScope } from '../lib/scope';

/**
 * Workspace and brand switcher.
 *
 * Two selects rather than one combined list, because they are different questions:
 * "which client am I working for" is a tenancy boundary, "which brand of theirs" is not.
 * Flattening them into one menu makes a cross-tenant switch look like a cross-brand one,
 * and those have very different consequences.
 *
 * The workspace select is hidden when the user belongs to exactly one — the common case
 * for a small business owner, for whom a menu with one option is just noise. Agencies and
 * the shared admin see both.
 */
export function ScopeSwitcher() {
  const { workspaces, brands, workspace, brand, selectWorkspace, selectBrand, isLoading } =
    useScope();

  if (isLoading && !workspace) {
    return <span className="scope-switcher scope-switcher-loading">Loading…</span>;
  }

  if (!workspace) {
    return null;
  }

  return (
    <div className="scope-switcher">
      {workspaces.length > 1 && (
        <label className="scope-field">
          <span className="scope-label">Client</span>
          <select
            value={workspace.id}
            onChange={(event) => selectWorkspace(event.target.value)}
            aria-label="Workspace"
          >
            {workspaces.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {brands.length > 0 && brand && (
        <label className="scope-field">
          <span className="scope-label">Brand</span>
          <select
            value={brand.id}
            onChange={(event) => selectBrand(event.target.value)}
            aria-label="Brand"
            // One brand is the normal case; a disabled select still shows which brand is
            // active, which a bare label would not once a second brand is added.
            disabled={brands.length === 1}
          >
            {brands.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

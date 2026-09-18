import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCategoryTree, searchCategories, type CategoryMatch } from '../lib/brandApi';

/**
 * The industry picker.
 *
 * Search-first with a browsable tree underneath, because ~56 leaves is too many to scan
 * and too few to justify making someone guess a search term. Only leaves are selectable:
 * the whole point of the category is the specificity — "Hospitality" tells the trend
 * engine nothing that "Vacation rental" does not tell it better.
 */
export function CategoryPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (categoryId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    // Typing "rest" should not be four round trips. 200ms is below the threshold where a
    // list feels laggy and above the rate at which people type individual letters.
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const treeQuery = useQuery({
    queryKey: ['categories', 'tree'],
    queryFn: fetchCategoryTree,
    // The taxonomy is platform-wide and effectively static. Refetching it per mount is
    // pure waste.
    staleTime: 60 * 60 * 1000,
  });

  const searchQuery = useQuery({
    queryKey: ['categories', 'search', debounced],
    queryFn: () => searchCategories(debounced),
    enabled: debounced.length >= 2,
  });

  const allLeaves = useMemo<CategoryMatch[]>(
    () =>
      (treeQuery.data ?? []).flatMap((parent) =>
        parent.children.map((child) => ({
          id: child.id,
          slug: child.slug,
          name: child.name,
          parentName: parent.name,
        })),
      ),
    [treeQuery.data],
  );

  const selected = allLeaves.find((leaf) => leaf.id === value) ?? null;
  const results = debounced.length >= 2 ? (searchQuery.data ?? []) : allLeaves;

  return (
    <fieldset className="brand-section">
      <legend>Industry</legend>

      <p className="field-hint">
        This drives which trends and templates we show you, so it is worth getting right.
      </p>

      {selected && (
        <p className="category-selected">
          Currently: <strong>{selected.name}</strong>
          {selected.parentName && (
            <span className="category-parent"> in {selected.parentName}</span>
          )}
          <button type="button" onClick={() => onChange(null)} aria-label="Clear industry">
            Clear
          </button>
        </p>
      )}

      <label className="field">
        <span className="field-label">Search</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="vacation rental, tax prep, coffee shop…"
          aria-label="Search industries"
        />
      </label>

      <ul className="category-results">
        {results.map((leaf) => (
          <li key={leaf.id}>
            <button
              type="button"
              className={leaf.id === value ? 'category-option selected' : 'category-option'}
              onClick={() => onChange(leaf.id)}
              aria-pressed={leaf.id === value}
            >
              <span className="category-name">{leaf.name}</span>
              {/* The parent disambiguates leaves that read alike out of context —
                  "Consulting" under Professional Services is not the same market as
                  "Consulting" under Health. */}
              {leaf.parentName && <span className="category-parent">{leaf.parentName}</span>}
            </button>
          </li>
        ))}
        {results.length === 0 && (
          <li className="category-empty">
            {debounced.length >= 2 ? `Nothing matches “${debounced}”.` : 'Loading industries…'}
          </li>
        )}
      </ul>
    </fieldset>
  );
}

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useBrandFeed, useFeedBrands, type FeedItem, type TrendStatus } from '../../lib/trends';

/**
 * The per-brand trend feed.
 *
 * The thing being sold here is not a ranked list of trends — it is the removal of the
 * blank page. So each card leads with the angle the user could actually post, and the
 * ranking and momentum numbers sit underneath as justification. A card that cannot answer
 * "what would I post?" is filtered out server-side rather than rendered as an empty shell.
 */

const STATUS_COPY: Record<TrendStatus, { label: string; hint: string }> = {
  EMERGING: { label: 'Emerging', hint: 'Rising and still early — best time to post' },
  PEAKING: { label: 'Peaking', hint: 'Near the top — worth posting now, not next week' },
  DECLINING: { label: 'Fading', hint: 'On the way down — only if you can move today' },
  STALE: { label: 'Stale', hint: 'No recent activity' },
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function TrendCard({ item }: { item: FeedItem }) {
  const status = STATUS_COPY[item.status];

  return (
    <article className="trend-card">
      <header className="trend-card-head">
        <div>
          <h2>{item.title}</h2>
          <p className="trend-card-meta">
            {item.kind.toLowerCase()}
            {item.platform ? ` · ${item.platform.toLowerCase()}` : ' · any platform'}
          </p>
        </div>
        <span
          className={`trend-status trend-status-${item.status.toLowerCase()}`}
          title={status.hint}
        >
          {status.label}
        </span>
      </header>

      {item.description ? <p className="trend-card-description">{item.description}</p> : null}

      {/* The angle comes first because it is the deliverable. */}
      <section className="trend-angle">
        <h3>Post this</h3>
        {item.hook ? <p className="trend-hook">“{item.hook}”</p> : null}
        <p>{item.suggestedAngle}</p>
      </section>

      <section className="trend-why">
        <h3>Why this fits you</h3>
        <p>{item.whyThisFitsYou}</p>
      </section>

      {item.pairedTemplates.length > 0 ? (
        <section className="trend-templates">
          <h3>Start from a template</h3>
          <ul>
            {item.pairedTemplates.map((template) => (
              <li key={template.id}>
                <span className="trend-template-name">{template.name}</span>
                <span className="trend-template-meta">
                  {template.archetype.toLowerCase().replace(/_/g, ' ')} · {percent(template.fit)}{' '}
                  fit
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="trend-card-foot">
        <span title="Velocity, acceleration and saturation combined — not raw popularity">
          momentum {percent(item.momentum)}
        </span>
        <span title="How well this trend matches your business category">
          category fit {percent(item.categoryScore)}
        </span>
        <span title="How recently this trend was last observed">
          freshness {percent(item.freshness)}
        </span>
        {item.exampleUrls.length > 0 ? (
          <a href={item.exampleUrls[0]} target="_blank" rel="noreferrer noopener">
            See an example
          </a>
        ) : null}
      </footer>
    </article>
  );
}

export function TrendFeed() {
  const [searchParams, setSearchParams] = useSearchParams();
  const brands = useFeedBrands();
  const [brandId, setBrandId] = useState<string | null>(searchParams.get('brand'));

  // Default to the first brand once they load, so the common single-brand case needs no
  // interaction at all. The id lives in the URL so a feed can be linked to and refreshed.
  useEffect(() => {
    if (!brandId && brands.data?.brands.length) {
      const first = brands.data.brands[0]!.id;
      setBrandId(first);
      setSearchParams({ brand: first }, { replace: true });
    }
  }, [brandId, brands.data, setSearchParams]);

  const feed = useBrandFeed(brandId);

  const handleBrandChange = (next: string) => {
    setBrandId(next);
    setSearchParams({ brand: next });
  };

  if (brands.isLoading) return <p className="trend-empty">Loading brands…</p>;

  if (brands.data && brands.data.brands.length === 0) {
    return (
      <section className="trend-page">
        <h1>Trends</h1>
        <p className="trend-empty">
          You don’t have a brand yet. Trends are matched to a business category, so there’s nothing
          to rank against until one exists.
        </p>
      </section>
    );
  }

  return (
    <section className="trend-page">
      <header className="trend-page-head">
        <div>
          <h1>Trends</h1>
          <p className="trend-subtitle">
            What’s moving for a business like yours — ranked by how early you’d be, not by how
            popular it already is.
          </p>
        </div>
        {brands.data && brands.data.brands.length > 1 ? (
          <label className="trend-brand-picker">
            Brand
            <select
              value={brandId ?? ''}
              onChange={(event) => handleBrandChange(event.target.value)}
            >
              {brands.data.brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {feed.isLoading ? <p className="trend-empty">Ranking trends…</p> : null}

      {feed.isError ? (
        <p className="trend-empty trend-error">
          Couldn’t load the feed. {(feed.error as Error).message}
        </p>
      ) : null}

      {/* An uncategorised brand gets a specific answer, not "no trends this week". The
          empty feed has a cause and a fix, and hiding that reads as a broken product. */}
      {feed.data?.needsCategory ? (
        <p className="trend-empty">
          {feed.data.brand.name} doesn’t have a business category yet. Trends are matched by
          category, so pick one in settings and the feed will fill in.
        </p>
      ) : null}

      {feed.data && !feed.data.needsCategory && feed.data.items.length === 0 ? (
        <p className="trend-empty">
          Nothing strong enough to recommend for {feed.data.brand.categoryName} this week. A thin
          feed is deliberate — a weak match is worse than nothing.
        </p>
      ) : null}

      <div className="trend-list">
        {feed.data?.items.map((item) => (
          <TrendCard key={item.trendId} item={item} />
        ))}
      </div>
      {feed.data?.items.length ? (
        <p className="trend-curate-link">
          Curating trends for the platform? <Link to="/trends/curate">Open the weekly pass.</Link>
        </p>
      ) : null}
    </section>
  );
}

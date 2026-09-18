/**
 * Placeholder route bodies.
 *
 * M1 delivers the routing shell only; W5 builds the real UI. Each placeholder names the
 * workstream that fills it in, so an unfinished screen is obviously unfinished rather
 * than looking like a bug.
 */
export function Placeholder({
  title,
  workstream,
  description,
}: {
  title: string;
  workstream: string;
  description: string;
}) {
  return (
    <section className="placeholder">
      <h1>{title}</h1>
      <p>{description}</p>
      <p className="placeholder-note">Built in {workstream}.</p>
    </section>
  );
}

export const Dashboard = () => (
  <Placeholder
    title="Dashboard"
    workstream="W5"
    description="Recommendations, upcoming posts, and recent performance at a glance."
  />
);

export const Composer = () => (
  <Placeholder
    title="Composer"
    workstream="W4 / W5"
    description="Pick a template, fill its slots, preview the rendered image, and schedule it."
  />
);

export const Calendar = () => (
  <Placeholder
    title="Calendar"
    workstream="W5 / W6"
    description="Scheduled and published posts across every connected brand and platform."
  />
);

export const Insights = () => (
  <Placeholder
    title="Insights"
    workstream="W8"
    description="How published posts actually performed, collected back from each platform."
  />
);

export const Settings = () => (
  <Placeholder
    title="Settings"
    workstream="W3 / W6"
    description="Workspace, brands, team members, and connected platform accounts."
  />
);

export const NotFound = () => (
  <Placeholder
    title="Not found"
    workstream="—"
    description="That page does not exist."
  />
);

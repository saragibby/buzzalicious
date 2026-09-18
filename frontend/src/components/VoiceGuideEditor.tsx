import { useState } from 'react';
import type { BrandVoiceGuide } from '../lib/brandApi';

/**
 * A repeatable list of short strings.
 *
 * Extracted because the voice guide has six of them and they are the fields people
 * actually fill in. A textarea split on newlines would be less code and would also lose
 * the distinction between "no entries" and "one empty entry", which matters when the
 * guide is interpolated into a prompt.
 */
function StringList({
  label,
  hint,
  values,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft('');
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {hint && <span className="field-hint">{hint}</span>}

      <ul className="chip-list">
        {values.map((value, index) => (
          <li key={`${value}-${index}`} className="chip">
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className="chip-add">
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Enter inside a form submits it. Adding a phrase is not saving the guide.
              event.preventDefault();
              add();
            }
          }}
          aria-label={label}
        />
        <button type="button" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

export interface VoiceGuideEditorProps {
  value: BrandVoiceGuide;
  onChange: (guide: BrandVoiceGuide) => void;
  onDraft?: (input: { audience?: string; notes?: string }) => Promise<void>;
  drafting?: boolean;
}

/**
 * The voice guide editor.
 *
 * The PRD is explicit that this is a structured guide, not a one-line descriptor, and the
 * structure is the product: "friendly and professional" produces captions indistinguishable
 * from every other small business, whereas a banned-openers list and a vocabulary do not.
 *
 * The AI draft fills the form; it never saves. A voice guide the owner did not actually
 * agree with is worse than none, because every caption afterwards inherits it and the
 * wrongness has no obvious source.
 */
export function VoiceGuideEditor({ value, onChange, onDraft, drafting }: VoiceGuideEditorProps) {
  const [audience, setAudience] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <fieldset className="brand-section">
      <legend>Voice</legend>

      <label className="field">
        <span className="field-label">Summary</span>
        <span className="field-hint">
          A sentence or two describing how this brand sounds. Concrete beats flattering.
        </span>
        <textarea
          rows={3}
          value={value.summary}
          onChange={(event) => onChange({ ...value, summary: event.target.value })}
          placeholder="Warm and unhurried, like a neighbour who knows the area."
        />
      </label>

      <StringList
        label="Tone attributes"
        hint="Three or four adjectives. More than that stops meaning anything."
        values={value.toneAttributes}
        placeholder="unhurried"
        onChange={(toneAttributes) => onChange({ ...value, toneAttributes })}
      />

      <StringList
        label="Say this"
        hint="Phrases and framings that sound like you."
        values={value.doSay}
        placeholder="the porch swing"
        onChange={(doSay) => onChange({ ...value, doSay })}
      />

      <StringList
        label="Never say this"
        hint="Usually the highest-signal part of the whole guide."
        values={value.dontSay}
        placeholder="luxury experience"
        onChange={(dontSay) => onChange({ ...value, dontSay })}
      />

      <StringList
        label="Vocabulary"
        hint="Words specific to your business — place names, product names, local terms."
        values={value.vocabulary}
        placeholder="low country"
        onChange={(vocabulary) => onChange({ ...value, vocabulary })}
      />

      <StringList
        label="Banned openers"
        hint="First lines you never want to see again."
        values={value.bannedOpeners}
        placeholder="Looking for the perfect…"
        onChange={(bannedOpeners) => onChange({ ...value, bannedOpeners })}
      />

      <StringList
        label="Sample copy"
        hint="Real posts you were happy with. Worth more than any description."
        values={value.sampleCopy}
        placeholder="Paste a caption that sounded right"
        onChange={(sampleCopy) => onChange({ ...value, sampleCopy })}
      />

      <div className="type-grid">
        <label className="field">
          <span className="field-label">Reading level</span>
          <select
            value={value.readingLevel}
            onChange={(event) =>
              onChange({
                ...value,
                readingLevel: event.target.value as BrandVoiceGuide['readingLevel'],
              })
            }
          >
            <option value="simple">Simple</option>
            <option value="standard">Standard</option>
            <option value="expert">Expert</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Emoji</span>
          <select
            value={value.emojiPolicy}
            onChange={(event) =>
              onChange({
                ...value,
                emojiPolicy: event.target.value as BrandVoiceGuide['emojiPolicy'],
              })
            }
          >
            <option value="none">None</option>
            <option value="sparing">Sparing</option>
            <option value="liberal">Liberal</option>
          </select>
        </label>
      </div>

      {onDraft && (
        <div className="voice-draft">
          <p className="field-hint">
            Staring at an empty form is harder than editing a wrong one. Tell us a little and
            we&rsquo;ll fill it in — nothing is saved until you press Save.
          </p>
          <label className="field">
            <span className="field-label">Who are you talking to?</span>
            <input
              type="text"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              placeholder="Families booking a week at the beach"
            />
          </label>
          <label className="field">
            <span className="field-label">Anything else about how you sound?</span>
            <textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="We're not a resort. We're a house that happens to be near the water."
            />
          </label>
          <button
            type="button"
            disabled={drafting}
            onClick={() =>
              void onDraft({
                ...(audience.trim() ? { audience: audience.trim() } : {}),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              })
            }
          >
            {drafting ? 'Drafting…' : 'Draft a voice guide'}
          </button>
        </div>
      )}
    </fieldset>
  );
}

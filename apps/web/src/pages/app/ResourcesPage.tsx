import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  monetizationPreferencesSchema,
  outboundUrlResponseSchema,
  resourcesResponseSchema,
  type MonetizationPreferences,
  type ResourceItem,
  type ResourcesResponse,
} from '@pencillift/contracts';
import type { ApiRequestError } from '@pencillift/contracts/client';
import {
  AMAZON_ASSOCIATES_DISCLOSURE,
  AMAZON_PRICE_NOTE,
  PLAIN_LINK_DISCLOSURE,
} from '@pencillift/domain/monetization';
import { clientLocale, openOutside, SponsorSlot } from '../../components/SponsorCard.tsx';
import { EmptyState, ErrorState, Loading, Notice } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import { buttonRow, sectionStyle, StepUpNotice, toApiError, useLastGood } from './SecurityPage.tsx';

/**
 * Parent learning-resource browser (spec P10 resources, P16.1/P16.3; AC_MON_03/04/05/08/11/12).
 *
 * The parent chooses the context (subject, grade, focus skill); nothing here is personalised from
 * a child's learning data. Items are ordered by the server's learning-relevance score, never by
 * commission. Merchant links are commercial content: each one shows its disclosure right beside
 * it (also its accessible description), never a price, and opens only after a deliberate click in
 * a new browsing context with no opener and no referrer. The API requires a recent parent-PIN
 * unlock; free adult accounts keep access (no paywall). At most one sponsor card appears, below
 * and apart from the educational list.
 */
export default function ResourcesPage() {
  return (
    <RequireParent>
      <h1>Learning resources</h1>
      <p>
        Free practice ideas and optional study materials for the subject and grade you choose. They
        are listed by learning fit, never by commission. Nothing here is required to learn, and no
        product guarantees better grades.
      </p>
      <ResourcesBrowser />
    </RequireParent>
  );
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

type Subject = ResourceItem['subjects'][number];
type Kind = ResourceItem['kind'];
type Mode = ResourceItem['mode'];

const SUBJECT_LABEL: Record<Subject, string> = {
  math: 'Math',
  reading: 'Reading',
  spelling_vocabulary: 'Spelling and vocabulary',
  grammar_writing: 'Grammar and writing',
  science: 'Science',
  social_studies: 'Social studies',
};
const SUBJECTS = Object.keys(SUBJECT_LABEL) as Subject[];

const KIND_LABEL: Record<Kind, string> = {
  workbook: 'Workbook',
  flashcards: 'Flashcards',
  manipulative: 'Hands-on manipulative',
  parent_exercise: 'Parent-led exercise (free)',
  in_app_practice: 'In-app practice (free)',
};

const GRADES = Array.from({ length: 13 }, (_, grade) => grade);

function gradeName(grade: number): string {
  return grade === 0 ? 'Kindergarten' : `Grade ${grade}`;
}

function gradeRange(min: number, max: number): string {
  const short = (g: number) => (g === 0 ? 'K' : String(g));
  return min === max ? gradeName(min) : `Grades ${short(min)}–${short(max)}`;
}

/** "math.fractions.compare" -> "math fractions compare". */
function skillLabel(skill: string): string {
  return skill.replace(/[._:-]+/g, ' ').trim();
}

/**
 * The adjacent disclosure for a linked item. The Associates sentence is Amazon's required wording
 * and is always used in affiliate mode, whatever text the server sent.
 */
function disclosureFor(mode: Mode): string | null {
  if (mode === 'amazon_associates') return AMAZON_ASSOCIATES_DISCLOSURE;
  if (mode === 'plain_link') return PLAIN_LINK_DISCLOSURE;
  return null;
}

function linkLabel(item: ResourceItem): string {
  return item.merchant === 'amazon' ? 'View on Amazon' : 'Open website';
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

interface Filters {
  subject: Subject | '';
  grade: string;
  skill: string;
}

const NO_FILTERS: Filters = { subject: '', grade: '', skill: '' };

function resourcesPath(filters: Filters): string {
  const query = new URLSearchParams({ platform: 'web' });
  if (filters.subject) query.set('subject', filters.subject);
  if (filters.grade !== '') query.set('grade', filters.grade);
  if (filters.skill) query.set('skill', filters.skill);
  const locale = clientLocale();
  if (locale) query.set('locale', locale);
  return `/v1/resources?${query.toString()}`;
}

function loadErrorMessage(error: ApiRequestError): string {
  if (error.code === 'NOT_FOUND') return 'Create your family first, then come back to resources.';
  return error.message;
}

function ResourcesBrowser() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [version, setVersion] = useState(0);
  const query = useApiQuery(
    (api) => api.get(resourcesPath(filters), resourcesResponseSchema),
    [filters, version],
  );
  const prefsQuery = useApiQuery(
    (api) => api.get('/v1/monetization/preferences', monetizationPreferencesSchema),
    [],
  );
  const [savedPrefs, setSavedPrefs] = useState<MonetizationPreferences | null>(null);
  const data = useLastGood(query);
  const loadedPrefs = useLastGood(prefsQuery);
  const prefs = savedPrefs ?? loadedPrefs;
  const stepUp =
    (query.status === 'error' && query.error.code === 'STEP_UP_REQUIRED') ||
    (prefsQuery.status === 'error' && prefsQuery.error.code === 'STEP_UP_REQUIRED');

  const { reload: reloadResources } = query;
  const { reload: reloadPrefs } = prefsQuery;
  const retry = useCallback(() => {
    reloadResources();
    reloadPrefs();
  }, [reloadResources, reloadPrefs]);

  if (stepUp) {
    return (
      <>
        <StepUpNotice action="Viewing learning resources" />
        <div style={buttonRow}>
          <button type="button" className="btn secondary" onClick={retry}>
            Try again
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <FilterForm
        draft={draft}
        items={data?.items ?? []}
        onDraft={setDraft}
        onApply={() => setFilters(draft)}
        busy={query.status === 'loading'}
      />
      {data === null && query.status === 'loading' ? <Loading label="Loading resources…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={loadErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {data ? (
        <ResourceList data={data} filters={filters} busy={query.status === 'loading'} />
      ) : null}
      {prefs ? (
        <PreferencesSection
          prefs={prefs}
          onSaved={(next) => {
            setSavedPrefs(next);
            if (next.hideAffiliate !== prefs.hideAffiliate) setVersion((v) => v + 1);
          }}
        />
      ) : null}
      {prefsQuery.status === 'error' && prefs === null ? (
        <ErrorState
          message={`Your display choices couldn’t be loaded. ${prefsQuery.error.message}`}
          onRetry={prefsQuery.reload}
        />
      ) : null}
      {/* One clearly separated sponsor slot, below the educational content. It is requested only
          after the parent's choices are known, and never when sponsor cards are hidden. */}
      <SponsorSlot
        placement="resources_browse"
        enabled={prefs !== null && !prefs.hideSponsorCards && data !== null}
      />
    </>
  );
}

function FilterForm({
  draft,
  items,
  onDraft,
  onApply,
  busy,
}: {
  draft: Filters;
  items: readonly ResourceItem[];
  onDraft: (next: Filters) => void;
  onApply: () => void;
  busy: boolean;
}) {
  const id = useId();
  const skills = useMemo(() => {
    const all = new Set(items.flatMap((item) => item.skills));
    if (draft.skill) all.add(draft.skill);
    return [...all].sort();
  }, [items, draft.skill]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };
  return (
    <form className="card" style={sectionStyle} aria-label="Find resources" onSubmit={submit}>
      <h2 style={{ marginTop: 0 }}>Find resources</h2>
      <p style={{ margin: 0 }}>
        Choose the context yourself. We don’t use your child’s scores or homework to pick these.
      </p>
      <label htmlFor={`${id}-subject`}>Subject</label>
      <select
        id={`${id}-subject`}
        value={draft.subject}
        onChange={(e) => onDraft({ ...draft, subject: e.target.value as Subject | '' })}
      >
        <option value="">All subjects</option>
        {SUBJECTS.map((subject) => (
          <option key={subject} value={subject}>
            {SUBJECT_LABEL[subject]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-grade`}>Grade</label>
      <select
        id={`${id}-grade`}
        value={draft.grade}
        onChange={(e) => onDraft({ ...draft, grade: e.target.value })}
      >
        <option value="">Any grade</option>
        {GRADES.map((grade) => (
          <option key={grade} value={String(grade)}>
            {gradeName(grade)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-skill`}>Focus skill (optional)</label>
      <select
        id={`${id}-skill`}
        value={draft.skill}
        aria-describedby={`${id}-skill-hint`}
        onChange={(e) => onDraft({ ...draft, skill: e.target.value })}
      >
        <option value="">No focus skill</option>
        {skills.map((skill) => (
          <option key={skill} value={skill}>
            {skillLabel(skill)}
          </option>
        ))}
      </select>
      <p id={`${id}-skill-hint`} style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
        Resources that practice this skill are listed first.
      </p>
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Loading…' : 'Show resources'}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Resource list and outbound links
// ---------------------------------------------------------------------------------------------

type LinkState =
  | { kind: 'opening' }
  | { kind: 'opened'; url: string; host: string }
  | { kind: 'changed' }
  | { kind: 'error'; message: string; stepUp: boolean };

function linkErrorState(error: unknown): LinkState {
  const apiError = toApiError(error);
  if (apiError.code === 'STEP_UP_REQUIRED') {
    return { kind: 'error', message: 'Enter your parent PIN to continue.', stepUp: true };
  }
  if (apiError.rule === 'LINKS_UNAVAILABLE') {
    return { kind: 'error', message: 'This resource has no outside link here.', stepUp: false };
  }
  if (apiError.code === 'NOT_FOUND') {
    return { kind: 'error', message: 'This resource is no longer available.', stepUp: false };
  }
  if (apiError.code === 'NETWORK') {
    return { kind: 'error', message: apiError.message, stepUp: false };
  }
  return { kind: 'error', message: 'We couldn’t open this link. Please try again.', stepUp: false };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the site';
  }
}

function ResourceList({
  data,
  filters,
  busy,
}: {
  data: ResourcesResponse;
  filters: Filters;
  busy: boolean;
}) {
  const headingId = useId();
  const { api } = useSession();
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  // A link whose mode changed since the list loaded is shown with its new disclosure first.
  const [modes, setModes] = useState<Record<string, Mode>>({});

  useEffect(() => {
    setLinks({});
    setModes({});
  }, [data]);

  const open = async (item: ResourceItem, shownMode: Mode) => {
    setLinks((current) => ({ ...current, [item.id]: { kind: 'opening' } }));
    const query = new URLSearchParams({ platform: 'web' });
    const locale = clientLocale();
    if (locale) query.set('locale', locale);
    try {
      const outbound = await api.get(
        `/v1/resources/${encodeURIComponent(item.id)}/outbound?${query.toString()}`,
        outboundUrlResponseSchema,
      );
      if (outbound.mode !== shownMode) {
        // Never open a link under a disclosure the parent has not seen.
        setModes((current) => ({ ...current, [item.id]: outbound.mode }));
        setLinks((current) => ({ ...current, [item.id]: { kind: 'changed' } }));
        return;
      }
      openOutside(outbound.url);
      setLinks((current) => ({
        ...current,
        [item.id]: { kind: 'opened', url: outbound.url, host: hostOf(outbound.url) },
      }));
    } catch (error) {
      setLinks((current) => ({ ...current, [item.id]: linkErrorState(error) }));
    }
  };

  return (
    <section style={sectionStyle} aria-labelledby={headingId} aria-busy={busy}>
      <h2 id={headingId}>Resources</h2>
      <p style={{ marginTop: 0, color: 'var(--muted)' }}>
        Listed by learning fit: skills, grade and availability, with free options first when they
        fit equally well. Commission never changes the order.
      </p>
      {data.commercialHidden ? (
        <Notice>
          Shopping links are hidden by your choice below. Free learning options are still shown.
        </Notice>
      ) : null}
      {data.items.length === 0 ? (
        <EmptyState title="No resources match yet">
          <p>Try another subject, grade or focus skill, or show all subjects.</p>
        </EmptyState>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.items.map((item) => (
            <ResourceCard
              key={item.id}
              item={item}
              mode={modes[item.id] ?? item.mode}
              focusSkill={filters.skill}
              link={links[item.id] ?? null}
              onOpen={(mode) => void open(item, mode)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ResourceCard({
  item,
  mode,
  focusSkill,
  link,
  onOpen,
}: {
  item: ResourceItem;
  mode: Mode;
  focusSkill: string;
  link: LinkState | null;
  onOpen: (mode: Mode) => void;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const disclosureId = `${id}-disclosure`;
  const newTabId = `${id}-new-tab`;
  const disclosure = disclosureFor(mode);
  const unavailable = item.availability === 'unavailable';
  const linked = disclosure !== null && item.merchant !== 'none' && !unavailable;
  const priceNote = linked && item.merchant === 'amazon' ? AMAZON_PRICE_NOTE : null;
  const free = item.merchant === 'none';
  const matchesSkill = focusSkill !== '' && item.skills.includes(focusSkill);

  return (
    <li className="card" style={{ marginTop: 12 }}>
      <article aria-labelledby={titleId} style={{ overflowWrap: 'anywhere' }}>
        <h3 id={titleId} style={{ margin: 0 }}>
          {item.title}
        </h3>
        <p style={{ margin: '4px 0', color: 'var(--muted)' }}>
          {KIND_LABEL[item.kind]} · {gradeRange(item.gradeMin, item.gradeMax)} ·{' '}
          {item.subjects.map((s) => SUBJECT_LABEL[s]).join(', ')}
          {matchesSkill ? ' · Practices your focus skill' : ''}
        </p>
        <p style={{ margin: '8px 0' }}>{item.description}</p>
        {free ? <p style={{ margin: '4px 0' }}>Free: no purchase needed.</p> : null}
        {unavailable ? <p style={{ margin: '4px 0' }}>Currently unavailable.</p> : null}
        {priceNote ? <p style={{ margin: '4px 0' }}>{priceNote}</p> : null}
        {!free && !linked && !unavailable ? (
          <p style={{ margin: '4px 0', color: 'var(--muted)' }}>
            No outside link is offered here. The description is for reference.
          </p>
        ) : null}
        {linked ? (
          <div
            data-testid="link-row"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              className="btn secondary"
              aria-label={`${linkLabel(item)}: ${item.title}`}
              aria-describedby={`${disclosureId} ${newTabId}`}
              disabled={link?.kind === 'opening'}
              onClick={() => onOpen(mode)}
            >
              {link?.kind === 'opening' ? 'Opening…' : linkLabel(item)}
            </button>
            <span
              id={disclosureId}
              data-testid="disclosure"
              style={{ fontWeight: 700, overflowWrap: 'anywhere', whiteSpace: 'normal' }}
            >
              {disclosure}
            </span>
            <span id={newTabId} style={{ color: 'var(--muted)', whiteSpace: 'normal' }}>
              Opens in a new tab.
            </span>
          </div>
        ) : null}
        {link ? <LinkFeedback link={link} disclosureId={disclosureId} /> : null}
      </article>
    </li>
  );
}

function LinkFeedback({ link, disclosureId }: { link: LinkState; disclosureId: string }) {
  if (link.kind === 'opening') return null;
  if (link.kind === 'changed') {
    return (
      <p role="alert" style={{ margin: '8px 0 0' }}>
        This link changed since the list loaded. Read the note beside it, then select it again.
      </p>
    );
  }
  if (link.kind === 'error') {
    return link.stepUp ? (
      <StepUpNotice action="Opening a resource link" />
    ) : (
      <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>
        {link.message}
      </p>
    );
  }
  return (
    <p role="status" style={{ margin: '8px 0 0' }}>
      Opened {link.host} in a new tab. If nothing opened,{' '}
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        aria-describedby={disclosureId}
      >
        open {link.host}
      </a>
      .
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

function PreferencesSection({
  prefs,
  onSaved,
}: {
  prefs: MonetizationPreferences;
  onSaved: (next: MonetizationPreferences) => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const [draft, setDraft] = useState(prefs);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useEffect(() => setDraft(prefs), [prefs]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const saved = await api.send(
        'PUT',
        '/v1/monetization/preferences',
        draft,
        monetizationPreferencesSchema,
      );
      onSaved(saved);
      setMessage('Your choices are saved for your family.');
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const checkbox = { width: 'auto', minHeight: 24 } as const;
  const inline = { fontWeight: 400, display: 'flex', gap: 8, alignItems: 'center' } as const;
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId} style={{ marginTop: 0 }}>
        Shopping links and sponsor cards
      </h2>
      <form aria-label="Commercial content choices" onSubmit={(e) => void save(e)}>
        <label style={inline}>
          <input
            type="checkbox"
            style={checkbox}
            checked={draft.hideAffiliate}
            onChange={(e) => setDraft({ ...draft, hideAffiliate: e.target.checked })}
          />
          Hide shopping and affiliate links
        </label>
        <p style={{ margin: '0 0 8px', color: 'var(--muted)' }}>
          Free learning options stay visible either way.
        </p>
        <label style={inline}>
          <input
            type="checkbox"
            style={checkbox}
            checked={draft.hideSponsorCards}
            onChange={(e) => setDraft({ ...draft, hideSponsorCards: e.target.checked })}
          />
          Hide sponsor cards
        </label>
        <div style={buttonRow}>
          <button type="submit" className="btn secondary" disabled={busy}>
            {busy ? 'Saving…' : 'Save choices'}
          </button>
        </div>
      </form>
      {message ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          {message}
        </p>
      ) : null}
      {error ? (
        error.code === 'STEP_UP_REQUIRED' ? (
          <StepUpNotice action="Changing these choices" />
        ) : (
          <ErrorState message={error.message} />
        )
      ) : null}
    </section>
  );
}

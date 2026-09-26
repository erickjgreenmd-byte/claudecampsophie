import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { childSubjectsResponseSchema } from '@pencillift/contracts';
import { PracticeSetsSection } from '../../components/learning/PracticeSetsSection.tsx';
import { ScheduleSection } from '../../components/learning/ScheduleSection.tsx';
import { SkillsSection } from '../../components/learning/SkillsSection.tsx';
import { StudyMaterialSection } from '../../components/learning/StudyMaterialSection.tsx';
import { SubjectsSection } from '../../components/learning/SubjectsSection.tsx';
import { TestDatesSection } from '../../components/learning/TestDatesSection.tsx';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery } from '../../lib/session.tsx';
import { childPickerSuffix } from './ChildrenPage.tsx';

/**
 * Parent learning planner (spec P7, P8, P10, P14 "learning trends, practice/review planner";
 * AC_LEARNING_01..10, AC_UX_02). One child at a time: subjects, the daily-practice and weekly
 * review schedule in the family's time zone, test dates, teacher lists and notes, the skill
 * dashboard, and practice sets with a PIN-protected answer key. No sibling comparison.
 */
export default function LearningPlannerPage() {
  return (
    <RequireParent>
      <LearningPlanner />
    </RequireParent>
  );
}

// Only the fields this page needs from GET /v1/family (owned by the family vertical); unknown keys
// are ignored rather than rendered.
//
// HUNT5-F-2: `deletionPending` is one of the fields this page needs. z.object strips what it does not
// name, so leaving it out silently emptied childPickerSuffix's first branch and the notice below: a
// child whose data deletion is under way was labelled "(archived — history only)" and offered an
// activation POST /children/:id/activate answers NOT_FOUND for, while the purge was deleting the
// history the archived notice promised stays readable.
const familySchema = z.object({
  timezone: z.string(),
  children: z.array(
    z.object({
      id: z.uuid(),
      nickname: z.string(),
      status: z.string(),
      deletionPending: z.boolean().optional(),
    }),
  ),
});
type PlannerChild = z.infer<typeof familySchema>['children'][number];

function LearningPlanner() {
  const family = useApiQuery((api) => api.get('/v1/family', familySchema), []);
  const children = family.status === 'ready' ? family.data.children : [];
  const [childId, setChildId] = useState<string | null>(null);
  const firstChild = children[0]?.id ?? null;
  useEffect(() => {
    if (childId === null && firstChild !== null) setChildId(firstChild);
  }, [childId, firstChild]);
  const selectId = useId();
  const child = children.find((c) => c.id === childId) ?? null;

  return (
    <>
      <h1>Learning planner</h1>
      <p>
        Plan daily practice and the weekly review, add test dates and class material, and see how
        each child is doing on their own terms. Children are never compared with each other.
      </p>
      {family.status === 'loading' ? <Loading label="Loading your family…" /> : null}
      {family.status === 'error' ? (
        <ErrorState
          message={
            family.error.code === 'NOT_FOUND'
              ? 'Create your family first, then come back to plan practice.'
              : family.error.message
          }
          onRetry={family.reload}
        />
      ) : null}
      {family.status === 'ready' && children.length === 0 ? (
        <EmptyState title="No children yet">
          <p>
            Add a child on the <Link to="/app/children">Children page</Link> to plan their practice.
          </p>
        </EmptyState>
      ) : null}
      {family.status === 'ready' && child !== null ? (
        <>
          <label htmlFor={selectId}>Child</label>
          <select id={selectId} value={child.id} onChange={(e) => setChildId(e.target.value)}>
            {children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
                {childPickerSuffix(c)}
              </option>
            ))}
          </select>
          <ChildPlanner key={child.id} child={child} zone={family.data.timezone} />
        </>
      ) : null}
    </>
  );
}

function ChildPlanner({ child, zone }: { child: PlannerChild; zone: string }) {
  // HUNT5-F-2: a child whose data deletion is under way has no plan to show and no subjects to load
  // (GET /v1/children/:id/subjects answers NOT_FOUND for it). Nothing here may promise that what was
  // planned and practised stays readable, or offer an activation the API refuses — the Children page
  // offers none either. Same wording as that page's notice for the same state.
  if (child.deletionPending === true) {
    return (
      <div aria-label={`Learning plan for ${child.nickname}`} role="region">
        <h2 style={{ marginTop: 24 }}>{child.nickname}</h2>
        <p className="notice">
          <strong>Data deletion under way.</strong> You asked for {child.nickname}’s data to be
          deleted. Processing has already stopped, so no practice is prepared or released for them
          and their plan is not kept. You can follow it on the{' '}
          <Link to="/app/privacy">privacy page</Link>. Deletion can’t be undone from the app: if you
          did not mean it, <Link to="/app/support">contact support</Link> straight away.
        </p>
      </div>
    );
  }
  return <ActivePlanner child={child} zone={zone} />;
}

function ActivePlanner({ child, zone }: { child: PlannerChild; zone: string }) {
  const subjectsPath = `/v1/children/${encodeURIComponent(child.id)}/subjects`;
  const subjects = useApiQuery(
    (api) => api.get(subjectsPath, childSubjectsResponseSchema),
    [subjectsPath],
  );
  // Bumped after subject or test-date changes so the schedule's upcoming releases refresh.
  const [scheduleKey, setScheduleKey] = useState(0);
  const { reload } = subjects;
  const subjectsChanged = useCallback(() => {
    reload();
    setScheduleKey((k) => k + 1);
  }, [reload]);
  const testDatesChanged = useCallback(() => setScheduleKey((k) => k + 1), []);
  const [list, setList] = useState<z.infer<typeof childSubjectsResponseSchema>['subjects'] | null>(
    null,
  );
  const ready = subjects.status === 'ready' ? subjects.data.subjects : null;
  useEffect(() => {
    if (ready) setList(ready);
  }, [ready]);
  const current = ready ?? list;

  return (
    <div aria-label={`Learning plan for ${child.nickname}`} role="region">
      <h2 style={{ marginTop: 24 }}>{child.nickname}</h2>
      {/*
        WEBR4-10: an archived child has no slot waiting to be bought — the profile is history only —
        so "doesn't have a paid slot yet … see Subscription" was both false and unactionable for it.
        A draft still gets that copy, because a draft really is waiting for a slot.
      */}
      {child.status === 'active' ? null : child.status === 'archived' ? (
        // HUNT5-F-10: this used to end "and nothing here is released to them", which the schedule
        // section below contradicts — it prints this child's next daily and weekly review instants,
        // and nothing there branches on the status (BUG-070's residual records that preview as a
        // known-open item, so the copy is what changes here). It now says what holds: nothing NEW is
        // prepared, and those times are what the schedule would produce for an active profile.
        <p className="notice">
          {child.nickname}’s profile is archived, so no new practice is prepared for them. What was
          planned and practised stays readable, and the times below are what the schedule would
          produce if the profile were active again.{' '}
          <Link to="/app/children">
            Activate {child.nickname} again on the Children page while a paid slot is free
          </Link>
          .
        </p>
      ) : (
        <p className="notice">
          {child.nickname} doesn’t have a paid slot yet, so no practice is prepared, and the times
          below are what the schedule would produce once they have one. You can still set things up;
          see <Link to="/app/subscription">Subscription</Link>.
        </p>
      )}
      {current === null && subjects.status === 'loading' ? (
        <Loading label="Loading subjects…" />
      ) : null}
      {subjects.status === 'error' ? (
        <ErrorState
          message={`We couldn’t load ${child.nickname}’s subjects. ${subjects.error.message}`}
          onRetry={reload}
        />
      ) : null}
      {current !== null ? (
        <>
          <SubjectsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            onChanged={subjectsChanged}
          />
          <ScheduleSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            refreshKey={scheduleKey}
          />
          <TestDatesSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            onChanged={testDatesChanged}
          />
          <StudyMaterialSection childId={child.id} childName={child.nickname} subjects={current} />
          <SkillsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            zone={zone}
          />
          {/* HUNT5-F-10: the status has to reach this section. The notice above frames the
              SCHEDULE's times as hypothetical, and that framing carries as far as its own words; a
              set card saying "Shown to your child from <instant>" is a promise instead, and an
              archived profile cannot keep it (app.current_child_id() requires status 'active'). With
              the status it prints the same instant as the notice's conditional. */}
          <PracticeSetsSection
            childId={child.id}
            childName={child.nickname}
            subjects={current}
            zone={zone}
            childStatus={child.status}
          />
        </>
      ) : null}
    </div>
  );
}
